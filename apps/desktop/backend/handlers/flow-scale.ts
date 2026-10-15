/**
 * RPC handlers: the flow designer's Scale stage in the app. A flow once per data row (tests.dataRun) or in several
 * environments (tests.matrixRun) runs in the background with its progress as batched `scale.progress` events and a
 * `scale.finished` event; tests.scaleCancel stops it. Rows never travel to the window in bulk: the grid asks for the
 * page on screen (tests.scaleRows, from the run's writer while it goes, from disk after) and one row's steps
 * (tests.scaleRow). tests.flowTimeline / tests.flowTimelineHtml give a run's timeline and save it as HTML.
 */
import {
  ApsError,
  flowDataSource,
  flowRunTimeline,
  flowRunTimelineHtml,
  isSuiteFile,
  listScaleRuns,
  normalizeError,
  readFlowDataHeader,
  readScaleRows,
  readScaleRun,
  readScaleRunSteps,
  requireEnvironment,
  runFlowData,
  runFlowMatrix,
  runTimeline,
  saveScaleRun,
  scaleRunRow,
  scaleRunId,
  ScaleRowsWriter,
  type RowFilter,
  type ScaleRunRow,
  type WorkspaceStore,
} from '@testpion/core';
import { existsSync, writeFileSync } from 'node:fs';
import type { Backend, Handlers } from '../backend.js';

interface Job {
  id: string;
  kind: 'data' | 'matrix';
  file: string;
  store: WorkspaceStore;
  ctrl: AbortController;
  startedAt: string;
  writer?: ScaleRowsWriter;
  progress: { done: number; passed: number; failed: number; cancelled: number; skipped: number; total?: number };
  environments?: string[];
  /** Finished environments of a matrix (status and time), as they come. */
  columns?: Array<{ environment: string; status: string; durationMs: number; failedStep?: string; error?: string }>;
}

/** The jobs of each backend (a workspace switch or quit cancels them). */
const jobsOf = new WeakMap<Backend, Map<string, Job>>();

/** Cancel every running data run and matrix of a backend. */
export function cancelScaleRuns(be: Backend): void {
  for (const j of jobsOf.get(be)?.values() ?? []) j.ctrl.abort();
}

