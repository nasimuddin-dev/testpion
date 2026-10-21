/**
 * The flow designer's Scale stage for agents: a flow once per data row (flow_data_run), in several environments side
 * by side (flow_env_matrix), the rows / matrix / a row's steps of such a run read back (flow_scale_result) and a run's
 * timeline with its critical path, also as a self-contained HTML file (flow_timeline). A flow as a load-test scenario
 * is load_test's `test_file`.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { createEngineContext } from '../../engine.js';
import { ApsError } from '../../errors.js';
import type { TestResult } from '../../model/types.js';
import { isSuiteFile } from '../../runner/loader.js';
import { flowDataSource, readFlowDataHeader, runFlowData } from '../../runner/flow-data-run.js';
import { runFlowMatrix } from '../../runner/flow-env-matrix.js';
import { flowRunTimeline, flowRunTimelineHtml, runTimeline } from '../../runner/flow-report.js';

import { readScaleRows, readScaleRun, readScaleRunSteps, saveScaleRun, scaleRunId, scaleRunRow, ScaleRowsWriter, type RowFilter } from '../../runner/flow-scale-runs.js';
import type { FlowToolDeps } from './flow-tools.js';
import { str, type Tool } from '../tool.js';

const step = (r: TestResult) => ({
  id: r.id,
  name: r.name,
  status: r.status,
  ms: Math.round(r.latencyMs ?? r.durationMs),
  ...(r.error ? { error: r.error.message } : {}),
  ...(r.checks.some((c) => !c.passed) ? { failedChecks: r.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.message}`) } : {}),
  ...(r.output ? { output: r.output.slice(0, 2000) } : {}),
});

export function scaleTools(d: FlowToolDeps): Tool[] {
  const { store } = d;
  /** A flow file inside tests/ (not a suite), as its path there and on disk. */
  const flowFile = (ref: unknown) => {
    const rel = String(ref ?? '')
      .replace(/\\/g, '/')
      .replace(/^tests\//, '');
    if (!rel) throw new ApsError('ValidationError', 'Give the flow file (a path inside tests/, e.g. rest/checkout.yaml)');
    const abs = store.safePath(rel, store.path('tests'));
    if (!existsSync(abs)) throw new ApsError('ConfigurationError', `No such test file: tests/${rel}`);
    if (isSuiteFile(abs)) throw new ApsError('ValidationError', `tests/${rel} is a suite: give one flow file`);
    return { rel, abs };
  };
  return [
    {
      name: 'flow_data_run',
      write: true,
      description:
        "Run a flow file once per row of a dataset (data-driven): each row's fields become variables ({{email}}), with {{$row.field}} and {{$index}} (0-based). `data` is a workspace data file (datasets/users.csv, .json, .jsonl, a SQLite database with `query`), a postgres:// / mysql:// URL or env:NAME with `query`, or omitted to use the file's own `data:`. Rows run `concurrency` at a time (default 1); `bail` stops at the first failing row. Returns the counts, the first failing rows (index, values, failing step, error) and an id: page every row with flow_scale_result (status 'failed' for the failures, `row` for one row's steps). Secret-looking columns are masked in what is returned.",
      inputSchema: {
        type: 'object',
        properties: {
          file: str('The flow file, a path inside tests/'),
          data: str("The rows: a data file in the workspace, a database URL or env:NAME (default: the file's data:)"),
          query: str('With a database: the SELECT whose rows are the runs'),
          limit: { type: 'number', description: 'At most this many rows' },
          environment: str('Environment name'),
          concurrency: { type: 'number', description: 'Rows run at once, 1-32 (default 1)' },
          bail: { type: 'boolean', description: 'Stop at the first failing row' },
        },
        required: ['file'],
      },
      run: async (a) => {
        const { rel, abs } = flowFile(a.file);
        const environment = d.checkEnvironment(a.environment);
        const spec = typeof a.data === 'string' && a.data ? a.data : readFlowDataHeader(abs);
        if (spec === undefined) throw new ApsError('ValidationError', `tests/${rel} has no data: give \`data\` (a data file, a database URL or env:NAME)`);
        const src = flowDataSource(spec, {
          file: typeof a.data === 'string' && a.data ? undefined : abs,
          roots: [store.root, store.path('tests')],
          query: typeof a.query === 'string' ? a.query : undefined,
          limit: typeof a.limit === 'number' ? a.limit : undefined,
        });
        const ctx = createEngineContext({ store, secrets: d.secrets, settings: d.settings, environment });
        const id = scaleRunId('data');
        const writer = new ScaleRowsWriter(store, id);
        try {
          const r = await runFlowData({
            file: abs,
            data: src,
            services: ctx.services,
            concurrency: typeof a.concurrency === 'number' ? a.concurrency : 1,
            bail: a.bail === true,
            environment,
            onRow: (row, steps) => writer.write(row, steps),
          });
          writer.close();
          // the run's status as everything shows it: skipped when nothing ran in any row
          const { status } = saveScaleRun(store, { id, kind: 'data', ...r, file: rel, ...(environment ? { environment } : {}) });
          const { failedRows, ...summary } = r;
          return {
            id,
            status,
            ...summary,
            file: rel,
            failedRows: failedRows.slice(0, 20),
            ...(r.failed > 20 ? { more: `${r.failed - 20} more failing rows: flow_scale_result { id: "${id}", status: "failed" }` } : {}),
          };
        } finally {
          writer.close();
          await ctx.dispose();
        }
      },
    },
    {
      name: 'flow_env_matrix',
      write: true,
      description:
        'Run a flow file in several environments (e.g. dev, staging) and compare: per environment its status, time and failing step; per step its status and ms in each environment (`differingSteps`: steps whose status differs); per value the flow extracted or returns (its output:) the value in each environment with `differs` marked. Production environments are refused unless the server allows them. The matrix is kept (flow_scale_result with its id).',
      inputSchema: {
        type: 'object',
        properties: { file: str('The flow file, a path inside tests/'), environments: { type: 'array', items: { type: 'string' }, description: 'Environment names, 1-20' } },
        required: ['file', 'environments'],
      },
      run: async (a) => {
        const { rel, abs } = flowFile(a.file);
        const envs = Array.isArray(a.environments) ? a.environments.map((e) => d.checkEnvironment(e)).filter((e): e is string => !!e) : [];
        if (!envs.length) throw new ApsError('ValidationError', 'Give the environments to compare (environments: ["dev", "staging"])');
        const m = await runFlowMatrix({ file: abs, environments: envs, contextFor: (environment) => createEngineContext({ store, secrets: d.secrets, settings: d.settings, environment }) });
        const id = scaleRunId('matrix');
        const { status } = saveScaleRun(store, { id, kind: 'matrix', ...m, file: rel });
        return { id, status, ...m, file: rel, columns: m.columns.map(({ results: _r, ...c }) => c) };
      },
    },
    {
      name: 'flow_scale_result',
      description:
        "Read back a data run or an environment matrix by id (from flow_data_run / flow_env_matrix, or the app): a data run's rows in row order, a page at a time (`offset`, `limit` up to 500, `status` all / failed / passed / cancelled / skipped), or one row's step results (`row`: its index); a matrix in full (with `environment`: that environment's step results).",
      inputSchema: {
        type: 'object',
        properties: {
          id: str('The data run or matrix id (data-… / matrix-…)'),
          offset: { type: 'number' },
          limit: { type: 'number' },
          status: { type: 'string', enum: ['all', 'failed', 'passed', 'cancelled', 'skipped'] },
          row: { type: 'number', description: "A data run: this row's step results" },
          environment: str("A matrix: this environment's step results"),
        },
        required: ['id'],
      },
      run: (a) => {
        const id = String(a.id ?? '');
        const run = readScaleRun(store, id);
        if (run.kind === 'matrix') {
          if (typeof a.environment === 'string') {
            const c = run.columns.find((x) => x.environment.toLowerCase() === String(a.environment).toLowerCase());
            if (!c) throw new ApsError('ValidationError', `No environment "${String(a.environment)}" in ${id}: ${run.environments.join(', ')}`);
            return { id, environment: c.environment, status: c.status, steps: c.results.map(step) };
          }
          return { ...run, status: scaleRunRow(run).status, columns: run.columns.map(({ results: _r, ...c }) => c) };
        }
        if (typeof a.row === 'number') {
          const steps = readScaleRunSteps(store, id, a.row);
          if (!steps)
            return {
              id,
              row: a.row,
              note: 'The full step results of this row were not kept (they are for failing rows and the first 100 passing ones); the row page has each step’s status and time.',
            };
          return { id, row: a.row, steps: steps.map(step) };
        }
        const { failedRows: _f, ...rest } = run;
        const summary = { ...rest, status: scaleRunRow(run).status };
        return {
          summary,
          ...readScaleRows(store, id, {
            offset: typeof a.offset === 'number' ? a.offset : 0,
            limit: typeof a.limit === 'number' ? a.limit : 100,
            status: (typeof a.status === 'string' ? a.status : 'all') as RowFilter,
          }),
        };
      },
    },
    {
      name: 'flow_timeline',
      description:
        "A run of a flow file as a timeline (the latest run, or `run_id`; see flow_runs): each step's start and end (ms from the run's start), how long it waited and for which step, lanes (steps that ran at the same time), the critical path (the chain of steps that decided the total time), the total, the time waiting, the slowest steps. `html` writes the same picture as a self-contained HTML file in the workspace (no network needed to view it) and returns its path.",
      inputSchema: {
        type: 'object',
        properties: {
          file: str('The flow file, a path inside tests/ (or leave it out and give run_id: the timeline of the whole run)'),
          run_id: str('The run (default: the latest of the file)'),
          html: str('Write the HTML report here (a path inside the workspace, e.g. reports/checkout-timeline.html)'),
        },
      },
      run: async (a) => {
        const runId = typeof a.run_id === 'string' && a.run_id ? a.run_id : undefined;
        const rel = a.file ? flowFile(a.file).rel : undefined;
        if (!rel && !runId) throw new ApsError('ValidationError', 'Give the flow file, or a run_id');
        const t = rel ? await flowRunTimeline(store, rel, runId) : await runTimeline(store, runId!);
        if (typeof a.html === 'string' && a.html) {
          const out = store.safePath(a.html);
          mkdirSync(dirname(out), { recursive: true });
          const h = await flowRunTimelineHtml(store, rel, t.runId);
          writeFileSync(out, h.html);
          return { ...t, html: a.html };
        }
        return t;
      },
    },
  ];
}
