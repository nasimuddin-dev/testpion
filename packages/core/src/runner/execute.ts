import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import type {
  AgentTest,
  AuthConfig,
  DelayTest,
  CheckConfig,
  CheckResult,
  GraphQLTest,
  GrpcTest,
  WebSocketTest,
  HttpTest,
  HttpResponseData,
  KeyValue,
  LlmTest,
  McpServerConfig,
  McpTest,
  NormalizedError,
  PriceEntry,
  RagTest,
  TestCase,
  TestStatus,
  TokenUsage,
} from '../model/types.js';
import { ApsError, normalizeError } from '../errors.js';
import type { VariableScope } from '../vars/variables.js';
import { timingSpans, type Tracer, type SpanHandle } from '../trace/tracer.js';
import type { Redactor } from '../util/redact.js';
import type { Logger } from '../log/logger.js';
import { executeHttp, timingSummary } from '../protocols/http/client.js';
import { detectOperation, executeGraphQL, type GraphQLResult } from '../protocols/graphql/graphql.js';
import { collectSubscriptionEvents, subscriptionUrl } from '../protocols/graphql/subscription.js';
import { executeGrpc, parseGrpcTarget } from '../protocols/grpc/grpc.js';
import { reflectServer } from '../protocols/grpc/reflection.js';
import { mcpResultBody, type McpManager } from '../protocols/mcp/client.js';
import { estimateCost, renderPrompt, type ProviderRegistry } from '../ai/index.js';
import { runAgent, type AgentTool } from '../ai/agent.js';
import type { ChatMessage } from '../ai/types.js';
import { runChecks, type CheckContext } from '../eval/checks.js';
import { runScript } from '../scripts/sandbox.js';
import { renderVisualizer } from '../scripts/visualizer.js';
import { applyScriptOutput, scriptRequestSender, scriptScopes, type PersistVariable } from '../scripts/bridge.js';
import { query, tryParseJson } from '../util/jsonpath.js';
import { sleep, withTimeout } from '../util/concurrency.js';
import { applyCookieJarOps, type CookieJar } from '../cookies/cookie-jar.js';
import { realtimeModeFor, runRealtimeExchange } from '../protocols/realtime.js';

export interface ExecServices {
  /** Source of a workspace script package (tp.require), when there is one. */
  scriptPackage?: (name: string) => string | undefined;
  vars: VariableScope;
  providers: ProviderRegistry;
  mcp: McpManager;
  mcpServers: McpServerConfig[];
  redactor: Redactor;
  pricing: PriceEntry[];
  logger?: Logger;
  defaultTimeoutMs: number;
  maxPreviewBytes?: number;
  /** Auth inherited from the collection/folder for requests with `auth: inherit`. */
  inheritedAuth?: AuthConfig;
  openExternal?: (url: string) => void | Promise<void>;
  /** Persist values set by scripts via tp.environment/globals/collectionVariables (desktop "current values"). */
  persistVariable?: PersistVariable;
  /** Cookie jar shared by the HTTP/GraphQL requests of a run (Postman's cookie jar). */
  cookieJar?: CookieJar;
  /** Every HTTP response of a test, in full (e.g. `testpion send` prints the body of a saved request). */
  onHttpResponse?: (r: { testId: string; status: number; statusText: string; headers: Array<[string, string]>; body: string; durationMs: number; url: string; timing?: ReturnType<typeof timingSummary> }) => void;
  /** HTTPS: the server certificate a response came with (recorded per host for the workspace's certificate list). */
  onCertificate?: (url: string, certificate: NonNullable<NonNullable<HttpResponseData['connection']>['certificate']>) => void;
  /** The active environment's name (tp.environment.name). */
  environmentName?: string;
  /** Reads a workspace file by relative path (OpenAPI documents for contract checks); never outside the workspace. */
  readFile?: (path: string) => string;
}

export interface ExecutionOutcome {
  status: TestStatus;
  checks: CheckResult[];
  error?: NormalizedError;
  latencyMs?: number;
  tokens?: TokenUsage;
  costUsd?: number;
  model?: string;
  output?: string;
  input?: string;
  metadata: Record<string, unknown>;
  /** The full check context (not persisted — available to the UI for single runs). */
  context?: CheckContext;
}

const OUTPUT_SUMMARY_CHARS = 4000;

function summarize(v: unknown, n = OUTPUT_SUMMARY_CHARS): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? '';
  return s.length > n ? s.slice(0, n) + `… [${s.length - n} more chars]` : s;
}

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 12);
}

