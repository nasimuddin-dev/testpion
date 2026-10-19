/**
 * Which outputs a CLI or an MCP server can save, and from which parameters: the one table both read, so
 * `testpion output <surface> --run r1` and `save_output {surface, run: "r1"}` name the same things. The surfaces whose
 * content only the window holds (the console of a running app, a selected Debugger exchange, a chart) are not here:
 * they are saved from the app.
 */
import { outputSurface, type OutputFormatId, type OutputSource } from '@testpion/shared';
import { ApsError } from '../errors.js';
import type { WorkspaceStore } from '../storage/workspace.js';

/** The parameters of a saved output, as the CLI options and the MCP arguments name them. */
export interface OutputParams {
  /** A run's id (run results, a run's flow timeline). */
  run?: string;
  /** A flow file in the workspace (its latest run's timeline). */
  file?: string;
  /** A data run's or matrix's id (the Scale stage). */
  dataRun?: string;
  /** Rows of a data run: all, failed, passed, cancelled or skipped. */
  status?: string;
  /** Evaluation runs (the matrix's columns) and the run they are compared against. */
  runs?: string[];
  baseline?: string;
  /** History / traces / runs: a text filter, the kind of History entry, only failed ones, how many. */
  query?: string;
  kind?: string;
  failed?: boolean;
  limit?: number;
  /** Trace ids. */
  traces?: string[];
  /** A monitor's name or id. */
  monitor?: string;
  /** The workspace's changes: one file, or the staged ones. */
  path?: string;
  staged?: boolean;
  /** workspace.report: days of activity. */
  days?: number;
  /** A History entry whose saved response body is the output. */
  historyId?: string;
}

/** Per surface the CLI / MCP can build: its parameters (the first is required unless it says otherwise) and what they mean. */
export const OUTPUT_PARAMS: Record<string, { params: Array<keyof OutputParams>; required?: Array<keyof OutputParams>; hint: string }> = {
  'run.results': { params: ['run'], required: ['run'], hint: 'the run id (`testpion history test`, the app)' },
  'flow.timeline': { params: ['run', 'file'], hint: 'a run id, or a flow file (its latest run)' },
  'flow.grid': { params: ['dataRun', 'status'], required: ['dataRun'], hint: 'the data run or matrix id (`testpion flow runs`)' },
  'eval.matrix': { params: ['runs', 'baseline'], required: ['runs'], hint: 'the evaluation run ids (the matrix columns), and a baseline run to compare with' },
  history: { params: ['query', 'kind', 'failed', 'limit'], hint: 'filters as `testpion history list`' },
  traces: { params: ['traces', 'query', 'kind', 'failed', 'limit'], hint: 'trace ids, or filters for the newest' },
  'monitor.runs': { params: ['monitor', 'limit'], required: ['monitor'], hint: 'the monitor’s name or id' },
  'runs.overview': { params: ['query', 'limit'], hint: 'filters of the runs list' },
  'git.diff': { params: ['path', 'staged'], hint: 'one file, or all uncommitted changes' },
  'workspace.report': { params: ['days'], hint: 'days of activity (1 to 90, default 14)' },
  'response.body': { params: ['historyId'], required: ['historyId'], hint: 'a History entry id (`testpion history list`)' },
  'graphql.response': { params: ['historyId'], required: ['historyId'], hint: 'a History entry id (`testpion history list`)' },
};

/** The surfaces `output` can save from a workspace, with their formats and parameters (`testpion output --list`). */
export function listOutputSurfaces(): Array<Record<string, unknown>> {
  return Object.entries(OUTPUT_PARAMS).map(([id, p]) => {
    const s = outputSurface(id)!;
    return {
      surface: id,
      label: s.label,
      formats: s.formats,
      default: s.default,
      redaction: s.redaction,
      includeSecrets: s.redaction === 'redacted-default' && !s.capturedRedacted,
      params: p.params.map((name) => ({ name, option: `--${name.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`, mcp: name.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`), required: !!p.required?.includes(name) })),
      hint: p.hint,
    };
  });
}

const need = (value: unknown, surface: string, name: string, hint: string) => {
  if (value === undefined || value === '' || (Array.isArray(value) && !value.length)) throw new ApsError('ValidationError', `${surface} needs ${name}`, { suggestions: [hint] });
};

/** The source of a surface from the parameters given, or a ValidationError saying what is missing / not saved from here. */
export function outputSourceFor(store: WorkspaceStore, surface: string, format: OutputFormatId, p: OutputParams): OutputSource {
  const table = OUTPUT_PARAMS[surface];
  if (!table)
    throw new ApsError('ValidationError', `${surface} cannot be saved from the command line or MCP: ${outputSurface(surface) ? 'only the app holds its content' : 'unknown surface'}`, {
      suggestions: [`Surfaces: ${Object.keys(OUTPUT_PARAMS).join(', ')}`],
    });
  for (const r of table.required ?? []) need(p[r], surface, r, table.hint);
  const limit = p.limit === undefined ? undefined : Number(p.limit);
  switch (surface) {
    case 'run.results':
      return { kind: 'run', runId: p.run! };
    case 'flow.timeline':
      if (!p.run && !p.file) need(undefined, surface, 'run or file', table.hint);
      return { kind: 'flow-timeline', runId: p.run, file: p.file };
    case 'flow.grid':
      return { kind: 'grid', grid: 'scale-rows', params: { id: p.dataRun, ...(p.status ? { status: p.status } : {}) } };
    case 'eval.matrix':
      return { kind: 'grid', grid: 'eval-matrix', params: { runs: p.runs, ...(p.baseline ? { baseline: p.baseline } : {}) } };
    case 'history':
      return { kind: 'history', query: p.query, historyKind: p.kind, failed: p.failed, limit };
    case 'traces':
      return { kind: 'traces', ids: p.traces, query: p.query, traceKind: p.kind, failed: p.failed, limit };
    case 'monitor.runs':
      return { kind: 'monitor-runs', monitor: p.monitor!, limit };
    case 'runs.overview':
      return { kind: 'runs-overview', query: p.query, limit };
    case 'workspace.report':
      return { kind: 'workspace-report', days: p.days === undefined ? undefined : Number(p.days), tzOffsetMin: new Date().getTimezoneOffset() };
    case 'git.diff':
      return { kind: 'git-diff', path: p.path, staged: p.staged };
    default: {
      // a History entry's saved response body
      const h = store.meta.getHistory(p.historyId!);
      if (!h?.payloadPath) throw new ApsError('ConfigurationError', `History entry ${p.historyId} has no saved response body`, { suggestions: ['`testpion history list` shows the entries.'] });
      return { kind: 'response', payloadPath: h.payloadPath, part: format === 'json' || format === 'json-min' ? 'pretty' : 'body' };
    }
  }
}
