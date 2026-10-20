/**
 * The samples × metrics matrix of a RAG run (planning/rag-testing.md §4f): one row per sample, one column per metric, each
 * cell that metric's own score (not the mean of all checks), with the per-metric aggregates (mean, median, p10, pass rate,
 * n/a, a bootstrap 95% interval, a distribution) and the failure class of every sample. Built from the results of a run
 * as a stream; the cells are typed arrays, one per column, so 5,000 samples × 40 metrics are about 1 MB and a page of rows
 * is cut from them. A threshold can be changed after the fact: pass and fail are decided from the stored scores.
 */
import type { TestResult } from '../../model/types.js';
import { round } from '../../util/stats.js';
import { FAILURE_CLASSES, type FailureClass } from './failure.js';
import { METRIC_GROUPS, resolveMetric, type MetricGroup } from './metric-registry.js';

export interface MetricColumn {
  /** The column's key: the check’s name (`recall@5`, `faithfulness`). */
  key: string;
  /** The canonical metric id (`recall@k`, `faithfulness`), or the check type for a metric that is not in the catalogue. */
  metric: string;
  label: string;
  group: MetricGroup | 'other';
  direction: 'higher' | 'lower';
  /** The pass mark the checks used (from the first result that carries one). */
  threshold?: number;
  kind?: string;
}

export interface MatrixCell {
  /** 0..1 (or the metric’s own scale), absent when n/a or the metric gave no number. */
  score?: number;
  /** Against the (possibly edited) threshold; absent when there is no score. */
  passed?: boolean;
  /** Why it has no score (n/a): the reason. */
  na?: string;
  /** The check failed without a score (a missing input, a judge error). */
  failed?: string;
}

export interface MatrixRow {
  /** The result id (open it in the run's results). */
  id: string;
  name: string;
  question?: string;
  tags?: string[];
  status: string;
  failure?: { class: FailureClass; reason: string };
  cells: Array<MatrixCell | null>;
}

export interface ColumnAggregate {
  key: string;
  n: number;
  naCount: number;
  mean?: number;
  median?: number;
  p10?: number;
  /** Share of scored samples that pass the threshold. */
  passRate?: number;
  /** A seeded bootstrap 95% interval of the mean. */
  ci?: [number, number];
  /** Ten equal bins of 0..1 (counts). */
  distribution: number[];
}

export interface MetricMatrix {
  runId?: string;
  columns: MetricColumn[];
  rows: MatrixRow[];
  total: number;
  aggregates: ColumnAggregate[];
  /** The groups the columns fall in, in catalogue order (for the two header rows). */
  groups: Array<{ id: string; label: string; columns: number }>;
  /** How many samples fall in each failure class (failing samples only). */
  failures: Array<{ class: FailureClass; label: string; count: number }>;
}

interface Col extends MetricColumn {
  scores: Float32Array;
  /** 0 absent, 1 scored, 2 n/a, 3 failed without a score */
  state: Uint8Array;
  reasons: Map<number, string>;
}

const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const quantile = (sorted: number[], q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1) + 1e-9)))]! : undefined);

const passes = (c: MetricColumn, score: number, thresholds: Record<string, number>): boolean | undefined => {
  const t = thresholds[c.key] ?? thresholds[c.metric] ?? c.threshold;
  if (t === undefined) return undefined;
  return c.direction === 'lower' ? score <= t : score >= t;
};

export interface MatrixQuery {
  offset?: number;
  limit?: number;
  /** Edited pass marks by column key or metric id; they replace the checks' own. */
  thresholds?: Record<string, number>;
  /** Only samples of this failure class ('passed' for none). */
  failure?: string;
  /** Only samples whose name, question or tags contain this text. */
  query?: string;
  /** Sort by a column key (lowest score first) or `failure`. */
  sort?: string;
  runId?: string;
}

