/**
 * The perf budget of the metrics matrix (planning/rag-testing.md §5.1 item 7): 5,000 samples × 40 metrics. The matrix, its
 * per-tag breakdown and its distributions (the By tag and Charts views are drawn from the same answer) are built from a
 * stream of results; the budget is loose enough for a busy machine and tight enough to catch an accidental quadratic step or a
 * copy of every cell. The e2e plan perf-large-workspace repeats it through the app's RPC.
 */
import { describe, expect, it } from 'vitest';
import { buildMatrixBase, buildMetricMatrix, cutMatrix, matrixIntervals, metricCatalogue, type CheckResult, type TestResult } from '../../packages/core/src/index.js';

const SAMPLES = 5000;
const METRICS = 40;

// forty real metric ids, every group the catalogue has (the columns are grouped and ordered by it)
const ids = metricCatalogue()
  .filter((m) => m.kind !== 'sql' && !m.id.includes('@'))
  .slice(0, METRICS)
  .map((m) => m.id);

const check = (id: string, i: number, k: number): CheckResult => {
  const score = ((i * 31 + k * 17) % 101) / 100;
  // some n/a and some failed-without-score cells, as a real run has
  if ((i + k) % 29 === 0) return { type: id, name: id, passed: true, source: 'ai-judge', message: `${id} is n/a: the answer makes no factual claims`, metadata: { na: 'the answer makes no factual claims', metric: id } };
  return { type: id, name: id, passed: score >= 0.5, source: 'ai-judge', message: `${id} ${score}: 3 of 4 claims supported (threshold 0.5)`, score, metadata: { threshold: 0.5, metric: id, items: [{ text: 'a claim of the answer', ok: true, evidence: '[doc-1] "opens at 8am"' }] } };
};

async function* results(): AsyncGenerator<TestResult> {
  for (let i = 0; i < SAMPLES; i++)
    yield {
      id: `perf:${i}`,
      name: `sample ${i}`,
      type: 'rag',
      status: 'passed',
      startedAt: '',
      durationMs: 5,
      attempts: 1,
      checks: ids.map((id, k) => check(id, i, k)),
      tags: [`tag-${i % 12}`, i % 2 ? 'odd' : 'even'],
      metadata: { rag: { query: `question ${i}` } },
    } as TestResult;
}

describe('the metrics matrix at 5,000 samples × 40 metrics', () => {
  it('builds the matrix, the per-tag breakdown and the distributions within the budget, in bounded memory', async () => {
    expect(ids).toHaveLength(METRICS);
    const heap0 = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    const m = await buildMetricMatrix(results(), { limit: 50 });
    const ms = performance.now() - t0;
    expect(m.total).toBe(SAMPLES);
    expect(m.columns).toHaveLength(METRICS);
    expect(m.rows).toHaveLength(50);
    expect(m.aggregates).toHaveLength(METRICS);
    // the By tag view: 12 tags and 2 more, one mean per column
    expect(m.byTag.length).toBe(14);
    expect(m.byTag[0]!.means).toHaveLength(METRICS);
    // the Charts view: ten bins per metric
    expect(m.aggregates.every((a) => a.distribution.length === 10)).toBe(true);
    const grown = (process.memoryUsage().heapUsed - heap0) / 1024 / 1024;
    // 200,000 cells: the result stream is not kept
    expect(ms, `built in ${Math.round(ms)} ms`).toBeLessThan(6000);
    expect(grown, `heap grew ${Math.round(grown)} MB`).toBeLessThan(400);
  }, 60_000);

  it('moving a pass mark, sorting and searching re-cut the same matrix within the budget', async () => {
    const t0 = performance.now();
    const sorted = await buildMetricMatrix(results(), { limit: 50, sort: ids[0], thresholds: { [ids[0]!]: 0.9 }, query: 'tag-3' });
    const ms = performance.now() - t0;
    expect(sorted.total).toBe(Math.ceil((SAMPLES - 3) / 12));
    expect(ms, `re-cut in ${Math.round(ms)} ms`).toBeLessThan(8000);
  }, 60_000);
});

/*
 * Review 2, finding 4: the window cuts the same run again for every page, sort, filter and pass-mark edit. The base (the
 * typed columns, statistics, intervals and tag means) is built once; a cut is milliseconds. Counted operations are asserted
 * beside the clocks: metric lookups per build, bootstrap draws per cut.
 */
