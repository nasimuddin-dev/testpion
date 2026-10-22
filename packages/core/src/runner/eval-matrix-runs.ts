/**
 * The evaluation matrix over a workspace's runs: runs named by id, "last" or name, the matrix built once and kept (a
 * page, a filter or a sort reads the kept one), a cell's full result, and the comparison of a run with a baseline run
 * that `testpion eval compare`, the eval_compare MCP tool and the app share.
 */
import { existsSync, statSync } from 'node:fs';
import { fileLines } from '../util/file-lines.js';
import type { RunSummary, TestResult } from '../model/types.js';
import { isMonitorRun, latestFinishedRun } from './result-source.js';
import { EVALUATIONS_LIBRARY } from './saved-evaluations.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { ApsError } from '../errors.js';
import { buildEvalMatrix, evalThreshold, type EvalMatrix, type EvalMatrixColumn, type EvalMatrixPage, type EvalMatrixQuery } from '../eval/matrix.js';
import { readRunSummary } from './run-records.js';
import { runResults, runResultsFile, runReviews } from './run-results.js';

type Store = Pick<WorkspaceStore, 'root' | 'runDir' | 'meta'>;

/** An evaluation's run: it has scored checks, or carries a saved evaluation's name (a monitor's or a collection run never). */
function isEvaluationRun(store: Store, s: RunSummary): boolean {
  if (isMonitorRun(s) || s.origin?.kind === 'collection') return false;
  if (Object.keys(s.scores ?? {}).length) return true;
  const lib = (store as Partial<Pick<WorkspaceStore, 'getLibrary'>>).getLibrary;
  if (!lib) return false;
  try {
    return lib.call(store, EVALUATIONS_LIBRARY).items.some((i) => i.name === s.name);
  } catch {
    return false;
  }
}

/**
 * A finished run by its id, "last" (the newest run), or its name (the newest run of that name, case-insensitive, e.g.
 * a saved evaluation's). A run that is still running or never finished has no summary and is refused.
 */
export function resolveRunRef(store: Store, ref: string): { runId: string; name: string; startedAt: string } {
  const r = String(ref ?? '').trim();
  if (!r) throw new ApsError('ValidationError', 'Name a run: its id, "last" or its name');
  const finished = (id: string) => {
    const s = readRunSummary(store, id);
    return s ? { runId: s.runId || id, name: s.name, startedAt: s.startedAt } : undefined;
  };
  if (r.toLowerCase() === 'last') {
    // the newest finished evaluation: a run of a saved evaluation, or one with scored checks (not a collection run, a
    // monitor's or a run still going / stopped)
    const s = latestFinishedRun(store, (x) => isEvaluationRun(store, x));
    if (!s) throw new ApsError('ConfigurationError', store.meta.listRuns({ limit: 1 }).items.length ? 'No finished evaluation run yet' : 'There are no runs yet');
    return { runId: s.runId, name: s.name, startedAt: s.startedAt };
  }
  // an id: a folder name, never a path
  if (/^[\w.-]+$/.test(r) && !r.startsWith('.') && existsSync(store.runDir(r))) {
    const s = finished(r);
    if (s) return s;
    throw new ApsError('ConfigurationError', `Run ${r} has not finished (or was interrupted): it has no summary`);
  }
  const lower = r.toLowerCase();
  const hit = store.meta.listRuns({ query: r, limit: 200 }).items.find((x) => x.name.toLowerCase() === lower);
  if (hit) {
    const s = finished(hit.id);
    if (s) return s;
  }
  const recent = [...new Set(store.meta.listRuns({ limit: 10 }).items.map((x) => x.name))].slice(0, 5);
  throw new ApsError('ConfigurationError', `No finished run "${r}"`, {
    suggestions: [`Give a run id (the app's Runs list shows them), "last" or a run's name${recent.length ? ` (recent: ${recent.join(', ')})` : ''}.`],
  });
}

/** What a run's results file is now (a changed or rewritten file builds the matrix again). */
function stamp(store: Store, runId: string): string {
  try {
    const st = statSync(runResultsFile(store, runId));
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return 'none';
  }
}

