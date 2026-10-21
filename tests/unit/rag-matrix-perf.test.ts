/**
 * The perf budget of the metrics matrix (planning/rag-testing.md §5.1 item 7): 5,000 samples × 40 metrics. The matrix, its
 * per-tag breakdown and its distributions (the By tag and Charts views are drawn from the same answer) are built from a
 * stream of results; the budget is loose enough for a busy machine and tight enough to catch an accidental quadratic step or a
 * copy of every cell. The e2e plan perf-large-workspace repeats it through the app's RPC.
 */
import { describe, expect, it } from 'vitest';
import { buildMetricMatrix, metricCatalogue, type CheckResult, type TestResult } from '../../packages/core/src/index.js';

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
