/** Sending a request: HTTP (httpSend), GraphQL (gqlSend) and the code snippet of a request. The Backend methods are one-line delegates. */
import { ApsError, Tracer, executeHttp, executeGraphQL, inheritedAuthFor, normalizeError, runChecks, runScript, scriptScopes, applyScriptOutput, responseCookies, applyCookieJarOps, folderChain, withFolderDefaults, withInheritedHeaders, inheritedHeaders, folderVariables, scriptRequestSender, shortId, prepareHttpRequest, renderVisualizer, generateCode, type SnippetRequest, type CheckContext, type HttpRequestSpec, recordCertificate, timingSummary, timingSpans, requireEnvironment, assertProductionStep, isDataChangingMethod } from '@testpion/core';
import { clipConsole, consoleRefs } from './console-log.js';
import type { GqlSendParams, HttpSendParams } from './params.js';
import type { Backend } from './backend.js';

export async function httpSend(be: Backend, p: HttpSendParams) {
  // an environment that does not exist (or whose file cannot be read) is an error, never a silent send without its variables
  // (answered like any failed send: the response pane shows it with its why and suggestions)
  const id = p.id ?? shortId('req-');
  if (p.environment)
    try {
      requireEnvironment(be.ws, p.environment);
    } catch (e) {
      return { id, error: normalizeError(e), scriptLogs: [], unresolved: [], cycles: [], blockedEnv: [] };
    }
  const ctrl = new AbortController();
  be.controllers.set(id, ctrl);
  const ctx = be.context({ environment: p.environment, collectionId: p.collectionId });
  const tracer = new Tracer(p.name ?? `${p.request.method} ${p.request.url}`, ctx.redactor);
  const root = tracer.start(p.name ?? 'request', 'http');
  const chunks = be.batched<unknown>('http.chunks', 80);
  const sseEvents = be.batched<unknown>('http.sse', 100);
  let scriptLogs: string[] = [];
  let preLogCount: number | undefined;
  const saved = ctx.services.savedRequest ? { find: ctx.services.savedRequest, resolve: (s: HttpRequestSpec) => ctx.vars.resolveDeep(s) } : undefined;
  const scriptSender = scriptRequestSender({ redactor: ctx.redactor, cookieJar: ctx.services.cookieJar, signal: ctrl.signal, timeoutMs: be.settings.defaultTimeoutMs, production: ctx.services.production, saved });
  const sentLogs = (o: { sentRequests?: Array<{ method: string; url: string; status?: number; error?: string; durationMs?: number }> }) =>
    (o.sentRequests ?? []).map((r) => `tp.sendRequest ${r.method} ${ctx.redactor.redactUrl(r.url)} → ${r.error ? `error: ${r.error}` : `${r.status} (${r.durationMs} ms)`}`);
  const logsOf = () => scriptLogs.map((message, i) => ({ phase: i < (preLogCount ?? scriptLogs.length) ? ('pre-request' as const) : ('test' as const), message: ctx.redactor.redactString(message) }));
  try {
    let request = p.request;
    if ((!request.auth || request.auth.type === 'inherit') && ctx.collection)
      request = { ...request, auth: p.requestId ? inheritedAuthFor(ctx.collection, p.requestId) : ctx.collection.auth };
    // collection-level, folder-level (outer to inner), then request-level pre-request scripts
    const folders = ctx.collection && p.requestId ? folderChain(ctx.collection, p.requestId) : [];
    // headers and settings of the collection and its folders, under the request's own
    request = withFolderDefaults(request, ctx.collection, folders);
    const fv = folderVariables(folders);
    if (Object.keys(fv).length) ctx.vars.setScope('request', fv);
    for (const script of [ctx.collection?.preRequestScript, ...folders.map((f) => f.preRequestScript), p.preRequestScript]) {
      if (!script?.trim()) continue;
      const bodyText = request.body && 'content' in request.body ? request.body.content : undefined;
      const out = await runScript(script, {
        ...scriptScopes(ctx.vars),
        request: { method: request.method, url: request.url, headers: request.headers ?? [], body: bodyText },
        jar: ctx.services.cookieJar?.list(),
        info: { requestName: p.name, requestId: p.requestId, environmentName: ctx.environment?.name },
      }, { sendRequest: scriptSender, requirePackage: (n) => be.ws.readScriptPackage(n) });
      scriptLogs.push(...out.logs, ...sentLogs(out));
      applyScriptOutput(out, [ctx.vars], { redactor: ctx.redactor, persist: ctx.services.persistVariable });
      if (ctx.services.cookieJar) applyCookieJarOps(ctx.services.cookieJar, out.jarOps);
      if (out.error) throw new ApsError('ScriptError', `Pre-request script failed: ${out.error}`);
      if (out.request) {
        request = { ...request, method: out.request.method, url: out.request.url, headers: out.request.headers };
        if (out.request.body !== undefined && request.body && 'content' in request.body) request = { ...request, body: { ...request.body, content: out.request.body } };
      }
    }
    preLogCount = scriptLogs.length;
    const spec = ctx.vars.resolveDeep(request);
    spec.settings = { timeoutMs: be.settings.defaultTimeoutMs, ...spec.settings };
    // a pre-request script may turn a read into a write: the engine's own production check on what is really sent
    assertProductionStep(ctx.services.production, { action: `${spec.method} ${p.name ?? spec.url}`, changesData: isDataChangingMethod(spec.method) });
    // executeHttp applies spec.settings.timeoutMs itself (and stops the timer once an event stream starts); ctrl is the cancel
    let result;
    const sentAt = Date.now();
    try {
      result = await executeHttp(spec, {
        signal: ctrl.signal,
        variableNames: () => ctx.vars.names(),
        payloadDir: be.ws.path('payloads'),
        maxPreviewBytes: be.settings.maxPreviewBytes,
        redactor: ctx.redactor,
        openExternal: be.host.openExternal?.bind(be.host),
        cookieJar: ctx.services.cookieJar,
        onChunk: /event-stream|stream/i.test(JSON.stringify(spec.headers ?? '')) || p.stream ? (c) => chunks.push({ id, chunk: c }) : undefined,
        onSseEvent: (event) => sseEvents.push({ id, event: { ...event, data: ctx.redactor.redactString(event.data) } }),
      });
    } finally {
      chunks.flush();
      sseEvents.flush();
    }
    const { response, prepared } = result;
    root.setAttributes({ status: response.status, url: prepared.url, size: response.size });
    // DNS, TCP, TLS, waiting and download as child spans (the Traces waterfall, OTLP export)
    timingSpans(root, response.timeline, sentAt);
    root.span.input = { method: prepared.method, headers: prepared.headers, body: prepared.bodyPreview };
    // the body is kept (redacted, up to 48 KB) for the trace's Payload tab; the full body is in the payload file
    const tracedBody = response.bodyPreview.length > 48_000 ? `${response.bodyPreview.slice(0, 48_000)}…` : response.bodyPreview;
    root.end({ status: response.status >= 400 ? 'error' : 'ok', output: { status: response.status, headers: response.headers, body: tracedBody } });

    const cctx: CheckContext = {
      testType: 'http',
      status: response.status,
      headers: response.headers,
      body: response.json ?? response.bodyPreview,
      text: response.bodyPreview,
      latencyMs: response.durationMs,
      request: { method: prepared.method, url: prepared.url },
      readFile: ctx.services.readFile,
    };
    const checks = await runChecks(ctx.vars.resolveDeep(p.assertions ?? []), cctx);
    // tp.visualizer.set in any test script (collection, folders, request); the last call wins
    let visual: { template: string; data: unknown } | null | undefined;
    for (const script of [ctx.collection?.testScript, ...folders.map((f) => f.testScript), p.testScript]) {
      if (!script?.trim()) continue;
      const out = await runScript(script, {
        ...scriptScopes(ctx.vars),
        request: { method: spec.method, url: spec.url, headers: spec.headers ?? [] },
        response: { status: response.status, headers: response.headers, body: response.bodyPreview, time: response.durationMs },
        cookies: responseCookies(response.cookies, ctx.services.cookieJar, response.url),
        jar: ctx.services.cookieJar?.list(),
        info: { requestName: p.name, requestId: p.requestId, environmentName: ctx.environment?.name },
      }, { sendRequest: scriptSender, requirePackage: (n) => be.ws.readScriptPackage(n) });
      scriptLogs.push(...out.logs, ...sentLogs(out));
      if (out.visualizer !== undefined) visual = out.visualizer;
      applyScriptOutput(out, [ctx.vars], { redactor: ctx.redactor, persist: ctx.services.persistVariable });
      if (ctx.services.cookieJar) applyCookieJarOps(ctx.services.cookieJar, out.jarOps);
      for (const t of out.tests) checks.push({ type: 'script', name: t.name, passed: t.passed, source: 'deterministic', message: t.message ?? (t.passed ? 'passed' : 'failed') });
      if (out.error) checks.push({ type: 'script', name: 'test script', passed: false, source: 'deterministic', message: out.error });
    }
    const trace = tracer.finish();
    be.ws.saveTrace(trace, 'http');
    const historyId = shortId('h-');
    be.ws.meta.addHistory({
      id: historyId,
      timestamp: new Date().toISOString(),
      kind: 'http',
      name: p.name ?? `${prepared.method} ${prepared.url}`,
      method: prepared.method,
      url: prepared.url,
      status: response.status,
      durationMs: response.durationMs,
      size: response.size,
      request: ctx.redactor.redact(p.request),
      payloadPath: response.payloadPath,
      traceId: trace.traceId,
      collectionId: p.collectionId,
      requestId: p.requestId,
      responseMeta: { headers: ctx.redactor.redact(response.headers), contentType: response.contentType, truncated: response.truncated, timing: timingSummary(response), ...(checks.length ? { checksOk: checks.every((c) => c.passed) } : {}) },
    });
    recordCertificate(be.ws, prepared.url, response.connection?.certificate);
    const clip = clipConsole;
    // values typed into sensitive headers are secrets too (e.g. echoed back in a response body)
    for (const h of spec.headers ?? [])
      if (h.enabled !== false && ctx.redactor.isSensitiveKey(h.key) && h.value.length >= 6) {
        ctx.redactor.addSecret(h.value);
        const token = h.value.replace(/^\w+\s+/, '');
        if (token !== h.value && token.length >= 6) ctx.redactor.addSecret(token);
      }
    // so are sensitive fields of the request body (servers often echo them back)
    const collect = (v: unknown, key = '', depth = 0): void => {
      if (depth > 20 || v == null) return;
      if (typeof v === 'string') {
        if (key && ctx.redactor.isSensitiveKey(key) && v.length >= 4) ctx.redactor.addSecret(v);
      } else if (Array.isArray(v)) v.forEach((x) => collect(x, key, depth + 1));
      else if (typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) collect(x, k, depth + 1);
    };
    if (spec.body && 'content' in spec.body)
      try {
        collect(JSON.parse(spec.body.content));
      } catch {
        /* not JSON */
      }
    else if (spec.body && 'fields' in spec.body) for (const f of spec.body.fields) collect(f.value, f.key);
    const safeBody = (t: string | undefined) => {
      if (!t) return t;
      try {
        return JSON.stringify(ctx.redactor.redact(JSON.parse(t)), null, 2);
      } catch {
        return ctx.redactor.redactString(t);
      }
    };
    be.consoleEntry({
      id,
      time: new Date().toISOString(),
      source: 'request',
      name: p.name ?? `${prepared.method} ${prepared.url}`,
      method: prepared.method,
      url: prepared.url,
      status: response.status,
      durationMs: response.durationMs,
      size: response.size,
      request: { headers: prepared.headers, body: clip(safeBody(prepared.bodyPreview)) },
      response: { headers: ctx.redactor.redact(response.headers), body: clip(safeBody(response.bodyPreview)) },
      logs: logsOf(),
      failedChecks: checks.filter((c) => !c.passed).length,
      refs: consoleRefs({ collectionId: p.collectionId, requestId: p.requestId, historyId, traceId: trace.traceId }),
    });
    const rendered = visual ? renderVisualizer(visual.template, visual.data) : undefined;
    // scripts (charts) run only on the isolated visualization origin; the id is its access key
    const visualizer = rendered && { ...rendered, vizId: rendered.html !== undefined ? be.vizPages.publish(rendered.html, visual!.data) : undefined };
    return { id, response, prepared, checks, scriptLogs, visualizer, unresolved: [...ctx.vars.unresolved], cycles: [...ctx.vars.cycles], blockedEnv: [...ctx.vars.blockedEnv], traceId: trace.traceId, historyId };
  } catch (e) {
    const err = normalizeError(ctrl.signal.reason instanceof ApsError ? ctrl.signal.reason : e);
    root.fail(e);
    const trace = tracer.finish('error');
    be.ws.saveTrace(trace, 'http');
    const failedHistoryId = shortId('h-');
    be.ws.meta.addHistory({ id: failedHistoryId, timestamp: new Date().toISOString(), kind: 'http', name: p.name ?? `${p.request.method} ${p.request.url}`, method: p.request.method, url: ctx.redactor.redactUrl(ctx.vars.resolve(p.request.url)), status: err.kind, request: ctx.redactor.redact(p.request), traceId: trace.traceId });
    be.consoleEntry({
      id,
      time: new Date().toISOString(),
      source: 'request',
      name: p.name ?? `${p.request.method} ${p.request.url}`,
      method: p.request.method,
      url: ctx.redactor.redactUrl(ctx.vars.resolve(p.request.url)),
      status: err.kind,
      logs: logsOf(),
      error: err.message,
      refs: consoleRefs({ collectionId: p.collectionId, requestId: p.requestId, historyId: failedHistoryId, traceId: trace.traceId }),
    });
    // variables that refer to each other ({{a}} -> {{b}} -> {{a}}) are why a value is missing: say so with the error
    const cycles = [...ctx.vars.cycles];
    if (cycles.length) err.why = `${err.why ? `${err.why} ` : ''}Variables refer to each other in a loop: ${cycles.join('; ')}.`;
    return { id, error: err, scriptLogs, unresolved: [...ctx.vars.unresolved], cycles, blockedEnv: [...ctx.vars.blockedEnv], traceId: trace.traceId };
  } finally {
    be.controllers.delete(id);
  }
}

