import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { QuickJSContext, QuickJSHandle, QuickJSRuntime, QuickJSWASMModule } from 'quickjs-emscripten-core';
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

// QuickJS (an 800 KB wasm blob) loads on the first script, not at startup.
let modulePromise: Promise<QuickJSWASMModule> | undefined;
function getModule(): Promise<QuickJSWASMModule> {
  return (modulePromise ??= (async () => {
    const [core, variant] = await Promise.all([import('quickjs-emscripten-core'), import('@jitl/quickjs-singlefile-mjs-release-sync')]);
    return core.newQuickJSWASMModuleFromVariant(variant.default as never);
  })());
}

/*
 * One runtime per process and one long-lived context: parsing the 44 KB prelude costs ~4.5 ms and lodash
 * ~13 ms, so they are evaluated once per context. The prelude is wrapped in a factory that rebuilds every
 * per-run object (tp, pm, tests, the scopes …) and assigns them to global `let` bindings before each script,
 * so no script sees another's variables, tests or logs. After a script the guard deletes globals it added and
 * verifies that the intrinsics (and the shared libraries) are untouched; a script that changed them, timed
 * out, ran out of memory or failed in the engine spends the context and the next script gets a fresh one.
 */
const PRELUDE_NAMES = [...new Set([...PRELUDE.matchAll(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]))];
const PRELUDE_SCRIPT = `let ${PRELUDE_NAMES.join(', ')};
(function () {
  const setup = function (__input_json) {
${PRELUDE}
return { ${PRELUDE_NAMES.join(', ')} };
  };
  return function (json) { ({ ${PRELUDE_NAMES.join(', ')} } = setup(json)); };
})();`;
const GUARD_SCRIPT = String.raw`(function () {
  const baseRoots = () => [globalThis, Object, Object.prototype, Function, Function.prototype, Array, Array.prototype, String, String.prototype, Number, Number.prototype, Boolean, Boolean.prototype, Symbol, Symbol.prototype, Date, Date.prototype, RegExp, RegExp.prototype, Error, Error.prototype, EvalError.prototype, RangeError.prototype, ReferenceError.prototype, SyntaxError.prototype, TypeError.prototype, URIError.prototype, Map, Map.prototype, Set, Set.prototype, WeakMap.prototype, WeakSet.prototype, Promise, Promise.prototype, Reflect, JSON, Math, BigInt, BigInt.prototype, ArrayBuffer, ArrayBuffer.prototype, DataView.prototype, Object.getPrototypeOf(Uint8Array), Object.getPrototypeOf(Uint8Array.prototype), Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())), Object.getPrototypeOf([][Symbol.iterator]()), Object.getPrototypeOf(new Map()[Symbol.iterator]()), Object.getPrototypeOf(new Set()[Symbol.iterator]()), Object.getPrototypeOf(''[Symbol.iterator]()), Object.getPrototypeOf(function* () {}), Object.getPrototypeOf(function* () {}).prototype, Object.getPrototypeOf(async function () {}), Object.getPrototypeOf(async function* () {}), Object.getPrototypeOf(async function* () {}).prototype];
  // a library's shared objects: the global, its prototype, and what scripts conventionally mutate
  const libRoots = (name) => {
    const v = globalThis[name];
    if (!v || (typeof v !== 'object' && typeof v !== 'function')) return [];
    const r = [v];
    if (v.prototype) r.push(v.prototype);
    if (name === '_' && v.templateSettings) r.push(v.templateSettings, v.templateSettings.imports);
    if (name === 'moment') r.push(Object.getPrototypeOf(v(0)));
    return r;
  };
  const snapOf = (roots) => {
    const snap = [];
    for (const o of roots) { const keys = Reflect.ownKeys(o); snap.push(keys.length); for (const k of keys) { const d = Object.getOwnPropertyDescriptor(o, k); snap.push(k, d.value, d.get, d.set); } }
    return snap;
  };
  const same = (roots, snap) => {
    let i = 0;
    for (const o of roots) {
      const keys = Reflect.ownKeys(o);
      if (keys.length !== snap[i++]) return false;
      for (const k of keys) { const d = Object.getOwnPropertyDescriptor(o, k); if (k !== snap[i++] || !Object.is(d.value, snap[i++]) || d.get !== snap[i++] || d.set !== snap[i++]) return false; }
    }
    return i === snap.length;
  };
  let base = [];
  let globalKeys = new Set();
  const libs = {};
  const take = () => { base = snapOf(baseRoots()); globalKeys = new Set(Reflect.ownKeys(globalThis)); };
  const takeLib = (name) => { libs[name] = snapOf(libRoots(name)); };
  const check = () => {
    for (const name of Object.keys(libs)) if (globalThis[name] !== undefined && !same(libRoots(name), libs[name])) return false;
    for (const k of Reflect.ownKeys(globalThis)) if (!globalKeys.has(k)) { try { delete globalThis[k]; } catch (e) {} if (Object.prototype.hasOwnProperty.call(globalThis, k)) return false; }
    return same(baseRoots(), base);
  };
  return { take, takeLib, check };
})()`;