/** The matrices built lately (a few: each is ~1 MB for 50,000 cells), and the builds under way (shared by callers). */
const cache = new Map<string, Promise<EvalMatrix>>(); // bounded: CACHE_SIZE
const CACHE_SIZE = 4;

export interface EvalMatrixParams {
  /** The runs (variants), as ids, "last" or names, in column order. */
  runs: string[];
  baseline?: string;
  threshold?: number;
}

/** The matrix of these runs against the baseline: built once, then served from the cache while the runs are unchanged. */
async function openEvalMatrix(store: Store, p: EvalMatrixParams): Promise<EvalMatrix> {
  if (!Array.isArray(p.runs) || !p.runs.length) throw new ApsError('ValidationError', 'Pick at least one run for the matrix');
  const runs = p.runs.map((r) => resolveRunRef(store, r));
  const seen = new Set<string>();
  const unique = runs.filter((r) => !seen.has(r.runId) && seen.add(r.runId));
  const baseline = p.baseline ? resolveRunRef(store, p.baseline) : undefined;
  const threshold = evalThreshold(p.threshold);
  const key = JSON.stringify([store.root, unique.map((r) => [r.runId, stamp(store, r.runId)]), baseline ? [baseline.runId, stamp(store, baseline.runId)] : null, threshold]);
  let m = cache.get(key);
  if (m) {
    // most recently used last
    cache.delete(key);
    cache.set(key, m);
    return m;
  }
  const source = (r: { runId: string; name: string; startedAt: string }) => ({ runId: r.runId, name: r.name, startedAt: r.startedAt, results: runResults(store, r.runId) });
  m = buildEvalMatrix(unique.map(source), baseline ? source(baseline) : undefined, { threshold });
  cache.set(key, m);
  m.catch(() => cache.delete(key));
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return m;
}

/** A page of the matrix (the RPC and the MCP tool): the rows asked for, the column stats, chip counts and tags. */
export async function evalMatrixPage(store: Store, p: EvalMatrixParams & EvalMatrixQuery): Promise<EvalMatrixPage> {
  return (await openEvalMatrix(store, p)).page(p);
}

/** One result of a run, whole (input, output, checks with the judge's reasoning, its review): a cell's detail. */
export async function evalMatrixResult(store: Pick<WorkspaceStore, 'runDir'>, runId: string, resultId: string): Promise<TestResult | null> {
  if (!/^[\w.-]+$/.test(runId) || runId.startsWith('.')) throw new ApsError('ValidationError', `Not a run id: ${runId}`);
  const file = runResultsFile(store, runId);
  if (!existsSync(file)) return null;
  // the id as it is written in the file: lines without it are not parsed
  const needle = JSON.stringify(resultId).slice(1, -1);
  const rl = fileLines(file);
  let found: TestResult | undefined;
  for await (const line of rl) {
    if (!line.includes(needle)) continue;
    try {
      const r = JSON.parse(line) as TestResult;
      if (r.id === resultId) found = r; // the last one wins (a result written again after a resume)
    } catch {
      /* a torn line */
    }
  }
  if (!found) return null;
  const review = runReviews(store, runId)[resultId];
  return review ? { ...found, review } : found;
}

/* ------------------------------------------------------------------ run vs baseline */

export interface EvalCompareItem {
  key: string;
  name: string;
  /** The variant (column) it is in: the run's name, and the model when the run has several. */
  column: string;
  status?: string;
  baselineStatus?: string;
  score?: number;
  baselineScore?: number;
  delta?: number;
  resultId?: string;
  baselineResultId?: string;
}

interface EvalCompareReport {
  run: { id: string; name: string; columns: EvalMatrixColumn[] };
  baseline: { id: string; name: string };
  threshold: number;
  maxRegressions: number;
  cases: number;
  counts: { regressed: number; improved: number; unchanged: number; missing: number; added: number };
  /** Per variant: pass rate and mean score here and in the baseline. */
  columns: Array<{ label: string; passRate: number; meanScore?: number; meanDelta?: number; regressed: number; improved: number }>;
  regressions: EvalCompareItem[];
  improvements: EvalCompareItem[];
  missing: EvalCompareItem[];
  added: EvalCompareItem[];
  /** Lists cut at `limit` items each. */
  truncated: boolean;
  /** No more regressions than allowed (and, with failOnMissing, no case missing): what CI exits 0 on. */
  passed: boolean;
}

