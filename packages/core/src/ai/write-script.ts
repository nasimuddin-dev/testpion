/**
 * AI-6 · Write a tp.* script (the script editors' "Write this script with AI", `testpion ai script`, MCP `write_script`):
 * a pre-request or post-response script for what the person describes — or a script that threw, fixed with its error and
 * logs — written against the script API as the sandbox really has it (script-reference.ts; never pm.*) and run once in the
 * sandbox before it is offered.
 *
 * The verifier (`script-dry-run`) is the proof: the static check names every member that does not exist and what to
 * write instead (that is what a repair turn sends back), then the script is parsed and run in the QuickJS sandbox — a
 * pre-request script against the request it is for (no network: `tp.sendRequest` is reported, not sent), a post-response
 * script against the response on screen (and the one before it) — and the badge says what it did: the variables it
 * set, the headers or URL it changed, the tests it ran. A script that throws is repaired, not offered as ready.
 */
import { ApsError } from '../errors.js';
import { runScript } from '../scripts/sandbox.js';
import type { ItemRef } from '@testpion/shared';
import type { WorkspaceStore } from '../storage/workspace.js';
import { contextOfItem } from './item-context.js';
import { loadScriptApi, scriptApiProblems } from './script-reference.js';
import type { AiTaskInput, DraftItem, PreparedItem } from './tasks/registry.js';
import { stringList } from '../util/collections.js';
import type { VerificationBadge } from './proposal.js';
import { registerVerifier, type StoredResponse } from './verify.js';

type ScriptPhase = 'pre' | 'test';

export const SCRIPT_PLAN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['script'],
  properties: {
    script: { type: 'string', description: 'The whole script: tp.* only, plain JavaScript, no network, no imports' },
    explanation: { type: 'string', description: 'What it does, in one or two sentences' },
    assumptions: { type: 'array', items: { type: 'string' }, description: 'What you assumed that the context does not say (the shape of the response, the name of a variable)' },
  },
};

/** The request a pre-request script is tried on (kept with the item for its verification). */
export interface SampleRequest {
  method: string;
  url: string;
  headers: Array<{ key: string; value: string }>;
  body?: string;
}

const phaseOf = (v: unknown): ScriptPhase => (v === 'pre' || v === 'pre-request' || v === 'prerequest' ? 'pre' : 'test');

/** The request as the editor or an item gives it: method, URL, headers (list or map) and a text body. */
function sampleRequest(v: unknown): SampleRequest | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  const url = typeof r.url === 'string' ? r.url : '';
  if (!url) return undefined;
  const h = r.headers;
  const headers = Array.isArray(h)
    ? h.filter((x): x is { key: string; value: string } => !!x && typeof (x as { key?: unknown }).key === 'string').map((x) => ({ key: x.key, value: String(x.value ?? '') }))
    : h && typeof h === 'object'
      ? Object.entries(h as Record<string, unknown>).map(([key, value]) => ({ key, value: String(value ?? '') }))
      : [];
  const body = typeof r.body === 'string' ? r.body : (r.body as { content?: unknown } | undefined)?.content;
  return { method: String(r.method ?? 'GET').toUpperCase(), url, headers, ...(typeof body === 'string' ? { body } : {}) };
}

/** What `prepare` keeps for building the item: where it goes, what it replaces. */
interface ScriptLocal {
  phase: ScriptPhase;
  mode: 'replace' | 'append';
  current: string;
  request?: SampleRequest;
}

/**
 * The task's context: the description is the question; with an item (a saved request) its request and latest response are
 * read from the workspace; the caller adds `phase`, the current `script` and, to fix one, its `error` and `logs`.
 */
export async function prepareScriptContext(store: WorkspaceStore, item: ItemRef, o: { context?: Record<string, unknown> } = {}): Promise<PreparedItem> {
  const c = o.context ?? {};
  const phase = phaseOf(c.phase);
  const base = item.kind === 'request' ? await contextOfItem(store, item) : undefined;
  // the request as the editor has it (unsaved edits included) wins over the saved one
  const requestIn = (c.request ?? base?.context.request) as Record<string, unknown> | undefined;
  const local: ScriptLocal = {
    phase,
    mode: c.mode === 'append' ? 'append' : 'replace',
    current: typeof c.script === 'string' ? c.script : typeof (requestIn as { testScript?: unknown } | undefined)?.testScript === 'string' && phase === 'test' ? String((requestIn as { testScript: string }).testScript) : '',
    request: sampleRequest(requestIn),
  };
  return {
    label: base?.label ?? 'script',
    local,
    ...(base?.response ? { response: base.response } : {}),
    ...(base?.previous ? { previous: base.previous } : {}),
    ...(base?.collection ? { collection: base.collection } : {}),
    context: {
      ...(base?.context ?? {}),
      ...c,
      phase: phase === 'pre' ? 'pre (runs before the request is sent)' : 'test (runs after the response)',
      ...(local.current ? { script: local.current } : {}),
    },
  };
}

