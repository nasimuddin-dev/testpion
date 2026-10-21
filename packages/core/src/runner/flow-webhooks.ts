/**
 * Flows behind webhooks (like Postman Flows' Deploy): a small HTTP server that runs a test file when something calls its
 * `webhook:` path. POST a JSON body (or GET with a query) and its fields become the flow's inputs (checked against
 * `expose.inputs` when the file declares them, else every field is a variable); the answer is the flow's `output:`,
 * each step's status and the run's id (the run is recorded like any other). Host-agnostic: the CLI (`testpion serve
 * flows`) and the desktop app (flows.webhooks.start) both start it; it never throws on bad input.
 *
 * Answers: 200 { ok: true, output, steps, runId } · 422 when a step failed (with failedStep) · 400 bad JSON or missing
 * inputs · 401 wrong or missing secret · 404 unknown path · 405 other methods · 413 body over the limit · 429 too many
 * runs at once · 504 the run took too long · 500 anything else.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { AppSettings, TestResult } from '../model/types.js';
import { createEngineContext, type EngineContext } from '../engine.js';
import { EnvSecretStore, type SecretStore } from '../storage/secrets.js';
import { WorkspaceStore } from '../storage/workspace.js';
import { shortId } from '../util/ids.js';
import { inputRequired } from './exposed-flows.js';
import { readFlowOutput, resolveOutput } from './flow-blocks.js';
import { webhookFlows, type WebhookFlow } from './flow-webhook-config.js';
import { loadTestsFromFile } from './loader.js';
import { recordRun } from './run-records.js';
import { runTests } from './runner.js';

interface FlowWebhookServerOptions {
  /** The open workspace (the app's), or `workspaceRoot` to open one (closed with the server). */
  store?: WorkspaceStore;
  workspaceRoot?: string;
  /** An engine context for a run (the app's: its secrets, current values, cookies); default the environment's variables and secrets from TESTPION_SECRET_*. */
  context?: (o: { environment?: string }) => EngineContext;
  secrets?: SecretStore;
  settings?: AppSettings;
  /** The environment every run uses. */
  environment?: string;
  /** Default 127.0.0.1 (only this machine); 0.0.0.0 serves the network. */
  host?: string;
  /** Default 4020; 0 picks a free port. */
  port?: number;
  /** Runs at once before callers get 429 (default 4). */
  maxConcurrent?: number;
  /** A run longer than this is cancelled and answered 504 (default 120 s). */
  timeoutMs?: number;
  /** Largest body accepted (default 1 MB). */
  maxBodyBytes?: number;
  /** Told about every call that reached a flow (and every refused one, with its HTTP status). */
  onRun?: (e: FlowWebhookCall) => void;
}

/** One call of a webhook, as onRun hears it. */
export interface FlowWebhookCall {
  file?: string;
  path: string;
  method: string;
  /** The HTTP status answered. */
  status: number;
  runId?: string;
  durationMs: number;
  error?: string;
}

/** A served hook: the file, its path and full URL, whether it needs a secret; `problem` when it is not served. */
interface ServedHook {
  file: string;
  path: string;
  url: string;
  secret: boolean;
  inputs?: string[];
  problem?: string;
}

export interface FlowWebhookServer {
  port: number;
  /** http://host:port (the address callers use). */
  url: string;
  /** The hooks found now (re-read from tests/). */
  hooks(): ServedHook[];
  close(): Promise<void>;
}

/** One step of the answer. */
interface WebhookStep {
  name: string;
  status: string;
  ms: number;
  error?: string;
  failedChecks?: string[];
}

const DEFAULT_PORT = 4020;
const MB = 1024 * 1024;
const RESCAN_MS = 1000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Constant-time comparison of two secrets (hashes first, so the lengths do not leak either). */
export function sameSecret(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** The secret a caller sent: X-TestPion-Secret, or Authorization: Bearer <secret>. */
function givenSecret(req: IncomingMessage): string | undefined {
  const h = req.headers['x-testpion-secret'];
  if (typeof h === 'string' && h) return h;
  const auth = req.headers.authorization;
  const m = typeof auth === 'string' ? /^Bearer\s+(.+)$/i.exec(auth.trim()) : null;
  return m?.[1]?.trim() || undefined;
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) return reject(new HttpError(413, `The body is over ${Math.round(limit / 1024)} KB`));
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        reject(new HttpError(413, `The body is over ${Math.round(limit / 1024)} KB`));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => !done && ((done = true), resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', (e) => !done && ((done = true), reject(e)));
  });
}

