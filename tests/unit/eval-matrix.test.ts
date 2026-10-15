import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildEvalMatrix,
  compareEvalCell,
  compareEvalRuns,
  evalMatrixPage,
  evalMatrixResult,
  evalThreshold,
  expandDataset,
  recordRun,
  resolveRunRef,
  resultScore,
  WorkspaceStore,
  type EvalMatrixSource,
  type RunSummary,
  type TestResult,
} from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';

// Evaluations as a matrix: the cell comparison (status flips, score deltas at and around the threshold, missing and
// new cases), the matrix (cases lined up across differently named runs, one column per model, duplicates kept apart,
// filters, tags, sorts, pages) and the run-level comparison CI gates on.
const tmp = tempDir('tp-eval-matrix-');
afterAll(() => tmp.cleanup());

type Cell = { status?: TestResult['status']; score?: number; model?: string; tags?: string[] };
const result = (id: string, c: Cell): TestResult => ({
  id,
  name: `Case [${id.split(':').pop()}]`,
  type: 'llm',
  status: c.status ?? 'passed',
  startedAt: '2026-10-13T00:00:00.000Z',
  durationMs: 1,
  attempts: 1,
  checks:
    c.score === undefined
      ? [{ type: 'contains', name: 'contains', passed: true, source: 'deterministic', message: '' }]
      : [{ type: 'similarity', name: 'similarity', passed: (c.status ?? 'passed') === 'passed', source: 'heuristic', score: c.score, message: '' }],
  ...(c.model ? { model: c.model } : {}),
  ...(c.tags ? { tags: c.tags } : {}),
  output: `output of ${id}`,
  input: `input of ${id}`,
});
async function* iter<T>(xs: T[]) {
  for (const x of xs) yield x;
}
const src = (runId: string, name: string, cells: Record<string, Cell>, prefix = name.toLowerCase().replace(/[^a-z0-9]+/g, '-')): EvalMatrixSource => ({
  runId,
  name,
  results: iter(Object.entries(cells).map(([k, c]) => result(`${prefix}:${k}`, c))),
});

describe('compareEvalCell', () => {
  it('a case that stops passing regressed and one that starts passing improved, whatever the score', () => {
    expect(compareEvalCell({ status: 'failed', score: 0.9 }, { status: 'passed', score: 0.5 })).toEqual({ change: 'regressed', delta: 0.4 });
    expect(compareEvalCell({ status: 'error' }, { status: 'passed' })).toEqual({ change: 'regressed' });
    expect(compareEvalCell({ status: 'passed', score: 0.1 }, { status: 'failed', score: 0.9 })).toEqual({ change: 'improved', delta: -0.8 });
  });

  it('the score moves beyond the threshold (strictly): a drop of exactly the threshold is unchanged', () => {
    expect(compareEvalCell({ status: 'passed', score: 0.84 }, { status: 'passed', score: 0.9 }, 0.05)).toEqual({ change: 'regressed', delta: -0.06 });
    expect(compareEvalCell({ status: 'passed', score: 0.85 }, { status: 'passed', score: 0.9 }, 0.05)).toEqual({ change: 'unchanged', delta: -0.05 });
    expect(compareEvalCell({ status: 'passed', score: 0.95 }, { status: 'passed', score: 0.9 }, 0.05)).toEqual({ change: 'unchanged', delta: 0.05 });
    expect(compareEvalCell({ status: 'passed', score: 0.96 }, { status: 'passed', score: 0.9 }, 0.05)).toEqual({ change: 'improved', delta: 0.06 });
    // floating point: 0.1 - 0.05 is not more than 0.05
    expect(compareEvalCell({ status: 'passed', score: 0.05 }, { status: 'passed', score: 0.1 }, 0.05)!.change).toBe('unchanged');
    // a tie and a zero threshold
    expect(compareEvalCell({ status: 'passed', score: 0.5 }, { status: 'passed', score: 0.5 }, 0)).toEqual({ change: 'unchanged', delta: 0 });
    expect(compareEvalCell({ status: 'passed', score: 0.4999 }, { status: 'passed', score: 0.5 }, 0)).toEqual({ change: 'regressed', delta: -0.0001 });
  });

  it('missing on either side; skipped is not run; no scores compares status only', () => {
    expect(compareEvalCell(undefined, { status: 'passed' })).toEqual({ change: 'missing' });
    expect(compareEvalCell({ status: 'skipped' }, { status: 'passed' })).toEqual({ change: 'missing' });
    expect(compareEvalCell({ status: 'passed' }, undefined)).toEqual({ change: 'new' });
    expect(compareEvalCell({ status: 'failed' }, { status: 'skipped' })).toEqual({ change: 'new' });
    expect(compareEvalCell(undefined, undefined)).toBeUndefined();
    expect(compareEvalCell({ status: 'failed' }, { status: 'failed' })).toEqual({ change: 'unchanged' });
    expect(compareEvalCell({ status: 'passed', score: 0.2 }, { status: 'passed' })).toEqual({ change: 'unchanged' });
  });

  it('thresholds are checked; a score is the mean of the scored checks', () => {
    expect(evalThreshold(undefined)).toBe(0.05);
    expect(evalThreshold('0.1')).toBe(0.1);
    expect(() => evalThreshold(-1)).toThrow(/from 0 to 1/);
    expect(() => evalThreshold('x')).toThrow(/from 0 to 1/);
    expect(() => evalThreshold(2)).toThrow(/from 0 to 1/);
    expect(resultScore({ checks: [{ score: 1 }, { score: 0.5 }, { score: undefined }] as never })).toBe(0.75);
    expect(resultScore({ checks: [] })).toBeUndefined();
  });
});

