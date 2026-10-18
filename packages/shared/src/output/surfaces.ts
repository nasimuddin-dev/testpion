/**
 * Every output of the app that can be downloaded (the down arrow): its id (the `data-output="<id>"` marker on the
 * panel), what it is, its formats, its secrets policy and whether it ships. The window, the backend (which applies
 * the policy, never trusting the window's word for it), the docs and the completeness test read this one list.
 */
import type { OutputFormatId } from './formats.js';
import type { GridSourceId } from './grid-sources.js';

/**
 * - `redacted-default`: log-like output; secrets are masked unless the person confirms "Include secrets…".
 * - `raw-notice`: the person's own data (a response body), saved as is, with a notice when it looks like it holds a secret.
 * - `none`: nothing secret in it (timings, a lint report).
 */
export type OutputRedaction = 'redacted-default' | 'raw-notice' | 'none';

/** A surface's id: one of OUTPUT_SURFACES (the `data-output` marker, OutputSpec.id, the `surface` of output.save). */
export type OutputSurfaceId = (typeof SURFACES)[number]['id'];

export interface OutputSurfaceInfo extends SurfaceFields {
  id: OutputSurfaceId;
}

/** A surface without its id (what the list below declares; the id is each entry's literal). */
interface SurfaceFields {
  label: string;
  formats: readonly OutputFormatId[];
  default: OutputFormatId;
  redaction: OutputRedaction;
  /**
   * Its secrets are masked before the output is built (when they are captured, or by the producer itself), so there is
   * nothing to include: the control shows the Redacted mark but no "Include secrets…". The console and the application
   * log keep only redacted values; a run's results and reports are redacted as each result is recorded (runner.ts),
   * traces as their spans are recorded (Tracer), the response pane's cURL by `http.code`, data-run rows and matrix
   * values by the scale runner, and the Debugger's HAR by `exchangesToHar` (also for saved sessions, which are stored
   * sanitized).
   */
  capturedRedacted?: true;
  /**
   * The backend sources this surface may be built from (`output.save` with a `source`): what binds a source to the
   * surface's policy, so a caller cannot pair the console (redacted) with a surface whose policy is `none`. A surface
   * without any is only ever saved from content the window built.
   */
  sources?: readonly OutputSource['kind'][];
  /** The CLI command that writes the same output (release B adds --out / --format everywhere). */
  cli?: string;
  /** true: shipped (the panel is marked and has the control); planned: comes in that release. */
  state: true | { planned: string };
}

/**
 * Output the backend builds and streams into the file (big, or held only there): the window names it, never sends it.
 */
export type OutputSource =
  | { kind: 'response'; payloadPath: string; part?: 'body' | 'pretty' }
  | { kind: 'run'; runId: string }
  | { kind: 'flow-timeline'; runId?: string; file?: string }
  | { kind: 'console' }
  | { kind: 'logs' }
  | { kind: 'debugger' }
  | { kind: 'grid'; grid: GridSourceId; params: Record<string, unknown> };

const s =<I extends string>(id: I, label: string, formats: OutputFormatId[], redaction: OutputRedaction, extra: Partial<SurfaceFields> = {}): SurfaceFields & { id: I } => ({
  id,
  label,
  formats,
  default: formats[0]!,
  redaction,
  state: true,
  ...extra,
});
const B = { state: { planned: 'release B' } } as const;

