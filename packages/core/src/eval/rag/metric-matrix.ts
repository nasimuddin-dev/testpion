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
import { matchExternal, type ExternalScores } from './ragas-io.js';

export interface MetricColumn {
  /** The column's key: the check’s name (`recall@5`, `faithfulness`). */
  key: string;
  /** The canonical metric id (`recall@k`, `faithfulness`), or the check type for a metric that is not in the catalogue. */
  metric: string;
  label: string;
  group: MetricGroup | 'other' | 'external';
  direction: 'higher' | 'lower';
  /** The pass mark the checks used (from the first result that carries one). */
  threshold?: number;
  kind?: string;
  /** The scores came from another tool's result table (Ragas), not from this run. */
  external?: { source: string; column: string };
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
  /** The mean of every column per tag of the dataset records (at most 50 tags, the biggest first): `means` is in the order of `columns`. */
  byTag: Array<{ tag: string; n: number; means: Array<number | null> }>;
}

export interface MatrixColumnData extends MetricColumn {
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
  /** Every row, not a page (an export). */
  all?: boolean;
  /** `false`: leave the 95% intervals out (a window asks for the visible columns' with `matrixIntervals`). Default: every column's. */
  ci?: boolean;
  /** Scores of another tool for the same samples (a Ragas result table), shown as columns beside this run's. */
  external?: ExternalScores;
}

/**
 * Everything about a run that does not depend on the page, the sort, the filter or the pass marks: the typed columns, the
 * rows' metadata and (computed once, when first asked) each column's statistics, intervals and the per-tag means. A host that
 * answers many cuts of one run (the window pages, sorts, filters and edits pass marks) builds this once and calls
 * `cutMatrix` for each; `buildMetricMatrix` is both in one call.
 */
export interface MatrixBase {
  readonly n: number;
  readonly meta: Array<Omit<MatrixRow, 'cells'>>;
  /** The columns in display order. */
  readonly order: MatrixColumnData[];
  readonly columns: MetricColumn[];
  readonly groups: MetricMatrix['groups'];
  readonly failures: MetricMatrix['failures'];
  /** Work counters, for tests and profiling: metric lookups made while building, bootstrap draws made so far. */
  readonly work: { resolves: number; bootstrapDraws: number };
  /** @internal memoised per column */
  readonly stats: Map<string, ColStats>;
  /** @internal */
  byTag?: MetricMatrix['byTag'];
  /** @internal */
  readonly cols: Map<string, MatrixColumnData>;
}

/** What a column's scores say, whatever the pass mark: sorted values are not kept, only what the cuts read. */
interface ColStats {
  /** The scored values, rounded as they are shown. */
  xs: Float64Array;
  na: number;
  mean?: number;
  median?: number;
  p10?: number;
  distribution: number[];
  ci?: [number, number] | null;
}