export function flowScaleHandlers(be: Backend): Handlers {
  const jobs = new Map<string, Job>();
  jobsOf.set(be, jobs);
  /** A flow file inside tests/ (not a suite): its path there and on disk. */
  const flowFile = (file: string) => {
    const rel = String(file ?? '').replace(/\\/g, '/');
    const abs = be.ws.safePath(rel, be.ws.path('tests'));
    if (!existsSync(abs)) throw new ApsError('ConfigurationError', `No such test file: tests/${rel}`);
    if (isSuiteFile(abs)) throw new ApsError('ValidationError', `tests/${rel} is a suite: run one of its flow files with data or in several environments`);
    return { rel, abs };
  };
  /** Progress events, at most every 150 ms per run (a 10,000-row run sends ~70 a second at most, never one per row). */
  const progress = be.batched<{ id: string; kind: string; done: number; passed: number; failed: number; cancelled: number; skipped: number; columns?: Job['columns'] }>('scale.progress', 150);
  const report = (j: Job) => progress.push({ id: j.id, kind: j.kind, ...j.progress, ...(j.columns ? { columns: j.columns } : {}) });
  const finish = (j: Job, status: string, error?: unknown) => {
    jobs.delete(j.id);
    progress.flush();
    be.host.emit('scale.finished', { id: j.id, kind: j.kind, file: j.file, status, ...(error ? { error: normalizeError(error) } : {}) });
  };
  const liveRow = (j: Job): ScaleRunRow => ({
    id: j.id,
    kind: j.kind,
    file: j.file,
    startedAt: j.startedAt,
    durationMs: Date.now() - Date.parse(j.startedAt),
    status: 'cancelled',
    total: j.kind === 'data' ? j.progress.done : (j.environments?.length ?? 0),
    passed: j.progress.passed,
    failed: j.progress.failed,
    skipped: j.progress.skipped,
    ...(j.environments ? { environments: j.environments } : {}),
  });

  return {
    /**
     * Run a flow once per data row: `data` a data file (absolute, or in the workspace), a database URL ({{variables}}
     * resolved in the environment) or env:NAME, with `dataQuery`; without it, the file's own data:. Answers { id }.
     */
    'tests.dataRun': async (p: { file: string; data?: string; dataQuery?: string; limit?: number; environment?: string; concurrency?: number; bail?: boolean }) => {
      const { rel, abs } = flowFile(p.file);
      if (p.environment) requireEnvironment(be.ws, p.environment);
      let spec = p.data || readFlowDataHeader(abs);
      if (spec === undefined)
        throw new ApsError('ValidationError', `tests/${rel} has no data: pick a data file`, {
          suggestions: ['Pick a CSV, JSON or JSONL file, a SQLite database or a database URL, or add data: datasets/users.csv to the file.'],
        });
      const ctx = be.context({ environment: p.environment });
      try {
        if (typeof spec === 'string' && /\{\{/.test(spec)) spec = ctx.vars.resolve(spec);
        const src = flowDataSource(spec, { file: p.data ? undefined : abs, roots: [be.ws.root, be.ws.path('tests')], query: p.dataQuery || undefined, limit: p.limit });
        const id = scaleRunId('data');
        const store = be.ws;
        const job: Job = {
          id,
          kind: 'data',
          file: rel,
          store,
          ctrl: new AbortController(),
          startedAt: new Date().toISOString(),
          writer: new ScaleRowsWriter(store, id),
          progress: { done: 0, passed: 0, failed: 0, cancelled: 0, skipped: 0 },
        };
        jobs.set(id, job);
        void runFlowData({
          file: abs,
          data: src,
          services: { ...ctx.services, persistVariable: undefined },
          concurrency: p.concurrency,
          bail: p.bail,
          signal: job.ctrl.signal,
          environment: p.environment,
          onRow: (row, steps) => {
            job.writer!.write(row, steps);
            job.progress.done++;
            job.progress[row.status]++;
            report(job);
          },
        })
          .then((r) => {
            job.writer!.close();
            const saved = saveScaleRun(store, { id, kind: 'data', ...r, file: rel, ...(p.environment ? { environment: p.environment } : {}) });
            finish(job, saved.status);
          })
          .catch((e) => {
            job.writer!.close();
            finish(job, 'error', e);
          })
          .finally(() => void ctx.dispose());
        return { id };
      } catch (e) {
        await ctx.dispose();
        throw e;
      }
    },
    /** Run a flow in each environment and compare (environment × step, outputs that differ). Answers { id }. */
    'tests.matrixRun': async (p: { file: string; environments: string[] }) => {
      const { rel, abs } = flowFile(p.file);
      const envs = [...new Set((p.environments ?? []).map((e) => String(e).trim()).filter(Boolean))];
      if (!envs.length) throw new ApsError('ValidationError', 'Pick the environments to compare');
      // a name that is not an environment is said now, before anything runs
      for (const e of envs) requireEnvironment(be.ws, e);
      const id = scaleRunId('matrix');
      const store = be.ws;
      const job: Job = {
        id,
        kind: 'matrix',
        file: rel,
        store,
        ctrl: new AbortController(),
        startedAt: new Date().toISOString(),
        progress: { done: 0, passed: 0, failed: 0, cancelled: 0, skipped: 0, total: envs.length },
        environments: envs,
        columns: [],
      };
      jobs.set(id, job);
      void runFlowMatrix({
        file: abs,
        environments: envs,
        signal: job.ctrl.signal,
        contextFor: (environment) => {
          const ctx = be.context({ environment });
          ctx.services.persistVariable = undefined;
          return ctx;
        },
        onColumn: (c) => {
          job.progress.done++;
          job.progress[c.status]++;
          job.columns!.push({ environment: c.environment, status: c.status, durationMs: c.durationMs, ...(c.failedStep ? { failedStep: c.failedStep } : {}), ...(c.error ? { error: c.error } : {}) });
          report(job);
        },
      })
        .then((m) => finish(job, saveScaleRun(store, { id, kind: 'matrix', ...m, file: rel }).status))
        .catch((e) => finish(job, 'error', e));
      return { id };
    },
    /** Stop a data run or matrix: the rows / environments running are cancelled, no more start. */
    'tests.scaleCancel': ({ id }: { id: string }) => {
      const j = jobs.get(id);
      if (!j) return { id, running: false };
      j.ctrl.abort();
      return { id, running: true };
    },
    /** The data runs and matrices of a file (or all), newest first; running ones first. */
    'tests.scaleRuns': ({ file, limit }: { file?: string; limit?: number }) => {
      const want = file?.replace(/\\/g, '/').toLowerCase();
      const running = [...jobs.values()].filter((j) => !want || j.file.toLowerCase() === want).map((j) => ({ ...liveRow(j), running: true }));
      return [...running, ...listScaleRuns(be.ws, { file, limit }).filter((r) => !jobs.has(r.id))];
    },
    /** A data run's summary or a matrix (while it runs: what is known so far, `running`). */
    'tests.scaleRun': ({ id }: { id: string }) => {
      const j = jobs.get(id);
      if (j) return { ...liveRow(j), running: true, ...(j.columns ? { columns: j.columns } : {}) };
      const r = readScaleRun(be.ws, id);
      // its status as everything shows it (skipped when nothing ran)
      const { status } = scaleRunRow(r);
      return r.kind === 'matrix' ? { ...r, status, columns: r.columns.map((c) => ({ ...c, results: c.results.map((x) => ({ ...x, output: x.output?.slice(0, 2000) })) })) } : { ...r, status };
    },
    /** A page of a data run's rows, in row order (status all / failed / passed / cancelled / skipped). */
    'tests.scaleRows': ({ id, offset, limit, status }: { id: string; offset?: number; limit?: number; status?: RowFilter }) => {
      const j = jobs.get(id);
      return j?.writer ? j.writer.page({ offset, limit, status }) : readScaleRows(be.ws, id, { offset, limit, status });
    },
    /** One row's step results (null when they were not kept: they are for failing rows and the first passing ones). */
    'tests.scaleRow': ({ id, index }: { id: string; index: number }) => {
      const j = jobs.get(id);
      return (j?.writer ? j.writer.steps(index) : readScaleRunSteps(be.ws, id, index)) ?? null;
    },
    /** A run as a timeline: of a flow file (its latest run by default), or a whole run (`runId` alone): bars, lanes, the critical path, the slowest steps. */
    'tests.flowTimeline': ({ file, runId }: { file?: string; runId?: string }) => {
      if (file) return flowRunTimeline(be.ws, file, runId);
      if (!runId) throw new ApsError('ValidationError', 'tests.flowTimeline: give a file or a runId');
      return runTimeline(be.ws, runId);
    },
    /** Save a run's timeline as a self-contained HTML file (where the person picks, or downloaded). */
    'tests.flowTimelineHtml': async ({ file, runId }: { file?: string; runId?: string }) => {
      const h = await flowRunTimelineHtml(be.ws, file, runId);
      return be.saveOrDownload(
        h.name,
        [{ name: 'HTML', extensions: ['html'] }],
        (dest) => writeFileSync(dest, h.html),
        () => Buffer.from(h.html),
      );
    },
  };
}