/** Execute one test case: scripts → protocol call → checks → extraction. Never throws (except cancellation). */
export async function executeTest(testIn: TestCase, svc: ExecServices, opts: { tracer: Tracer; signal?: AbortSignal; parentSpan?: SpanHandle }): Promise<ExecutionOutcome> {
  let test = testIn;
  const scope = svc.vars.clone();
  if (test.variables) scope.setScope('request', test.variables);
  const root = opts.tracer.start(test.name, 'test', { parent: opts.parentSpan, attributes: { type: test.type, file: test.file && workspaceRelative(test.file) } });
  const metadata: Record<string, unknown> = {};
  const scriptChecks: CheckResult[] = [];
  let ctx: CheckContext = { testType: test.type, body: undefined, text: '' };
  let partial: Partial<ExecutionOutcome> = {};
  const sendRequest = scriptRequestSender({ redactor: svc.redactor, cookieJar: svc.cookieJar, signal: opts.signal, timeoutMs: svc.defaultTimeoutMs });

  try {
    // pre-request script (Postman-compatible: can read/modify the request and set variables)
    if (test.preRequestScript) {
      const req =
        test.type === 'http'
          ? { method: test.request.method, url: test.request.url, headers: [...(test.request.headers ?? [])], body: test.request.body && 'content' in test.request.body ? test.request.body.content : undefined }
          : test.type === 'graphql'
            ? { method: 'POST', url: test.endpoint, headers: [...(test.headers ?? [])], body: JSON.stringify({ query: test.query, variables: test.graphqlVariables, operationName: test.operationName }) }
            : undefined;
      const s = await runScript(test.preRequestScript, { ...scriptScopes(scope, test.variables), request: req, jar: svc.cookieJar?.list(), info: scriptInfo(test, svc) }, { sendRequest, requirePackage: svc.scriptPackage });
      root.event('pre-request script', { logs: s.logs, error: s.error });
      if (svc.cookieJar) applyCookieJarOps(svc.cookieJar, s.jarOps);
      applyScriptOutput(s, [scope, svc.vars], { redactor: svc.redactor, persist: svc.persistVariable });
      if (s.error) throw new ApsError('ScriptError', `Pre-request script failed: ${s.error}`);
      if (s.logs.length) metadata.preRequestLogs = s.logs.slice(0, 100);
      if (s.sentRequests?.length) metadata.sentRequests = s.sentRequests.map((r) => ({ ...r, url: svc.redactor.redactUrl(r.url) }));
      if (test.type === 'http' && s.request) {
        const body = test.request.body && 'content' in test.request.body && s.request.body !== undefined ? { ...test.request.body, content: s.request.body } : test.request.body;
        test = { ...test, request: { ...test.request, method: s.request.method, url: s.request.url, headers: s.request.headers, body } };
      }
      // GraphQL: the endpoint and headers can change (the query stays as written)
      if (test.type === 'graphql' && s.request) test = { ...test, endpoint: s.request.url, headers: s.request.headers };
      if (s.nextRequest !== undefined) metadata.nextRequest = s.nextRequest;
      if (s.skipRequest) {
        root.end({ status: 'ok' });
        return { status: 'skipped', checks: [], metadata: { ...metadata, reason: 'skipped by tp.execution.skipRequest()' } };
      }
    }

    const run = async (signal: AbortSignal) => {
      switch (test.type) {
        case 'http':
          return runHttp(test, scope, svc, root, signal);
        case 'graphql':
          return runGraphQL(test, scope, svc, root, signal);
        case 'grpc':
          return runGrpc(test, scope, svc, root, signal);
        case 'websocket':
          return runWebSocket(test, scope, svc, root, signal);
        case 'mcp':
          return runMcp(test, scope, svc, root, signal);
        case 'llm':
          return runLlm(test, scope, svc, root, signal);
        case 'rag':
          return runRag(test, scope, svc, root, signal);
        case 'agent':
          return runAgentTest(test, scope, svc, root, signal);
        case 'delay':
          return runDelay(test, test.timeoutMs ?? svc.defaultTimeoutMs, signal);
        default:
          throw new ApsError('ConfigurationError', `Unknown test type "${(test as TestCase).type}"`);
      }
    };
    const r = await withTimeout(run, test.timeoutMs ?? svc.defaultTimeoutMs, opts.signal, `Test "${test.name}"`);
    ctx = r.ctx;
    partial = r.partial;
    Object.assign(metadata, r.metadata ?? {});
  } catch (e) {
    const err = normalizeError(e);
    if (err.kind === 'CancelledError' && opts.signal?.aborted) {
      root.fail(e);
      throw e;
    }
    ctx.error = err;
    root.event('error', { kind: err.kind, message: err.message });
  }
  ctx.services = { providers: svc.providers, signal: opts.signal, span: root };

  // test script (sandboxed)
  if (test.testScript) {
    const s = await runScript(test.testScript, {
      ...scriptScopes(scope, test.variables),
      request:
        test.type === 'http'
          ? { method: test.request.method, url: scope.resolve(test.request.url), headers: scope.resolveDeep([...(test.request.headers ?? [])]) }
          : test.type === 'graphql'
            ? { method: 'POST', url: scope.resolve(test.endpoint), headers: scope.resolveDeep([...(test.headers ?? [])]) }
            : undefined,
      response: { status: ctx.status, headers: ctx.headers, body: ctx.text, time: ctx.latencyMs },
      cookies: ctx.cookies,
      jar: svc.cookieJar?.list(),
      info: scriptInfo(test, svc),
      data: { body: ctx.body, toolCalls: ctx.toolCalls, tokens: ctx.tokens, error: ctx.error },
    }, { sendRequest, requirePackage: svc.scriptPackage });
    if (svc.cookieJar) applyCookieJarOps(svc.cookieJar, s.jarOps);
    applyScriptOutput(s, [scope, svc.vars], { redactor: svc.redactor, persist: svc.persistVariable });
    if (s.nextRequest !== undefined) metadata.nextRequest = s.nextRequest;
    for (const t of s.tests) scriptChecks.push({ type: 'script', name: t.name, passed: t.passed, source: 'deterministic', message: t.message ?? (t.passed ? 'passed' : 'failed') });
    if (s.error) scriptChecks.push({ type: 'script', name: 'test script', passed: false, source: 'deterministic', message: s.error });
    if (s.logs.length) metadata.scriptLogs = s.logs.slice(0, 100);
    if (s.visualizer) {
      // tp.visualizer output (redacted HTML) for reports, the MCP server and the CLI's --json output
      const v = renderVisualizer(s.visualizer.template, s.visualizer.data);
      metadata.visualizer = { html: v.html === undefined ? undefined : svc.redactor.redactString(v.html.slice(0, 200_000)), error: v.error };
    }
    if (s.sentRequests?.length) metadata.sentRequests = [...((metadata.sentRequests as unknown[]) ?? []), ...s.sentRequests.map((r) => ({ ...r, url: svc.redactor.redactUrl(r.url) }))];
  }

  // check configs may reference variables, e.g. dataset fields: `expected: "{{expected}}"`
  const checkConfigs: CheckConfig[] = scope.resolveDeep([...(test.assertions ?? []), ...(test.evaluators ?? []), ...implicitChecks(test, ctx)]);
  const evalSpan = checkConfigs.length ? root.child('evaluate', 'evaluation', { attributes: { checks: checkConfigs.length } }) : undefined;
  ctx.services.span = evalSpan ?? root;
  const checks = [...scriptChecks, ...(await runChecks(checkConfigs, ctx))];
  evalSpan?.end({ status: checks.every((c) => c.passed) ? 'ok' : 'error', output: checks.map((c) => ({ name: c.name, passed: c.passed, score: c.score, source: c.source })) });

  // extraction into runtime variables (visible to later/dependent tests)
  for (const [name, path] of Object.entries(test.extract ?? {})) {
    const v = path === '$status' ? ctx.status : path === '$text' ? ctx.text : query(ctx.body, path);
    if (v !== undefined) {
      svc.vars.set(name, v, 'runtime');
      if (svc.redactor.isSensitiveKey(name) && typeof v === 'string') svc.redactor.addSecret(v);
    }
  }

  // execution exceptions always make the test an error; otherwise any failed check fails it
  const failed = checks.some((c) => !c.passed);
  const status: TestStatus = ctx.error ? 'error' : failed ? 'failed' : 'passed';

  if (scope.unresolved.size) metadata.unresolvedVariables = [...scope.unresolved];
  root.setAttributes({ status });
  root.end({ status: status === 'passed' ? 'ok' : 'error', error: ctx.error?.message });

  return {
    status,
    checks,
    error: ctx.error,
    latencyMs: ctx.latencyMs,
    tokens: ctx.tokens,
    costUsd: ctx.costUsd,
    model: partial.model,
    output: partial.output ?? (ctx.text ? summarize(svc.redactor.redactString(ctx.text)) : undefined),
    input: partial.input,
    metadata,
    context: ctx,
  };
}