/** Code snippet for a request, with variables and auth resolved. Secrets are masked unless revealSecrets. */
export async function codeSnippet(be: Backend, p: { request: HttpRequestSpec; environment?: string; collectionId?: string; requestId?: string; language: string; revealSecrets?: boolean }) {
  const ctx = be.context({ environment: p.environment, collectionId: p.collectionId });
  let request = p.request;
  if ((!request.auth || request.auth.type === 'inherit') && ctx.collection)
    request = { ...request, auth: p.requestId ? inheritedAuthFor(ctx.collection, p.requestId) : ctx.collection.auth };
  if (ctx.collection) request = withFolderDefaults(request, ctx.collection, p.requestId ? folderChain(ctx.collection, p.requestId) : []);
  const spec = ctx.vars.resolveDeep(request);
  // OAuth would trigger a token request just to show code; show a placeholder header instead
  const auth = spec.auth?.type === 'oauth2' ? undefined : spec.auth;
  const prepared = await prepareHttpRequest({ ...spec, auth }, { redactor: ctx.redactor });
  const headers = [...prepared.headers.entries()].filter(([k]) => k !== 'user-agent') as Array<[string, string]>;
  if (spec.auth?.type === 'oauth2') headers.push(['Authorization', 'Bearer <access token from OAuth 2.0>']);
  // Digest is answered after the server's 401 challenge; AWS signatures below are valid for about 15 minutes
  if (spec.auth?.type === 'digest') headers.push(['Authorization', 'Digest <answer to the server challenge>']);
  const body = spec.body;
  const snippet: SnippetRequest = {
    method: prepared.method,
    url: prepared.url.toString(),
    headers,
    body: body && body.type !== 'multipart' && body.type !== 'binary' && body.type !== 'none' ? prepared.bodyPreview : body?.type === 'binary' ? `@${body.filePath}` : undefined,
    form: body?.type === 'multipart' ? body.fields.filter((f) => f.enabled !== false && f.key).map((f) => ({ key: f.key, value: f.value, file: f.kind === 'file' })) : undefined,
  };
  // "url": the resolved URL only (Copy URL); otherwise code in the chosen language
  const code = p.language === 'url' ? snippet.url : generateCode(snippet, p.language);
  if (p.revealSecrets) return code;
  // mask secret values and sensitive headers
  let masked = ctx.redactor.redactString(code);
  for (const [k, v] of headers) if (ctx.redactor.isSensitiveKey(k) && v.length >= 4) masked = masked.split(v).join('<secret>');
  return masked.split('[REDACTED]').join('<secret>');
}