interface Slot {
  vm: QuickJSContext;
  /** `reset(inputJson)`: rebuilds the per-run API objects. */
  reset: QuickJSHandle;
  /** Guard: `take()` snapshots the shared state, `check()` verifies it and removes added globals. */
  take: QuickJSHandle;
  takeLib: QuickJSHandle;
  check: QuickJSHandle;
  /** Loaded libraries' globals, held by the host and installed only for the scripts that use them. */
  libs: Map<string, Array<[name: string, handle: QuickJSHandle]>>;
  /** Scripts run in this context; it is replaced after MAX_SLOT_USES to bound what unreachable leftovers it can hold. */
  uses: number;
}
const MAX_SLOT_USES = 2000;
let runtime: QuickJSRuntime | undefined;
let pooled: Slot | undefined;
/** Options of the script running now, read by the host functions. */
let current: ScriptOptions = {};

function getRuntime(mod: QuickJSWASMModule): QuickJSRuntime {
  if (!runtime) {
    runtime = mod.newRuntime();
    runtime.setMaxStackSize(1024 * 1024);
  }
  return runtime;
}

function unwrap(vm: QuickJSContext, r: { error: QuickJSHandle } | { value: QuickJSHandle }, what: string): QuickJSHandle {
  if ('error' in r) {
    const err = vm.dump(r.error);
    r.error.dispose();
    throw new Error(`${what}: ${typeof err === 'object' && err ? `${(err as { name?: string }).name}: ${(err as { message?: string }).message}` : String(err)}`);
  }
  return r.value;
}

function newSlot(rt: QuickJSRuntime): Slot {
  const vm = rt.newContext();
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
        return JSON.stringify(current.requirePackage?.(name ?? '') ?? null);
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
    const reset = unwrap(vm, vm.evalCode(PRELUDE_SCRIPT, 'prelude.js'), 'script prelude');
    const guard = unwrap(vm, vm.evalCode(GUARD_SCRIPT, 'guard.js'), 'script guard');
    const take = vm.getProp(guard, 'take');
    const takeLib = vm.getProp(guard, 'takeLib');
    const check = vm.getProp(guard, 'check');
    guard.dispose();
    const slot: Slot = { vm, reset, take, takeLib, check, libs: new Map(), uses: 0 };
    snapshot(slot);
    return slot;
  } catch (e) {
    vm.dispose();
    throw e;
  }
}

function snapshot(slot: Slot) {
  const r = slot.vm.callFunction(slot.take, slot.vm.undefined);
  if (r.error) r.error.dispose();
  else r.value.dispose();
}

function disposeSlot(slot: Slot) {
  for (const h of [slot.reset, slot.take, slot.takeLib, slot.check]) if (h.alive) h.dispose();
  for (const lib of slot.libs.values()) for (const [, h] of lib) if (h.alive) h.dispose();
  slot.vm.dispose();
}

/** Lodash, moment and Bruno's API: parsed once per context, present only in scripts that use them. */
const LIBS = [
  [USES_LODASH, LODASH_SOURCE, 'lodash.js', ['_']],
  [USES_MOMENT, MOMENT_SOURCE, 'moment.js', ['moment']],
  [USES_BRUNO, BRUNO_SOURCE, 'bruno.js', ['bru', 'req', 'res', 'test']],
] as const;

