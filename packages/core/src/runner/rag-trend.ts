/**
 * The trend of RAG metric means across the runs of an evaluation (`testpion rag trend`, MCP `rag_trend`, the chart in the
 * window): one point per run, built from each run's metric matrix. A run's means are cached beside its results
 * (runs/<id>/rag-means.json) under the results file's size and modification time, so a trend over 30 runs of thousands of samples
 * reads each run once. It lives in runner/ because it reads runs; the arithmetic is eval/rag/trend.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ApsError } from '../errors.js';
import { analyzeTrend, type TrendFinding, type TrendMetric, type TrendPoint } from '../eval/rag/trend/analyze.js';
import { buildMetricMatrix } from '../eval/rag/metric-matrix.js';
import { resolveMetric } from '../eval/rag/metric-registry.js';
import { atomicWrite, readJson } from '../storage/fsutil.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { runResults, runResultsFile } from './run-results.js';
import { findSavedEvaluation, listSavedEvaluations } from './saved-evaluations.js';
import { MONITOR_RUN_PREFIX } from './result-source.js';

export interface RagTrendQuery {
  /** A saved evaluation (id or name): its runs, and the runs of a monitor of that evaluation. */
  evaluation?: string;
  /** Or these runs. */
  runIds?: string[];
  /** Only these metrics (names or aliases). */
  metrics?: string[];
  /** The most recent runs (default 30, at most 200). */
  runs?: number;
  /** Only runs since this ISO date or day. */
  since?: string;
  minDelta?: number;
}

export interface RagTrend {
  evaluation?: string;
  points: TrendPoint[];
  findings: TrendFinding[];
}

interface Cached {
  key: string;
  judge?: string;
  versions?: string;
  n: number;
  metrics: Record<string, TrendMetric>;
}

const cacheFile = (store: Pick<WorkspaceStore, 'runDir'>, id: string) => join(store.runDir(id), 'rag-means.json');

/** The cache key of a run: any change to its results file changes it. */
function keyOf(store: Pick<WorkspaceStore, 'runDir'>, id: string): string | undefined {
  const f = runResultsFile(store, id);
  if (!existsSync(f)) return undefined;
  const st = statSync(f);
  return `${st.size}:${Math.round(st.mtimeMs)}`;
}

/** The judge and wording versions of a run: from the first judged checks (a run uses one judge). */
async function judgeOf(store: Pick<WorkspaceStore, 'runDir'>, id: string): Promise<{ judge?: string; versions?: string }> {
  const versions = new Set<string>();
  let judge: string | undefined;
  let seen = 0;
  for await (const r of runResults(store, id)) {
    for (const c of r.checks ?? []) {
      const md = (c.metadata ?? {}) as { judge?: { provider?: string; model?: string }; promptVersion?: string };
      if (md.judge?.model) judge ??= `${md.judge.provider ?? '?'}/${md.judge.model}`;
      if (md.promptVersion) versions.add(`${c.name || c.type}@${md.promptVersion}`);
    }
    if (++seen >= 20) break;
  }
  return { ...(judge ? { judge } : {}), ...(versions.size ? { versions: [...versions].sort().join(',') } : {}) };
}

async function pointOf(store: WorkspaceStore, run: { id: string; name: string; startedAt: string }, o: { cacheOnly?: boolean } = {}): Promise<TrendPoint | undefined> {
  const key = keyOf(store, run.id);
  if (!key) return undefined;
  let c: Cached | undefined;
  try {
    c = readJson<Cached>(cacheFile(store, run.id));
  } catch {
    /* no cache yet, or an unreadable one: built again */
  }
  if ((!c || c.key !== key) && o.cacheOnly) return undefined;
  if (!c || c.key !== key) {
    const m = await buildMetricMatrix(runResults(store, run.id), { runId: run.id, limit: 1 });
    if (!m.total) return undefined;
    const metrics: Record<string, TrendMetric> = {};
    for (const a of m.aggregates) metrics[a.key] = { ...(a.mean !== undefined ? { mean: a.mean } : {}), ...(a.ci ? { ci: a.ci } : {}), ...(a.passRate !== undefined ? { passRate: a.passRate } : {}), n: a.n, naCount: a.naCount };
    c = { key, n: m.total, metrics, ...(await judgeOf(store, run.id)) };
    try {
      atomicWrite(cacheFile(store, run.id), JSON.stringify(c));
    } catch {
      /* a cache that cannot be written is only slower */
    }
  }
  return { runId: run.id, name: run.name, at: run.startedAt, n: c.n, ...(c.judge ? { judge: c.judge } : {}), ...(c.versions ? { versions: c.versions } : {}), metrics: c.metrics };
}

