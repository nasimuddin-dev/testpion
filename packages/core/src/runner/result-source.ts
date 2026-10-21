import { isAbsolute, sep } from 'node:path';
import { relativeInside } from '../storage/fsutil.js';
import type { ItemRef } from '@testpion/shared';
import type { RunOrigin, RunSummary } from '../model/types.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { ApsError } from '../errors.js';
import type { CiTarget } from './ci-config.js';
import { readRunSummary } from './run-records.js';

/**
 * WF-08: a run's result and where it came from. Every result names its source as refs — the test file at its step, or
 * (a collection run, a monitor) the saved request — and a run, or some of its results, can be run again the way it
 * first ran. The window (result header, monitor rows), `runs.results`, the MCP server and the CLI all use these.
 */

/** A collection run numbers its results per iteration: `<request id>@<iteration>` (`#n` when it ran again). */
export const requestIdOfResult = (id: string): string => id.replace(/@\d+(#\d+)?$/, '');

/**
 * A result file's path under tests/ (as refs name it), or undefined outside the workspace's tests. A recorded absolute
 * path may name the workspace another way than the store does (the real path behind a link: on macOS every temp folder,
 * /var → /private/var, and the current folder a run resolved its files from), so it is related as given or really
 * (`relativeInside`), never by a plain `relative`.
 */
export function testsPathOf(store: Pick<WorkspaceStore, 'path'>, file: string | undefined): string | undefined {
  if (!file) return undefined;
  if (!isAbsolute(file)) return file.startsWith('../') || file.startsWith('..\\') || file === '..' ? undefined : file.split(sep).join('/');
  const rel = relativeInside(store.path('tests'), file);
  return rel ? rel.split(sep).join('/') : undefined;
}

/** Where a result came from: the saved request of a collection run (or a monitor of one), else its test file at its step. */
export function resultSourceRefs(store: Pick<WorkspaceStore, 'path'>, result: { id: string; file?: string }, origin?: RunOrigin): ItemRef[] {
  const refs: ItemRef[] = [];
  if (origin?.kind === 'collection') refs.push({ kind: 'request', collectionId: origin.collectionId, requestId: requestIdOfResult(result.id) });
  const path = testsPathOf(store, result.file);
  if (path) refs.push({ kind: 'test', path, step: result.id });
  return refs;
}

/** What running a run again starts: the same test files (or only some results), or the same collection run (or some of its requests). */
type RunAgainPlan =
  | { kind: 'tests'; paths: string[]; ids?: string[]; grep?: string; tags?: string[]; environment?: string; name: string }
  | { kind: 'collection'; collectionId: string; selection?: string[]; iterations?: number; rerun?: boolean; environment?: string; name: string };

/**
 * How to run `summary` again: as it ran (its origin), or only `resultIds`. A run recorded before runs kept their origin
 * runs its files again (`summary.files`); one with neither cannot be (a refusal saying so).
 */
export function runAgainPlan(summary: RunSummary, resultIds?: string[]): RunAgainPlan {
  const only = resultIds?.length ? [...new Set(resultIds)] : undefined;
  const origin = summary.origin;
  const name = only ? `${summary.name} (${only.length === 1 ? 'one result' : `${only.length} results`} again)` : summary.name;
  if (origin?.kind === 'collection')
    return {
      kind: 'collection',
      collectionId: origin.collectionId,
      selection: only ? [...new Set(only.map(requestIdOfResult))] : origin.selection,
      iterations: only ? undefined : origin.iterations,
      // some requests again: the earlier ones they need (a token request) run first as setup
      ...(only || origin.rerun ? { rerun: true } : {}),
      environment: summary.environment,
      name,
    };
  const paths = origin?.kind === 'tests' ? origin.paths : summary.files;
  if (!paths)
    throw new ApsError('ValidationError', `Run ${summary.runId} does not say what it ran, so it can't be run again`, { suggestions: ['Run its test files or collection again from the Tests view.'] });
  return {
    kind: 'tests',
    paths,
    // only some results again; else the tests it picked (a run of some results, run again as it ran), or all
    ids: only ?? (origin?.kind === 'tests' && origin.ids?.length ? origin.ids : undefined),
    grep: only ? undefined : origin?.kind === 'tests' ? origin.grep : undefined,
    tags: only ? undefined : origin?.kind === 'tests' ? origin.tags : undefined,
    environment: summary.environment,
    name,
  };
}

/**
 * WF-09: a run as a CI target — what the pipeline (or `testpion` on this computer) runs to do the same run: its test
 * files with their name / tag filter, or its collection with the folders and requests it picked, and its environment.
 * Iterations and data rows of a collection run are not carried (the pipeline runs it once); `note` says so.
 */
export function ciTargetOfRun(store: Pick<WorkspaceStore, 'path'>, summary: RunSummary): { target: CiTarget; environment?: string; note?: string } {
  const plan = runAgainPlan(summary);
  if (plan.kind === 'collection') {
    const note = plan.iterations && plan.iterations > 1 ? `The run had ${plan.iterations} iterations; the pipeline runs the collection once.` : undefined;
    return { target: { collection: plan.collectionId, ...(plan.selection?.length ? { folders: plan.selection } : {}) }, environment: plan.environment, ...(note ? { note } : {}) };
  }
  // paths under tests/ as the pipeline names them (a run kept absolute paths before it kept its origin)
  const tests = plan.paths.map((p) => testsPathOf(store, p) ?? p);
  // a run of some of the files' tests: the pipeline picks the same ones by id (`-g` matches a test's name or id)
  const grep = plan.ids?.length ? `^(?:${plan.ids.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$` : plan.grep;
  return { target: { tests, ...(grep ? { grep } : {}), ...(plan.tags?.length ? { tags: plan.tags } : {}) }, environment: plan.environment };
}

/** Monitors name their runs `Monitor · <name>`: scheduled checks, not a run someone started. */
export const MONITOR_RUN_PREFIX = 'Monitor · ';
export const isMonitorRun = (s: Pick<RunSummary, 'name'>): boolean => s.name.startsWith(MONITOR_RUN_PREFIX);

/** Whether a run says what it ran (its origin, or its files), so it can be run again or put in CI. */
function canRunAgain(s: RunSummary): boolean {
  return !!s.origin || !!s.files?.length;
}

/**
 * The newest FINISHED run of a kind: it has its summary and was not cancelled, and `accept` takes it. A run that is
 * still going (no summary yet), was stopped, or is of another kind is passed by. The newest `scan` runs are looked at.
 */
export function latestFinishedRun(store: Pick<WorkspaceStore, 'runDir' | 'meta'>, accept: (s: RunSummary) => boolean, scan = 500): RunSummary | undefined {
  for (let offset = 0; offset < scan; offset += 50) {
    const page = store.meta.listRuns({ limit: 50, offset }).items;
    for (const r of page) {
      let s: RunSummary | undefined;
      try {
        s = readRunSummary(store, r.id);
      } catch {
        continue; // a summary being written
      }
      if (s && !s.cancelled && accept(s)) return s;
    }
    if (page.length < 50) return undefined;
  }
  return undefined;
}

/**
 * A finished run's summary by id, or 'last': the newest finished run that can be run again (test files or a collection;
 * not a monitor's, not a stopped one), or a ValidationError saying there is none.
 */
export function finishedRun(store: Pick<WorkspaceStore, 'runDir' | 'meta'>, runId: string): RunSummary {
  const hint = { suggestions: ['list_runs (MCP) or `testpion history` name the runs.'] };
  if (runId === 'last') {
    const s = latestFinishedRun(store, (x) => canRunAgain(x) && !isMonitorRun(x));
    if (!s) throw new ApsError('ValidationError', store.meta.listRuns({ limit: 1 }).items.length ? 'No finished run of test files or a collection yet' : 'There are no runs yet', hint);
    return s;
  }
  const summary = runId ? readRunSummary(store, runId) : undefined;
  if (!summary) throw new ApsError('ValidationError', runId ? `No finished run ${runId}` : 'There are no runs yet', hint);
  return summary;
}
