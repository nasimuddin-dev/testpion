import { responseOfResult, requestOfResult } from '../ai/run-evidence.js';
import { ApsError } from '../errors.js';
import type { TestResult } from '../model/types.js';
import { finishedRun } from '../runner/result-source.js';
import { runResults } from '../runner/run-results.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { Redactor } from '../util/redact.js';
import { createShareBundle } from './bundle.js';
import { strictHarRedactor } from './har.js';
import type { DebuggerExchange } from './proxy-types.js';

/**
 * A repro bundle of a run's failures (`testpion debugger repro`, MCP `debugger_repro`, RPC `run.repro`, Run results ▸
 * Repro bundle…): the failing HTTP steps as they were sent and answered, in one `.tpbundle` file (the share bundle of
 * the Debugger: a masked HAR, facts about this computer, notes). Whoever gets it opens it in TestPion (Debugger ▸ Open
 * session) or with `testpion debugger open`, sees each request and response, and resends or saves one as a request.
 * The notes say what failed: the run, each step's failed checks with what was expected and what came, its error.
 * Secrets are masked the strict way (authorization and cookie headers, tokens in URLs and bodies): the bundle shows
 * what happened, it does not carry the credentials to do it again.
 */
export interface ReproOptions {
  /** Only these results (ids from the run); default: every failed or errored step. */
  results?: string[];
  /** Every HTTP step of the run, the passing ones too (what led up to the failure). */
  all?: boolean;
  /** Your own words, put above the generated notes. */
  notes?: string;
  redactor?: Redactor;
  now?: Date;
}

export interface ReproBundle {
  bytes: Buffer;
  /** A file name for it (`repro-<run>.tpbundle`). */
  name: string;
  run: { id: string; name: string; startedAt: string };
  /** The steps in the bundle. */
  steps: Array<{ id: string; name: string; status: string }>;
  /** Steps left out, and why (not an HTTP step, nothing was kept of its request). */
  skipped: Array<{ id: string; name: string; why: string }>;
  notes: string;
}

const lower = (h: Array<[string, string]> | Record<string, unknown> | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  if (Array.isArray(h)) for (const [k, v] of h) out[String(k).toLowerCase()] = String(v);
  else if (h && typeof h === 'object') for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  return out;
};

/** What the run kept of a step's request: its headers and body (the trace's HTTP span). */
function sentOf(store: WorkspaceStore, r: TestResult): { headers: Record<string, string>; body?: string } {
  if (r.traceId)
    try {
      for (const s of store.loadTrace(r.traceId)?.spans ?? []) {
        const i = s.input as { headers?: unknown; body?: unknown } | undefined;
        if (s.kind === 'http' && i && typeof i === 'object') return { headers: lower(i.headers as Record<string, unknown>), ...(typeof i.body === 'string' && i.body ? { body: i.body } : {}) };
      }
    } catch {
      /* a trace that is gone: the request line is still known */
    }
  return { headers: {} };
}

const text = (v: unknown): string => (typeof v === 'string' ? v : v === undefined ? '' : (JSON.stringify(v) ?? String(v))).slice(0, 300);