export async function buildMatrixBase(results: AsyncIterable<TestResult>, q: { external?: ExternalScores } = {}): Promise<MatrixBase> {
  const cols = new Map<string, MatrixColumnData>();
  const meta: Array<Omit<MatrixRow, 'cells'>> = [];
  const cap = 4096;
  const work = { resolves: 0, bootstrapDraws: 0 };
  // a check type is looked up in the catalogue once, not once per cell (84 metrics × 5,000 samples was 420,000 lookups)
  const resolved = new Map<string, ReturnType<typeof resolveMetric>>();
  const resolve = (type: string) => {
    if (!resolved.has(type)) {
      work.resolves++;
      resolved.set(type, resolveMetric(type));
    }
    return resolved.get(type);
  };
  // cells are collected per row first (a column can appear late) and then laid into the typed arrays
  const raw: Array<Map<string, { score?: number; na?: string; failed?: string; threshold?: number }>> = [];
  for await (const r of results) {
    const ragMeta = (r.metadata?.rag ?? {}) as { query?: string; failure?: { class: FailureClass; reason: string } };
    meta.push({ id: r.id, name: r.name, ...(ragMeta.query ? { question: ragMeta.query } : {}), ...(r.tags?.length ? { tags: r.tags } : {}), status: r.status, ...(ragMeta.failure ? { failure: { class: ragMeta.failure.class, reason: ragMeta.failure.reason } } : {}) });
    const row = new Map<string, { score?: number; na?: string; failed?: string; threshold?: number }>();
    for (const c of r.checks ?? []) {
      const key = c.name || c.type;
      const res = resolve(c.type);
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

  // another tool's scores for the same samples: each metric column of the table, matched to the samples by the question
  if (q.external) {
    const at = matchExternal(meta.map((m) => m.question), q.external);
    for (const name of q.external.metrics) {
      const hit = resolve(name);
      const key = `${name} (${q.external.source})`;
      if (cols.has(key)) continue;
      const c: MatrixColumnData = {
        key,
        metric: hit?.def.id ?? name,
        label: key,
        group: 'external',
        direction: hit?.def.direction ?? 'higher',
        ...(hit?.def.threshold !== undefined ? { threshold: hit.def.threshold } : {}),
        external: { source: q.external.source, column: name },
        scores: new Float32Array(n),
        state: new Uint8Array(n),
        reasons: new Map(),
      };
      at.forEach((row, i) => {
        const v = row === undefined ? undefined : q.external!.rows[row]!.scores[name];
        if (v === undefined) return;
        if (v === null) {
          c.state[i] = 2;
          c.reasons.set(i, `${q.external!.source} gave no score (NaN)`);
        } else {
          c.scores[i] = v;
          c.state[i] = 1;
        }
      });
      cols.set(key, c);
    }
  }

  const order = [...cols.values()].sort((a, b) => groupRank(a.group) - groupRank(b.group));
  const columns: MetricColumn[] = order.map(({ scores: _s, state: _t, reasons: _r, ...c }) => c);
  const counts = new Map<FailureClass, number>();
  for (const m of meta) if (m.failure) counts.set(m.failure.class, (counts.get(m.failure.class) ?? 0) + 1);
  const failures = FAILURE_CLASSES.filter((f) => counts.has(f.id)).map((f) => ({ class: f.id, label: f.label, count: counts.get(f.id)! }));
  const groups: MetricMatrix['groups'] = [];
  for (const c of columns) {
    const label = c.group === 'other' ? 'Other' : c.group === 'external' ? `Scores of ${c.external?.source ?? 'another tool'}` : METRIC_GROUPS.find((g) => g.id === c.group)!.label;
    const last = groups[groups.length - 1];
    if (last && last.id === c.group) last.columns++;
    else groups.push({ id: c.group, label, columns: 1 });
  }
  return { n, meta, order, columns, groups, failures, work, stats: new Map(), cols };
}

/** The statistics of a column that do not depend on a pass mark (computed once per column of a base). */
function statsOf(base: MatrixBase, c: MatrixColumnData): ColStats {
  const hit = base.stats.get(c.key);
  if (hit) return hit;
  const scored: number[] = [];
  let na = 0;
  for (let i = 0; i < base.n; i++) {
    if (c.state[i] === 1) scored.push(round(c.scores[i]!, 4));
    else if (c.state[i] === 2) na++;
  }
  const distribution = new Array<number>(10).fill(0);
  for (const x of scored) distribution[Math.min(9, Math.max(0, Math.floor(x * 10)))]!++;
  const xs = Float64Array.from(scored);
  const sorted = Float64Array.from(xs).sort();
  const q = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1) + 1e-9)))]! : undefined);
  const mean = xs.length ? scored.reduce((a, b) => a + b, 0) / xs.length : undefined;
  const s: ColStats = { xs, na, distribution, ...(mean !== undefined ? { mean: round(mean, 4), median: round(q(0.5)!, 4), p10: round(q(0.1)!, 4) } : {}) };
  base.stats.set(c.key, s);
  return s;
}

/**
 * The seeded bootstrap 95% interval of a column's mean, computed on the first ask and kept. The rounds shrink as the samples
 * grow (1,000 up to 2,000 samples, then 200, never more than about 2 million draws a column), so asking for every column of a
 * big run is never the cost of showing one page.
 */
function intervalOf(base: MatrixBase, c: MatrixColumnData): [number, number] | undefined {
  const s = statsOf(base, c);
  if (s.ci !== undefined) return s.ci ?? undefined;
  const xs = s.xs;
  if (xs.length < 3) return void (s.ci = null);
  const rnd = mulberry32(0x5eed + xs.length);
  const rounds = xs.length > 2000 ? 200 : 1000;
  const means = new Float64Array(rounds);
  for (let b = 0; b < rounds; b++) {
    let sum = 0;
    for (let k = 0; k < xs.length; k++) sum += xs[Math.floor(rnd() * xs.length)]!;
    means[b] = sum / xs.length;
  }
  base.work.bootstrapDraws += rounds * xs.length;
  means.sort();
  const sorted = Array.from(means);
  s.ci = [round(quantile(sorted, 0.025)!, 4), round(quantile(sorted, 0.975)!, 4)];
  return s.ci;
}

