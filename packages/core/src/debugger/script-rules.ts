import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { scrubSecrets } from '@testpion/shared';
import { BoundedMap } from '../util/collections.js';
import { runScript } from '../scripts/sandbox.js';
import { isInsidePath } from './shaping.js';
import { scriptWantsResponse, type HeaderEdit, type DebuggerRule, type ReplySpec, type ScriptSpec } from './rules.js';
import type { DebuggerExchange } from './proxy-types.js';

/**
 * JS rule scripts (FG-21): a rule of kind `script` holds JavaScript that defines `onRequest(ctx)` and / or `onResponse(ctx)`. It runs
 * in the same QuickJS sandbox as collection scripts (a worker of the script pool when the host set one), with nothing but the
 * `ctx` it is handed: no network (`tp.sendRequest` is not offered), no files, no workspace packages, no environment or secrets.
 * Time (100 ms a hook by default, 2 s at most) and memory (16 MB) are limited; a script that fails or runs out of time is skipped
 * for that exchange and the traffic goes on as if the rule were not there (fail open), the error is kept for the rules panel.
 *
 *   function onRequest(ctx) {                       // ctx.request: method, url, host, headers (lower-case names), body (text, or undefined)
 *     ctx.request.headers['x-env'] = 'staging';     // set, or `delete`, a header
 *     if (ctx.request.url.includes('/admin')) ctx.reply(403, { error: 'no' });   // answer here; the server never sees it
 *     ctx.delay(200); ctx.highlight('red'); ctx.ignore(); console.log('seen');
 *   }
 *   function onResponse(ctx) {                      // ctx.response: status, headers, body (text); change them to rewrite the answer
 *     if (ctx.response.status === 500) ctx.response.status = 503;
 *   }
 *
 * This file turns that into the same pieces the declarative rules use (header edits, a body, a status, a reply, a delay), so the
 * proxy applies them the way it applies any rule.
 */

export const DEFAULT_HOOK_MS = 100;
export const MAX_HOOK_MS = 2000;
export const MAX_SCRIPT_BYTES = 64 * 1024;
const HOOK_MEMORY_MB = 16;
const MAX_BODY_FOR_SCRIPT = 1024 * 1024;

export type ScriptPhase = 'request' | 'response';

/** What a hook asked for, in the pieces the proxy applies. */
export interface HookEffects {
  requestHeaders?: HeaderEdit[];
  requestBody?: string;
  responseHeaders?: HeaderEdit[];
  responseBody?: string;
  setStatus?: number;
  reply?: ReplySpec;
  delayMs?: number;
  highlight?: string;
  ignore?: boolean;
}

export interface HookRun {
  rule: string;
  ruleName: string;
  phase: ScriptPhase;
  /** The script ran to its end (and defined this hook). */
  ran: boolean;
  /** The script does not define this hook: nothing happened. */
  noHook?: boolean;
  error?: string;
  logs: string[];
  ms: number;
  effects: HookEffects;
}

/* ---------------------------------------------------------------- the source */

const sources = new BoundedMap<string, { mtime: number; text: string }>(64); // bounded: 64 script files, the oldest goes first

/** The script's text: inline, or read from a file of the workspace (checked again when the file changes). */
export function scriptSourceOf(rule: Pick<DebuggerRule, 'script' | 'name'>, workspaceRoot: string | undefined): { source?: string; error?: string } {
  const s = rule.script;
  if (!s) return { error: 'The rule has no script' };
  if (s.code !== undefined) return s.code.length > MAX_SCRIPT_BYTES ? { error: `The script is over ${MAX_SCRIPT_BYTES / 1024} KB` } : { source: s.code };
  if (!s.file) return { error: 'The rule has no script text and no file' };
  if (!workspaceRoot) return { error: `The script file ${s.file} needs a workspace` };
  if (!isInsidePath(s.file)) return { error: 'The script file must be a path inside the workspace (no .., no drive or root)' };
  const full = join(workspaceRoot, s.file);
  try {
    const st = statSync(full);
    if (!st.isFile() || st.size > MAX_SCRIPT_BYTES) return { error: `${s.file} is not a file or is over ${MAX_SCRIPT_BYTES / 1024} KB` };
    const hit = sources.get(full);
    if (hit && hit.mtime === st.mtimeMs) return { source: hit.text };
    const text = readFileSync(full, 'utf8');
    sources.set(full, { mtime: st.mtimeMs, text });
    return { source: text };
  } catch (e) {
    return { error: `${s.file} could not be read: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}` };
  }
}