/** `…/tests/rest/auth.yaml` → `tests/rest/auth.yaml`, so traces don't embed machine-specific absolute paths. */
function workspaceRelative(file: string): string {
  const p = file.split('\\').join('/');
  const i = p.lastIndexOf('/tests/');
  return i >= 0 ? p.slice(i + 1) : p.slice(p.lastIndexOf('/') + 1);
}

function implicitChecks(test: TestCase, ctx: CheckContext): CheckConfig[] {
  const out: CheckConfig[] = [];
  const explicit = [...(test.assertions ?? []), ...(test.evaluators ?? [])];
  if (test.type === 'llm') {
    const l = test.limits ?? {};
    if (l.latency_ms) out.push({ type: 'latency', name: 'limit: latency', max: l.latency_ms });
    if (l.tokens) out.push({ type: 'tokens', name: 'limit: total tokens', max: l.tokens });
    if (l.output_tokens) out.push({ type: 'tokens', name: 'limit: output tokens', field: 'output', max: l.output_tokens });
    if (l.cost) out.push({ type: 'cost', name: 'limit: cost', max: l.cost });
    if (test.responseFormat?.schema && !explicit.some((c) => c.type === 'json-schema'))
      out.push({ type: 'json-schema', name: 'structured output schema', schema: test.responseFormat.schema });
    if (!explicit.length && test.expected !== undefined)
      out.push({ type: typeof test.expected === 'object' ? 'equals' : 'exact-match', name: 'matches expected', expected: test.expected, ignoreCase: typeof test.expected === 'string' });
  }
  if (test.type === 'rag' && !explicit.length) {
    out.push({ type: 'context-precision' }, { type: 'groundedness' }, { type: 'answer-relevance' }, { type: 'citation', required: false });
    if (ctx.expected) out.push({ type: 'context-recall' });
  }
  if (test.type === 'mcp' && !explicit.length) out.push({ type: 'status', expected: 'success' });
  if (test.type === 'graphql' && !explicit.length) out.push({ type: 'graphql-no-errors' });
  if (test.type === 'grpc' && !explicit.some((c) => c.type === 'grpc-status')) out.push({ type: 'grpc-status', expected: 'OK' });
  return out;
}

/** `tp.cookies`: the jar's cookies for the response URL, overlaid with the response's own Set-Cookie values. */
export function responseCookies(set: Array<{ name: string; value: string }>, jar: CookieJar | undefined, url: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (jar) for (const c of jar.cookiesFor(url).reverse()) out[c.name] = c.value;
  for (const c of set) if (c.name) out[c.name] = c.value;
  return out;
}

type Runner = Promise<{ ctx: CheckContext; partial: Partial<ExecutionOutcome>; metadata?: Record<string, unknown> }>;

