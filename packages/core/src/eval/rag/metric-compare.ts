/**
 * Comparing two RAG runs metric by metric (planning/rag-testing.md §4e): for every metric the two runs share, the mean of
 * each, the difference, and whether it is real: a seeded paired bootstrap over the samples both runs scored, so one
 * unlucky sample does not fail a CI job and a slow drift does not hide. Direction aware: a lower-is-better metric that went
 * up is a regression.
 */
import type { TestResult } from '../../model/types.js';
import { mean, round } from '../../util/stats.js';
import { mulberry32 } from '../../util/random.js';
import { resolveMetric } from './metric-registry.js';

export interface MetricChange {
  key: string;
  direction: 'higher' | 'lower';
  current?: number;
  baseline?: number;
  /** current − baseline, over the samples both scored. */
  delta?: number;
  /** Samples both runs scored for this metric. */
  paired: number;
  /** A 95% interval of the mean paired difference. */
  ci?: [number, number];
  /** The interval excludes 0 (needs 3 or more paired samples). */
  significant?: boolean;
  change: 'regressed' | 'improved' | 'unchanged' | 'new' | 'missing';
}

export interface MetricComparison {
  metrics: MetricChange[];
  samples: { shared: number; onlyCurrent: number; onlyBaseline: number };
  regressions: MetricChange[];
  improvements: MetricChange[];
}

type Scores = Map<string, { direction: 'higher' | 'lower'; byResult: Map<string, number> }>;

async function scoresOf(results: AsyncIterable<TestResult>): Promise<{ scores: Scores; ids: Set<string> }> {
  const scores: Scores = new Map();
  const ids = new Set<string>();
  for await (const r of results) {
    ids.add(r.id);
    for (const c of r.checks ?? []) {
      if (typeof c.score !== 'number' || !Number.isFinite(c.score) || (c.metadata as { na?: string } | undefined)?.na) continue;
      const key = c.name || c.type;
      const e = scores.get(key) ?? scores.set(key, { direction: resolveMetric(c.type)?.def.direction ?? 'higher', byResult: new Map() }).get(key)!;
      e.byResult.set(r.id, c.score);
    }
  }
  return { scores, ids };
}

export async function compareMetricRuns(current: AsyncIterable<TestResult>, baseline: AsyncIterable<TestResult>, o: { minDelta?: number } = {}): Promise<MetricComparison> {
  const minDelta = o.minDelta ?? 0.05;
  const [a, b] = [await scoresOf(current), await scoresOf(baseline)];
  const metrics: MetricChange[] = [];
  for (const key of new Set([...a.scores.keys(), ...b.scores.keys()])) {
    const cur = a.scores.get(key);
    const base = b.scores.get(key);
    const direction = cur?.direction ?? base!.direction;
    if (!cur || !base) {
      metrics.push({ key, direction, paired: 0, change: cur ? 'new' : 'missing', ...(cur ? { current: round(mean([...cur.byResult.values()]), 4) } : { baseline: round(mean([...base!.byResult.values()]), 4) }) });
      continue;
    }
    const diffs: number[] = [];
    for (const [id, v] of cur.byResult) {
      const w = base.byResult.get(id);
      if (w !== undefined) diffs.push(v - w);
    }
    const delta = diffs.length ? mean(diffs) : mean([...cur.byResult.values()]) - mean([...base.byResult.values()]);
    let ci: [number, number] | undefined;
    if (diffs.length >= 3) {
      const rnd = mulberry32(0xc0ffee + diffs.length);
      const means: number[] = [];
      const rounds = diffs.length > 2000 ? 200 : 1000;
      for (let i = 0; i < rounds; i++) {
        let s = 0;
        for (let k = 0; k < diffs.length; k++) s += diffs[Math.floor(rnd() * diffs.length)]!;
        means.push(s / diffs.length);
      }
      means.sort((x, y) => x - y);
      ci = [round(means[Math.floor(0.025 * (means.length - 1))]!, 4), round(means[Math.ceil(0.975 * (means.length - 1))]!, 4)];
    }
    const significant = ci ? ci[0] > 0 || ci[1] < 0 : undefined;
    // toward worse: negative for a higher-is-better metric, positive for a lower-is-better one
    const worse = direction === 'higher' ? -delta : delta;
    const big = Math.abs(delta) >= minDelta && significant !== false;
    metrics.push({
      key,
      direction,
      current: round(mean([...cur.byResult.values()]), 4),
      baseline: round(mean([...base.byResult.values()]), 4),
      delta: round(delta, 4),
      paired: diffs.length,
      ...(ci ? { ci, significant } : {}),
      change: !big ? 'unchanged' : worse > 0 ? 'regressed' : 'improved',
    });
  }
  const shared = [...a.ids].filter((id) => b.ids.has(id)).length;
  return {
    metrics,
    samples: { shared, onlyCurrent: a.ids.size - shared, onlyBaseline: b.ids.size - shared },
    regressions: metrics.filter((m) => m.change === 'regressed'),
    improvements: metrics.filter((m) => m.change === 'improved'),
  };
}