/** The rule's script as a checked shape for saving: undefined when fine. */
export function checkScriptSpec(s: ScriptSpec | undefined): string | undefined {
  if (!s || typeof s !== 'object') return 'A script rule needs a script: its text (code) or a file of the workspace';
  if (s.code !== undefined && s.file !== undefined) return 'A script rule has its text or a file, not both';
  if (s.code === undefined && !s.file?.trim()) return 'A script rule needs a script: its text (code) or a file of the workspace';
  if (s.code !== undefined) {
    if (typeof s.code !== 'string' || !s.code.trim()) return 'The script is empty';
    if (s.code.length > MAX_SCRIPT_BYTES) return `The script is over ${MAX_SCRIPT_BYTES / 1024} KB`;
    if (!/\bon(Request|Response)\b/.test(s.code)) return 'The script defines neither onRequest(ctx) nor onResponse(ctx), so it would never do anything';
  } else if (!isInsidePath(s.file!)) return 'The script file must be a path inside the workspace (no .., no drive or root)';
  if (s.timeoutMs !== undefined && !(s.timeoutMs >= 10 && s.timeoutMs <= MAX_HOOK_MS)) return `A hook may run 10 ms to ${MAX_HOOK_MS} ms`;
  return undefined;
}

/* ---------------------------------------------------------------- running a hook */

/** The user's code, then the call of its hook with a `ctx`; the changes come back through one variable. */
function wrap(code: string, phase: ScriptPhase): string {
  const hook = phase === 'request' ? 'onRequest' : 'onResponse';
  return `${code}
;{
  const __ctx = JSON.parse(JSON.stringify(tp.data.ctx));
  const __acts = {};
  __ctx.reply = (status, body, headers) => { __acts.reply = { status: Number(status) || 200, body: body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body), headers: headers || (typeof body === 'object' ? { 'content-type': 'application/json' } : {}) }; };
  __ctx.delay = (ms) => { __acts.delayMs = Number(ms) || 0; };
  __ctx.highlight = (color) => { __acts.highlight = String(color); };
  __ctx.ignore = () => { __acts.ignore = true; };
  __ctx.log = (...a) => console.log(...a);
  const __hook = typeof ${hook} === 'function' ? ${hook} : null;
  if (__hook) await __hook(__ctx);
  tp.variables.set('__rule', { defined: !!__hook, request: __ctx.request, response: __ctx.response, acts: __acts });
}`;
}

let warmed: Promise<unknown> | undefined; // bounded: one promise per process - the engine's first start (the WASM module, the prelude) is paid once, before a hook's own clock starts
const warm = () => (warmed ??= runScript('1', { variables: {} }, { timeoutMs: 10_000, memoryMb: HOOK_MEMORY_MB }).catch(() => undefined));

/** The most recent run of each rule's hooks, for the rules panel ("last run: 3 ms, ok" / the error). */
const lastRuns = new BoundedMap<string, HookRun>(200); // bounded: one per rule, the oldest goes first
export function lastScriptRun(ruleId: string): HookRun | undefined {
  return lastRuns.get(ruleId);
}

const lower = (h: Record<string, unknown> | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) if (v !== undefined && v !== null) out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  return out;
};

export function headerEditsBetween(before: Record<string, string>, after: Record<string, string>): HeaderEdit[] {
  const edits: HeaderEdit[] = [];
  for (const [k, v] of Object.entries(after)) if (before[k] !== v) edits.push({ op: 'set', name: k, value: v });
  for (const k of Object.keys(before)) if (!(k in after)) edits.push({ op: 'remove', name: k });
  return edits;
}

/** What a hook sees of the exchange: the text of a body only when it is text and small enough. */
export interface HookInput {
  phase: ScriptPhase;
  method: string;
  url: string;
  host: string;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  status?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
}

export function hookInputOf(e: DebuggerExchange, phase: ScriptPhase, o: { requestBody?: string; responseBody?: string } = {}): HookInput {
  return {
    phase,
    method: e.method,
    url: e.url,
    host: e.host,
    requestHeaders: e.requestHeaders,
    requestBody: o.requestBody ?? e.requestBody,
    ...(phase === 'response' ? { status: e.status, responseHeaders: e.responseHeaders, responseBody: o.responseBody ?? e.responseBody } : {}),
  };
}