async function runHttp(test: HttpTest, scope: VariableScope, svc: ExecServices, span: SpanHandle, signal: AbortSignal): Runner {
  const spec = scope.resolveDeep(test.request);
  if (spec.auth?.type === 'inherit' || !spec.auth) spec.auth = svc.inheritedAuth ? scope.resolveDeep(svc.inheritedAuth) : spec.auth;
  const s = span.child(`${spec.method} ${svc.redactor.redactUrl(spec.url)}`, 'http', { attributes: { method: spec.method } });
  try {
    const { response, prepared } = await executeHttp(spec, {
      signal,
      redactor: svc.redactor,
      maxPreviewBytes: svc.maxPreviewBytes ?? 1024 * 1024,
      openExternal: svc.openExternal,
      cookieJar: svc.cookieJar,
      variableNames: () => scope.names(),
    });
    svc.onHttpResponse?.({ testId: test.id ?? test.name, status: response.status, statusText: response.statusText ?? '', headers: response.headers, body: response.bodyPreview, durationMs: response.durationMs, url: prepared.url, timing: timingSummary(response) });
    if (response.connection?.certificate) svc.onCertificate?.(prepared.url, response.connection.certificate);
    timingSpans(s, response.timeline);
    s.setAttributes({ url: prepared.url, status: response.status, size: response.size, durationMs: response.durationMs });
    s.span.input = { headers: prepared.headers, body: prepared.bodyPreview };
    s.end({ status: response.status >= 400 ? 'error' : 'ok', output: { status: response.status, headers: response.headers, body: summarize(response.bodyPreview, 16_000) } });
    return {
      ctx: {
        testType: 'http',
        status: response.status,
        headers: response.headers,
        body: response.json ?? response.bodyPreview,
        text: response.bodyPreview,
        latencyMs: response.durationMs,
        cookies: responseCookies(response.cookies, svc.cookieJar, response.url),
        request: { method: prepared.method, url: prepared.url },
        certificate: response.connection?.certificate,
        readFile: svc.readFile,
      },
      partial: { input: `${prepared.method} ${prepared.url}`, output: summarize(svc.redactor.redact(response.json ?? response.bodyPreview)) },
      metadata: { url: prepared.url, method: prepared.method, status: response.status, size: response.size, truncated: response.truncated, timing: timingSummary(response) },
    };
  } catch (e) {
    s.fail(e);
    throw e;
  }
}

/**
 * A subscription in a test file or a collection run: subscribe over WebSocket (graphql-transport-ws or graphql-ws),
 * collect `events` events (default 1) or listen `waitMs` at most, then stop. The body looks like a query's: the first
 * event's `data` and `errors`, plus every event in `events`, so `$.data.x` checks work the same.
 */
async function runGraphQLSubscription(test: GraphQLTest, r: { endpoint: string; query: string; variables?: unknown; operationName?: string; headers?: KeyValue[] }, auth: AuthConfig | undefined, svc: ExecServices, s: SpanHandle, signal: AbortSignal): Runner {
  const t0 = Date.now();
  const headers = [...(r.headers ?? [])];
  // the usual header auth travels with the WebSocket handshake
  if (auth?.type === 'bearer' && auth.token) headers.push({ key: 'Authorization', value: `Bearer ${auth.token}`, enabled: true });
  else if (auth?.type === 'basic') headers.push({ key: 'Authorization', value: `Basic ${Buffer.from(`${auth.username ?? ''}:${auth.password ?? ''}`).toString('base64')}`, enabled: true });
  else if (auth?.type === 'apiKey' && (auth.in ?? 'header') === 'header' && auth.key) headers.push({ key: auth.key, value: auth.value ?? '', enabled: true });
  const vars = typeof r.variables === 'string' ? (r.variables.trim() ? (JSON.parse(r.variables) as Record<string, unknown>) : undefined) : (r.variables as Record<string, unknown> | undefined);
  const wait = Math.min(Math.max(100, test.waitMs ?? 10_000), 600_000);
  try {
    if (signal.aborted) throw new ApsError('CancelledError', 'The run was stopped');
    const out = await collectSubscriptionEvents({
      url: subscriptionUrl(r.endpoint),
      query: r.query,
      variables: vars,
      operationName: r.operationName,
      headers,
      cookieJar: svc.cookieJar,
      maxEvents: Math.max(1, test.events ?? 1),
      durationMs: wait,
      signal,
    });
    const events = out.events as Array<{ data?: unknown; errors?: unknown[] }>;
    const first = events[0];
    const errors = [...((first?.errors as GraphQLResult['errors']) ?? []), ...(out.errors.flat() as NonNullable<GraphQLResult['errors']>)];
    const body = { data: first?.data ?? null, ...(errors.length ? { errors } : {}), events, count: events.length, completed: out.completed, protocol: out.protocol };
    const latencyMs = Date.now() - t0;
    s.setAttributes({ endpoint: svc.redactor.redactUrl(r.endpoint), operationType: 'subscription', events: events.length, errors: errors.length });
    s.end({ status: errors.length || !events.length ? 'error' : 'ok', output: summarize(body, 16_000) });
    return {
      // no event at all fails the default check (graphql-no-errors) with the reason
      ctx: { testType: 'graphql', status: 101, headers: [], body, text: JSON.stringify(body), latencyMs, graphqlErrors: errors.length ? errors : events.length ? undefined : [{ message: `No subscription event arrived within ${wait} ms` }] },
      partial: { input: summarize(r.query, 1000), output: summarize(body) },
    };
  } catch (e) {
    s.fail(e);
    throw e;
  }
}