describe('buildEvalMatrix', () => {
  it('lines up cases of differently named runs by record, with missing cases on either side and the baseline', async () => {
    const m = await buildEvalMatrix(
      [
        src('r1', 'Intent v1', { '1': { score: 0.9 }, '2': { score: 0.5 }, '3': { status: 'failed', score: 0.2 } }),
        src('r2', 'Intent v2 (gpt)', { '1': { score: 0.8 }, '2': { score: 0.9 }, '4': { score: 1 } }),
      ],
      src('b', 'Old', { '1': { score: 0.9 }, '2': { score: 0.6 }, '3': { score: 0.7 }, '5': { score: 0.5 } }),
    );
    const p = m.page({ limit: 50 });
    expect(p.cases).toBe(5);
    expect(p.rows.map((r) => r.key)).toEqual(['1', '2', '3', '4', '5']);
    expect(p.columns.map((c) => c.label)).toEqual(['Intent v1', 'Intent v2 (gpt)']);
    const changes = (k: number) => p.rows.map((r) => r.cells[k]!.change ?? '-');
    expect(changes(0)).toEqual(['unchanged', 'regressed', 'regressed', '-', 'missing']);
    expect(changes(1)).toEqual(['regressed', 'improved', 'missing', 'new', 'missing']);
    expect(p.rows[0]!.cells[1]).toMatchObject({ status: 'passed', score: 0.8, delta: -0.1, id: 'intent-v2-gpt-:1', baseline: { status: 'passed', score: 0.9, id: 'old:1' } });
    expect(p.rows[3]!.cells[0]).toEqual({});
    expect(p.columns[0]!.stats).toMatchObject({ cases: 3, passed: 2, failed: 1, regressed: 2, improved: 0, unchanged: 1, missing: 1, added: 0, meanScore: 0.5333 });
    expect(p.columns[1]!.stats).toMatchObject({ cases: 3, regressed: 1, improved: 1, missing: 2, added: 1 });
    expect(p.counts).toEqual({ all: 5, failed: 1, regressed: 3, improved: 1, changed: 3, missing: 2 });
    expect(m.page({ filter: 'regressed' }).rows.map((r) => r.key)).toEqual(['1', '2', '3']);
    expect(m.page({ filter: 'improved' }).rows.map((r) => r.key)).toEqual(['2']);
    expect(m.page({ filter: 'missing' }).rows.map((r) => r.key)).toEqual(['3', '5']);
    expect(m.page({ filter: 'failed' }).rows.map((r) => r.key)).toEqual(['3']);
  });

  it('without a baseline there is no comparison', async () => {
    const m = await buildEvalMatrix([src('r1', 'A', { a: { status: 'failed' }, b: {} })]);
    const p = m.page();
    expect(p.baseline).toBeUndefined();
    expect(p.rows[0]!.cells[0]).toEqual({ status: 'failed', id: 'a:a' });
    expect(p.counts).toEqual({ all: 2, failed: 1, regressed: 0, improved: 0, changed: 0, missing: 0 });
  });

  it('a run with several models is a column per model, compared with the baseline column of the same model', async () => {
    const run: EvalMatrixSource = {
      runId: 'r',
      name: 'Compare',
      results: iter([result('c:1', { model: 'a', score: 0.5 }), result('c:1', { model: 'b', score: 0.9 }), result('c:2', { model: 'a', score: 0.5 }), result('c:2', { model: 'b', score: 0.1 })]),
    };
    const base: EvalMatrixSource = {
      runId: 'b',
      name: 'Base',
      results: iter([result('x:1', { model: 'b', score: 0.9 }), result('x:2', { model: 'b', score: 0.9 }), result('x:1', { model: 'a', score: 0.1 }), result('x:2', { model: 'a', score: 0.5 })]),
    };
    const p = (await buildEvalMatrix([run], base)).page();
    expect(p.columns.map((c) => `${c.key}=${c.label}`)).toEqual(['r|a=Compare · a', 'r|b=Compare · b']);
    expect(p.rows.map((r) => r.cells.map((c) => c.change).join(','))).toEqual(['improved,unchanged', 'unchanged,regressed']);
  });

  it('the same case twice in a run (a dataset with repeated ids) is two rows, not one hiding the other', async () => {
    const run: EvalMatrixSource = { runId: 'r', name: 'D', results: iter([result('d:7', { status: 'passed' }), result('d:7', { status: 'failed' })]) };
    const p = (await buildEvalMatrix([run])).page();
    expect(p.rows.map((r) => `${r.key}=${r.cells[0]!.status}`)).toEqual(['7=passed', '7#2=failed']);
  });

  it('ids without a common prefix are kept whole; torn and odd results are skipped', async () => {
    const run: EvalMatrixSource = {
      runId: 'r',
      name: 'Mixed',
      results: iter([result('a:1', {}), result('b:1', {}), null as never, { id: 5 } as never, result('plain', { status: 'weird' as never })]),
    };
    const p = (await buildEvalMatrix([run])).page();
    expect(p.rows.map((r) => `${r.key}=${r.cells[0]!.status}`)).toEqual(['a:1=passed', 'b:1=passed', 'plain=error']);
  });

  it('tags, search, sorts and pages', async () => {
    const cells: Record<string, Cell> = {};
    for (let i = 1; i <= 30; i++) cells[String(i)] = { score: i / 100, status: i % 7 === 0 ? 'failed' : 'passed', tags: i % 2 ? ['odd'] : ['even', i % 3 === 0 ? 'three' : 'other'] };
    const base: Record<string, Cell> = {};
    for (let i = 1; i <= 30; i++) base[String(i)] = { score: 0.15 };
    const m = await buildEvalMatrix([src('r', 'T', cells)], src('b', 'B', base));
    const p = m.page({ limit: 10 });
    expect(p.total).toBe(30);
    expect(p.rows.map((r) => r.key)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']); // natural order, not 1, 10, 11
    expect(m.page({ offset: 25, limit: 10 }).rows.map((r) => r.key)).toEqual(['26', '27', '28', '29', '30']);
    expect(p.tags).toEqual(
      [
        { tag: 'odd', count: 15 },
        { tag: 'even', count: 15 },
        { tag: 'other', count: 10 },
        { tag: 'three', count: 5 },
      ].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
    );
    const three = m.page({ tag: 'three' });
    expect(three.rows.map((r) => r.key)).toEqual(['6', '12', '18', '24', '30']);
    expect(three.counts.all).toBe(5);
    expect(m.page({ search: 'case [2' }).rows.map((r) => r.key)).toEqual(['2', '20', '21', '22', '23', '24', '25', '26', '27', '28', '29']);
    expect(m.page({ sort: 'score', dir: 'desc', limit: 3 }).rows.map((r) => r.key)).toEqual(['30', '29', '28']);
    // the biggest drop first; ties in the natural order of the cases
    expect(m.page({ sort: 'delta', limit: 3 }).rows.map((r) => r.key)).toEqual(['1', '2', '3']);
    expect(m.page({ sort: 'failures', limit: 4 }).rows.map((r) => r.key)).toEqual(['7', '14', '21', '28']);
    expect(m.page({ limit: 5000 }).rows).toHaveLength(30);
    expect(m.page({ limit: -3 }).rows).toHaveLength(1);
  });

  it('limits: no run, too many runs, a bad threshold', async () => {
    await expect(buildEvalMatrix([])).rejects.toThrow(/at least one run/);
    await expect(buildEvalMatrix(Array.from({ length: 21 }, (_, i) => src(`r${i}`, 'X', {})))).rejects.toThrow(/At most 20 runs/);
    await expect(buildEvalMatrix([src('r', 'X', {})], undefined, { threshold: 3 })).rejects.toThrow(/from 0 to 1/);
  });

  it('5,000 cases × 10 variants: built well under a second and a page in milliseconds', async () => {
    const N = 5000;
    const sources = Array.from({ length: 10 }, (_, v) => ({
      runId: `r${v}`,
      name: `Variant ${v}`,
      results: iter(Array.from({ length: N }, (_, i) => result(`variant-${v}:${i}`, { score: ((i * 7 + v * 13) % 100) / 100, status: (i + v) % 11 === 0 ? 'failed' : 'passed', tags: [`t${i % 5}`] }))),
    }));
    const base = { runId: 'b', name: 'Base', results: iter(Array.from({ length: N }, (_, i) => result(`base:${i}`, { score: 0.5 }))) };
    let t0 = performance.now();
    const m = await buildEvalMatrix(sources, base);
    const buildMs = performance.now() - t0;
    t0 = performance.now();
    const p = m.page({ offset: 2500, limit: 200, filter: 'regressed', sort: 'delta' });
    const firstPageMs = performance.now() - t0;
    t0 = performance.now();
    for (let o = 0; o < 4000; o += 200) m.page({ offset: o, limit: 200, filter: 'regressed', sort: 'delta' });
    const pagesMs = (performance.now() - t0) / 20;
    expect(m.cases).toBe(N);
    expect(p.columns).toHaveLength(10);
    expect(p.rows).toHaveLength(200);
    expect(p.rows[0]!.cells).toHaveLength(10);
    expect(buildMs).toBeLessThan(3000);
    expect(firstPageMs).toBeLessThan(500);
    expect(pagesMs).toBeLessThan(50);
    console.log(`eval matrix 5000×10: build ${Math.round(buildMs)} ms, first page (filter + sort) ${Math.round(firstPageMs)} ms, next pages ${pagesMs.toFixed(1)} ms`);
  }, 30_000);
});

describe('runs of a workspace', () => {
  const store = WorkspaceStore.create(join(tmp.dir, 'ws'), 'Evals');
  afterAll(() => store.close());
  let clock = 0;
  const writeRun = async (runId: string, name: string, cells: Record<string, Cell>, extra: Partial<RunSummary> = {}) => {
    const dir = store.runDir(runId);
    mkdirSync(dir, { recursive: true });
    const prefix = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    writeFileSync(
      join(dir, 'results.jsonl'),
      Object.entries(cells)
        .map(([k, c]) => JSON.stringify(result(`${prefix}:${k}`, c)))
        .join('\n') + '\n',
    );
    const summary = {
      runId,
      name,
      startedAt: new Date(Date.UTC(2026, 9, 13, 0, 0, clock++)).toISOString(),
      finishedAt: '',
      durationMs: 1,
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      errors: 0,
      latency: {},
      tokens: {},
      costUsd: 0,
      cancelled: false,
      // an evaluation's run carries the mean of its scored checks
      scores: Object.values(cells).some((c) => c.score !== undefined) ? { 'llm-judge': { mean: 0.8, count: Object.keys(cells).length } } : {},
      reproducibility: {},
      ...extra,
    } as unknown as RunSummary;
    await recordRun(store, summary, dir);
  };

  it('runs by id, "last" or name; unknown and unfinished runs are refused with the recent names', async () => {
    await writeRun('run-a', 'Intent', { '1': { score: 0.9 }, '2': { score: 0.9 }, '3': { score: 0.5 } });
    await writeRun('run-b', 'Intent', { '1': { score: 0.9 }, '2': { score: 0.8 }, '3': { status: 'failed', score: 0.1 }, '4': { score: 1 } });
    expect(resolveRunRef(store, 'run-a').runId).toBe('run-a');
    expect(resolveRunRef(store, 'last').runId).toBe('run-b');
    expect(resolveRunRef(store, 'INTENT').runId).toBe('run-b');
    expect(() => resolveRunRef(store, 'nope')).toThrow(/No finished run "nope"/);
    expect(() => resolveRunRef(store, '../etc')).toThrow(/No finished run/);
    mkdirSync(store.runDir('run-busy'), { recursive: true });
    expect(() => resolveRunRef(store, 'run-busy')).toThrow(/has not finished/);
    expect(() => resolveRunRef(store, '')).toThrow(/Name a run/);
  });

  it('"last" is the newest FINISHED evaluation run: a newer stopped run, collection run or monitor run is passed by', async () => {
    await writeRun('run-later-col', 'My API', { '1': { status: 'passed' } }, { origin: { kind: 'collection', collectionId: 'c1' } });
    await writeRun('run-later-mon', 'Monitor · Intent', { '1': { score: 0.9 } });
    await writeRun('run-later-stopped', 'Intent', { '1': { score: 0.9 } }, { cancelled: true });
    expect(resolveRunRef(store, 'last').runId).toBe('run-b');
    for (const id of ['run-later-col', 'run-later-mon', 'run-later-stopped']) {
      store.meta.deleteRun(id);
      rmSync(store.runDir(id), { recursive: true, force: true });
    }
  });

  it('compareEvalRuns: regressions beyond the threshold, missing and new cases, passed by maxRegressions and failOnMissing', async () => {
    await writeRun('run-c', 'Intent', { '1': { score: 0.9 }, '2': { score: 0.85 }, '4': { score: 0.2 } });
    const r = await compareEvalRuns(store, { run: 'run-c', baseline: 'run-a' });
    expect(r.counts).toEqual({ regressed: 0, improved: 0, unchanged: 2, missing: 1, added: 1 });
    expect(r.passed).toBe(true);
    expect(r.missing.map((x) => x.key)).toEqual(['3']);
    expect(r.added.map((x) => x.key)).toEqual(['4']);
    expect((await compareEvalRuns(store, { run: 'run-c', baseline: 'run-a', failOnMissing: true })).passed).toBe(false);
    // 0.9 → 0.85 is a drop of exactly 0.05: unchanged at 0.05, a regression at 0.04
    const tight = await compareEvalRuns(store, { run: 'run-c', baseline: 'run-a', threshold: 0.04 });
    expect(tight.regressions.map((x) => `${x.key} ${x.baselineScore}→${x.score} ${x.delta}`)).toEqual(['2 0.9→0.85 -0.05']);
    expect(tight.passed).toBe(false);
    expect((await compareEvalRuns(store, { run: 'run-c', baseline: 'run-a', threshold: 0.04, maxRegressions: 1 })).passed).toBe(true);
    const b = await compareEvalRuns(store, { run: 'run-b', baseline: 'run-a' });
    // a lost pass first, then the biggest drop
    expect(b.regressions.map((x) => x.key)).toEqual(['3', '2']);
    expect(b.columns[0]).toMatchObject({ label: 'Intent', passRate: 0.75, regressed: 2 });
    expect(b.regressions[0]).toMatchObject({ status: 'failed', baselineStatus: 'passed', resultId: 'intent:3', baselineResultId: 'intent:3' });
    const cut = await compareEvalRuns(store, { run: 'run-b', baseline: 'run-a', limit: 1 });
    expect(cut.regressions).toHaveLength(1);
    expect(cut.truncated).toBe(true);
    await expect(compareEvalRuns(store, { run: 'run-a', baseline: 'run-a' })).rejects.toThrow(/same run/);
    await expect(compareEvalRuns(store, { run: 'run-a', baseline: 'run-a', maxRegressions: -1 })).rejects.toThrow(/whole number/);
  });

  it('the matrix is kept until a run changes; a cell opens its full result', async () => {
    const before = await evalMatrixPage(store, { runs: ['run-a', 'run-b'], baseline: 'run-c' });
    expect(before.columns.map((c) => c.runId)).toEqual(['run-a', 'run-b']);
    expect(before.cases).toBe(4);
    // the same runs named twice are one column
    expect((await evalMatrixPage(store, { runs: ['run-a', 'run-b', 'run-a'] })).columns.map((c) => c.runId)).toEqual(['run-a', 'run-b']);
    appendFileSync(join(store.runDir('run-a'), 'results.jsonl'), JSON.stringify(result('intent:9', {})) + '\n');
    const after = await evalMatrixPage(store, { runs: ['run-a', 'run-b'], baseline: 'run-c' });
    expect(after.cases).toBe(5);
    const r = await evalMatrixResult(store, 'run-b', 'intent:3');
    expect(r).toMatchObject({ id: 'intent:3', status: 'failed', output: 'output of intent:3', input: 'input of intent:3' });
    expect(await evalMatrixResult(store, 'run-b', 'intent:77')).toBeNull();
    await expect(evalMatrixResult(store, '../x', 'a')).rejects.toThrow(/Not a run id/);
  });
});

describe('dataset tags reach the cases', () => {
  it("a record's tags (a list or comma-separated) join the template's", async () => {
    const dir = join(tmp.dir, 'ds');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'd.jsonl'), '{"id":"a","input":"x","tags":["billing"," edge "]}\n{"id":"b","input":"y","tags":"refund, edge"}\n{"id":"c","input":"z"}\n');
    const cases = [];
    for await (const t of expandDataset({ name: 'E', type: 'llm', tags: ['smoke'], prompt: '{{input}}', dataset: { path: 'd.jsonl' } }, join(dir, 'x'))) cases.push(t);
    expect(cases.map((t) => t.tags)).toEqual([['smoke', 'billing', 'edge'], ['smoke', 'refund', 'edge'], ['smoke']]);
  });
});
