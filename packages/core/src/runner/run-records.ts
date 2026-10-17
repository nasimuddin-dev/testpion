/** A finished run on disk: its summary.json next to results.jsonl, the reports, and its row in the run history. */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stageAtomicWrite } from '../storage/fsutil.js';
import type { RunSummary, TestResult } from '../model/types.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { ApsError } from '../errors.js';
import { writeReports, type ReportFormat } from '../report/reports.js';
import { compareToBaseline, createBaseline, type RegressionReport, type RegressionThresholds } from '../report/regression.js';
import { readResultsFile } from './runner.js';
import { runResults } from './run-results.js';

async function* resultsIn(dir: string): AsyncGenerator<TestResult> {
  yield* await readResultsFile(join(dir, 'results.jsonl'));
}

/**
 * Record a finished run in `dir` (where its results.jsonl is): the `reports` asked for, a row in the workspace's run
 * history (`history: false` leaves the history alone, e.g. for an ephemeral workspace), and summary.json.
 * Returns the report paths by format.
 *
 * A run's summary.json and its history row appear TOGETHER, after its reports: some wait for the summary
 * (`readRunSummary`: the window, the CLI, agents) and then look the run up in the history ('last': run again, compare,
 * CI); others list the history (`runs.list`) and then read the summary (Copy CLI command, Run in CI, results). So the
 * summary is written to a temp file first (the slow part), then the row is added and the file renamed into place in
 * the same synchronous step: nothing else in this process runs in between, and either both are there or neither is.
 * (Summary first left a gap while the reports were written in which a finished run was not in the history yet; the
 * row first, one in which a listed run had no summary.)
 */
export async function recordRun(store: Pick<WorkspaceStore, 'meta'>, summary: RunSummary, dir: string, opts: { reports?: ReportFormat[]; history?: boolean } = {}): Promise<Partial<Record<ReportFormat, string>>> {
  mkdirSync(dir, { recursive: true });
  const paths = opts.reports?.length ? await writeReports(dir, summary, () => resultsIn(dir), opts.reports) : {};
  const file = stageAtomicWrite(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  try {
    if (opts.history !== false) store.meta.addRun(summary, dir);
  } catch (e) {
    file.discard();
    throw e;
  }
  try {
    file.commit();
  } catch (e) {
    // no summary, so no row: a listed run always has its summary
    if (opts.history !== false) store.meta.deleteRun(summary.runId);
    throw e;
  }
  return paths;
}

/** The summary of a finished run, or undefined while it runs (or when it never finished). */
export function readRunSummary(store: Pick<WorkspaceStore, 'runDir'>, runId: string): RunSummary | undefined {
  const f = join(store.runDir(runId), 'summary.json');
  if (!existsSync(f)) return undefined;
  // a damaged file (an edit, a disk error, a copy cut short) is said as such, never as a JSON parser's internal error
  const damaged = () =>
    new ApsError('ConfigurationError', `The summary of run ${runId} cannot be read (its summary.json is damaged)`, { suggestions: ['Run the tests again for a new run (the app\'s Runs list shows the runs).'] });
  let s: unknown;
  try {
    s = JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    throw damaged();
  }
  if (!s || typeof s !== 'object' || Array.isArray(s) || typeof (s as { runId?: unknown }).runId !== 'string') throw damaged();
  return s as RunSummary;
}

/** What changed between two finished runs: the earlier one is the baseline the later one is compared with. */
export async function compareRuns(store: Pick<WorkspaceStore, 'runDir'>, before: string, after: string, thresholds?: RegressionThresholds): Promise<RegressionReport> {
  const summaryOf = (id: string) => {
    const s = readRunSummary(store, id);
    if (!s) throw new ApsError('ValidationError', `No finished run ${id}`);
    return s;
  };
  const earlier = summaryOf(before);
  const later = summaryOf(after);
  const baseline = await createBaseline(`run ${before}`, earlier, runResults(store, before));
  return compareToBaseline(baseline, later, runResults(store, after), thresholds);
}
