/** One test across earlier runs: did it pass, how long it took, which checks failed. */
import { join } from 'node:path';
import type { WorkspaceStore } from '../storage/workspace.js';
import { jsonNeedle, readResultsFile } from './runner.js';

interface TestHistoryPoint {
  runId: string;
  runName: string;
  startedAt: string;
  environment?: string;
  status: string;
  latencyMs?: number;
  attempts?: number;
  /** Names of the checks that failed (up to 5), or the error. */
  failures: string[];
}

/**
 * The result of a test in each of the latest `runs` runs that included it, newest first (one per run: the first
 * matching result, so a data-driven run counts once). A test is matched by id when given, otherwise by name.
 */
export async function testHistory(store: WorkspaceStore, test: { id?: string; name?: string }, opts: { runs?: number; limit?: number } = {}): Promise<TestHistoryPoint[]> {
  if (!test.id && !test.name) return [];
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 200);
  const runs = store.meta.listRuns({ limit: Math.min(Math.max(opts.runs ?? 60, 1), 500) }).items;
  const out: TestHistoryPoint[] = [];
  // a line without the test's id (or name) cannot be its result: those lines are not parsed
  const needle = jsonNeedle((test.id ? test.id : test.name)!);
  for (const run of runs) {
    if (out.length >= limit) break;
    for await (const r of await readResultsFile(join(store.runDir(run.id), 'results.jsonl'), { contains: needle })) {
      if (test.id ? r.id !== test.id : r.name !== test.name) continue;
      out.push({
        runId: run.id,
        runName: run.name,
        startedAt: run.startedAt,
        environment: run.environment,
        status: r.status,
        latencyMs: r.latencyMs ?? r.durationMs,
        attempts: r.attempts > 1 ? r.attempts : undefined,
        failures: r.error
          ? [r.error.message]
          : (r.checks ?? [])
              .filter((c) => !c.passed)
              .slice(0, 5)
              .map((c) => c.name),
      });
      break;
    }
  }
  return out;
}

/** How a test has been doing: passes, failures and how often its result flipped (a sign of flakiness), oldest to newest. */
export function summarizeTestHistory(points: TestHistoryPoint[]): { runs: number; passed: number; failed: number; flips: number; medianMs?: number } {
  const ordered = [...points].reverse().filter((p) => p.status !== 'skipped');
  let flips = 0;
  for (let i = 1; i < ordered.length; i++) if ((ordered[i]!.status === 'passed') !== (ordered[i - 1]!.status === 'passed')) flips++;
  const ms = ordered
    .map((p) => p.latencyMs)
    .filter((v): v is number => typeof v === 'number')
    .sort((a, b) => a - b);
  return {
    runs: ordered.length,
    passed: ordered.filter((p) => p.status === 'passed').length,
    failed: ordered.filter((p) => p.status === 'failed' || p.status === 'error').length,
    flips,
    medianMs: ms.length ? Math.round(ms[Math.floor((ms.length - 1) / 2)]!) : undefined,
  };
}

interface FlakyTest {
  id: string;
  name: string;
  runs: number;
  passed: number;
  failed: number;
  /** How often the result changed from one run to the next (oldest to newest). */
  flips: number;
  /** Runs where it passed only after a retry. */
  retried: number;
  lastStatus: string;
  lastRunAt: string;
  /** The latest results, oldest first (up to 20): passed or failed. */
  recent: string[];
}

/**
 * Tests whose result keeps changing across the latest `runs` runs (at least two flips), or that passed only after a
 * retry, most flips first. One pass over the runs' results.
 */
export async function flakyTests(store: WorkspaceStore, opts: { runs?: number } = {}): Promise<FlakyTest[]> {
  const runs = store.meta.listRuns({ limit: Math.min(Math.max(opts.runs ?? 30, 2), 300) }).items.reverse();
  // reading the runs' results is the slow part: the answer only changes when a run is added or removed
  const key = `${runs.length}:${runs[0]?.id ?? ''}:${runs[runs.length - 1]?.id ?? ''}`;
  const cached = flakyCache.get(store);
  if (cached?.key === key) return cached.value;
  const value = await scanFlaky(store, runs);
  flakyCache.set(store, { key, value });
  return value;
}

const flakyCache = new WeakMap<WorkspaceStore, { key: string; value: FlakyTest[] }>();

async function scanFlaky(store: WorkspaceStore, runs: Array<{ id: string; startedAt: string }>): Promise<FlakyTest[]> {
  const by = new Map<string, { id: string; name: string; statuses: string[]; retried: number; lastAt: string }>();
  for (const run of runs) {
    const seen = new Set<string>();
    for await (const r of await readResultsFile(join(store.runDir(run.id), 'results.jsonl'))) {
      if (r.status === 'skipped' || seen.has(r.id)) continue;
      seen.add(r.id);
      let t = by.get(r.id);
      if (!t) by.set(r.id, (t = { id: r.id, name: r.name, statuses: [], retried: 0, lastAt: run.startedAt }));
      t.statuses.push(r.status === 'passed' ? 'passed' : 'failed');
      if (r.status === 'passed' && r.attempts > 1) t.retried++;
      t.lastAt = run.startedAt;
      t.name = r.name;
    }
  }
  const out: FlakyTest[] = [];
  for (const t of by.values()) {
    let flips = 0;
    for (let i = 1; i < t.statuses.length; i++) if (t.statuses[i] !== t.statuses[i - 1]) flips++;
    if (flips < 2 && !t.retried) continue;
    const passed = t.statuses.filter((s) => s === 'passed').length;
    out.push({
      id: t.id,
      name: t.name,
      runs: t.statuses.length,
      passed,
      failed: t.statuses.length - passed,
      flips,
      retried: t.retried,
      lastStatus: t.statuses[t.statuses.length - 1]!,
      lastRunAt: t.lastAt,
      recent: t.statuses.slice(-20),
    });
  }
  return out.sort((a, b) => b.flips - a.flips || b.retried - a.retried || a.name.localeCompare(b.name));
}

/** The latest result of each named test over the latest `runs` runs (newest first): one pass, stops once all are found. */
export async function latestResults(
  store: WorkspaceStore,
  names: string[],
  opts: { runs?: number } = {},
): Promise<Record<string, { status: string; runId: string; startedAt: string; latencyMs?: number }>> {
  const wanted = new Set(names);
  const out: Record<string, { status: string; runId: string; startedAt: string; latencyMs?: number }> = {};
  if (!wanted.size) return out;
  for (const run of store.meta.listRuns({ limit: Math.min(Math.max(opts.runs ?? 30, 1), 300) }).items) {
    for await (const r of await readResultsFile(join(store.runDir(run.id), 'results.jsonl'))) {
      if (!wanted.has(r.name) || out[r.name]) continue;
      out[r.name] = { status: r.status, runId: run.id, startedAt: run.startedAt, latencyMs: r.latencyMs ?? r.durationMs };
    }
    if (Object.keys(out).length === wanted.size) break;
  }
  return out;
}
