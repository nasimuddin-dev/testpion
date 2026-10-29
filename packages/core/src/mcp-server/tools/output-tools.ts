import { mkdirSync } from 'node:fs';
import { dirname, relative, sep } from 'node:path';
import { OUTPUT_FORMATS, isOutputFormatId, outputSurface } from '@testpion/shared';
import { ApsError } from '../../errors.js';
import { OUTPUT_PARAMS, outputSourceFor, type OutputParams } from '../../output/params.js';
import { collectBuilt, prepareSource, storeOutputDeps } from '../../output/prepare.js';
import { writeChunks } from '../../output/write.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import type { Redactor } from '../../util/redact.js';
import { str, type Tool } from '../tool.js';
import { exportTarget } from './export-target.js';

/** What a call returns inline, by kind: more than this is cut and the call says to use `save_to` (the contract caps a string at 20,000 characters). */
const INLINE_TEXT = 15_000;
const INLINE_BINARY = 9_000;

/**
 * `save_output`: any output of the app (the down arrow in the window, `testpion output` in the CLI) as an agent asks for
 * it — the same builders, formats and secrets policy (core's output/). The bytes come back inline (text, or base64 for
 * a binary format; cut at a size the agent can read) or, with `save_to`, are written to a new file inside the workspace.
 * Values of secrets are never returned: surfaces that mask them stay masked, and there is no `include_secrets`.
 */