async function runGraphQL(test: GraphQLTest, scope: VariableScope, svc: ExecServices, span: SpanHandle, signal: AbortSignal): Runner {
  const r = scope.resolveDeep({ endpoint: test.endpoint, query: test.query, variables: test.graphqlVariables, operationName: test.operationName, headers: test.headers, auth: test.auth });
  const auth = !r.auth || r.auth.type === 'inherit' ? (svc.inheritedAuth ? scope.resolveDeep(svc.inheritedAuth) : undefined) : r.auth;
  const s = span.child(`graphql ${test.operationName ?? ''}`.trim(), 'graphql', { input: { query: r.query, variables: r.variables } });
  if (detectOperation(r.query, r.operationName).type === 'subscription') return runGraphQLSubscription(test, r, auth, svc, s, signal);
  try {
    const out = await executeGraphQL({ ...r, auth }, { signal, redactor: svc.redactor, maxPreviewBytes: svc.maxPreviewBytes ?? 1024 * 1024, cookieJar: svc.cookieJar, variableNames: () => scope.names() });
    svc.onHttpResponse?.({ testId: test.id ?? test.name, status: out.response.status, statusText: out.response.statusText ?? '', headers: out.response.headers, body: out.response.bodyPreview, durationMs: out.response.durationMs, url: out.prepared.url, timing: timingSummary(out.response) });
    if (out.response.connection?.certificate) svc.onCertificate?.(out.prepared.url, out.response.connection.certificate);
    timingSpans(s, out.response.timeline);
    s.setAttributes({ endpoint: svc.redactor.redactUrl(r.endpoint), status: out.response.status, operationType: out.operationType, errors: out.errors?.length ?? 0 });
    s.end({ status: out.errors?.length || out.response.status >= 400 ? 'error' : 'ok', output: summarize(out.response.json ?? out.response.bodyPreview, 16_000) });
    return {
      ctx: {
        testType: 'graphql',
        status: out.response.status,
        headers: out.response.headers,
        body: out.response.json ?? out.response.bodyPreview,
        text: out.response.bodyPreview,
        latencyMs: out.response.durationMs,
        graphqlErrors: out.errors,
      },
      partial: { input: summarize(r.query, 1000), output: summarize(out.response.json ?? out.response.bodyPreview) },
      metadata: { timing: timingSummary(out.response) },
    };
  } catch (e) {
    s.fail(e);
    throw e;
  }
}

async function runGrpc(test: GrpcTest, scope: VariableScope, svc: ExecServices, span: SpanHandle, signal: AbortSignal): Runner {
  const r = scope.resolveDeep({ target: test.target, method: test.method, message: test.message, metadata: test.metadata });
  // without proto files, the server describes itself (server reflection)
  let protoFiles: Array<{ name: string; text: string }> | undefined;
  let descriptorSet: string | undefined;
  if (test.protoFiles?.length) protoFiles = test.protoFiles;
  else if (test.descriptorSet) descriptorSet = test.descriptorSet;
  else if (test.protos?.length) {
    if (!svc.readFile) throw new ApsError('ConfigurationError', 'gRPC tests need a workspace to read their .proto files from');
    protoFiles = test.protos.map((name) => ({ name, text: svc.readFile!(name) }));
  } else descriptorSet = (await reflectServer(parseGrpcTarget(r.target, test.tls), { metadata: r.metadata })).descriptorSet;
  const s = span.child(`grpc ${r.method}`, 'grpc', { input: { message: r.message } });
  try {
    const out = await executeGrpc(
      { target: r.target, method: r.method, message: r.message === undefined ? undefined : JSON.stringify(r.message), metadata: r.metadata, protoFiles, descriptorSet, tls: test.tls, timeoutMs: test.timeoutMs ?? svc.defaultTimeoutMs },
      { signal, redactor: svc.redactor },
    );
    const body = out.messages ? out.messages.map((m) => m.data) : (out.response ?? null);
    s.setAttributes({ target: out.target, method: out.method, code: out.code });
    s.end({ status: out.code === 0 ? 'ok' : 'error', output: summarize(body, 16_000) });
    return {
      ctx: {
        testType: 'grpc',
        status: out.code,
        headers: out.metadata,
        body,
        text: JSON.stringify(body),
        latencyMs: out.durationMs,
        grpc: { code: out.code, codeName: out.codeName, details: out.details, trailers: out.trailers },
      },
      partial: { input: `${out.method} @ ${out.target}`, output: summarize(svc.redactor.redact(body)) },
      metadata: { target: out.target, method: out.method, code: out.codeName },
    };
  } catch (e) {
    s.fail(e);
    throw e;
  }
}