export async function buildMetricMatrix(results: AsyncIterable<TestResult>, q: MatrixQuery = {}): Promise<MetricMatrix> {
  const cols = new Map<string, Col>();
  const meta: Array<Omit<MatrixRow, 'cells'>> = [];
  const cap = 4096;
  // cells are collected per row first (a column can appear late) and then laid into the typed arrays
  const raw: Array<Map<string, { score?: number; na?: string; failed?: string; threshold?: number }>> = [];
  for await (const r of results) {
    const ragMeta = (r.metadata?.rag ?? {}) as { query?: string; failure?: { class: FailureClass; reason: string } };
    meta.push({ id: r.id, name: r.name, ...(ragMeta.query ? { question: ragMeta.query } : {}), ...(r.tags?.length ? { tags: r.tags } : {}), status: r.status, ...(ragMeta.failure ? { failure: { class: ragMeta.failure.class, reason: ragMeta.failure.reason } } : {}) });
    const row = new Map<string, { score?: number; na?: string; failed?: string; threshold?: number }>();
    for (const c of r.checks ?? []) {
      const key = c.name || c.type;
      const res = resolveMetric(c.type);
      if (!cols.has(key) && cols.size < cap) {
        cols.set(key, {
          key,
          metric: res?.def.id ?? c.type,
          label: key,
          group: res?.def.group ?? 'other',
          direction: res?.def.direction ?? 'higher',
          ...(res?.def.kind ? { kind: res.def.kind } : {}),
          scores: new Float32Array(0),
          state: new Uint8Array(0),
          reasons: new Map(),
        });
      }
      const m = c.metadata as { na?: string; threshold?: number } | undefined;
      const col = cols.get(key);
      if (col && col.threshold === undefined && typeof m?.threshold === 'number') col.threshold = m.threshold;
      if (col && col.threshold === undefined && res?.def.threshold !== undefined) col.threshold = res.def.threshold;
      row.set(key, typeof c.score === 'number' && Number.isFinite(c.score) && !m?.na ? { score: c.score } : m?.na ? { na: String(m.na) } : { failed: c.message });
    }
    raw.push(row);
  }
  const n = meta.length;
  for (const c of cols.values()) {
    c.scores = new Float32Array(n);
    c.state = new Uint8Array(n);
  }
  raw.forEach((row, i) => {
    for (const [key, v] of row) {
      const c = cols.get(key);
      if (!c) continue;
      if (v.score !== undefined) {
        c.scores[i] = v.score;
        c.state[i] = 1;
      } else if (v.na !== undefined) {
        c.state[i] = 2;
        c.reasons.set(i, v.na);
      } else {
        c.state[i] = 3;
        c.reasons.set(i, v.failed ?? 'failed');
      }
    }
  });
  raw.length = 0;

  const thresholds = q.thresholds ?? {};
  const order = [...cols.values()].sort((a, b) => groupRank(a.group) - groupRank(b.group));
  const columns: MetricColumn[] = order.map(({ scores: _s, state: _t, reasons: _r, ...c }) => c);
  const cell = (c: Col, i: number): MatrixCell | null => {
    const s = c.state[i];
    if (!s) return null;
    if (s === 1) {
      const score = round(c.scores[i]!, 4);
      return { score, ...(passes(c, score, thresholds) === undefined ? {} : { passed: passes(c, score, thresholds) }) };
    }
    return s === 2 ? { na: c.reasons.get(i) ?? 'n/a' } : { failed: c.reasons.get(i) ?? 'failed' };
  };

  // aggregates over every sample, whatever the page
  const aggregates: ColumnAggregate[] = order.map((c) => {
    const xs: number[] = [];
    let na = 0;
    let pass = 0;
    let judged = 0;
    for (let i = 0; i < n; i++) {
      if (c.state[i] === 1) {
        const v = round(c.scores[i]!, 4);
        xs.push(v);
        const p = passes(c, v, thresholds);
        if (p !== undefined) {
          judged++;
          if (p) pass++;
        }
      } else if (c.state[i] === 2) na++;
    }
    const dist = new Array<number>(10).fill(0);
    for (const x of xs) dist[Math.min(9, Math.max(0, Math.floor(x * 10)))]!++;
    const sorted = [...xs].sort((a, b) => a - b);
    const mean = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined;
    let ci: [number, number] | undefined;
    if (xs.length >= 3) {
      const rnd = mulberry32(0x5eed + xs.length);
      const rounds = xs.length > 2000 ? 200 : 1000;
      const means: number[] = [];
      for (let b = 0; b < rounds; b++) {
        let sum = 0;
        for (let k = 0; k < xs.length; k++) sum += xs[Math.floor(rnd() * xs.length)]!;
        means.push(sum / xs.length);
      }
      means.sort((a, b) => a - b);
      ci = [round(quantile(means, 0.025)!, 4), round(quantile(means, 0.975)!, 4)];
    }
    return {
      key: c.key,
      n: xs.length,
      naCount: na,
      ...(mean !== undefined ? { mean: round(mean, 4), median: round(quantile(sorted, 0.5)!, 4), p10: round(quantile(sorted, 0.1)!, 4) } : {}),
      ...(judged ? { passRate: round(pass / judged, 4) } : {}),
      ...(ci ? { ci } : {}),
      distribution: dist,
    };
  });

  const counts = new Map<FailureClass, number>();
  for (const m of meta) if (m.failure) counts.set(m.failure.class, (counts.get(m.failure.class) ?? 0) + 1);
  const failures = FAILURE_CLASSES.filter((f) => counts.has(f.id)).map((f) => ({ class: f.id, label: f.label, count: counts.get(f.id)! }));

  // the page: filtered, sorted, cut
  let idx = meta.map((_, i) => i);
  if (q.failure) idx = idx.filter((i) => (q.failure === 'passed' ? !meta[i]!.failure : meta[i]!.failure?.class === q.failure));
  if (q.query?.trim()) {
    const needle = q.query.trim().toLowerCase();
    idx = idx.filter((i) => `${meta[i]!.name} ${meta[i]!.question ?? ''} ${(meta[i]!.tags ?? []).join(' ')}`.toLowerCase().includes(needle));
  }
  if (q.sort === 'failure') idx.sort((a, b) => Number(!!meta[b]!.failure) - Number(!!meta[a]!.failure));
  else if (q.sort) {
    const c = cols.get(q.sort);
    if (c) idx.sort((a, b) => (c.state[a] === 1 ? c.scores[a]! : 2) - (c.state[b] === 1 ? c.scores[b]! : 2));
  }
  const offset = Math.max(0, q.offset ?? 0);
  const limit = Math.min(Math.max(1, q.limit ?? 100), 500);
  const rows: MatrixRow[] = idx.slice(offset, offset + limit).map((i) => ({ ...meta[i]!, cells: order.map((c) => cell(c, i)) }));
  const groups: MetricMatrix['groups'] = [];
  for (const c of columns) {
    const label = c.group === 'other' ? 'Other' : METRIC_GROUPS.find((g) => g.id === c.group)!.label;
    const last = groups[groups.length - 1];
    if (last && last.id === c.group) last.columns++;
    else groups.push({ id: c.group, label, columns: 1 });
  }
  return { ...(q.runId ? { runId: q.runId } : {}), columns, rows, total: idx.length, aggregates, groups, failures };
}

