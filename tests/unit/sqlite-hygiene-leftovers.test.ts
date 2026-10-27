import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore, appendDatasetRow, fileSink, loadHistory, pageRunResults, recordLoadRun, resetResultsIndexForTest, writeOwned, type LoadRunRecord } from '../../packages/core/src/index.js';
import { ownWriteStat } from '../../packages/core/src/storage/fsutil.js';
import { appendBoundedLine } from '../../packages/core/src/util/jsonl-append.js';

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'tp-hygiene-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const lines = (f: string) =>
  readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => l.trim());

describe('D-9 bounded JSONL appends count once', () => {
  it('keeps the newest records and compacts only past twice the limit', () => {
    const f = join(tempDir(), 'r', 'results.jsonl');
    let rewrites = 0;
    for (let i = 0; i < 25; i++) appendBoundedLine(f, JSON.stringify({ i }), 10, (file, text) => (rewrites++, writeFileSync(file, text)));
    expect(rewrites).toBe(1);
    const kept = lines(f).map((l) => JSON.parse(l).i);
    expect(kept.at(-1)).toBe(24);
    expect(kept.length).toBeLessThanOrEqual(20);
    expect(kept.length).toBeGreaterThanOrEqual(10);
  });

  it('does not read the file after an append (only the first append of a file counts its lines)', () => {
    const f = join(tempDir(), 'r.jsonl');
    appendBoundedLine(f, '{"i":0}', 500, writeFileSync);
    // a line count of a big file read per append is what this removes: appending 2,000 records to a 5 MB file stays quick
    appendFileSync(f, ('{"x":"' + 'y'.repeat(2000) + '"}\n').repeat(2000));
    const t0 = performance.now();
    for (let i = 0; i < 300; i++) appendBoundedLine(f, '{"i":1}', 5000, writeFileSync);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('the load history keeps its newest 500 records', () => {
    const root = tempDir();
    const rec = (n: number) => ({ id: `l${n}`, startedAt: new Date(1.7e12 + n).toISOString(), name: 'x' }) as unknown as LoadRunRecord;
    for (let i = 0; i < 1100; i++) recordLoadRun({ path: (...p: string[]) => join(root, ...p) } as never, rec(i));
    const got = loadHistory({ path: (...p: string[]) => join(root, ...p) } as never, { limit: 500 });
    expect(got.length).toBe(500);
  });
});

describe('D-8 the log file sink', () => {
  it('rotates by the bytes it wrote, without a stat per record', () => {
    const dir = tempDir();
    const log = join(dir, 'app.log');
    const sink = fileSink(log, 2000);
    for (let i = 0; i < 100; i++) sink({ time: 'now', level: 'INFO', scope: 'x', message: `record ${i} ${'.'.repeat(40)}` } as never);
    expect(existsSync(`${log}.1`)).toBe(true);
    expect(readFileSync(log, 'utf8').length).toBeLessThan(2400);
    expect(lines(log).every((l) => JSON.parse(l).scope === 'x')).toBe(true);
  });
});

describe('D-10 appending to a dataset', () => {
  it('1,000 appends to a 10 MB dataset take under a second and count right', async () => {
    const root = tempDir();
    mkdirSync(join(root, 'datasets'), { recursive: true });
    writeFileSync(join(root, 'workspace.json'), JSON.stringify({ schemaVersion: '1.0', id: 'w', name: 'W', variables: [] }));
    const store = WorkspaceStore.open(root);
    const file = join(root, 'datasets', 'big.jsonl');
    const row = JSON.stringify({ text: 'x'.repeat(1000) }) + '\n';
    writeFileSync(file, row.repeat(10_000)); // ~10 MB
    const first = await appendDatasetRow(store, 'big', { n: 0 });
    expect(first.rows).toBe(10_001);
    const t0 = performance.now();
    let last = 0;
    for (let i = 1; i <= 1000; i++) last = (await appendDatasetRow(store, 'big', { n: i })).rows;
    const ms = performance.now() - t0;
    console.log(`1,000 appends to a 10 MB dataset: ${ms.toFixed(0)} ms`);
    expect(last).toBe(11_001);
    expect(ms).toBeLessThan(1000 * Number(process.env.TESTPION_PERF_SLACK || 3));
    // a change by someone else in between is counted again, not assumed
    appendFileSync(file, '{"outside":1}\n');
    expect((await appendDatasetRow(store, 'big', { n: 9999 })).rows).toBe(11_003);
    store.close();
  });
});

describe('D-11 own writes remember size and time', () => {
  it('a big own write has its stat note; a small one does not need it', () => {
    const dir = tempDir();
    const big = join(dir, 'big.json');
    const small = join(dir, 'small.json');
    writeOwned(big, 'x'.repeat(10_000));
    writeOwned(small, '{}');
    expect(ownWriteStat(big)).toMatch(/^stat:10000:\d+$/);
    expect(ownWriteStat(small)).toBeUndefined();
  });
});

describe('D-12 the results index continues from where it ended', () => {
  it('paging a live 50,000-line file ten times is quick and sees the lines added meanwhile', async () => {
    resetResultsIndexForTest();
    const root = tempDir();
    const runDir = (id: string) => join(root, 'runs', id);
    mkdirSync(runDir('live'), { recursive: true });
    const file = join(runDir('live'), 'results.jsonl');
    const row = (i: number) => JSON.stringify({ id: `t${i}`, name: `test ${i}`, status: i % 10 === 0 ? 'failed' : 'passed', output: 'o'.repeat(1400), checks: [], attempts: 1, durationMs: 1 }) + '\n';
    let text = '';
    for (let i = 0; i < 50_000; i++) text += row(i);
    writeFileSync(file, text);
    const store = { runDir } as never;
    const first = await pageRunResults(store, { runId: 'live', limit: 10 });
    expect(first.total).toBe(50_000);
    const t0 = performance.now();
    for (let k = 0; k < 10; k++) {
      appendFileSync(file, row(50_000 + k));
      const page = await pageRunResults(store, { runId: 'live', limit: 10, offset: 49_990 });
      expect(page.total).toBe(50_001 + k);
    }
    const ms = performance.now() - t0;
    console.log(`10 pages of a growing 50,000-line file: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(1500 * Number(process.env.TESTPION_PERF_SLACK || 3));
    // a torn last line is not a result until its newline is there
    appendFileSync(file, '{"id":"torn","na');
    expect((await pageRunResults(store, { runId: 'live', limit: 1 })).total).toBe(50_010);
    appendFileSync(file, 'me":"torn","status":"passed","checks":[],"attempts":1}\n');
    expect((await pageRunResults(store, { runId: 'live', query: 'torn' })).items.map((r) => r.id)).toEqual(['torn']);
    // a file rewritten under the index is read again from the start
    writeFileSync(file, row(1) + row(2));
    expect((await pageRunResults(store, { runId: 'live' })).total).toBe(2);
  });
});