/**
 * A run against a baseline run, case by case: what regressed (stopped passing, or the score dropped by more than the
 * threshold), improved, went missing or is new. `passed` is false when there are more than `maxRegressions`
 * regressions (default 0), or with `failOnMissing` any missing case.
 */
export async function compareEvalRuns(
  store: Store,
  o: { run: string; baseline: string; threshold?: number; maxRegressions?: number; failOnMissing?: boolean; limit?: number },
): Promise<EvalCompareReport> {
  if (!o.baseline) throw new ApsError('ValidationError', 'Give the baseline run to compare with');
  const maxRegressions = o.maxRegressions === undefined ? 0 : Number(o.maxRegressions);
  if (!Number.isInteger(maxRegressions) || maxRegressions < 0) throw new ApsError('ValidationError', `maxRegressions is a whole number from 0 (got ${String(o.maxRegressions)})`);
  const limit = Math.min(100_000, Math.max(1, Math.floor(Number(o.limit) || 200)));
  const run = resolveRunRef(store, o.run);
  const base = resolveRunRef(store, o.baseline);
  if (run.runId === base.runId) throw new ApsError('ValidationError', `The run and the baseline are the same run (${run.runId})`);
  const m = await openEvalMatrix(store, { runs: [run.runId], baseline: base.runId, threshold: o.threshold });
  const lists = { regressions: [] as EvalCompareItem[], improvements: [] as EvalCompareItem[], missing: [] as EvalCompareItem[], added: [] as EvalCompareItem[] };
  const counts = { regressed: 0, improved: 0, unchanged: 0, missing: 0, added: 0 };
  let truncated = false;
  const page = m.page({ limit: 1 });
  for (let offset = 0; offset < m.cases; offset += 1000) {
    for (const row of m.page({ offset, limit: 1000 }).rows) {
      row.cells.forEach((c, k) => {
        if (!c.change) return;
        const item: EvalCompareItem = {
          key: row.key,
          name: row.name,
          column: page.columns[k]!.label,
          ...(c.status ? { status: c.status } : {}),
          ...(c.baseline?.status ? { baselineStatus: c.baseline.status } : {}),
          ...(c.score !== undefined ? { score: c.score } : {}),
          ...(c.baseline?.score !== undefined ? { baselineScore: c.baseline.score } : {}),
          ...(c.delta !== undefined ? { delta: c.delta } : {}),
          ...(c.id ? { resultId: c.id } : {}),
          ...(c.baseline?.id ? { baselineResultId: c.baseline.id } : {}),
        };
        const kind = c.change === 'new' ? 'added' : c.change;
        counts[kind]++;
        const list = kind === 'regressed' ? lists.regressions : kind === 'improved' ? lists.improvements : kind === 'missing' ? lists.missing : kind === 'added' ? lists.added : undefined;
        if (!list) return;
        if (list.length < limit) list.push(item);
        else truncated = true;
      });
    }
  }
  // the worst first: a lost pass before a score drop, the biggest drop first
  const worst = (a: EvalCompareItem, b: EvalCompareItem) =>
    Number(b.baselineStatus === 'passed' && b.status !== 'passed') - Number(a.baselineStatus === 'passed' && a.status !== 'passed') || (a.delta ?? 0) - (b.delta ?? 0);
  lists.regressions.sort(worst);
  lists.improvements.sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0));
  return {
    run: { id: run.runId, name: run.name, columns: m.columns },
    baseline: { id: base.runId, name: base.name },
    threshold: m.threshold,
    maxRegressions,
    cases: m.cases,
    counts,
    columns: page.columns.map((c) => ({
      label: c.label,
      passRate: c.stats.cases ? Math.round((c.stats.passed / c.stats.cases) * 10_000) / 10_000 : 0,
      ...(c.stats.meanScore !== undefined ? { meanScore: c.stats.meanScore } : {}),
      ...(c.stats.meanDelta !== undefined ? { meanDelta: c.stats.meanDelta } : {}),
      regressed: c.stats.regressed,
      improved: c.stats.improved,
    })),
    ...lists,
    truncated,
    passed: counts.regressed <= maxRegressions && !(o.failOnMissing && counts.missing > 0),
  };
}