/** The caller's inputs: the query, then the body's fields over it (JSON, or a form). */
function parseInputs(text: string, contentType: string | undefined, query: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = Object.fromEntries(query.entries());
  if (!text.trim()) return out;
  if (/application\/x-www-form-urlencoded/i.test(contentType ?? '')) return { ...out, ...Object.fromEntries(new URLSearchParams(text).entries()) };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (e) {
    throw new HttpError(400, `The body is not JSON: ${(e as Error).message}`);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'The body must be a JSON object: { "input": "value", … }');
  return { ...out, ...(body as Record<string, unknown>) };
}

/** The variables a run starts with: the declared inputs (with their defaults; missing required ones refused), else every field. */
function webhookInputs(hook: Pick<WebhookFlow, 'inputs'>, given: Record<string, unknown>): Record<string, unknown> {
  if (!hook.inputs?.length) return Object.fromEntries(Object.entries(given).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(k)));
  const vars: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const i of hook.inputs) {
    const v = given[i.name];
    if (v !== undefined && v !== null && v !== '') vars[i.name] = v;
    else if (i.default !== undefined) vars[i.name] = i.default;
    else if (inputRequired(i)) missing.push(i.name);
  }
  if (missing.length) throw new HttpError(400, `Missing input${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`, { inputs: hook.inputs.map((i) => i.name) });
  return vars;
}