export async function ragTrend(store: WorkspaceStore, q: RagTrendQuery): Promise<RagTrend> {
  const limit = Math.min(Math.max(q.runs ?? 30, 1), 200);
  let name: string | undefined;
  if (q.evaluation) {
    // an evaluation that is not saved (a draft run in the window, one deleted since) still has runs under its name
    try {
      name = findSavedEvaluation(store, q.evaluation).name;
    } catch {
      name = q.evaluation;
    }
  }
  else if (!q.runIds?.length) throw new ApsError('ValidationError', 'Name an evaluation, or the runs to follow');
  const wanted = q.runIds ? new Set(q.runIds) : undefined;
  const since = q.since ? Date.parse(q.since) : undefined;
  if (q.since && !Number.isFinite(since)) throw new ApsError('ValidationError', `"${q.since}" is not a date (2026-10-01 or an ISO time)`);
  const keep = q.metrics?.length ? new Set(q.metrics.map((m) => resolveMetric(m)?.def.id ?? m)) : undefined;
  const all = store.meta.listRuns({ limit: 400 }).items;
  const runs = all.filter((r) => (wanted ? wanted.has(r.id) : r.name === name || r.name === `${MONITOR_RUN_PREFIX}${name}`)).filter((r) => since === undefined || Date.parse(r.startedAt) >= since);
  const points: TrendPoint[] = [];
  // newest first from the store; the line reads oldest to newest
  for (const r of runs.slice(0, limit)) {
    const p = await pointOf(store, r);
    if (p) points.push(p);
  }
  points.reverse();
  const lower = new Set(points.flatMap((p) => Object.keys(p.metrics)).filter((k) => resolveMetric(k)?.def.direction === 'lower'));
  const a = analyzeTrend(points, { minDelta: q.minDelta, lower });
  const filter = (p: TrendPoint): TrendPoint => (keep ? { ...p, metrics: Object.fromEntries(Object.entries(p.metrics).filter(([k]) => keep.has(k) || keep.has(resolveMetric(k)?.def.id ?? k))) } : p);
  return { ...(name ? { evaluation: name } : {}), points: a.points.map(filter), findings: keep ? a.findings.filter((f) => keep.has(f.metric) || keep.has(resolveMetric(f.metric)?.def.id ?? f.metric)) : a.findings };
}

/**
 * Metrics of saved RAG evaluations whose newest run got worse against the runs before it, for "Needs attention". It reads only
 * the cached means (a trend is cached whenever it is looked at and after every monitor run), so the Problems list never scans
 * the results of big runs; an evaluation with fewer than 3 cached runs says nothing.
 */
export async function ragTrendFindings(store: WorkspaceStore): Promise<Array<{ evaluation: string; finding: TrendFinding }>> {
  const out: Array<{ evaluation: string; finding: TrendFinding }> = [];
  const all = store.meta.listRuns({ limit: 200 }).items;
  for (const ev of listSavedEvaluations(store).filter((e) => e.type === 'rag')) {
    const runs = all.filter((r) => r.name === ev.name || r.name === `${MONITOR_RUN_PREFIX}${ev.name}`).slice(0, 5);
    const points: TrendPoint[] = [];
    for (const r of runs) {
      const p = await pointOf(store, r, { cacheOnly: true });
      if (!p) break;
      points.push(p);
    }
    if (points.length < 3) continue;
    points.reverse();
    const lower = new Set(points.flatMap((p) => Object.keys(p.metrics)).filter((k) => resolveMetric(k)?.def.direction === 'lower'));
    for (const finding of analyzeTrend(points, { lower }).findings) if (finding.worse) out.push({ evaluation: ev.name, finding });
  }
  return out;
}