/** Runs one rule's hook. Never throws: a failure is in `error` and the effects are empty. */
export async function runHook(rule: DebuggerRule, input: HookInput, workspaceRoot: string | undefined): Promise<HookRun> {
  const run: HookRun = { rule: rule.id, ruleName: rule.name, phase: input.phase, ran: false, logs: [], ms: 0, effects: {} };
  const t0 = performance.now();
  const finish = () => ((run.ms = Math.round(performance.now() - t0)), lastRuns.set(rule.id, run), run);
  const src = scriptSourceOf(rule, workspaceRoot);
  if (src.error || src.source === undefined) return ((run.error = src.error ?? 'No script'), finish());
  const big = (t: string | undefined) => (t !== undefined && t.length > MAX_BODY_FOR_SCRIPT ? undefined : t);
  const reqHeaders = lower(input.requestHeaders);
  const resHeaders = lower(input.responseHeaders);
  const reqBody = big(input.requestBody);
  const resBody = big(input.responseBody);
  const ctx = {
    phase: input.phase,
    rule: rule.name,
    request: { method: input.method, url: input.url, host: input.host, headers: reqHeaders, body: reqBody },
    ...(input.phase === 'response' ? { response: { status: input.status, headers: resHeaders, body: resBody } } : {}),
  };
  try {
    await warm();
    const out = await runScript(wrap(src.source, input.phase), { variables: {}, data: { ctx } }, { timeoutMs: Math.min(MAX_HOOK_MS, Math.max(10, rule.script?.timeoutMs ?? DEFAULT_HOOK_MS)), memoryMb: HOOK_MEMORY_MB });
    run.logs = out.logs.slice(0, 50).map((l) => scrubSecrets(l.length > 500 ? `${l.slice(0, 500)}…` : l));
    if (out.error) return ((run.error = out.error.split('\n')[0]!.slice(0, 300)), finish());
    const r = out.vars.__rule as { defined?: boolean; request?: { headers?: Record<string, unknown>; body?: unknown }; response?: { status?: unknown; headers?: Record<string, unknown>; body?: unknown }; acts?: Record<string, any> } | undefined;
    if (!r) return ((run.error = 'The script did not finish'), finish());
    run.ran = true;
    if (!r.defined) return ((run.noHook = true), finish());
    const fx = run.effects;
    const reqEdits = headerEditsBetween(reqHeaders, lower(r.request?.headers));
    if (reqEdits.length && input.phase === 'request') fx.requestHeaders = reqEdits;
    const nb = r.request?.body;
    if (input.phase === 'request' && typeof nb === 'string' && nb !== reqBody) fx.requestBody = nb;
    if (input.phase === 'response' && r.response) {
      const resEdits = headerEditsBetween(resHeaders, lower(r.response.headers));
      if (resEdits.length) fx.responseHeaders = resEdits;
      if (typeof r.response.body === 'string' && r.response.body !== resBody) fx.responseBody = r.response.body;
      const st = Number(r.response.status);
      if (Number.isInteger(st) && st >= 100 && st <= 599 && st !== input.status) fx.setStatus = st;
    }
    const a = r.acts ?? {};
    if (input.phase === 'request') {
      if (a.reply && Number.isInteger(a.reply.status) && a.reply.status >= 100 && a.reply.status <= 599) fx.reply = { status: a.reply.status, headers: lower(a.reply.headers), body: String(a.reply.body ?? '') };
      if (typeof a.delayMs === 'number' && a.delayMs > 0) fx.delayMs = Math.min(a.delayMs, 60_000);
      if (typeof a.highlight === 'string') fx.highlight = a.highlight;
      if (a.ignore === true) fx.ignore = true;
    }
  } catch (e) {
    run.error = (e as Error).message;
  }
  return finish();
}

/** What a hook did, in plain words (the test button, the CLI, the agent). */
export function effectsInWords(fx: HookEffects): string[] {
  const out: string[] = [];
  for (const h of fx.requestHeaders ?? []) out.push(h.op === 'set' ? `sets the request header ${h.name}: ${h.value}` : `removes the request header ${h.name}`);
  if (fx.requestBody !== undefined) out.push(`replaces the request body (${fx.requestBody.length} characters)`);
  if (fx.reply) out.push(`answers ${fx.reply.status} itself; the server never sees the request`);
  if (fx.delayMs) out.push(`waits ${fx.delayMs} ms before forwarding`);
  if (fx.highlight) out.push(`highlights the row ${fx.highlight}`);
  if (fx.ignore) out.push('keeps the exchange out of the list');
  if (fx.setStatus) out.push(`changes the response status to ${fx.setStatus}`);
  for (const h of fx.responseHeaders ?? []) out.push(h.op === 'set' ? `sets the response header ${h.name}: ${h.value}` : `removes the response header ${h.name}`);
  if (fx.responseBody !== undefined) out.push(`replaces the response body (${fx.responseBody.length} characters)`);
  return out;
}

