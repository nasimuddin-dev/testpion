import { createHash, createHmac, randomUUID } from 'node:crypto';
import { newQuickJSWASMModuleFromVariant, shouldInterruptAfterDeadline, type QuickJSHandle, type QuickJSWASMModule } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-singlefile-mjs-release-sync';
import { EPILOGUE, PRELUDE } from './prelude.js';
import { dynamicValue } from '../vars/dynamic.js';
import { validateSchema } from '../eval/checks.js';
import { LODASH_SOURCE } from './lodash.generated.js';
import { MOMENT_SOURCE } from './moment.js';
import { BRUNO_SOURCE, USES_BRUNO } from './bruno.js';
import { queryHtml } from './html.js';

const USES_MOMENT = /\bmoment\b/;
const USES_LODASH = /(^|[^\w$.])_\s*[.(]|require\s*\(\s*['"]lodash['"]/;
import type { CookieJarOp, StoredCookie } from '../cookies/cookie-jar.js';

/**
 * User scripts run inside QuickJS compiled to WebAssembly — a separate JS engine with its
 * own heap. Scripts have no access to the filesystem, network, processes, Node APIs or the
 * host realm. Data is passed in and out as JSON only; the only host functions exposed are
 * pure crypto/encoding/uuid helpers. CPU time and memory are bounded.
 *
 * The API is Postman-compatible (`tp.*`, with `pm.*` and `postman.*` for Postman scripts, `tests[...]`, CryptoJS); `aps` is an alias.
 */

export type ScriptScope = 'environment' | 'globals' | 'collectionVariables';

export interface ScriptInput {
  /** Merged variables (all scopes) — `tp.variables`. */
  variables: Record<string, unknown>;
  environment?: Record<string, unknown>;
  globals?: Record<string, unknown>;
  collectionVariables?: Record<string, unknown>;
  iterationData?: Record<string, unknown>;
  request?: { method: string; url: string; headers: Array<{ key: string; value: string; enabled?: boolean }>; body?: string };
  response?: { status?: number; headers?: Array<[string, string]>; body?: string; time?: number };
  cookies?: Record<string, string>;
  /** Snapshot of the workspace cookie jar for `tp.cookies.jar()`. */
  jar?: StoredCookie[];
  /** Responses to `tp.sendRequest` calls from earlier passes (set by the host). */
  sent?: Array<{ key: string; response?: ScriptHttpResponse; error?: string }>;
  info?: { requestName?: string; requestId?: string; iteration?: number; iterationCount?: number; environmentName?: string };
  /** Arbitrary extra data exposed as `tp.data` (e.g. LLM output, MCP result). */
  data?: unknown;
}

export interface ScriptOutput {
  /** Local variables set via `tp.variables.set` (runtime scope). */
  vars: Record<string, unknown>;
  unset: string[];
  /** Values set via tp.environment / tp.globals / tp.collectionVariables. */
  scopeSets: Record<ScriptScope, Record<string, unknown>>;
  scopeUnsets: Record<ScriptScope, string[]>;
  tests: Array<{ name: string; passed: boolean; message?: string; skipped?: boolean }>;
  logs: string[];
  request?: ScriptInput['request'];
  /** `postman.setNextRequest(name)`: undefined = not called, null = stop the run. */
  nextRequest?: string | null;
  skipRequest?: boolean;
  /** Changes made through `tp.cookies.jar()` (apply with `applyCookieJarOps`). */
  jarOps?: CookieJarOp[];
  /** `tp.sendRequest` calls the host has not answered yet (internal to the replay loop). */
  pendingRequests?: Array<{ key: string; request: ScriptHttpRequest }>;
  /** `tp.visualizer.set(template, data)`: undefined = not called, null = `tp.visualizer.clear()`. */
  visualizer?: { template: string; data: unknown; options?: unknown } | null;
  /** Requests sent through `tp.sendRequest`, for logs and the console. */
  sentRequests?: Array<{ method: string; url: string; status?: number; error?: string; durationMs?: number }>;
  error?: string;
  durationMs: number;
}

/** A request made with `tp.sendRequest` (Postman request object or URL, normalised in the sandbox). */
export interface ScriptHttpRequest {
  method: string;
  url: string;
  headers: Array<{ key: string; value: string }>;
  body?: string | { urlencoded: Array<{ key: string; value: string }> };
}
export interface ScriptHttpResponse {
  status: number;
  statusText?: string;
  headers: Array<[string, string]>;
  body: string;
  time?: number;
}
/** Sends `tp.sendRequest` requests for the host (network, auth-free, with its own timeout). */
export type ScriptRequestSender = (req: ScriptHttpRequest) => Promise<ScriptHttpResponse>;

export interface ScriptOptions {
  timeoutMs?: number;
  memoryMb?: number;
  /** Enables `tp.sendRequest`. Without it, calls are reported as unavailable. */
  sendRequest?: ScriptRequestSender;
  /** Most `tp.sendRequest` calls per script run (default 20). */
  maxRequests?: number;
  /** Source of a workspace script package, for `tp.require(name)`. */
  requirePackage?: (name: string) => string | undefined;
}

const emptyScopes = () => ({
  scopeSets: { environment: {}, globals: {}, collectionVariables: {} } as ScriptOutput['scopeSets'],
  scopeUnsets: { environment: [], globals: [], collectionVariables: [] } as ScriptOutput['scopeUnsets'],
});

let modulePromise: Promise<QuickJSWASMModule> | undefined;
function getModule(): Promise<QuickJSWASMModule> {
  return (modulePromise ??= newQuickJSWASMModuleFromVariant(variant as never));
}

const HASHES = new Set(['md5', 'sha1', 'sha256', 'sha512']);

/**
 * Run a script. `tp.sendRequest` is supported by replaying: when a pass records requests the host
 * hasn't answered, they are sent and the script runs again from the start with the responses, so
 * callbacks run synchronously with real data. Only the last pass's results are kept.
 */
export async function runScript(code: string, input: ScriptInput, opts: ScriptOptions = {}): Promise<ScriptOutput> {
  const max = opts.maxRequests ?? 20;
  const sent: NonNullable<ScriptInput['sent']> = [];
  const log: NonNullable<ScriptOutput['sentRequests']> = [];
  const t0 = performance.now();
  for (let pass = 0; ; pass++) {
    const out = await runScriptOnce(code, { ...input, sent }, opts);
    const pending = out.pendingRequests ?? [];
    delete out.pendingRequests;
    if (!pending.length) return { ...out, ...(log.length ? { sentRequests: log } : {}), durationMs: Math.round(performance.now() - t0) };
    if (!opts.sendRequest) {
      out.logs.push('tp.sendRequest is not available here: the callback did not run.');
      return out;
    }
    if (sent.length + pending.length > max || pass >= max) {
      out.error ??= `tp.sendRequest: more than ${max} requests in one script`;
      return { ...out, sentRequests: log };
    }
    for (const p of pending) {
      const r0 = performance.now();
      try {
        const response = await opts.sendRequest(p.request);
        sent.push({ key: p.key, response });
        log.push({ method: p.request.method, url: p.request.url, status: response.status, durationMs: Math.round(performance.now() - r0) });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        sent.push({ key: p.key, error });
        log.push({ method: p.request.method, url: p.request.url, error });
      }
    }
  }
}

/** Lines before the user's code in the evaluated source (the prelude plus the wrapper's first line). */
const USER_LINE_OFFSET = PRELUDE.split('\n').length + 1;

/**
 * Stack frames point into the evaluated source (prelude + wrapper + script). Keep the message and the
 * frames in the user's script, numbered as the user sees them ("at line 3:12").
 */
export function userErrorLines(error: string, offset: number, lines = Infinity): string {
  const [message, ...frames] = error.split('\n');
  const own = frames
    .map((f) => /user-script\.js:(\d+):(\d+)/.exec(f))
    .filter((m): m is RegExpExecArray => !!m && Number(m[1]) > offset && Number(m[1]) <= offset + lines)
    .map((m) => `    at line ${Number(m[1]) - offset}:${m[2]}`);
  return [message, ...own].join('\n');
}

async function runScriptOnce(code: string, input: ScriptInput, opts: ScriptOptions = {}): Promise<ScriptOutput> {
  const t0 = performance.now();
  if (!code?.trim()) return { vars: {}, unset: [], ...emptyScopes(), tests: [], logs: [], request: input.request, durationMs: 0 };
  const mod = await getModule();
  const runtime = mod.newRuntime();
  runtime.setMemoryLimit((opts.memoryMb ?? 32) * 1024 * 1024);
  runtime.setMaxStackSize(1024 * 1024);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + (opts.timeoutMs ?? 2000)));
  const vm = runtime.newContext();
  try {
    const fn = (name: string, impl: (...args: string[]) => string) => {
      const h = vm.newFunction(name, (...args) => vm.newString(impl(...args.map((a) => String(vm.dump(a))))));
      vm.setProp(vm.global, name, h);
      h.dispose();
    };
    const alg = (a: string) => (HASHES.has(a) ? a : 'sha256');
    fn('__host_uuid', () => randomUUID());
    fn('__host_bytelen', (s) => String(Buffer.byteLength(s ?? '', 'utf8')));
    fn('__host_schema', (schema, data) => {
      try {
        const r = validateSchema(JSON.parse(schema ?? '{}'), JSON.parse(data ?? 'null'));
        return JSON.stringify({ valid: r.valid, errors: r.errors.slice(0, 5) });
      } catch (e) {
        return JSON.stringify({ valid: false, errors: [`invalid schema: ${(e as Error).message}`] });
      }
    });
    fn('__host_dynamic', (name) => JSON.stringify(dynamicValue(name ?? '') ?? null));
    // cheerio: CSS selectors over HTML, parsed on the host
    fn('__host_html', (html, path, op, selector) => {
      try {
        return JSON.stringify(queryHtml(html ?? '', JSON.parse(path || '[]') as number[], op ?? 'find', selector ?? ''));
      } catch (e) {
        return JSON.stringify({ error: (e as Error).message });
      }
    });
    fn('__host_package', (name) => {
      try {
        return JSON.stringify(opts.requirePackage?.(name ?? '') ?? null);
      } catch {
        return 'null';
      }
    });
    fn('__host_hash', (a, s) => createHash(alg(a)).update(s ?? '').digest('hex'));
    fn('__host_hmac', (a, key, s) => createHmac(alg(a), key ?? '').update(s ?? '').digest('hex'));
    fn('__host_b64', (s) => Buffer.from(s ?? '', 'utf8').toString('base64'));
    fn('__host_unb64', (s) => Buffer.from(s ?? '', 'base64').toString('utf8'));
    fn('__host_hex2b64', (h) => Buffer.from(h ?? '', 'hex').toString('base64'));
    fn('__host_b642hex', (s) => Buffer.from(s ?? '', 'base64').toString('hex'));
    fn('__host_hex2utf8', (h) => Buffer.from(h ?? '', 'hex').toString('utf8'));
    const inputHandle = vm.newString(JSON.stringify(input));
    vm.setProp(vm.global, '__input_json', inputHandle);
    inputHandle.dispose();

    // lodash, like Postman's sandbox: `_` and require('lodash'). Parsed only for scripts that use it.
    // … and moment (a UTC subset, see moment.ts)
    for (const [uses, source, file] of [
      [USES_LODASH, LODASH_SOURCE, 'lodash.js'],
      [USES_MOMENT, MOMENT_SOURCE, 'moment.js'],
      // … and Bruno's bru / req / res API for scripts imported from Bruno
      [USES_BRUNO, BRUNO_SOURCE, 'bruno.js'],
    ] as const) {
      if (!uses.test(code)) continue;
      const lib = vm.evalCode(source, file);
      if (lib.error) lib.error.dispose();
      else lib.value.dispose();
    }

    // The script is the body of an async function, so `await tp.sendRequest(…)` and `await tp.vault.get(…)`
    // work. A request that hasn't been sent yet leaves its promise pending: the run stops there, the host
    // sends it, and the next pass (a replay) goes on with the response.
    const wrapped = `${PRELUDE}\n(async function(){\n${code}\n})().then(() => { __runTimers(); }, (e) => { __out.error = e && e.stack ? String(e) + '\\n' + e.stack : String(e); });`;
    let failure: QuickJSHandle | undefined;
    let json = '';
    const started = vm.evalCode(wrapped, 'user-script.js');
    if (started.error) failure = started.error;
    else {
      started.value.dispose();
      const jobs = runtime.executePendingJobs();
      if (jobs.error) failure = jobs.error;
      else {
        const finished = vm.evalCode(`${EPILOGUE}\nJSON.stringify(__out);`, 'epilogue.js');
        if (finished.error) failure = finished.error;
        else {
          json = vm.getString(finished.value);
          finished.value.dispose();
        }
      }
    }
    if (failure) {
      const err = vm.dump(failure);
      failure.dispose();
      const msg = typeof err === 'object' && err ? `${(err as { name?: string }).name ?? 'Error'}: ${(err as { message?: string }).message ?? JSON.stringify(err)}` : String(err);
      return {
        vars: {},
        unset: [],
        ...emptyScopes(),
        tests: [],
        logs: [],
        request: input.request,
        error: /interrupted/i.test(msg) ? `Script timed out after ${opts.timeoutMs ?? 2000} ms` : msg,
        durationMs: Math.round(performance.now() - t0),
      };
    }
    const out = JSON.parse(json) as Omit<ScriptOutput, 'durationMs'> & { error: string | null };
    return { ...out, error: out.error ? userErrorLines(out.error, USER_LINE_OFFSET, code.split('\n').length) : undefined, request: out.request ?? undefined, durationMs: Math.round(performance.now() - t0) };
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}