/** The 95% intervals of some columns (by key), for a window that shows the first page without them and asks for the visible columns. */
export function matrixIntervals(base: MatrixBase, keys: string[]): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  for (const key of keys) {
    const c = base.cols.get(key);
    const ci = c ? intervalOf(base, c) : undefined;
    if (ci) out[key] = ci;
  }
  return out;
}

/** One cut of a base: the pass marks, the filter, the sort and the page applied. Cheap: nothing is read from disk or recomputed but what a pass mark changes. */
export function cutMatrix(base: MatrixBase, q: MatrixQuery = {}): MetricMatrix {
  const { meta, order, columns, groups, failures } = base;
  const n = base.n;
  const thresholds = q.thresholds ?? {};
  const cell = (c: MatrixColumnData, i: number): MatrixCell | null => {
    const s = c.state[i];
    if (!s) return null;
    if (s === 1) {
      const score = round(c.scores[i]!, 4);
      return { score, ...(passes(c, score, thresholds) === undefined ? {} : { passed: passes(c, score, thresholds) }) };
    }
    return s === 2 ? { na: c.reasons.get(i) ?? 'n/a' } : { failed: c.reasons.get(i) ?? 'failed' };
  };

  // aggregates over every sample, whatever the page; only the pass rate depends on the (edited) pass marks
  const withCi = q.ci !== false;
  const aggregates: ColumnAggregate[] = order.map((c) => {
    const s = statsOf(base, c);
    let pass = 0;
    let judged = 0;
    for (let k = 0; k < s.xs.length; k++) {
      const p = passes(c, s.xs[k]!, thresholds);
      if (p !== undefined) {
        judged++;
        if (p) pass++;
      }
    }
    const ci = withCi ? intervalOf(base, c) : undefined;
    return {
      key: c.key,
      n: s.xs.length,
      naCount: s.na,
      ...(s.mean !== undefined ? { mean: s.mean, median: s.median, p10: s.p10 } : {}),
      ...(judged ? { passRate: round(pass / judged, 4) } : {}),
      ...(ci ? { ci } : {}),
      distribution: s.distribution,
    };
  });

  // the page: filtered, sorted, cut
  let idx = meta.map((_, i) => i);
  if (q.failure) idx = idx.filter((i) => (q.failure === 'passed' ? !meta[i]!.failure : meta[i]!.failure?.class === q.failure));
  if (q.query?.trim()) {
    const needle = q.query.trim().toLowerCase();
    idx = idx.filter((i) => `${meta[i]!.name} ${meta[i]!.question ?? ''} ${(meta[i]!.tags ?? []).join(' ')}`.toLowerCase().includes(needle));
  }
  if (q.sort === 'failure') idx.sort((a, b) => Number(!!meta[b]!.failure) - Number(!!meta[a]!.failure));
  else if (q.sort) {
    const c = base.cols.get(q.sort);
    if (c) idx.sort((a, b) => (c.state[a] === 1 ? c.scores[a]! : 2) - (c.state[b] === 1 ? c.scores[b]! : 2));
  }
  const offset = Math.max(0, q.offset ?? 0);
  const limit = q.all ? Math.max(1, idx.length) : Math.min(Math.max(1, q.limit ?? 100), 500);
  const rows: MatrixRow[] = idx.slice(offset, offset + limit).map((i) => ({ ...meta[i]!, cells: order.map((c) => cell(c, i)) }));
  return { ...(q.runId ? { runId: q.runId } : {}), columns, rows, total: idx.length, aggregates, groups, failures, byTag: byTagOf(base) };
}

/** The mean of every column per tag, the biggest tags first (independent of pass marks, so computed once). */
function byTagOf(base: MatrixBase): MetricMatrix['byTag'] {
  if (base.byTag) return base.byTag;
  const tagRows = new Map<string, number[]>();
  base.meta.forEach((m, i) => {
    for (const t of m.tags ?? []) {
      const list = tagRows.get(t);
      if (list) list.push(i);
      else tagRows.set(t, [i]);
    }
  });
  base.byTag = [...tagRows.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, 50)
    .map(([tag, rowsOfTag]) => ({
      tag,
      n: rowsOfTag.length,
      means: base.order.map((c) => {
        let sum = 0;
        let count = 0;
        for (const i of rowsOfTag) if (c.state[i] === 1) (sum += c.scores[i]!), count++;
        return count ? round(sum / count, 4) : null;
      }),
    }));
  return base.byTag;
}

export async function buildMetricMatrix(results: AsyncIterable<TestResult>, q: MatrixQuery = {}): Promise<MetricMatrix> {
  return cutMatrix(await buildMatrixBase(results, { external: q.external }), q);
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