/** The script of the model's answer: the code only (a fence the model added is removed). */
function scriptOfValue(v: unknown): string {
  const raw = (v as { script?: unknown } | undefined)?.script;
  if (typeof raw !== 'string' || !raw.trim()) throw new ApsError('ValidationError', 'The answer has no script');
  const fenced = /^\s*```(?:javascript|js|typescript|ts)?\s*\n([\s\S]*?)\n```\s*$/.exec(raw);
  return (fenced ? fenced[1]! : raw).replace(/\r\n/g, '\n').trim();
}

/** The proposal item of a script (registry `propose`): replaces the editor's script or is added after it. */
export function proposeScript(a: { value?: unknown }, input: AiTaskInput): DraftItem[] {
  // without an item the caller passed the context itself (the editor: phase, the script on screen, the request)
  const local: ScriptLocal = (input.local as ScriptLocal | undefined) ?? {
    phase: phaseOf(input.context?.phase),
    mode: input.context?.mode === 'append' ? 'append' : 'replace',
    current: typeof input.context?.script === 'string' ? input.context.script : '',
    request: sampleRequest(input.context?.request),
  };
  const code = scriptOfValue(a.value);
  const after = `// AI-generated script (${input.model}): review it before relying on it.\n${code}\n`;
  const req = input.item?.kind === 'request' ? input.item : undefined;
  return [
    {
      kind: 'script',
      title: local.phase === 'pre' ? 'Pre-request script' : 'Post-response script',
      after,
      before: local.current || undefined,
      language: 'javascript',
      ...(req ? { target: req } : {}),
      data: { phase: local.phase, mode: local.mode, scriptTask: { phase: local.phase, request: local.request } },
    },
  ];
}

/** The summary and assumptions of the proposal (registry `describe`). */
export function describeScript(value: unknown): { summary?: string; assumptions?: string[] } {
  const v = (value ?? {}) as { explanation?: unknown; assumptions?: unknown };
  return { summary: typeof v.explanation === 'string' ? v.explanation.slice(0, 1200) : undefined, assumptions: stringList(v.assumptions, 10) };
}

/* ------------------------------------------------------------------ verification */

const POSTMAN_API = /(^|[^\w$.])(pm|postman)\s*\.\s*[A-Za-z_$]/;

/** What a script did in the sandbox, in words ("sets nonce; adds the X-Trace header; runs 3 tests"). */
function effects(out: Awaited<ReturnType<typeof runScript>>, before?: SampleRequest): string[] {
  const set = [...Object.keys(out.vars), ...Object.values(out.scopeSets).flatMap((s) => Object.keys(s))];
  const list: string[] = [];
  if (set.length) list.push(`sets ${[...new Set(set)].slice(0, 5).join(', ')}`);
  if (out.request && before) {
    const was = new Set(before.headers.map((h) => h.key.toLowerCase()));
    const added = out.request.headers.filter((h) => !was.has(h.key.toLowerCase())).map((h) => h.key);
    if (added.length) list.push(`adds the ${added.slice(0, 3).join(', ')} header${added.length === 1 ? '' : 's'}`);
    if (out.request.url !== before.url) list.push('changes the URL');
    if ((out.request.body ?? '') !== (before.body ?? '')) list.push('changes the body');
  }
  const tests = out.tests.filter((t) => !t.skipped);
  if (tests.length) list.push(`runs ${tests.length} test${tests.length === 1 ? '' : 's'}`);
  return list;
}

/**
 * Parse and dry-run a script (see the module comment). A post-response script is also tried on the response before the
 * current one: a test that passes now but failed then depends on a value that changes.
 */
