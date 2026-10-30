import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { WorkspaceStore, EVALUATIONS_LIBRARY, SAMPLE_NAME, type SavedEvaluation } from '../../packages/core/src/index.js';
import { cliData, runCli, tempDir } from '../helpers.js';

/**
 * A-6: the review queue. Answers of a run to grade good or bad (the failed ones first, the checks' verdict hidden until graded),
 * how often the checks agreed, and the good answers added to the test cases as expected answers.
 */
const tmp = tempDir('tp-review-');
let ws: string;
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  ws = join(tmp.dir, 'ws');
  WorkspaceStore.create(ws, 'RV').close();
  env = { ...process.env, TESTPION_HOME: join(tmp.dir, 'home') };
  expect((await runCli(['eval', 'sample', '-w', ws, '-q'], { env })).status).toBe(0);
  // record 3 expects the wrong answer (fails); record 1 has no expected answer at all, so its check cannot pass (a good answer can be added to it)
  const store = WorkspaceStore.open(ws);
  try {
    const lib = store.getLibrary<SavedEvaluation>(EVALUATIONS_LIBRARY);
    const lines = lib.items[0]!.data.dataset.split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    delete lines[0]!.expected;
    lines[2]!.expected = 'booking';
    store.saveLibrary(EVALUATIONS_LIBRARY, { folders: lib.folders, items: lib.items.map((i) => ({ ...i, data: { ...i.data, dataset: lines.map((l) => JSON.stringify(l)).join('\n') } })) });
  } finally {
    store.close();
  }
  expect((await runCli(['eval', 'run', SAMPLE_NAME, '-w', ws, '-q', '-r', 'console'], { env })).status).toBe(1);
}, 180_000);
afterAll(() => tmp.cleanup());

const cli = (args: string[]) => runCli(args, { env });
const queue = async (count = 10) => cliData((await cli(['eval', 'review', 'last', '--count', String(count), '-w', ws, '--json'])).out);

describe('the review queue', () => {
  it('puts the failed answer first and hides what the checks decided', async () => {
    const q = await queue();
    expect(q.total).toBe(10);
    expect(q.graded).toBe(0);
    // the failed cases come first: record 1 (no expected answer to match) and record 3 (the wrong one)
    expect(q.cases.slice(0, 2).map((c: { key: string }) => c.key)).toEqual(['1', '3']);
    expect(q.cases.every((c: { verdict?: unknown; rating?: string }) => c.verdict === undefined && c.rating === undefined)).toBe(true);
    expect(q.text).toBe('Read 10 answers and grade each good or bad. What the checks decided stays hidden until you have graded it.');
    // the words, for a person
    const words = (await cli(['eval', 'review', 'last', '-w', ws])).out;
    expect(words).toContain('1. 1 not graded');
    expect(words).not.toContain('the checks:');
  }, 120_000);

  it('a grade shows the checks verdict for that case and how often they agreed', async () => {
    const q = await queue();
    const failed = q.cases.find((c: { key: string }) => c.key === '3').resultId as string;
    const passed = q.cases.find((c: { key: string }) => c.key === '2').resultId as string;
    expect((await cli(['history', 'review', q.run, failed, '--bad', '-w', ws])).status).toBe(0);
    expect((await cli(['history', 'review', q.run, passed, '--good', '--note', 'right', '-w', ws])).status).toBe(0);
    const after = await queue();
    expect(after.graded).toBe(2);
    expect(after.agreement).toEqual({ graded: 2, agreed: 2, percent: 100 });
    const c3 = after.cases.find((c: { key: string }) => c.key === '3');
    expect(c3).toMatchObject({ rating: 'bad', verdict: { status: 'failed' } });
    expect(after.cases.find((c: { key: string }) => c.key === '2')).toMatchObject({ rating: 'good', note: 'right', verdict: { status: 'passed' } });
    // a case that is not graded still hides its verdict
    expect(after.cases.find((c: { key: string }) => c.key === '1').verdict).toBeUndefined();
    expect(after.text).toBe('2 of 10 graded: 8 to go.');
    const exported = (await cli(['eval', 'review', 'last', '--export', '-w', ws])).out.trim().split('\n').map((l) => JSON.parse(l));
    expect(exported.map((e) => `${e.case}:${e.rating}`).sort()).toEqual(['2:good', '3:bad']);
  }, 120_000);

  it('the good answers become the expected answers of their records; one that has an expected answer keeps it', async () => {
    const q = await queue();
    // the answer of record 1 is good although its check could not pass (there was nothing to match): the person knows better
    const one = q.cases.find((c: { key: string }) => c.key === '1').resultId as string;
    expect((await cli(['history', 'review', q.run, one, '--good', '-w', ws])).status).toBe(0);
    expect((await queue()).agreement).toEqual({ graded: 3, agreed: 2, percent: 67 });
    const r = cliData((await cli(['eval', 'review-add', 'last', '-w', ws, '--json'])).out);
    // record 1 had no expected answer (added); record 2 already had one (kept)
    expect(r).toMatchObject({ evaluation: SAMPLE_NAME, added: 1, kept: 1, missing: 0 });
    expect(r.text).toContain('Added 1 good answer as the expected answer');
    const store = WorkspaceStore.open(ws);
    try {
      const data = store.getLibrary<SavedEvaluation>(EVALUATIONS_LIBRARY).items[0]!.data;
      const first = JSON.parse(data.dataset.split('\n')[0]!) as Record<string, unknown>;
      expect(typeof first.expected).toBe('string');
      expect(String(first.expected).length).toBeGreaterThan(0);
      expect(JSON.parse(data.dataset.split('\n')[1]!).expected).toBe('cancellation');
    } finally {
      store.close();
    }
  }, 120_000);

  it('adding with nothing graded good says so', async () => {
    const fresh = await cli(['eval', 'run', SAMPLE_NAME, '-w', ws, '-q', '-r', 'console']);
    expect(fresh.status).toBeLessThanOrEqual(1);
    const none = await cli(['eval', 'review-add', 'last', '-w', ws]);
    expect(none.status).not.toBe(0);
    expect(none.out + none.err).toContain('No answer of this run is graded good yet');
  }, 120_000);
});