export async function gqlSend(be: Backend, p: GqlSendParams) {
  const id = p.id ?? shortId('gql-');
  const ctrl = new AbortController();
  be.controllers.set(id, ctrl);
  const ctx = be.context({ environment: p.environment, collectionId: p.collectionId });
  const tracer = new Tracer(p.operationName ?? 'GraphQL', ctx.redactor);
  const span = tracer.start('graphql', 'graphql', { input: { query: p.request.query, variables: p.request.variables } });
  const saved = ctx.services.savedRequest ? { find: ctx.services.savedRequest, resolve: (s: HttpRequestSpec) => ctx.vars.resolveDeep(s) } : undefined;
  const scriptSender = scriptRequestSender({ redactor: ctx.redactor, cookieJar: ctx.services.cookieJar, signal: ctrl.signal, timeoutMs: be.settings.defaultTimeoutMs, production: ctx.services.production, saved });
  const scriptLogs: Array<{ phase: 'pre-request' | 'test'; message: string }> = [];
  const folders = ctx.collection && p.requestId ? folderChain(ctx.collection, p.requestId) : [];
  const info = { requestName: p.name ?? p.operationName, requestId: p.requestId, environmentName: ctx.environment?.name };
  try {
    // collection, folder (outer to inner) and request pre-request scripts, as for REST requests
    let request = p.request;
    request = { ...request, headers: withInheritedHeaders(request.headers, inheritedHeaders(ctx.collection, folders)) };
    const fv = folderVariables(folders);
    if (Object.keys(fv).length) ctx.vars.setScope('request', fv);
    for (const script of [ctx.collection?.preRequestScript, ...folders.map((f) => f.preRequestScript), p.preRequestScript]) {
      if (!script?.trim()) continue;
      const out = await runScript(script, {
        ...scriptScopes(ctx.vars),
        request: { method: 'POST', url: request.endpoint, headers: request.headers ?? [], body: JSON.stringify({ query: request.query, variables: request.variables }) },
        jar: ctx.services.cookieJar?.list(),
        info,
      }, { sendRequest: scriptSender, requirePackage: (n) => be.ws.readScriptPackage(n) });
      scriptLogs.push(...out.logs.map((message) => ({ phase: 'pre-request' as const, message: ctx.redactor.redactString(message) })));
      applyScriptOutput(out, [ctx.vars], { redactor: ctx.redactor, persist: ctx.services.persistVariable });
      if (ctx.services.cookieJar) applyCookieJarOps(ctx.services.cookieJar, out.jarOps);
      if (out.error) throw new ApsError('ScriptError', `Pre-request script failed: ${out.error}`);
      if (out.request) request = { ...request, endpoint: out.request.url, headers: out.request.headers };
    }
    const spec = ctx.vars.resolveDeep(request);
    const sentAt = Date.now();
    const r = await executeGraphQL(spec, { signal: ctrl.signal, redactor: ctx.redactor, maxPreviewBytes: be.settings.maxPreviewBytes, payloadDir: be.ws.path('payloads'), cookieJar: ctx.services.cookieJar });
    timingSpans(span, r.response.timeline, sentAt);
    span.end({ status: r.errors?.length ? 'error' : 'ok', output: r.response.json });
    const checks = await runChecks(ctx.vars.resolveDeep(p.assertions ?? []), {
      testType: 'graphql',
      status: r.response.status,
      headers: r.response.headers,
      body: r.response.json ?? r.response.bodyPreview,
      text: r.response.bodyPreview,
      latencyMs: r.response.durationMs,
      graphqlErrors: r.errors,
    });
    for (const script of [ctx.collection?.testScript, ...folders.map((f) => f.testScript), p.testScript]) {
      if (!script?.trim()) continue;
      const out = await runScript(script, {
        ...scriptScopes(ctx.vars),
        request: { method: 'POST', url: r.prepared.url, headers: spec.headers ?? [] },
        response: { status: r.response.status, headers: r.response.headers, body: r.response.bodyPreview, time: r.response.durationMs },
        jar: ctx.services.cookieJar?.list(),
        info,
      }, { sendRequest: scriptSender, requirePackage: (n) => be.ws.readScriptPackage(n) });
      scriptLogs.push(...out.logs.map((message) => ({ phase: 'test' as const, message: ctx.redactor.redactString(message) })));
      applyScriptOutput(out, [ctx.vars], { redactor: ctx.redactor, persist: ctx.services.persistVariable });
      if (ctx.services.cookieJar) applyCookieJarOps(ctx.services.cookieJar, out.jarOps);
      for (const t of out.tests) checks.push({ type: 'script', name: t.name, passed: t.passed, source: 'deterministic', message: t.message ?? (t.passed ? 'passed' : 'failed') });
      if (out.error) checks.push({ type: 'script', name: 'test script', passed: false, source: 'deterministic', message: out.error });
    }
    const trace = tracer.finish();
    be.ws.saveTrace(trace, 'graphql');
    recordCertificate(be.ws, r.prepared.url, r.response.connection?.certificate);
    const historyId = shortId('h-');
    be.ws.meta.addHistory({ id: historyId, timestamp: new Date().toISOString(), kind: 'graphql', name: p.name ?? p.operationName ?? 'GraphQL query', method: 'POST', url: r.prepared.url, status: r.response.status, durationMs: r.response.durationMs, size: r.response.size, request: ctx.redactor.redact(p.request), responseMeta: { timing: timingSummary(r.response), ...(checks.length ? { checksOk: checks.every((c) => c.passed) } : {}) }, traceId: trace.traceId, collectionId: p.collectionId, requestId: p.requestId });
    const clip = (t: string) => clipConsole(t)!;
    be.consoleEntry({
      id,
      time: new Date().toISOString(),
      source: 'request',
      kind: 'graphql',
      name: p.operationName ?? 'GraphQL query',
      method: 'POST',
      url: r.prepared.url,
      status: r.response.status,
      durationMs: r.response.durationMs,
      size: r.response.size,
      request: { headers: r.prepared.headers, body: clip(JSON.stringify(ctx.redactor.redact({ query: spec.query, variables: spec.variables, operationName: spec.operationName }), null, 2)) },
      response: { headers: ctx.redactor.redact(r.response.headers), body: clip(r.response.json !== undefined ? JSON.stringify(ctx.redactor.redact(r.response.json), null, 2) : ctx.redactor.redactString(r.response.bodyPreview)) },
      logs: scriptLogs,
      failedChecks: checks.filter((c) => !c.passed).length + (r.errors?.length ? 1 : 0),
      refs: consoleRefs({ collectionId: p.collectionId, requestId: p.requestId, historyId, traceId: trace.traceId }),
    });
    return { id, ...r, checks, traceId: trace.traceId, scriptLogs };
  } catch (e) {
    span.fail(e);
    be.ws.saveTrace(tracer.finish('error'), 'graphql');
    const err = normalizeError(e);
    be.consoleEntry({ id, time: new Date().toISOString(), source: 'request', kind: 'graphql', name: p.operationName ?? 'GraphQL query', method: 'POST', url: ctx.redactor.redactUrl(ctx.vars.resolve(p.request.endpoint)), status: err.kind, logs: scriptLogs, error: err.message });
    return { id, error: err, scriptLogs };
  } finally {
    be.controllers.delete(id);
  }
}