/** Loads a library once: evaluates it, snapshots its objects for the guard, then takes its globals off the global object. */
function loadLib(slot: Slot, source: string, file: string, names: readonly string[]) {
  const vm = slot.vm;
  const lib = vm.evalCode(source, file);
  if (lib.error) lib.error.dispose();
  else lib.value.dispose();
  const handles: Array<[string, QuickJSHandle]> = [];
  for (const name of names) {
    const n = vm.newString(name);
    const r = vm.callFunction(slot.takeLib, vm.undefined, n);
    n.dispose();
    if (r.error) r.error.dispose();
    else r.value.dispose();
    handles.push([name, vm.getProp(vm.global, name)]);
  }
  slot.libs.set(file, handles);
  const del = vm.evalCode(`for (const n of ${JSON.stringify(names)}) delete globalThis[n];`);
  if (del.error) del.error.dispose();
  else del.value.dispose();
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

/** Lines before the user's code in the evaluated source: the wrapper's first line (the prelude is a separate script). */
const USER_LINE_OFFSET = 1;

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
  const rt = getRuntime(mod);
  rt.setMemoryLimit((opts.memoryMb ?? 32) * 1024 * 1024);
  const deadline = Date.now() + (opts.timeoutMs ?? 2000);
  rt.setInterruptHandler(() => Date.now() > deadline);
  // A pass runs synchronously once the module is loaded, so one pooled context serves every script in turn.
  const slot = pooled ?? newSlot(rt);
  pooled = undefined;
  slot.uses++;
  let keep = false;
  try {
    current = opts;
    const vm = slot.vm;
    for (const [uses, source, file, names] of LIBS) {
      if (!uses.test(code)) continue;
      if (!slot.libs.has(file)) loadLib(slot, source, file, names);
      for (const [name, h] of slot.libs.get(file)!) vm.setProp(vm.global, name, h);
    }
    let failure: QuickJSHandle | undefined;
    let json = '';
    const inputHandle = vm.newString(JSON.stringify(input));
    const reset = vm.callFunction(slot.reset, vm.undefined, inputHandle);
    inputHandle.dispose();
    if (reset.error) failure = reset.error;
    else reset.value.dispose();

    // The script is the body of an async function, so `await tp.sendRequest(…)` and `await tp.vault.get(…)`
    // work. A request that hasn't been sent yet leaves its promise pending: the run stops there, the host
    // sends it, and the next pass (a replay) goes on with the response.
    const wrapped = `(async function(){\n${code}\n})().then(() => { __runTimers(); }, (e) => { __out.error = e && e.stack ? String(e) + '\\n' + e.stack : String(e); });`;
    if (!failure) {
      const started = vm.evalCode(wrapped, 'user-script.js');
      if (started.error) failure = started.error;
      else {
        started.value.dispose();
        const jobs = rt.executePendingJobs();
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
    // the context is reused only when the script left the shared state as it found it
    const checked = vm.callFunction(slot.check, vm.undefined);
    if (checked.error) checked.error.dispose();
    else {
      keep = vm.dump(checked.value) === true;
      checked.value.dispose();
    }
    if (Date.now() > deadline) keep = false;
    const out = JSON.parse(json) as Omit<ScriptOutput, 'durationMs'> & { error: string | null };
    // an interrupt inside the async body is caught by its rejection handler
    if (out.error && /^InternalError: interrupted/.test(out.error)) out.error = `Script timed out after ${opts.timeoutMs ?? 2000} ms`;
    return { ...out, error: out.error ? userErrorLines(out.error, USER_LINE_OFFSET, code.split('\n').length) : undefined, request: out.request ?? undefined, durationMs: Math.round(performance.now() - t0) };
  } finally {
    rt.removeInterruptHandler();
    current = {};
    if (keep && !pooled && slot.uses < MAX_SLOT_USES) pooled = slot;
    else {
      disposeSlot(slot);
      // jobs an interrupted script left queued would run in the next script: start a clean runtime
      if (rt.hasPendingJob()) {
        rt.dispose();
        runtime = undefined;
      }
    }
  }
}

/** What an `if:` expression sees: the previous step's response and the variables. */
export interface ExpressionInput {
  status?: number;
  /** Header names in lower case. */
  headers?: Record<string, string>;
  body?: unknown;
  text?: string;
  vars?: Record<string, unknown>;
}

/**
 * Evaluate a flow's `if:` expression (`status == 200 && $.role == 'admin'`) in the script runtime, in a fresh context
 * of its own: no tp API, no host functions (no network, files, processes or require), only the data passed in as JSON,
 * a few milliseconds of CPU and a small heap. `$` and `body` are the response body, `status`, `headers`, `text` and
 * `vars` the rest. Answers the value, or the error (a syntax error, a timeout).
 */
export async function evaluateExpression(expr: string, input: ExpressionInput, opts: { timeoutMs?: number; memoryMb?: number } = {}): Promise<{ value?: unknown; error?: string }> {
  if (!expr?.trim()) return { error: 'The expression is empty' };
  const mod = await getModule();
  const rt = getRuntime(mod);
  const timeoutMs = opts.timeoutMs ?? 250;
  rt.setMemoryLimit((opts.memoryMb ?? 16) * 1024 * 1024);
  const deadline = Date.now() + timeoutMs;
  rt.setInterruptHandler(() => Date.now() > deadline);
  const vm = rt.newContext();
  try {
    const source = `"use strict";
const __d = JSON.parse(${JSON.stringify(JSON.stringify(input ?? {}))});
const status = __d.status, headers = __d.headers || {}, body = __d.body, $ = __d.body, text = __d.text, vars = __d.vars || {};
JSON.stringify({ v: (function () { return (
${expr}
); })() });`;
    const r = vm.evalCode(source, 'expression.js');
    if (r.error) {
      const err = vm.dump(r.error);
      r.error.dispose();
      const msg = typeof err === 'object' && err ? `${(err as { name?: string }).name ?? 'Error'}: ${(err as { message?: string }).message ?? JSON.stringify(err)}` : String(err);
      return { error: /interrupted/i.test(msg) ? `The expression took longer than ${timeoutMs} ms` : msg };
    }
    const json = vm.typeof(r.value) === 'string' ? vm.getString(r.value) : undefined;
    r.value.dispose();
    const parsed = json === undefined ? {} : (JSON.parse(json) as { v?: unknown });
    return { value: parsed.v };
  } catch (e) {
    return { error: (e as Error).message };
  } finally {
    // jobs of promises an expression made run out within its time (an endless one is interrupted), then the context goes
    if (rt.hasPendingJob()) {
      const j = rt.executePendingJobs();
      if (j.error) j.error.dispose();
    }
    rt.removeInterruptHandler();
    vm.dispose();
    if (rt.hasPendingJob()) {
      if (pooled) disposeSlot(pooled);
      pooled = undefined;
      rt.dispose();
      runtime = undefined;
    }
  }
}