export async function dryRunScript(code: string, phase: ScriptPhase, o: { request?: SampleRequest; response?: StoredResponse; previous?: StoredResponse }): Promise<VerificationBadge> {
  const misuse = scriptApiProblems(code, await loadScriptApi());
  if (misuse.length)
    return {
      verifier: 'script-dry-run',
      status: 'fail',
      label: POSTMAN_API.test(code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')) ? 'uses pm.* / postman.*' : 'misuses the tp.* script API',
      detail: misuse.slice(0, 6).join('\n'),
    };
  if (/\b(async|await|import|fetch|XMLHttpRequest)\b|\brequire\s*\(\s*['"](?!crypto-js['"]|uuid['"])/.test(code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""')))
    return { verifier: 'script-dry-run', status: 'fail', label: 'uses something the sandbox does not have', detail: 'The sandbox is synchronous and has no network, imports or fetch: use tp.sendRequest for a request (it is not run here), tp.require("crypto-js") for hashing.' };
  const input = (r: StoredResponse | undefined) => ({
    variables: {},
    ...(phase === 'pre' ? { request: o.request ?? { method: 'GET', url: 'https://example.test/', headers: [] } } : { response: r ? { status: r.status, headers: r.headers, body: r.body, time: r.latencyMs } : undefined, ...(o.request ? { request: o.request } : {}) }),
  });
  if (phase === 'test' && o.response && o.response.latencyMs === undefined && /\bresponseTime\b/.test(code))
    return { verifier: 'script-dry-run', status: 'fail', label: 'reads the response time, which the response it was written for does not have', detail: 'Leave the timing out, or send the request again and write the script for that response.' };
  // a post-response script with no response to run it on (an agent's call, a request never sent): parsed, and tried on an empty answer
  // only for syntax and obvious mistakes — a failure there proves nothing about the script
  if (phase === 'test' && !o.response) {
    const probe = await runScript(code, { variables: {}, response: { status: 200, headers: [['content-type', 'application/json']], body: '{}' }, ...(o.request ? { request: o.request } : {}) }, { timeoutMs: 3000, maxRequests: 0 });
    if (probe.error && /SyntaxError|is not defined|not a function/i.test(probe.error)) return { verifier: 'script-dry-run', status: 'fail', label: 'the script does not run', detail: probe.error };
    return { verifier: 'script-dry-run', status: 'skip', label: 'parsed; no response to run it on', detail: 'Send the request and write the script for that response to have it tried.' };
  }
  const out = await runScript(code, input(o.response), { timeoutMs: 3000, maxRequests: 0 });
  if (out.error) return { verifier: 'script-dry-run', status: 'fail', label: 'the script throws', detail: out.error };
  const sent = out.logs.some((l) => /sendRequest is not available/.test(l));
  const did = effects(out, phase === 'pre' ? (o.request ?? { method: 'GET', url: 'https://example.test/', headers: [] }) : undefined);
  const failed = out.tests.filter((t) => !t.skipped && !t.passed);
  if (failed.length)
    return {
      verifier: 'script-dry-run',
      status: 'fail',
      label: `${failed.length} of ${out.tests.filter((t) => !t.skipped).length} tests fail on the response`,
      detail: failed
        .slice(0, 5)
        .map((t) => `${t.name}: ${t.message ?? 'failed'}`)
        .join('\n'),
    };
  if (phase === 'test' && o.previous?.body !== undefined && out.tests.length) {
    const before = await runScript(code, input(o.previous), { timeoutMs: 3000, maxRequests: 0 });
    const flaky = before.tests.filter((t) => !t.skipped && !t.passed);
    if (before.error || flaky.length)
      return { verifier: 'script-dry-run', status: 'fail', label: 'passes now but failed on the previous response: it depends on a value that changes', detail: before.error ?? flaky.map((t) => `${t.name}: ${t.message ?? 'failed'}`).join('\n') };
  }
  if (sent) return { verifier: 'script-dry-run', status: 'warn', label: `ran without error${did.length ? `: ${did.join('; ')}` : ''}; tp.sendRequest was not sent`, detail: 'The sandbox sends no request while checking: its callback was not run.' };
  if (!did.length) return { verifier: 'script-dry-run', status: 'warn', label: 'ran without error, but changed nothing', detail: out.logs.slice(0, 3).join('\n') || undefined };
  return { verifier: 'script-dry-run', status: 'pass', label: `parsed · ran in the sandbox: ${did.join('; ')}` };
}

registerVerifier('script-dry-run', (item, ctx) => {
  if (item.kind !== 'script') return undefined;
  const d = (item.data as { phase?: string; scriptTask?: { phase?: ScriptPhase; request?: SampleRequest } } | undefined) ?? {};
  return dryRunScript(item.after, d.scriptTask?.phase ?? phaseOf(d.phase), { request: d.scriptTask?.request, response: ctx.response, previous: ctx.previous });
});

export const SCRIPT_VERIFIERS = ['script-dry-run'];