describe('the matrix at 5,000 samples × 84 metrics: one build, many cuts', () => {
  const COLS = 84;
  const types = metricCatalogue()
    .filter((m) => m.kind !== 'sql' && !m.id.includes('@'))
    .map((m) => m.id);
  const all: TestResult[] = [];
  const bestOf = async <T,>(n: number, f: () => Promise<T> | T) => {
    let best = Infinity;
    let out!: T;
    for (let k = 0; k < n; k++) {
      const t0 = performance.now();
      out = await f();
      best = Math.min(best, performance.now() - t0);
    }
    return { ms: best, out };
  };
  async function* stream(): AsyncGenerator<TestResult> {
    for (const r of all) yield r;
  }
  it('has 84 columns of real metric types (a column repeats a type under another name when the catalogue is shorter)', () => {
    for (let i = 0; i < SAMPLES; i++)
      all.push({
        id: `perf:${i}`,
        name: `sample ${i}`,
        type: 'rag',
        status: 'passed',
        startedAt: '',
        durationMs: 5,
        attempts: 1,
        checks: Array.from({ length: COLS }, (_, k) => {
          const c = check(types[k % types.length]!, i, k);
          return { ...c, name: k < types.length ? c.name : `${c.name}#${k}` };
        }),
        tags: [`tag-${i % 12}`, i % 2 ? 'odd' : 'even'],
        metadata: { rag: { query: `question ${i}` } },
      } as TestResult);
    expect(all[0]!.checks).toHaveLength(COLS);
  });

  it('the first build is under 700 ms and looks each metric type up once, not once per cell', async () => {
    const { ms, out: base } = await bestOf(3, () => buildMatrixBase(stream()));
    expect(base.n).toBe(SAMPLES);
    expect(base.columns).toHaveLength(COLS);
    // 420,000 cells used to be 420,000 lookups
    expect(base.work.resolves, 'metric lookups').toBeLessThanOrEqual(Math.min(types.length, COLS));
    expect(ms, `first build ${Math.round(ms)} ms`).toBeLessThan(700);
    console.log(`matrix first build (best of 3): ${Math.round(ms)} ms, ${base.work.resolves} metric lookups`);
  }, 60_000);

  it('page, sort, filter and pass-mark edits are under 100 ms each after the first build, and compute no interval', async () => {
    const base = await buildMatrixBase(stream());
    const key = base.columns[0]!.key;
    const cuts: Array<[string, () => unknown]> = [
      ['page', () => cutMatrix(base, { offset: 100, limit: 100, ci: false })],
      ['sort', () => cutMatrix(base, { sort: key, limit: 100, ci: false })],
      ['filter', () => cutMatrix(base, { query: 'tag-3', limit: 100, ci: false })],
      ['pass mark', () => cutMatrix(base, { thresholds: { [key]: 0.9 }, limit: 100, ci: false })],
    ];
    for (const [what, f] of cuts) {
      const { ms } = await bestOf(5, f);
      console.log(`matrix ${what} (best of 5): ${ms.toFixed(1)} ms`);
      expect(ms, `${what} ${ms.toFixed(1)} ms`).toBeLessThan(100);
    }
    expect(base.work.bootstrapDraws, 'bootstrap draws while cutting').toBe(0);
  }, 60_000);

  it('an interval is computed once per column, for the columns asked for, and the same cut answers it from then on', async () => {
    const base = await buildMatrixBase(stream());
    const keys = base.columns.slice(0, 3).map((c) => c.key);
    const first = matrixIntervals(base, keys);
    expect(Object.keys(first)).toEqual(keys);
    // 200 rounds over the scored samples of each column (above 2,000 samples), three columns
    const draws = base.work.bootstrapDraws;
    expect(draws).toBeGreaterThan(0);
    expect(draws).toBeLessThanOrEqual(3 * 200 * SAMPLES);
    expect(matrixIntervals(base, keys)).toEqual(first);
    expect(cutMatrix(base, { limit: 1 }).aggregates.find((a) => a.key === keys[0])!.ci).toEqual(first[keys[0]!]);
    // asking again, or cutting, drew nothing more for those three (the cut above drew the other 81 once)
    const before = base.work.bootstrapDraws;
    cutMatrix(base, { limit: 1 });
    expect(base.work.bootstrapDraws).toBe(before);
  }, 60_000);

  it('the cut equals the one-call build (same numbers, same intervals)', async () => {
    const q = { limit: 20, sort: ids[0], thresholds: { [ids[0]!]: 0.6 } };
    const base = await buildMatrixBase(stream());
    const a = cutMatrix(base, q);
    const b = await buildMetricMatrix(stream(), q);
    expect(a).toEqual(b);
  }, 60_000);
});
