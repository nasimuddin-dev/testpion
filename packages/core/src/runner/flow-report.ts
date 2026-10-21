/**
 * The run timeline report: a run (of a flow file, or any run: its results) as a timeline (each step's start and end,
 * waits, parallel lanes, the critical path, the slowest steps; shared `flowTimeline`), and the same as a
 * self-contained HTML file (shared `timelineHtml`). `testpion flow report`, the flow_timeline MCP tool and the app's
 * Timeline tab of a run read it here. What each step waits for comes from its file (dependsOn, finally).
 */
import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { flowTimeline, timelineHtml, type FlowTimeline, type TimelineStepInput } from '@testpion/shared';
import type { TestResult } from '../model/types.js';
import { ApsError } from '../errors.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { pathMatcher } from '../storage/fsutil.js';
import { testsPathOf } from './result-source.js';
import { loadTestsFromFile } from './loader.js';
import { readResultsFile } from './runner.js';
import { readRunSummary } from './run-records.js';
import { flowRuns, type FlowRunRow } from './flow-history.js';

/** The most steps a timeline shows (the first ones of the run). */
const MAX_TIMELINE_STEPS = 2000;

interface FlowRunTimeline {
  /** The flow file (inside tests/) when the timeline is of one file. */
  file?: string;
  runId: string;
  run?: FlowRunRow;
  name?: string;
  /** The run had more steps than the timeline shows (MAX_TIMELINE_STEPS). */
  truncated?: boolean;
  timeline: FlowTimeline;
}

/** What each step of a file waits for, by id (empty for a file that is gone). */
async function depsOf(abs: string): Promise<Map<string, { dependsOn: string[]; finally: boolean }>> {
  const deps = new Map<string, { dependsOn: string[]; finally: boolean }>();
  if (!existsSync(abs)) return deps;
  try {
    for await (const t of loadTestsFromFile(abs)) {
      deps.set(t.id ?? t.name, { dependsOn: [...(t.dependsOn ?? [])], finally: !!t.finally });
      if (deps.size >= MAX_TIMELINE_STEPS) break;
    }
  } catch {
    /* a file that no longer parses: no dependencies */
  }
  return deps;
}

/**
 * The timeline of a run: all its results, or only those of `file` (inside tests/). With several files, step ids are
 * shown as `file#id` so two files' steps never mix.
 */
export async function runTimeline(store: WorkspaceStore, runId: string, o: { file?: string } = {}): Promise<FlowRunTimeline> {
  const resultsFile = join(store.runDir(runId), 'results.jsonl');
  if (!existsSync(resultsFile)) throw new ApsError('ValidationError', `No run ${runId} (or it has no results yet)`);
  // the file as the workspace names it, or as the run did (its real path, resolved from the current folder)
  const isFile = o.file ? pathMatcher(store.safePath(o.file, store.path('tests'))) : undefined;
  const results: TestResult[] = [];
  let truncated = false;
  for await (const r of await readResultsFile(resultsFile)) {
    if (isFile && !isFile(r.file)) continue;
    if (results.length >= MAX_TIMELINE_STEPS) {
      truncated = true;
      break;
    }
    results.push(r);
  }
  if (!results.length) throw new ApsError('ValidationError', o.file ? `Run ${runId} did not include tests/${o.file}` : `Run ${runId} has no results`);
  const files = [...new Set(results.map((r) => r.file ?? ''))];
  const many = files.length > 1;
  const label = (f: string) => testsPathOf(store, f) ?? f.split(sep).join('/');
  const deps = new Map<string, Map<string, { dependsOn: string[]; finally: boolean }>>();
  for (const f of files) deps.set(f, f ? await depsOf(f) : new Map());
  const key = (f: string, id: string) => (many ? `${label(f)}#${id}` : id);
  const steps: TimelineStepInput[] = results.map((r) => {
    const f = r.file ?? '';
    const d = deps.get(f)?.get(r.id);
    return {
      id: key(f, r.id),
      name: many && f ? `${r.name}` : r.name,
      startedAt: r.startedAt,
      durationMs: r.durationMs,
      status: r.status,
      type: r.type,
      dependsOn: d?.dependsOn.map((x) => key(f, x)),
      finally: !!d?.finally || r.metadata?.finally === true,
    };
  });
  const summary = readRunSummary(store, runId);
  const single = files.length === 1 && files[0] ? label(files[0]) : undefined;
  return {
    ...(o.file ? { file: o.file.replace(/\\/g, '/') } : single ? { file: single } : {}),
    runId,
    ...(summary ? { name: summary.name } : {}),
    ...(truncated ? { truncated } : {}),
    timeline: flowTimeline(steps),
  };
}

/** The timeline of a run of a flow file (`runId`, default: the file's latest run). */
export async function flowRunTimeline(store: WorkspaceStore, file: string, runId?: string): Promise<FlowRunTimeline> {
  const runs = (await flowRuns(store, file, { limit: runId ? 200 : 1 })).runs;
  const run = runId ? runs.find((r) => r.runId === runId) : runs[0];
  const id = runId ?? run?.runId;
  if (!id) throw new ApsError('ValidationError', `tests/${file} has not been run yet: run it first (testpion test ${file})`);
  const t = await runTimeline(store, id, { file });
  return { ...t, ...(run ? { run } : {}) };
}

/** The timeline report as a self-contained HTML page (no scripts, no network): of a flow file's run, or of a whole run. */
export async function flowRunTimelineHtml(store: WorkspaceStore, file: string | undefined, runId?: string): Promise<{ file?: string; runId: string; html: string; name: string }> {
  if (!file && !runId) throw new ApsError('ValidationError', 'Give a flow file or a run');
  const t = file ? await flowRunTimeline(store, file, runId) : await runTimeline(store, runId!);
  const what = t.file ? t.file.split('/').pop()! : (t.name ?? t.runId);
  const html = timelineHtml(t.timeline, {
    title: `Run timeline: ${what}`,
    file: t.file,
    runId: t.runId,
    environment: t.run?.environment,
    status: t.run?.status,
    generatedAt: new Date().toISOString(),
  });
  const base = (t.file ? t.file.replace(/\.(ya?ml|json)$/i, '') : what).replace(/[^\w.-]+/g, '-').slice(0, 80);
  return { ...(t.file ? { file: t.file } : {}), runId: t.runId, html, name: `${base}-${t.runId}-timeline.html` };
}