async function runWebSocket(test: WebSocketTest, scope: VariableScope, svc: ExecServices, span: SpanHandle, signal: AbortSignal): Runner {
  const r = scope.resolveDeep({ url: test.url, send: test.send ?? [], headers: test.headers, auth: test.auth, path: test.path, subscribe: test.subscribe, clientId: test.clientId, username: test.username, password: test.password, groupId: test.groupId });
  const mode = test.mode ?? realtimeModeFor(r.url);
  // WebSocket frames are text: objects are sent as JSON. Socket.IO items are { event, args, ack } (or an event name).
  // MQTT items are { topic, payload, qos, retain }; Kafka items { topic, payload, key, headers, partition }.
  const send = r.send.map((m) =>
    mode === 'kafka'
      ? typeof m === 'string'
        ? { topic: m }
        : {
            topic: String(m.topic ?? ''),
            payload: m.payload ?? m.value ?? m.data ?? m.message,
            ...(m.key !== undefined ? { key: String(m.key) } : {}),
            ...(m.headers ? { headers: Object.fromEntries(Object.entries(m.headers as Record<string, unknown>).map(([k, v]) => [k, String(v)])) } : {}),
            ...(m.partition !== undefined ? { partition: Number(m.partition) } : {}),
          }
      : mode === 'websocket'
      ? typeof m === 'string'
        ? m
        : JSON.stringify(m)
      : mode === 'mqtt'
        ? typeof m === 'string'
          ? { topic: m }
          : { topic: String(m.topic ?? ''), payload: m.payload ?? m.data ?? m.message, qos: (Number(m.qos) || 0) as 0 | 1 | 2, retain: !!m.retain }
        : typeof m === 'string'
          ? m
          : { event: String(m.event ?? 'message'), args: Array.isArray(m.args) ? m.args : m.data !== undefined ? [m.data] : [], ack: !!m.ack },
  );
  const s = span.child(`${mode} ${svc.redactor.redactUrl(r.url)}`, 'internal', { input: { send, ...(r.subscribe ? { subscribe: r.subscribe } : {}) } });
  const out = await runRealtimeExchange(
    { url: r.url, mode, send, waitMs: test.waitMs, headers: r.headers, protocols: test.protocols, auth: r.auth, path: r.path, subscribe: r.subscribe, clientId: r.clientId, username: r.username, password: r.password, groupId: r.groupId, mechanism: test.mechanism },
    { redactor: svc.redactor, cookieJar: svc.cookieJar, signal },
  );
  if (!out.connected) {
    const why = out.messages.filter((m) => m.direction === 'system').map((m) => m.data).join('; ') || 'the server did not accept the connection';
    s.fail(new Error(why));
    throw new ApsError('NetworkError', `Could not connect to ${svc.redactor.redactUrl(r.url)}: ${why}`, { suggestions: [] });
  }
  const parse = (t: string): unknown => {
    try {
      return JSON.parse(t);
    } catch {
      return t;
    }
  };
  const received = out.messages
    .filter((m) => m.direction === 'received')
    .map((m) =>
      mode === 'socketio'
        ? { event: m.event, data: parse(m.data) }
        : mode === 'mqtt'
          ? { topic: m.topic, data: parse(m.data) }
          : mode === 'kafka'
            ? { topic: m.topic, key: m.key, partition: m.partition, offset: m.offset, ...(m.headers ? { headers: m.headers } : {}), data: parse(m.data) }
            : parse(m.data),
    );
  const body = { connected: true, received, messages: out.messages };
  s.setAttributes({ mode, received: received.length });
  s.end({ status: 'ok', output: summarize(received, 16_000) });
  return {
    ctx: { testType: 'websocket', status: mode === 'websocket' ? 101 : 200, body, text: out.messages.filter((m) => m.direction === 'received').map((m) => m.data).join('\n'), latencyMs: out.durationMs },
    partial: { input: `${mode} ${svc.redactor.redactUrl(r.url)} · ${send.length} sent`, output: summarize(received) },
    metadata: { url: svc.redactor.redactUrl(r.url), mode, received: received.length },
  };
}

/** tp.info for scripts: the request's own name (not its folder path), its location and the environment. */
function scriptInfo(test: TestCase, svc: ExecServices) {
  return { requestName: test.location?.at(-1) ?? test.name, requestId: test.id, environmentName: svc.environmentName, location: test.location ?? [test.name] };
}