/* ---------------------------------------------------------------- in the proxy */

/** The pieces of a decision a script changes (declared here so rules.ts and the proxy share one shape). */
export interface ScriptTarget {
  scripts?: DebuggerRule[];
  ignore: boolean;
  highlight?: string;
  requestHeaders?: HeaderEdit[];
  requestBody?: string;
  responseHeaders?: HeaderEdit[];
  responseBody?: string;
  setStatus?: number;
  reply?: ReplySpec;
  delayMs: number;
  hold: boolean;
  applied: string[];
}

const note = (d: ScriptTarget, r: HookRun) => {
  if (!r.error) return;
  const i = d.applied.indexOf(r.ruleName);
  const text = `${r.ruleName} (script error: ${r.error.slice(0, 80)})`;
  if (i >= 0) d.applied[i] = text;
  else d.applied.push(text);
};

/** Runs the request hooks of the matched script rules, in order, and folds what they asked for into the decision. Each sees the previous one's edits. */
export async function applyRequestScripts(d: ScriptTarget, e: DebuggerExchange, workspaceRoot: string | undefined): Promise<void> {
  let headers = { ...e.requestHeaders };
  let body = e.requestBody;
  for (const rule of d.scripts ?? []) {
    const run = await runHook(rule, hookInputOf({ ...e, requestHeaders: headers }, 'request', { requestBody: body }), workspaceRoot);
    note(d, run);
    const fx = run.effects;
    if (fx.requestHeaders) {
      d.requestHeaders = [...(d.requestHeaders ?? []), ...fx.requestHeaders];
      headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !fx.requestHeaders!.some((h) => h.op === 'remove' && h.name === k)));
      for (const h of fx.requestHeaders) if (h.op === 'set') headers[h.name] = h.value ?? '';
    }
    if (fx.requestBody !== undefined) d.requestBody = body = fx.requestBody;
    if (fx.reply) d.reply ??= fx.reply;
    if (fx.delayMs) d.delayMs += fx.delayMs;
    if (fx.highlight) d.highlight ??= fx.highlight;
    if (fx.ignore) d.ignore = true;
  }
}

/** Runs the response hooks once the whole response is in. `body` is the decoded text (undefined for a body that is not text). */
export async function applyResponseScripts(d: ScriptTarget, e: DebuggerExchange, body: string | undefined, workspaceRoot: string | undefined): Promise<void> {
  let status = e.status;
  let headers = { ...e.responseHeaders };
  let text = body;
  for (const rule of d.scripts ?? []) {
    if (!scriptWantsResponse(rule)) continue;
    const run = await runHook(rule, hookInputOf({ ...e, status, responseHeaders: headers }, 'response', { responseBody: text }), workspaceRoot);
    note(d, run);
    const fx = run.effects;
    if (fx.setStatus) d.setStatus = status = fx.setStatus;
    if (fx.responseHeaders) {
      d.responseHeaders = [...(d.responseHeaders ?? []), ...fx.responseHeaders];
      headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !fx.responseHeaders!.some((h) => h.op === 'remove' && h.name === k)));
      for (const h of fx.responseHeaders) if (h.op === 'set') headers[h.name] = h.value ?? '';
    }
    if (fx.responseBody !== undefined) d.responseBody = text = fx.responseBody;
  }
}

/* ---------------------------------------------------------------- the test button */

export interface ScriptTestResult {
  ok: boolean;
  phases: Array<{ phase: ScriptPhase; ran: boolean; noHook?: boolean; error?: string; ms: number; logs: string[]; does: string[] }>;
  /** Would the rule's match apply to this exchange (the script runs only then). */
  matches: boolean;
}

/** Runs a rule's script against a captured exchange, both hooks, and says what it would do. Sends nothing, changes nothing. */
export async function testRuleScript(rule: DebuggerRule, e: DebuggerExchange, matches: boolean, workspaceRoot: string | undefined): Promise<ScriptTestResult> {
  const phases: ScriptTestResult['phases'] = [];
  for (const phase of ['request', 'response'] as const) {
    if (phase === 'response' && e.status === undefined) break;
    const run = await runHook(rule, hookInputOf(e, phase), workspaceRoot);
    phases.push({ phase, ran: run.ran, ...(run.noHook ? { noHook: true } : {}), ...(run.error ? { error: run.error } : {}), ms: run.ms, logs: run.logs, does: effectsInWords(run.effects) });
  }
  return { ok: phases.every((p) => !p.error), phases, matches };
}
