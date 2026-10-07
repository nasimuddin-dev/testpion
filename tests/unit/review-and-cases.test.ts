import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { appendDatasetRow, pageRunResults, reviewCounts, reviewResult, runReviews } from '../../packages/core/src/index.js';

// A person's verdict on a result (👍 / 👎 and a note) kept beside the run, and a Playground answer kept as an
// evaluation case (a record added to a JSONL dataset).
const root = mkdtempSync(join(tmpdir(), 'tp-review-'));
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
const store = {
  root,
  runDir: (id: string) => join(root, 'runs', id),
  path: (...p: string[]) => join(root, ...p),
  safePath(rel: string, base = root) {
    const p = resolve(base, rel);
    if (!p.startsWith(base + sep)) throw new Error('outside the workspace');
    return p;
  },
};
const result = (id: string, status: string) => ({
  id,
  name: `case ${id}`,
  type: 'llm',
  status,
  startedAt: '2026-10-07T00:00:00Z',
  durationMs: 5,
  attempts: 1,
  checks: [{ type: 'similarity', name: 's', passed: status === 'passed', source: 'heuristic', message: '', score: status === 'passed' ? 0.9 : 0.3 }],
});
mkdirSync(store.runDir('r1'), { recursive: true });
writeFileSync(join(store.runDir('r1'), 'results.jsonl'), ['a', 'b', 'c'].map((id, i) => JSON.stringify(result(id, i === 1 ? 'failed' : 'passed'))).join('\n') + '\n');

describe('reviewing results', () => {
  it('rates a result good or bad with a note, and a later change keeps what it does not touch', () => {
    expect(reviewResult(store, 'r1', 'a', { rating: 'bad', note: 'Right category, rude tone' })).toMatchObject({ rating: 'bad', note: 'Right category, rude tone' });
    // a new rating keeps the note
    expect(reviewResult(store, 'r1', 'a', { rating: 'good' })).toMatchObject({ rating: 'good', note: 'Right category, rude tone' });
    // clearing the rating and the note removes the review
    expect(reviewResult(store, 'r1', 'a', { rating: null, note: '' })).toBeUndefined();
    expect(runReviews(store, 'r1')).toEqual({});
  });

  it('results carry their review; the "reviewed" and "unreviewed" filters and the counts follow it', async () => {
    reviewResult(store, 'r1', 'b', { rating: 'good', note: 'The check is too strict', by: 'agent' });
    reviewResult(store, 'r1', 'c', { note: 'look again' });
    const page = await pageRunResults(store, { runId: 'r1' });
    expect(page.items.find((r) => r.id === 'b')!.review).toMatchObject({ rating: 'good', by: 'agent' });
    expect((await pageRunResults(store, { runId: 'r1', status: 'reviewed' })).items.map((r) => r.id)).toEqual(['b']);
    // a note alone is not a verdict
    expect((await pageRunResults(store, { runId: 'r1', status: 'unreviewed' })).items.map((r) => r.id)).toEqual(['a', 'c']);
    expect(reviewCounts(runReviews(store, 'r1'), 3)).toEqual({ good: 1, bad: 0, unreviewed: 2 });
  });

  it('says what is wrong: an unknown run, a rating that is not good or bad', () => {
    expect(() => reviewResult(store, 'nope', 'a', { rating: 'good' })).toThrow(/No finished run nope/);
    expect(() => reviewResult(store, 'r1', 'a', { rating: 'meh' as 'good' })).toThrow(/good or bad/);
  });
});

describe('adding a case to a dataset', () => {
  it('makes the JSONL file, appends records and counts them', async () => {
    await expect(appendDatasetRow(store, 'intent-cases', { message: 'Cancel my booking', expected: 'cancellation' })).resolves.toEqual({ path: 'datasets/intent-cases.jsonl', rows: 1 });
    expect((await appendDatasetRow(store, 'datasets/intent-cases.jsonl', { message: 'Refill', expected: { category: 'refill' } })).rows).toBe(2);
    const lines = readFileSync(join(root, 'datasets', 'intent-cases.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(JSON.parse(lines[1]!)).toEqual({ message: 'Refill', expected: { category: 'refill' } });
  });

  it('only JSONL, only an object, only inside datasets/', async () => {
    await expect(appendDatasetRow(store, 'cases.csv', { a: 1 })).rejects.toThrow(/JSONL datasets, not \.csv/);
    await expect(appendDatasetRow(store, 'x', [1] as unknown as Record<string, unknown>)).rejects.toThrow(/object of fields/);
    await expect(appendDatasetRow(store, '../../escape', { a: 1 })).rejects.toThrow();
  });
});
