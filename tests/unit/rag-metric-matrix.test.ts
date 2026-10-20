/**
 * The samples × metrics matrix as a pure function over results: columns grouped by type, per-metric aggregates with a
 * seeded bootstrap interval, n/a counted apart, a lower-is-better metric, thresholds edited after the run, paging.
 */
import { describe, expect, it } from 'vitest';
import { buildMetricMatrix, type CheckResult, type TestResult } from '../../packages/core/src/index.js';

const check = (type: string, score: number | undefined, over: Partial<CheckResult> = {}): CheckResult => ({ type, name: type, passed: (score ?? 0) >= 0.5, source: 'deterministic', message: type, ...(score !== undefined ? { score } : {}), ...over });
const result = (i: number, checks: CheckResult[]): TestResult => ({ id: `r:${i}`, name: `sample ${i}`, type: 'rag', status: 'passed', startedAt: '', durationMs: 1, attempts: 1, checks, tags: i % 2 ? ['odd'] : ['even'], metadata: { rag: { query: `question ${i}` } } });
async function* gen(rs: TestResult[]) {
  yield* rs;
}

describe('buildMetricMatrix', () => {
  const rs = Array.from({ length: 40 }, (_, i) => result(i, [check('faithfulness', (i % 10) / 10, { metadata: { threshold: 0.5 } }), check('recall@k', i % 4 ? 1 : 0, { name: 'recall@5' }), check('latency', undefined)]));
  rs[3]!.checks[0] = check('faithfulness', undefined, { passed: true, metadata: { na: 'the answer makes no factual claims' } });

  it('one column per metric, grouped by type, with the mean, p10, pass rate, an interval and a distribution', async () => {
    const m = await buildMetricMatrix(gen(rs));
    expect(m.total).toBe(40);
    // the retrieval metrics come before the generation ones, the limits last
    expect(m.columns.map((c) => c.key)).toEqual(['recall@5', 'faithfulness', 'latency']);
    expect(m.groups.map((g) => g.id)).toEqual(['retrieval-ir', 'generation', 'operational']);
    const f = m.aggregates.find((a) => a.key === 'faithfulness')!;
    expect(f.n).toBe(39);
    expect(f.naCount).toBe(1);
    expect(f.mean).toBeCloseTo(0.4538, 3);
    expect(f.ci![0]).toBeLessThan(f.mean!);
    expect(f.ci![1]).toBeGreaterThan(f.mean!);
    expect(f.distribution.reduce((a, b) => a + b, 0)).toBe(39);
    expect(f.passRate).toBeGreaterThan(0.3);
    // the interval is seeded: the same input always gives the same numbers
    expect((await buildMetricMatrix(gen(rs))).aggregates.find((a) => a.key === 'faithfulness')!.ci).toEqual(f.ci);
    // a metric with no number (latency here) has no mean
    expect(m.aggregates.find((a) => a.key === 'latency')!.mean).toBeUndefined();
  });

  it('n/a is in neither the mean nor the pass rate, and the cell says why', async () => {
    const m = await buildMetricMatrix(gen(rs), { limit: 5 });
    const col = m.columns.findIndex((c) => c.key === 'faithfulness');
    expect(m.rows[3]!.cells[col]).toEqual({ na: 'the answer makes no factual claims' });
    expect(m.rows).toHaveLength(5);
    expect(m.rows[0]!.question).toBe('question 0');
  });

  it('pages, sorts by a metric (lowest first) and searches names, questions and tags', async () => {
    expect((await buildMetricMatrix(gen(rs), { offset: 38, limit: 10 })).rows.map((r) => r.id)).toEqual(['r:38', 'r:39']);
    const sorted = await buildMetricMatrix(gen(rs), { sort: 'faithfulness', limit: 3 });
    const col = sorted.columns.findIndex((c) => c.key === 'faithfulness');
    expect(sorted.rows.map((r) => r.cells[col]!.score)).toEqual([0, 0, 0]);
    expect((await buildMetricMatrix(gen(rs), { query: 'odd' })).total).toBe(20);
    expect((await buildMetricMatrix(gen(rs), { query: 'question 17' })).total).toBe(1);
  });

  it('a lower-is-better metric passes at or below its threshold', async () => {
    const lat = Array.from({ length: 4 }, (_, i) => result(i, [check('latency', 0.2 * i, { metadata: { threshold: 0.3 } })]));
    const m = await buildMetricMatrix(gen(lat));
    expect(m.columns[0]).toMatchObject({ direction: 'lower', threshold: 0.3 });
    expect(m.rows.map((r) => r.cells[0]!.passed)).toEqual([true, true, false, false]);
    // and the pass mark can be moved afterwards
    expect((await buildMetricMatrix(gen(lat), { thresholds: { latency: 0.5 } })).aggregates[0]!.passRate).toBe(0.75);
  });

  it('an empty run, and a check that is not a catalogue metric', async () => {
    expect((await buildMetricMatrix(gen([]))).columns).toEqual([]);
    const m = await buildMetricMatrix(gen([result(0, [check('my-own-check', 0.4)])]));
    expect(m.columns[0]).toMatchObject({ key: 'my-own-check', group: 'other' });
  });
});