const groupRank = (g: string) => {
  const i = METRIC_GROUPS.findIndex((x) => x.id === g);
  return i < 0 ? 99 : i;
};

/** `--min faithfulness=0.8,recall@5=0.9`: the gates of a run as { column or metric: lowest mean }. */
export function parseGates(specs: string[] | string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of (Array.isArray(specs) ? specs : specs ? [specs] : []).flatMap((s) => s.split(','))) {
    const m = /^\s*(.+?)\s*[=:]\s*(-?[\d.]+)\s*$/.exec(part);
    if (!m) throw new Error(`A gate is metric=value (e.g. faithfulness=0.8), not "${part}"`);
    out[m[1]!] = Number(m[2]);
  }
  return out;
}

export interface GateResult {
  metric: string;
  column?: string;
  min: number;
  mean?: number;
  passed: boolean;
  why: string;
}

/** The mean of each gated metric against its minimum: a metric that has no score in the run fails its gate (it cannot be assumed to pass). */
export function checkGates(matrix: Pick<MetricMatrix, 'columns' | 'aggregates'>, gates: Record<string, number>): GateResult[] {
  return Object.entries(gates).map(([name, min]) => {
    const res = resolveMetric(name);
    const id = res?.def.id ?? name;
    const col = matrix.columns.find((c) => c.key === name) ?? matrix.columns.find((c) => c.key === id) ?? matrix.columns.find((c) => c.metric === id);
    const agg = col ? matrix.aggregates.find((a) => a.key === col.key) : undefined;
    if (!col || agg?.mean === undefined) return { metric: name, min, passed: false, why: `${name} has no score in this run (is it among the run’s metrics, and did the samples have its inputs?)` };
    const lower = col.direction === 'lower';
    const ok = lower ? agg.mean <= min : agg.mean >= min;
    return { metric: name, column: col.key, min, mean: agg.mean, passed: ok, why: `${col.key} mean ${agg.mean} ${ok ? (lower ? '≤' : '≥') : lower ? '>' : '<'} ${min}` };
  });
}