const SURFACES = [
  // the response of a request (REST, SOAP), one per tab of the response pane
  s('response.body', 'Response body', ['raw', 'json', 'json-min', 'csv', 'tsv', 'html', 'xml', 'text', 'har', 'md'], 'raw-notice', { cli: 'send --json', sources: ['response'] }),
  s('response.headers', 'Response headers', ['json', 'csv', 'text'], 'raw-notice'),
  s('response.cookies', 'Response cookies', ['json', 'csv', 'cookies-txt'], 'raw-notice'),
  s('response.jwt', 'Decoded JWTs', ['json'], 'redacted-default'),
  s('response.timeline', 'Response timeline', ['json', 'har', 'md'], 'none'),
  s('response.tests', 'Response checks', ['json', 'junit', 'md'], 'none'),
  s('response.stream', 'Response stream', ['text'], 'raw-notice'),
  s('response.events', 'Server-sent events', ['jsonl', 'csv', 'text'], 'raw-notice'),
  s('response.trace', 'Request trace', ['json'], 'redacted-default', { capturedRedacted: true }),
  s('response.history', 'Response history', ['json', 'csv'], 'raw-notice'),
  s('response.curl', 'cURL command', ['curl', 'text'], 'redacted-default', { capturedRedacted: true }),
  // the other protocols
  s('graphql.response', 'GraphQL response', ['json', 'json-min', 'raw', 'csv'], 'raw-notice', { sources: ['response'] }),
  s('graphql.events', 'GraphQL subscription events', ['jsonl', 'json'], 'raw-notice'),
  s('grpc.response', 'gRPC response, metadata and trailers', ['json', 'jsonl', 'csv'], 'raw-notice'),
  s('ws.log', 'Message log (WebSocket, Socket.IO, MQTT, Kafka)', ['jsonl', 'csv', 'text', 'json'], 'raw-notice'),
  s('mcp.tool-result', 'MCP tool result', ['json', 'md', 'text'], 'raw-notice'),
  s('code.generated', 'Generated code', ['text'], 'redacted-default'),
  // runs and results
  s('run.results', 'Run results', ['html', 'json', 'junit', 'md', 'csv', 'zip'], 'redacted-default', { cli: 'run-collection -o / -r', capturedRedacted: true, sources: ['run'] }),
  s('flow.timeline', 'Flow run timeline', ['html', 'json'], 'redacted-default', { cli: 'flow report --html', capturedRedacted: true, sources: ['flow-timeline'] }),
  s('flow.grid', 'Flow data / scale / matrix rows', ['csv', 'json', 'html'], 'redacted-default', { capturedRedacted: true, sources: ['grid'] }),
  s('load.results', 'Load test results', ['json', 'csv', 'html', 'md'], 'none', { cli: 'load --json' }),
  s('eval.matrix', 'Evaluation matrix', ['csv', 'json', 'md', 'html'], 'none', { sources: ['grid'] }),
  // logs
  s('console', 'Console', ['text', 'jsonl'], 'redacted-default', { capturedRedacted: true, sources: ['console'] }),
  s('logs', 'Application log', ['text', 'jsonl'], 'redacted-default', { capturedRedacted: true, sources: ['logs'] }),
  s('terminal', 'Terminal transcript', ['text'], 'redacted-default'),
  s('problems', 'Problems', ['md', 'json', 'csv'], 'none'),
  s('debugger.session', 'HTTP Debugger session', ['har', 'json', 'csv'], 'redacted-default', { cli: 'debug -o', capturedRedacted: true, sources: ['debugger'] }),
  // release B
  s('history', 'History', ['har', 'csv', 'json'], 'redacted-default', B),
  s('traces', 'Traces', ['json'], 'redacted-default', B),
  s('debugger.exchange', 'Debugger exchange', ['har', 'text'], 'redacted-default', B),
  s('mcp.resource', 'MCP resource', ['raw'], 'raw-notice', B),
  s('mcp.prompt', 'MCP prompt output', ['json', 'md'], 'raw-notice', B),
  s('mcp.trace', 'MCP protocol trace', ['jsonl'], 'redacted-default', B),
  s('ai.answers', 'AI answers, proposals and analyses', ['md', 'json'], 'redacted-default', B),
  s('git.diff', 'Git changes', ['diff', 'md'], 'none', B),
  s('api.reports', 'API lint, fuzz, coverage, security and OpenAPI diff reports', ['md', 'json'], 'none', B),
  s('chart', 'Charts', ['png', 'svg', 'csv'], 'none', B),
  s('env.matrix', 'Environment matrix and compare', ['csv', 'md', 'json'], 'redacted-default', B),
  s('monitor.runs', 'Monitor runs', ['csv', 'json'], 'none', B),
  s('runs.overview', 'Runs overview and test history', ['csv', 'json'], 'none', B),
  s('settings.diagnostics', 'Settings diagnostics', ['text', 'json'], 'redacted-default', B),
] as const;

export const OUTPUT_SURFACES: readonly OutputSurfaceInfo[] = SURFACES;

const BY_ID = new Map<string, OutputSurfaceInfo>(OUTPUT_SURFACES.map((x) => [x.id, x]));

/** The surface with this id, or undefined. */
export const outputSurface = (id: string): OutputSurfaceInfo | undefined => BY_ID.get(id);