export async function reproBundle(store: WorkspaceStore, runId: string, o: ReproOptions = {}): Promise<ReproBundle> {
  const run = finishedRun(store, runId);
  const wanted = o.results?.length ? new Set(o.results) : undefined;
  const exchanges: DebuggerExchange[] = [];
  const steps: ReproBundle['steps'] = [];
  const skipped: ReproBundle['skipped'] = [];
  const lines: string[] = [];
  const seen = new Set<string>();
  for await (const r of runResults(store, run.runId)) {
    const failing = r.status === 'failed' || r.status === 'error';
    if (wanted ? !wanted.has(r.id) : !(o.all || failing)) continue;
    seen.add(r.id);
    const req = requestOfResult(r);
    if (r.type !== 'http' || !req?.url) {
      if (failing || wanted) skipped.push({ id: r.id, name: r.name, why: r.type !== 'http' ? `a ${r.type} step: the bundle carries HTTP requests` : 'the run kept nothing of its request' });
      continue;
    }
    const sent = sentOf(store, r);
    const { response } = responseOfResult(store, r);
    let host = '';
    try {
      host = new URL(req.url).host;
    } catch {
      /* a URL that never resolved (an unset variable): shown as it was */
    }
    const responseHeaders = lower(response?.headers);
    exchanges.push({
      id: `repro-${exchanges.length + 1}`,
      startedAt: r.startedAt,
      kind: 'http',
      method: req.method ?? 'GET',
      url: req.url,
      host,
      clientPort: 0,
      requestHeaders: sent.headers,
      ...(sent.body ? { requestBody: sent.body } : {}),
      requestBodyBytes: Buffer.byteLength(sent.body ?? ''),
      ...(response?.status ? { status: response.status } : {}),
      ...(response ? { responseHeaders } : {}),
      ...(response?.body !== undefined ? { responseBody: response.body } : {}),
      responseBodyBytes: Buffer.byteLength(response?.body ?? ''),
      ...(responseHeaders['content-type'] ? { contentType: responseHeaders['content-type'] } : {}),
      ...(r.latencyMs !== undefined ? { durationMs: r.latencyMs } : {}),
      ...(r.error ? { error: r.error.message } : {}),
      ...(failing ? { mark: 'red', note: `${r.status}: ${r.name}` } : {}),
    });
    steps.push({ id: r.id, name: r.name, status: r.status });
    if (!failing) continue;
    lines.push(`## ${r.name}`, '', `\`${req.method ?? 'GET'} ${req.url}\`${response?.status ? ` answered ${response.status}` : ' got no answer'}${r.latencyMs !== undefined ? ` in ${Math.round(r.latencyMs)} ms` : ''}.`, '');
    for (const c of r.checks.filter((c) => !c.passed)) lines.push(`- **${c.name || c.type}**: ${c.message || 'failed'}${c.expected !== undefined ? ` (expected ${text(c.expected)}, got ${text(c.actual)})` : ''}`);
    if (r.error) lines.push(`- **${r.error.kind}**: ${r.error.message}`);
    lines.push('');
  }
  for (const id of wanted ?? []) if (!seen.has(id)) throw new ApsError('ValidationError', `The run ${run.runId} has no result "${id}"`, { suggestions: ['`testpion history results <run> --json` lists the results with their ids.'] });
  if (!exchanges.length)
    throw new ApsError('ValidationError', skipped.length ? `Nothing to put in a repro bundle: ${skipped[0]!.why}` : o.all || wanted ? 'The run has no HTTP step to put in a repro bundle' : 'The run has no failed step: nothing to reproduce', {
      suggestions: skipped.length ? [] : ['Pass `all` to take every HTTP step of the run, the passing ones too.'],
    });
  const failed = steps.filter((s) => s.status !== 'passed').length;
  const head = [
    `# Repro: ${run.name || run.runId}`,
    '',
    `Run \`${run.runId}\` of ${run.startedAt}${(run as { environment?: string }).environment ? `, environment ${(run as { environment?: string }).environment}` : ''}: ${run.failed + (run.errors ?? 0)} of ${run.total} steps failed.`,
    `This bundle holds ${exchanges.length} request${exchanges.length === 1 ? '' : 's'}${failed && failed !== exchanges.length ? ` (${failed} failing, marked red)` : ''} as sent and answered. Secrets are masked: use your own credentials to send one again.`,
    '',
    'Open it in TestPion (Debugger ▸ Open session) or with `testpion debugger open <file>`; a row resends, or opens as a request.',
    '',
  ];
  const redactor = o.redactor ?? new Redactor();
  // masked here too, the strict way: what comes back to the caller (a terminal, an agent) is what the bundle holds
  const notes = strictHarRedactor(redactor).redactString([...(o.notes?.trim() ? [o.notes.trim(), ''] : []), ...head, ...lines, ...(skipped.length ? ['## Not in the bundle', '', ...skipped.map((s) => `- ${s.name}: ${s.why}`), ''] : [])].join('\n'));
  const name = `repro-${run.runId.replace(/[^\w.-]+/g, '_')}`;
  const { bytes } = await createShareBundle({ name, exchanges, notes, redactor, now: o.now });
  return { bytes, name: `${name}.tpbundle`, run: { id: run.runId, name: run.name, startedAt: run.startedAt }, steps, skipped, notes };
}