/** Start the server; it serves every flow of the workspace with a `webhook:` block (new and changed ones without a restart). */
export async function startFlowWebhookServer(o: FlowWebhookServerOptions): Promise<FlowWebhookServer> {
  if (!o.store && !o.workspaceRoot) throw new Error('startFlowWebhookServer needs a store or a workspaceRoot');
  const own = !o.store;
  const store = o.store ?? WorkspaceStore.open(o.workspaceRoot!);
  const secrets = o.secrets ?? new EnvSecretStore();
  const context = o.context ?? ((c: { environment?: string }) => createEngineContext({ store, secrets, settings: o.settings, environment: c.environment }));
  const host = o.host ?? '127.0.0.1';
  const maxConcurrent = Math.max(1, o.maxConcurrent ?? 4);
  const timeoutMs = Math.max(1000, o.timeoutMs ?? 120_000);
  const maxBody = Math.max(1024, o.maxBodyBytes ?? MB);
  const running = new Set<AbortController>();
  let scanned: { at: number; hooks: WebhookFlow[] } | undefined;
  const scan = (force = false): WebhookFlow[] => {
    if (!force && scanned && Date.now() - scanned.at < RESCAN_MS) return scanned.hooks;
    scanned = { at: Date.now(), hooks: webhookFlows(store.path('tests')) };
    return scanned.hooks;
  };
  const find = (path: string): WebhookFlow | undefined => {
    const hit = (hooks: WebhookFlow[]) => hooks.find((h) => h.path === path && !h.problem);
    return hit(scan()) ?? hit(scan(true));
  };

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    if (res.headersSent || res.destroyed) return;
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store', ...headers });
    res.end(text);
  };

  const run = async (hook: WebhookFlow, given: Record<string, unknown>, ctx: EngineContext, signal: AbortSignal) => {
    const vars = webhookInputs(hook, given);
    for (const [k, v] of Object.entries(vars)) ctx.vars.set(k, v);
    const abs = join(store.path('tests'), hook.file);
    const runId = shortId('run-');
    const outDir = store.runDir(runId);
    const results: TestResult[] = [];
    const summary = await runTests({
      name: `Webhook ${hook.path} (${hook.file})`,
      runId,
      tests: loadTestsFromFile(abs),
      services: ctx.services,
      concurrency: 1,
      resultsFile: join(outDir, 'results.jsonl'),
      traceMode: 'none',
      environment: o.environment,
      signal,
      onEvent: (e) => void (e.type === 'test-end' && results.push(e.result)),
    });
    await recordRun(store, summary, outDir).catch(() => undefined);
    const r = ctx.redactor;
    const declared = readFlowOutput(abs);
    const output = declared
      ? Object.fromEntries(Object.entries(resolveOutput(declared, ctx.vars)).map(([k, v]) => [k, r.isSensitiveKey(k) ? '***' : typeof v === 'string' ? r.redactString(v) : r.redact(v)]))
      : {};
    const steps: WebhookStep[] = results.map((x) => ({
      name: x.name,
      status: x.status,
      ms: Math.round(x.durationMs),
      ...(x.error ? { error: r.redactString(x.error.message) } : {}),
      ...(x.checks.some((c) => !c.passed) ? { failedChecks: x.checks.filter((c) => !c.passed).map((c) => r.redactString(`${c.name ?? c.type}: ${c.message ?? 'failed'}`)) } : {}),
    }));
    return { runId, summary, output, steps };
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now();
    const method = (req.method ?? 'GET').toUpperCase();
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return send(res, 400, { ok: false, error: 'Bad request URL' });
    }
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
    const tell = (status: number, extra: Partial<FlowWebhookCall> = {}) => {
      try {
        o.onRun?.({ path, method, status, durationMs: Date.now() - started, ...extra });
      } catch {
        // a listener's error never reaches the caller
      }
    };
    const hook = find(path);
    if (!hook) {
      // drain what was sent, then answer
      req.resume();
      tell(404);
      return send(res, 404, {
        ok: false,
        error: `No flow listens on ${path}`,
        hooks: scan()
          .filter((h) => !h.problem)
          .map((h) => h.path),
      });
    }
    if (method !== 'POST' && method !== 'GET') {
      req.resume();
      tell(405, { file: hook.file });
      return send(res, 405, { ok: false, error: `${method} is not supported: POST a JSON body (or GET with a query)` }, { allow: 'POST, GET' });
    }
    if (running.size >= maxConcurrent) {
      req.resume();
      tell(429, { file: hook.file });
      return send(res, 429, { ok: false, error: `Too many runs at once (${maxConcurrent}); try again shortly` }, { 'retry-after': '1' });
    }
    const ctrl = new AbortController();
    running.add(ctrl);
    let ctx: EngineContext | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      ctx = context({ environment: o.environment });
      if (hook.secret) {
        const expected = ctx.vars.resolve(hook.secret);
        if (!expected || /\{\{[^}]*\}\}/.test(expected)) throw new HttpError(500, `The webhook's secret (${hook.secret.startsWith('{{') ? hook.secret : 'its value'}) is not set in this environment`);
        const given = givenSecret(req);
        if (!given || !sameSecret(given, expected)) throw new HttpError(401, 'Wrong or missing secret: send it as X-TestPion-Secret or Authorization: Bearer <secret>');
      }
      const text = method === 'POST' ? await readBody(req, maxBody) : (req.resume(), '');
      const given = parseInputs(text, req.headers['content-type'], url.searchParams);
      timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const r = await run(hook, given, ctx, ctrl.signal);
      if (ctrl.signal.aborted) throw new HttpError(504, `The flow took longer than ${Math.round(timeoutMs / 1000)} s and was cancelled`, { runId: r.runId, steps: r.steps });
      const failed = r.summary.failed + r.summary.errors > 0;
      const failing = r.steps.find((s) => s.status === 'failed' || s.status === 'error');
      const status = failed ? 422 : 200;
      tell(status, { file: hook.file, runId: r.runId, ...(failing ? { error: failing.error ?? failing.failedChecks?.[0] ?? `${failing.name} ${failing.status}` } : {}) });
      return send(res, status, { ok: !failed, output: r.output, steps: r.steps, runId: r.runId, ...(failing ? { failedStep: failing } : {}) });
    } catch (e) {
      const err =
        e instanceof HttpError
          ? e
          : new HttpError(ctrl.signal.aborted ? 504 : 500, ctrl.signal.aborted ? `The flow took longer than ${Math.round(timeoutMs / 1000)} s and was cancelled` : (e as Error)?.message || String(e));
      if (!req.complete) req.resume();
      tell(err.status, { file: hook.file, error: err.message });
      return send(res, err.status, { ok: false, error: ctx ? ctx.redactor.redactString(err.message) : err.message, ...err.extra });
    } finally {
      if (timer) clearTimeout(timer);
      running.delete(ctrl);
      if (ctx) void ctx.dispose().catch(() => undefined);
    }
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      try {
        send(res, 500, { ok: false, error: (e as Error)?.message || 'Internal error' });
      } catch {
        res.destroy();
      }
    });
  });
  server.on('clientError', (_e, socket) => {
    try {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      else socket.destroy();
    } catch {
      // the socket is gone already
    }
  });
  server.requestTimeout = timeoutMs + 30_000;
  server.headersTimeout = 30_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port ?? DEFAULT_PORT, host, () => {
      server.off('error', reject);
      resolve();
    });
  }).catch((e) => {
    if (own) store.close();
    throw e;
  });
  server.on('error', () => undefined);
  const port = (server.address() as AddressInfo).port;
  const shownHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host.includes(':') ? `[${host}]` : host;
  const base = `http://${shownHost}:${port}`;
  let closed = false;
  return {
    port,
    url: base,
    hooks: () =>
      scan(true).map((h) => ({
        file: h.file,
        path: h.path,
        url: base + h.path,
        secret: !!h.secret,
        ...(h.inputs?.length ? { inputs: h.inputs.map((i) => i.name) } : {}),
        ...(h.problem ? { problem: h.problem } : {}),
      })),
    close: async () => {
      if (closed) return;
      closed = true;
      for (const c of running) c.abort();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      if (own) store.close();
    },
  };
}
