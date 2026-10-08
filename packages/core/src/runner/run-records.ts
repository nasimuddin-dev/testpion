/** A finished run on disk: its summary.json next to results.jsonl, the reports, and its row in the run history. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
 * Record a finished run in `dir` (where its results.jsonl is): summary.json, the `reports` asked for, and a row in
 * the workspace's run history (`history: false` leaves the history alone, e.g. for an ephemeral workspace).
 * Returns the report paths by format.
 */
export async function recordRun(store: Pick<WorkspaceStore, 'meta'>, summary: RunSummary, dir: string, opts: { reports?: ReportFormat[]; history?: boolean } = {}): Promise<Partial<Record<ReportFormat, string>>> {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  const paths = opts.reports?.length ? await writeReports(dir, summary, () => resultsIn(dir), opts.reports) : {};
  if (opts.history !== false) store.meta.addRun(summary, dir);
  return paths;
}

/** The summary of a finished run, or undefined while it runs (or when it never finished). */
export function readRunSummary(store: Pick<WorkspaceStore, 'runDir'>, runId: string): RunSummary | undefined {
  const f = join(store.runDir(runId), 'summary.json');
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as RunSummary) : undefined;
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