export function outputTools({ store, redactor }: { store: WorkspaceStore; redactor: Redactor }): Tool[] {
  const surfaces = Object.keys(OUTPUT_PARAMS);
  return [
    {
      name: 'save_output',
      write: true,
      description: `Get or save an output of TestPion as a file format: run results (HTML, JSON, JUnit, Markdown, CSV, ZIP), History (HAR, CSV, JSON), traces (OTLP JSON), a flow's timeline, a data run's rows or an evaluation matrix (CSV, JSON, Markdown, HTML), a monitor's runs, the runs list, the workspace's uncommitted changes (patch, Markdown), or a saved response body. The same bytes the app's download arrow and \`testpion output\` write. \`surface\` is one of: ${surfaces.join(', ')}; give the parameters it needs (run, file, data_run, runs, query, monitor, history_id …). Without \`save_to\` the content comes back (text; base64 for ZIP/PNG), cut at ${INLINE_TEXT.toLocaleString('en-US')} characters; with \`save_to\` it is written to a new file inside the workspace (never over an existing file or a definition) and only the path and size come back. Secrets stay masked.`,
      doc: {
        when: 'Use it to hand a report, an export or a list (run results as JUnit or CSV, History as HAR, the changes as a patch) to a person or a CI step as a file, in the format they asked for.',
        whenNot: 'To look at results yourself, use the tools that return structured data (`run_breakdown`, `history_list`, `monitor_results`, `git_diff`); this one returns a file format.',
        example: { surface: 'run.results', format: 'csv', run: 'run-2026-10-18-0932', save_to: 'exports/last-run.csv' },
        narrow: 'Use `save_to` for big outputs, or `limit` / `query`.',
      },
      inputSchema: {
        type: 'object',
        properties: {
          surface: { ...str(`The output: ${surfaces.join(', ')}`), enum: surfaces },
          format: str('The format (default: the output’s own); each output lists its formats in `testpion output --list --json`'),
          run: str('run.results, flow.timeline: the run id'),
          file: str('flow.timeline: a flow file in the workspace (its latest run)'),
          data_run: str('flow.grid: the data run or matrix id'),
          status: str('flow.grid: all, failed, passed, cancelled or skipped rows'),
          runs: { type: 'array', items: { type: 'string' }, description: 'eval.matrix: the evaluation run ids (columns)' },
          baseline: str('eval.matrix: the run to compare against'),
          query: str('history, traces, runs.overview: only entries matching this text'),
          kind: str('history: only this kind of entry (http, graphql, grpc, mcp, llm, websocket, capture)'),
          failed: { type: 'boolean', description: 'history, traces: only failed ones' },
          limit: { type: 'number', description: 'history, traces, monitor.runs, runs.overview: how many, newest first' },
          traces: { type: 'array', items: { type: 'string' }, description: 'traces: these trace ids' },
          monitor: str('monitor.runs: the monitor’s name or id'),
          path: str('git.diff: one file (default: every uncommitted change)'),
          staged: { type: 'boolean', description: 'git.diff: the staged changes only' },
          days: { type: 'number', description: 'workspace.report: days of activity (1 to 90)' },
          history_id: str('response.body, graphql.response: a History entry whose saved response body is the output'),
          save_to: str(
            'Write a new file here instead of returning the content: a path under exports/ or .local/exports/ (e.g. exports/run.csv); it must not exist, no other folder or program file is allowed. Needs confirm',
          ),
        },
        required: ['surface'],
      },
      run: async (a) => {
        const surface = String(a.surface ?? '');
        const info = outputSurface(surface);
        if (!info || !OUTPUT_PARAMS[surface])
          throw new ApsError('ValidationError', `${surface || '(no surface)'} cannot be saved with save_output`, { suggestions: [`Surfaces: ${surfaces.join(', ')}`] });
        const asked = a.format === undefined ? info.default : String(a.format);
        if (!isOutputFormatId(asked) || !info.formats.includes(asked))
          throw new ApsError('ValidationError', `${info.label} cannot be saved as ${asked}`, { suggestions: [`Formats: ${info.formats.join(', ')}`] });
        const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : undefined);
        const params: OutputParams = {
          run: a.run === undefined ? undefined : String(a.run),
          file: a.file === undefined ? undefined : String(a.file),
          dataRun: a.data_run === undefined ? undefined : String(a.data_run),
          status: a.status === undefined ? undefined : String(a.status),
          runs: list(a.runs),
          baseline: a.baseline === undefined ? undefined : String(a.baseline),
          query: a.query === undefined ? undefined : String(a.query),
          kind: a.kind === undefined ? undefined : String(a.kind),
          failed: a.failed === true ? true : undefined,
          limit: a.limit === undefined ? undefined : Number(a.limit),
          traces: list(a.traces),
          monitor: a.monitor === undefined ? undefined : String(a.monitor),
          path: a.path === undefined ? undefined : String(a.path),
          staged: a.staged === true ? true : undefined,
          days: a.days === undefined ? undefined : Number(a.days),
          historyId: a.history_id === undefined ? undefined : String(a.history_id),
        };
        // the target is checked before anything is built
        let target: string | undefined;
        if (typeof a.save_to === 'string' && a.save_to) target = exportTarget(store, a.save_to, { what: 'saved outputs', arg: 'save_to' });
        const source = outputSourceFor(store, surface, asked, params);
        const ac = new AbortController();
        const r = await prepareSource(storeOutputDeps(store, redactor), { surface, format: asked, source }, ac.signal, 'save_output');
        const fmt = OUTPUT_FORMATS[asked];
        const head = { surface, format: asked, label: fmt.label, redacted: r.built.redacted || (r.redacting && fmt.text), ...(r.notice ? { notice: r.notice } : {}) };
        if (target) {
          mkdirSync(dirname(target), { recursive: true });
          let bytes = 0;
          await writeChunks(r.built.chunks, target, { onBytes: (n) => (bytes += n) });
          return { ...head, saved: relative(store.root, target).split(sep).join('/'), bytes };
        }
        const limit = fmt.text ? INLINE_TEXT : INLINE_BINARY;
        const got = await collectBuilt(r.built, limit);
        const note = got.truncated ? { truncated: true, note: `Cut at ${limit} bytes of ${got.total}: use save_to to write the whole file.` } : {};
        // a cut multi-byte character is dropped, not half-written
        return fmt.text
          ? { ...head, bytes: got.total, text: got.bytes.toString('utf8').replace(/�$/, ''), ...note }
          : { ...head, bytes: got.total, encoding: 'base64', base64: got.bytes.toString('base64'), ...note };
      },
    },
  ];
}