async function runMcp(test: McpTest, scope: VariableScope, svc: ExecServices, span: SpanHandle, signal: AbortSignal): Runner {
  // what the server asked the client during this test (elicitation, sampling), for the trace and the result
  const serverRequests: Array<{ kind: string; params: unknown }> = [];
  const connect = span.child('mcp session', 'mcp', { attributes: { server: typeof test.server === 'string' ? test.server : test.server.name } });
  let session;
  try {
    // sessions are pooled per run (and per client capability set), so this is only slow for the first test using a server
    const features = [...(test.elicitation ? ['elicitation' as const] : []), ...(test.sampling ? ['sampling' as const] : []), ...(test.roots ? ['roots' as const] : [])];
    session = await svc.mcp.get(test.server, features);
    const asked: Array<{ kind: string; params: unknown }> = serverRequests;
    session.setHandlers({
      ...(test.roots ? { roots: () => test.roots!.map((r) => ({ uri: /^[a-z][\w+.-]*:\/\//i.test(r) ? r : pathToFileURL(r).href })) } : {}),
      ...(test.elicitation
        ? {
            elicitation: async (params) => {
              asked.push({ kind: 'elicitation', params });
              const action = test.elicitation!.action ?? 'accept';
              return action === 'accept' ? { action, content: scope.resolveDeep(test.elicitation!.content ?? {}) as Record<string, string | number | boolean> } : { action };
            },
          }
        : {}),
      ...(test.sampling
        ? {
            sampling: async (params) => {
              asked.push({ kind: 'sampling', params });
              return { role: 'assistant' as const, content: { type: 'text' as const, text: scope.resolve(test.sampling!.text) }, model: test.sampling!.model ?? 'testpion-fixed-reply', stopReason: 'endTurn' };
            },
          }
        : {}),
    });
    connect.end({ output: { server: session.config.name, transport: session.config.transport } });
  } catch (e) {
    connect.fail(e);
    throw e;
  }
  const args = scope.resolveDeep(test.arguments ?? {});
  if (test.tool) {
    const s = span.child(`tools/call ${test.tool}`, 'mcp', { attributes: { server: session.config.name, tool: test.tool }, input: args });
    const r = await session.callTool(test.tool, args, { signal });
    const { body, text } = mcpResultBody(r);
    if (serverRequests.length) s.setAttributes({ serverRequests: serverRequests.length });
    s.end({ status: r.isError ? 'error' : 'ok', output: serverRequests.length ? { result: r.raw, serverRequests } : r.raw });
    return {
      ctx: { testType: 'mcp', body, text, isError: r.isError, latencyMs: r.durationMs },
      partial: { input: `${test.tool}(${summarize(args, 500)})`, output: summarize(svc.redactor.redact(body)) },
      metadata: { server: session.config.name, tool: test.tool, ...(serverRequests.length ? { serverRequests: svc.redactor.redact(serverRequests) } : {}) },
    };
  }
  if (test.resource) {
    const uri = scope.resolve(test.resource);
    const s = span.child(`resources/read ${uri}`, 'mcp', { attributes: { server: session.config.name, uri } });
    const r = await session.readResource(uri, { signal });
    s.end({ output: r.contents });
    const texts = (r.contents as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
    const parsed = tryParseJson(texts);
    return { ctx: { testType: 'mcp', body: parsed.ok ? parsed.value : { contents: r.contents }, text: texts, latencyMs: r.durationMs }, partial: { input: uri, output: summarize(texts) } };
  }
  if (test.prompt) {
    const pargs = scope.resolveDeep(test.prompt.arguments ?? {});
    const s = span.child(`prompts/get ${test.prompt.name}`, 'mcp', { attributes: { server: session.config.name }, input: pargs });
    const r = await session.getPrompt(test.prompt.name, pargs, { signal });
    s.end({ output: r.messages });
    return { ctx: { testType: 'mcp', body: { messages: r.messages, description: r.description }, text: JSON.stringify(r.messages), latencyMs: r.durationMs }, partial: { input: test.prompt.name } };
  }
  // no operation: connectivity test (ping)
  const ms = await session.ping();
  return { ctx: { testType: 'mcp', body: { ok: true }, text: 'pong', latencyMs: ms }, partial: { input: 'ping' } };
}

function promptOf(test: LlmTest): { template: string; system?: string } {
  return typeof test.prompt === 'string' ? { template: test.prompt, system: test.system } : { template: test.prompt.template, system: test.prompt.system ?? test.system };
}

async function runLlm(test: LlmTest, scope: VariableScope, svc: ExecServices, span: SpanHandle, signal: AbortSignal): Runner {
  const { provider, model } = svc.providers.resolveModel(scope.resolveDeep(test.model));
  const p = promptOf(test);
  const input = scope.resolveDeep(test.input ?? {});
  const userPrompt = renderPrompt(p.template, scope, input);
  const system = p.system ? renderPrompt(p.system, scope, input) : undefined;
  const messages: ChatMessage[] = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: userPrompt });
  const s = span.child(`llm ${model}`, 'llm', {
    attributes: { provider: provider.config.name, model, temperature: test.model.temperature, topP: test.model.topP, maxTokens: test.model.maxTokens },
    input: messages,
  });
  let r;
  try {
    r = await provider.chat({
      model,
      messages,
      temperature: test.model.temperature,
      topP: test.model.topP,
      maxTokens: test.model.maxTokens,
      seed: test.model.seed,
      responseFormat: test.responseFormat,
      stream: (test as { stream?: boolean }).stream === true,
      signal,
    });
  } catch (e) {
    s.fail(e);
    throw e;
  }
  const cost = estimateCost(svc.pricing, provider.config, r.model || model, r.usage);
  s.setAttributes({ inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, ttftMs: r.timing.firstTokenMs, latencyMs: r.timing.totalMs, costUsd: cost.cost, finishReason: r.finishReason });
  s.end({ output: r.text });
  const parsed = tryParseJson(r.text);
  return {
    ctx: {
      testType: 'llm',
      body: parsed.ok ? parsed.value : r.text,
      text: r.text,
      latencyMs: r.timing.totalMs,
      firstTokenMs: r.timing.firstTokenMs,
      tokens: r.usage,
      costUsd: cost.cost,
      input,
      expected: test.expected,
    },
    partial: { model: `${provider.config.name}/${r.model || model}`, input: summarize(userPrompt, 2000), output: summarize(r.text) },
    metadata: {
      reproducibility: {
        provider: provider.config.kind,
        model: r.model || model,
        temperature: test.model.temperature,
        topP: test.model.topP,
        seed: test.model.seed,
        promptHash: sha(JSON.stringify(messages)),
        priceVersion: cost.priceVersion,
        usageEstimated: r.usageEstimated,
      },
      ttftMs: r.timing.firstTokenMs,
      finishReason: r.finishReason,
    },
  };
}

const DEFAULT_RAG_PROMPT = `Answer the question using only the context below. Cite the sources you use as [id]. If the context does not contain the answer, say you don't know.

Context:
{{context}}

Question: {{question}}`;

async function runRag(test: RagTest, scope: VariableScope, svc: ExecServices, span: SpanHandle, signal: AbortSignal): Runner {
  const question = scope.resolve(test.question);
  const contexts = scope.resolveDeep(test.contexts ?? []);
  const retrieval = span.child('retrieval', 'internal', { attributes: { documents: contexts.length }, input: question });
  retrieval.end({ output: contexts.map((d) => ({ id: d.id, score: d.score, source: d.source, text: d.text.slice(0, 300) })) });
  let answer = test.answer !== undefined ? scope.resolve(test.answer) : undefined;
  let tokens: TokenUsage | undefined;
  let latencyMs: number | undefined;
  let modelName: string | undefined;
  let costUsd: number | undefined;
  let promptHash: string | undefined;
  if (answer === undefined) {
    if (!test.model) throw new ApsError('ConfigurationError', 'RAG test needs either `answer` or `model`');
    const { provider, model } = svc.providers.resolveModel(scope.resolveDeep(test.model));
    const prompt = renderPrompt(test.prompt ?? DEFAULT_RAG_PROMPT, scope, {
      question,
      context: contexts.map((d) => `[${d.id}] ${d.text}`).join('\n\n'),
    });
    promptHash = sha(prompt);
    const s = span.child(`llm ${model}`, 'llm', { attributes: { provider: provider.config.name, model }, input: prompt });
    try {
      const r = await provider.chat({ model, messages: [{ role: 'user', content: prompt }], temperature: test.model.temperature, maxTokens: test.model.maxTokens, seed: test.model.seed, signal });
      answer = r.text;
      tokens = r.usage;
      latencyMs = r.timing.totalMs;
      modelName = `${provider.config.name}/${r.model || model}`;
      costUsd = estimateCost(svc.pricing, provider.config, r.model || model, r.usage).cost;
      s.setAttributes({ inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens });
      s.end({ output: r.text });
    } catch (e) {
      s.fail(e);
      throw e;
    }
  }
  return {
    ctx: { testType: 'rag', body: answer, text: answer ?? '', contexts, question, expected: test.expected, tokens, latencyMs, costUsd },
    partial: { model: modelName, input: question, output: summarize(answer ?? '') },
    metadata: {
      rag: {
        query: question,
        documentIds: contexts.map((d) => d.id),
        scores: contexts.map((d) => d.score ?? null),
        promptHash,
      },
    },
  };
}

/** A pause: no request, no trace payload; never longer than the test's timeout; the run's cancel stops it at once. */
async function runDelay(test: DelayTest, timeoutMs: number | undefined, signal: AbortSignal): Runner {
  const ms = timeoutMs && timeoutMs > 0 ? Math.min(test.ms, timeoutMs) : test.ms;
  await sleep(ms, signal);
  return { ctx: { testType: 'delay', body: undefined, text: '' }, partial: {}, metadata: { waitedMs: ms, ...(ms < test.ms ? { cappedByTimeoutMs: timeoutMs } : {}) } };
}

async function runAgentTest(test: AgentTest, scope: VariableScope, svc: ExecServices, span: SpanHandle, signal: AbortSignal): Runner {
  const { provider, model } = svc.providers.resolveModel(scope.resolveDeep(test.model));
  const tools: AgentTool[] = [];
  const toolSchemas: Record<string, Record<string, unknown>> = {};
  for (const t of test.tools ?? []) {
    const schema = t.inputSchema ?? { type: 'object', properties: {} };
    toolSchemas[t.name] = schema;
    tools.push({
      name: t.name,
      description: t.description,
      inputSchema: schema,
      source: 'mock',
      invoke: async (args) => {
        const local = scope.clone();
        local.set('args', args, 'runtime');
        const result = local.resolveDeep(t.result ?? { ok: true });
        return { text: typeof result === 'string' ? result : JSON.stringify(result) };
      },
    });
  }
  for (const ref of test.mcpServers ?? []) {
    const session = await svc.mcp.get(ref);
    for (const t of await session.listTools()) {
      toolSchemas[t.name] = t.inputSchema;
      tools.push({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        source: 'mcp',
        server: session.config.name,
        invoke: async (args, sig) => {
          const r = await session.callTool(t.name, args, { signal: sig });
          const { text, body } = mcpResultBody(r);
          return { text: text || JSON.stringify(body), isError: r.isError };
        },
      });
    }
  }
  const input = scope.resolve(test.input);
  const r = await runAgent({
    provider,
    model,
    system: test.system ? scope.resolve(test.system) : undefined,
    input,
    tools,
    maxSteps: test.maxSteps,
    temperature: test.model.temperature,
    maxTokens: test.model.maxTokens,
    span,
    signal,
  });
  const cost = estimateCost(svc.pricing, provider.config, model, r.usage);
  const parsed = tryParseJson(r.finalText);
  return {
    ctx: {
      testType: 'agent',
      body: parsed.ok ? parsed.value : r.finalText,
      text: r.finalText,
      latencyMs: r.latencyMs,
      tokens: r.usage,
      costUsd: cost.cost,
      toolCalls: r.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments })),
      toolSchemas,
      input,
    },
    partial: { model: `${provider.config.name}/${model}`, input, output: summarize(r.finalText) },
    metadata: {
      agent: { steps: r.steps, modelCalls: r.modelCalls, stoppedReason: r.stoppedReason, toolCalls: r.toolCalls.map(({ result, ...c }) => ({ ...c, result: result.slice(0, 500) })) },
    },
  };
}
