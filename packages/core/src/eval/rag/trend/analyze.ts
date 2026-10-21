/**
 * The trend of RAG metric means across the runs of an evaluation (planning/rag-testing.md R4): pure functions over points that
 * runner/rag-trend.ts reads from the runs. A step in a line is only a regression when nothing about the measuring changed, so a
 * run whose judge model or metric versions differ from the run before is flagged `judgeChanged` and is never reported as a drop.
 */
import { median, round } from '../../../util/stats.js';

export interface TrendMetric {
  mean?: number;
  ci?: [number, number];
  passRate?: number;
  n: number;
  naCount: number;
}

export interface TrendPoint {
  runId: string;
  name: string;
  at: string;
  /** Samples in the run. */
  n: number;
  /** The judge that scored it (`provider/model`), when a judged metric ran. */
  judge?: string;
  /** The prompt versions of the judged metrics, joined: a change of wording changes the measure. */
  versions?: string;
  /** The judge or a metric version differs from the run before: a step here is not a regression of the system. */
  judgeChanged?: boolean;
  metrics: Record<string, TrendMetric>;
}

export interface TrendFinding {
  metric: string;
  /** `dropped` / `rose`: against the median of the previous runs; the run it is about is the newest point of the metric. */
  change: 'dropped' | 'rose';
  runId: string;
  from: number;
  to: number;
  delta: number;
  /** Runs in the comparison (up to 3 before it). */
  against: number;
  /** The newest run's interval excludes the median: the move is more than noise. */
  beyondInterval: boolean;
  /** The move is toward worse (a higher-is-better metric fell, a lower-is-better one rose). */
  worse: boolean;
  text: string;
}


/** The pass marks of a lower-is-better metric are read the other way: the caller names those. */
export interface TrendOptions {
  /** The smallest move that counts, when the interval does not decide it (default 0.05). */
  minDelta?: number;
  /** Metrics where a lower mean is better (hallucination, latency, cost …). */
  lower?: ReadonlySet<string>;
}

/**
 * Marks each point `judgeChanged` when its judge or metric versions differ from the previous point's, and names the metrics
 * whose newest mean moved more than its interval (or `minDelta`) against the median of the 3 runs before it. Runs measured
 * differently are left out of that median, so a new judge cannot hide or cause a finding.
 */
export function analyzeTrend(points: TrendPoint[], o: TrendOptions = {}): { points: TrendPoint[]; findings: TrendFinding[] } {
  const minDelta = o.minDelta ?? 0.05;
  const marked = points.map((p, i) => {
    const prev = points[i - 1];
    const changed = !!prev && ((prev.judge ?? '') !== (p.judge ?? '') || (prev.versions ?? '') !== (p.versions ?? ''));
    return { ...p, ...(changed ? { judgeChanged: true } : {}) };
  });
  const findings: TrendFinding[] = [];
  const last = marked[marked.length - 1];
  if (!last || last.judgeChanged) return { points: marked, findings };
  for (const [metric, m] of Object.entries(last.metrics)) {
    if (m.mean === undefined) continue;
    // the runs before it measured the same way (back to the last change of judge or wording)
    const before: number[] = [];
    for (let i = marked.length - 2; i >= 0 && before.length < 3; i--) {
      const v = marked[i]!.metrics[metric]?.mean;
      if (v !== undefined) before.push(v);
      if (marked[i]!.judgeChanged) break;
    }
    if (!before.length) continue;
    const base = median(before);
    const delta = m.mean - base;
    const lowerBetter = o.lower?.has(metric) === true;
    const beyond = !!m.ci && (base < m.ci[0] || base > m.ci[1]);
    // outside the interval counts from half of minDelta, so a tight interval does not turn a tiny move into news
    if (!(Math.abs(delta) > minDelta || (beyond && Math.abs(delta) >= minDelta / 2))) continue;
    const bad = lowerBetter ? delta > 0 : delta < 0;
    const f: TrendFinding = {
      metric,
      change: delta < 0 ? 'dropped' : 'rose',
      runId: last.runId,
      from: round(base, 3),
      to: round(m.mean, 3),
      delta: round(delta, 3),
      against: before.length,
      beyondInterval: beyond,
      worse: bad,
      text: `${metric} ${delta < 0 ? 'dropped' : 'rose'} ${Math.abs(round(delta, 3))} over ${before.length} run${before.length === 1 ? '' : 's'} (${round(base, 3)} to ${round(m.mean, 3)})${bad ? '' : ', in the good direction'}`,
    };
    findings.push(f);
  }
  return { points: marked, findings };
}

/** The metric keys in the points, the most-measured first (the chart's lines). */
export function trendMetricKeys(points: TrendPoint[]): string[] {
  const n = new Map<string, number>();
  for (const p of points) for (const [k, m] of Object.entries(p.metrics)) if (m.mean !== undefined) n.set(k, (n.get(k) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
}

const cell = (v: number | undefined) => (v === undefined ? '' : String(round(v, 4)));
const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** A CSV with a row per run and a column per metric mean (and its lower and upper bound when the run has an interval). */
export function trendCsv(points: TrendPoint[], keys = trendMetricKeys(points)): string {
  const head = ['run', 'at', 'samples', 'judge', 'judge_changed', ...keys.flatMap((k) => [k, `${k}_low`, `${k}_high`])];
  const rows = points.map((p) => [p.runId, p.at, String(p.n), p.judge ?? '', p.judgeChanged ? 'yes' : '', ...keys.flatMap((k) => [cell(p.metrics[k]?.mean), cell(p.metrics[k]?.ci?.[0]), cell(p.metrics[k]?.ci?.[1])])]);
  return [head, ...rows].map((r) => r.map(q).join(',')).join('\n') + '\n';
}

/** The table the terminal prints: a row per run (oldest first), a column per metric. */
export function trendTable(points: TrendPoint[], keys = trendMetricKeys(points)): string {
  const w = (s: string, n: number) => s.padEnd(n);
  const head = [w('run', 28), w('at', 17), ...keys.map((k) => k.slice(0, 16).padStart(16))];
  const lines = points.map((p) => [w(p.runId.slice(0, 27), 28), w(p.at.slice(0, 16).replace('T', ' '), 17), ...keys.map((k) => `${cell(p.metrics[k]?.mean)}${p.judgeChanged ? '*' : ''}`.padStart(16))].join(' '));
  const note = points.some((p) => p.judgeChanged) ? '\n* the judge or a metric version changed since the run before: not comparable' : '';
  return [head.join(' '), ...lines].join('\n') + note;
}
