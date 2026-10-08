import { runTests } from '../runner/runner.js';
import { breakdownOfRun, reviewResult, runResultsFile, runReviewReport } from '../runner/run-results.js';
import { monitorRequestStats } from '../runner/monitor-requests.js';
import { streamTests } from '../runner/loader.js';
import { join, relative, sep } from 'node:path';
import { testFromRequest } from '../runner/test-from.js';
import { evaluateThresholds, parseThreshold } from '../load/thresholds.js';
import { loadHistory, loadRunRecord, recordLoadRun } from '../load/history.js';
import { ENGINE_VERSION } from '../version.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { AppSettings, CheckConfig, Collection, CollectionNode, HttpRequestSpec, TestResult } from '../model/types.js';
import { AGENT_PROMPTS, agentGuide, toolAnnotations } from './agent-kit.js';
import { checkTypes } from '../eval/checks.js';
import { isSuiteFile, loadSuite, loadTestsFromFile } from '../runner/loader.js';
import { lintTestFile } from '../runner/test-schema.js';
import { tmpdir } from 'node:os';
import { readdirSync, rmSync, statSync } from 'node:fs';
import type { RunEvent } from '../runner/runner.js';
import { ApsError, normalizeError } from '../errors.js';
import { Redactor } from '../util/redact.js';
import { shortId } from '../util/ids.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { listCertificates, recordCertificate } from '../storage/certificates.js';
import { checkCertificate } from '../net/certificate-check.js';
import { decodeJwt } from '../util/jwt.js';
import { mcpToolUsage } from '../storage/mcp-usage.js';
import { llmUsage } from '../storage/llm-usage.js';
import { collectionTiming } from '../storage/collection-timing.js';
import type { SecretStore } from '../storage/secrets.js';
import { createEngineContext } from '../engine.js';
import { executeHttp, timingSummary } from '../protocols/http/client.js';
import { describeRoot, executeGrpc, grpcRoot, parseGrpcTarget } from '../protocols/grpc/grpc.js';
import { reflectServer } from '../protocols/grpc/reflection.js';
import { runRealtimeExchange, type RealtimeExchange } from '../protocols/realtime.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { workspaceEditTools } from './workspace-edit-tools.js';
import { gitTools } from './git-tools.js';
import { openApiTools } from './openapi-tools.js';
import { debuggerTools } from './debugger-tools.js';
import { historyTools } from './history-tools.js';
import { str, withEnvironmentSecrets, type Tool } from './tool.js';
import { MINIMAL_TOOLS, searchTool } from './search-tools.js';
import { commandLine, isCommandTrusted } from '../storage/trust.js';
import { McpSession } from '../protocols/mcp/client.js';
import { runCollection } from '../runner/collection-run.js';
import { appendDatasetRow, listWorkspaceDatasets, readDataset, type DatasetRecord } from '../runner/datasets.js';
import { dbKindOf } from '../runner/db-datasets.js';
import { collectionVariableFlow, definedVariableNames, unusedVariables } from '../runner/variable-flow.js';
import { collectionRealtimeTests, collectionSavedItems } from '../runner/collection-realtime.js';
import { collectionMarkdown } from '../report/collection-docs.js';
import { detectRequestSnippet, parseRequestSnippet } from '../import/snippet.js';
import { addRequestToCollection, externalizeSecrets } from '../import/save-request.js';
import { importIntoWorkspace } from '../import/workspace-import.js';
import { fetchImportText } from '../import/fetch-url.js';
import { diffOpenApi } from '../openapi/diff.js';
import { workspaceApiCoverage } from '../openapi/coverage.js';
import { evaluationTests, findSavedEvaluation, listSavedEvaluations } from '../runner/saved-evaluations.js';
import { collectionSecurityFindings } from '../runner/collection-findings.js';
import { compareRuns, recordRun } from '../runner/run-records.js';
import { readSpecRef } from '../openapi/spec-files.js';
import { collectSubscriptionEvents } from '../protocols/graphql/subscription.js';
import { introspect } from '../protocols/graphql/graphql.js';
import { buildGraphQLOperation } from '../protocols/graphql/operation-builder.js';
import { exportOtlp } from '../trace/otlp.js';
import { collectionToOpenApiText } from '../openapi/from-collection.js';
import { renameVariable, variableUsages } from '../storage/variable-refactor.js';
import { requireCollection, requireEnvironment, setEnvironmentVariables } from '../storage/env-edit.js';
import { runLoadTest, type LoadTarget } from '../load/load.js';
import { collectionLoadTarget } from '../load/collection-load.js';
import { compareHistory } from '../storage/history-compare.js';
import { redactDiff } from '../report/response-diff.js';
import { ciConfig, type CiConfigOptions } from '../runner/ci-config.js';
import { compareEnvironments, environmentMatrix } from '../storage/env-compare.js';
import { compareRequestAcrossEnvironments } from '../runner/env-request-compare.js';
import { executeMonitor, findMonitor, listMonitors, monitorDaily, monitorResults, monitorStatus } from '../runner/monitors.js';

/**
 * `testpion mcp-server`: the TestPion engine as MCP tools, so AI agents (Claude, IDE assistants …)
 * can browse a workspace's collections, send requests and run collections. Output is redacted with the
 * workspace's redaction rules; secret values never leave the machine through this server.
 */
export interface TestPionMcpOptions {
  store: WorkspaceStore;
  secrets: SecretStore;
  settings: AppSettings;
  /** Only the browsing tools (no requests are sent). */
  readOnly?: boolean;
  /**
   * Which tools are listed: `full` (every tool; the default) or `minimal` (the tools of the common jobs, for hosts
   * that load every listed tool into the context; search_tools finds the rest, and any tool can be called).
   */
  profile?: 'minimal' | 'full';
  /** Allow sending to environments marked as production (off by default). */
  allowProduction?: boolean;
  version?: string;
}

const BODY_CHARS = 20_000;




export function createTestPionMcpServer(opts: TestPionMcpOptions): Server {
  const { store, secrets, settings } = opts;
  const redactor = new Redactor(settings.redactFields);
  const collections = () => store.listCollections().filter((c) => !c.problem);
  const findCollection = (ref: unknown): Collection => requireCollection(store, String(ref ?? ''), { loadable: true });
  /** An OpenAPI document given as an http(s) link, a path inside the workspace (never outside it) or the text itself. */
  const readSpec = (ref: string): Promise<string> => readSpecRef(store, ref);
  type Flat = { node: Exclude<CollectionNode, { kind: 'folder' }>; folder: string };
  const flatten = (nodes: CollectionNode[], path: string[] = []): Flat[] => nodes.flatMap((n) => (n.kind === 'folder' ? flatten(n.items, [...path, n.name]) : [{ node: n, folder: path.join(' / ') }]));
  const findRequest = (c: Collection, ref: unknown): Flat => {
    const all = flatten(c.items);
    const r = String(ref ?? '').toLowerCase();
    const f = all.find((x) => x.node.id.toLowerCase() === r) ?? all.find((x) => x.node.name.toLowerCase() === r);
    if (!f) throw new ApsError('ConfigurationError', `No request "${String(ref)}" in "${c.name}"`);
    return f;
  };
  /**
   * A run recorded like the app's (runs/<id>/results.jsonl, summary.json, the history): the tests, run with the
   * engine, their results written as they finish; the first 200 come back summarized. run_tests and run_evaluation.
   */
  const recordedRun = async (environment: string | undefined, o: { name: string; tests: Parameters<typeof runTests>[0]['tests']; concurrency: number; retries?: number }) => {
    const ctx = createEngineContext({ store, secrets, settings, environment });
    const runId = shortId('run-');
    const outDir = store.runDir(runId);
    const results: TestResult[] = [];
    try {
      const summary = await runTests({
        name: o.name,
        runId,
        tests: o.tests,
        services: ctx.services,
        concurrency: o.concurrency,
        ...(o.retries !== undefined ? { retries: o.retries } : {}),
        resultsFile: join(outDir, 'results.jsonl'),
        traceMode: 'none',
        environment,
        onEvent: (e: RunEvent) => void (e.type === 'test-end' && results.push(e.result)),
      });
      await recordRun(store, summary, outDir);
      return { summary, runId, total: summary.total, passed: summary.passed, failed: summary.failed, errors: summary.errors, durationMs: summary.durationMs, results: results.slice(0, 200).map(summarizeResult) };
    } finally {
      await ctx.dispose();
    }
  };
  const checkEnvironment = (name: unknown): string | undefined => {
    if (name === undefined || name === null || name === '') return undefined;
    const env = store.getEnvironment(String(name));
    if (!env) throw new ApsError('ConfigurationError', `No environment "${String(name)}". Available: ${store.listEnvironments().map((e) => e.name).join(', ') || 'none'}`);
    if (env.isProduction && !opts.allowProduction) throw new ApsError('ConfigurationError', `"${env.name}" is a production environment; the MCP server does not send to production unless started with --allow-production`);
    return env.name;
  };
  const clip = (t: string) => (t.length > BODY_CHARS ? `${t.slice(0, BODY_CHARS)}… [${t.length - BODY_CHARS} more characters]` : t);
  const summarizeResult = (r: TestResult) => ({
    name: r.name,
    status: r.status,
    latencyMs: r.latencyMs,
    url: (r.metadata as { url?: string } | undefined)?.url,
    error: r.error?.message,
    failedChecks: r.checks.filter((c) => !c.passed).map((c) => `${c.name ?? c.type}: ${c.message ?? 'failed'}`),
    passedChecks: r.checks.filter((c) => c.passed).length,
    // console.log output of the scripts and the pm.visualizer rendering, when there is one
    scriptLogs: (r.metadata as { scriptLogs?: string[] } | undefined)?.scriptLogs?.map((l) => redactor.redactString(l)),
    visualization: (r.metadata as { visualizer?: { html?: string; error?: string } } | undefined)?.visualizer,
  });
  /** A request from `snippet` (cURL / fetch / PowerShell) or from method + url + headers + body. */
  const requestFrom = (a: Record<string, unknown>): { request: HttpRequestSpec; format?: string } => {
    if (typeof a.snippet === 'string' && a.snippet.trim()) {
      const format = detectRequestSnippet(a.snippet);
      if (!format) throw new ApsError('ValidationError', 'snippet is not a cURL, fetch or PowerShell (Invoke-WebRequest / Invoke-RestMethod) command');
      return { request: parseRequestSnippet(a.snippet), format };
    }
    if (!a.url) throw new ApsError('ValidationError', 'Give snippet, or url (+ method, headers, body)');
    const body = typeof a.body === 'string' && a.body ? { type: /^\s*[{[]/.test(a.body) ? ('json' as const) : ('text' as const), content: a.body } : undefined;
    return {
      request: {
        method: String(a.method ?? 'GET').toUpperCase(),
        url: String(a.url),
        headers: Object.entries((a.headers as Record<string, string>) ?? {}).map(([key, value]) => ({ key, value: String(value) })),
        body,
      },
    };
  };

  const all: Tool[] = [
    {
      name: 'list_collections',
      description: 'List the collections of the TestPion workspace with their request counts (HTTP/GraphQL requests, gRPC calls, WebSocket/MQTT connections).',
      inputSchema: { type: 'object', properties: {} },
      run: () =>
        collections().map((c) => {
          const saved = collectionSavedItems(store, c.id);
          return {
            id: c.id,
            name: c.name,
            description: c.description?.slice(0, 300),
            requests: flatten(c.items).length,
            grpcCalls: saved?.grpc?.length ?? 0,
            connections: saved?.websocket?.length ?? 0,
            examples: flatten(c.items).reduce((a, f) => a + (f.node.kind === 'http' ? f.node.examples?.length ?? 0 : 0), 0),
          };
        }),
    },
    {
      name: 'list_requests',
      description: 'List what a collection holds: its HTTP and GraphQL requests (id, name, method, URL with {{variables}}, folder), then its gRPC calls (kind grpc: target, method) and WebSocket / Socket.IO / MQTT connections (kind websocket: url, mode). run_collection runs all of them.',
      inputSchema: { type: 'object', properties: { collection: str('Collection name or id') }, required: ['collection'] },
      run: (a) => {
        const c = findCollection(a.collection);
        const saved = collectionSavedItems(store, c.id);
        return [
          ...flatten(c.items).map(({ node, folder }) => ({
            id: node.id,
            name: node.name,
            kind: node.kind,
            method: node.kind === 'http' ? node.request.method : 'POST',
            url: node.kind === 'http' ? redactor.redactString(node.request.url) : node.request.endpoint,
            folder: folder || undefined,
          })),
          ...(saved?.grpc ?? []).map((i) => {
            const d = i.data as { target?: string; method?: string };
            return { id: i.id, name: i.name, kind: 'grpc', target: d.target, method: d.method, folder: i.folder };
          }),
          ...(saved?.websocket ?? []).map((i) => {
            const d = i.data as { url?: string; mode?: string };
            return { id: i.id, name: i.name, kind: 'websocket', mode: d.mode ?? 'websocket', url: d.url ? redactor.redactString(d.url) : undefined, folder: i.folder };
          }),
        ];
      },
    },
    {
      name: 'collection_health',
      description:
        'How the HTTP and GraphQL requests of a collection are doing, from the responses sent in the TestPion app: per request its folder, method, whether it has checks (assertions or a test script), responses recorded, how many failed, the latest status and the median time of the latest 50. Failing requests first, then the slowest; never-sent ones last. Use it to find broken, slow or untested endpoints.',
      inputSchema: { type: 'object', properties: { collection: str('Collection name or id') }, required: ['collection'] },
      run: (a) => {
        const c = findCollection(a.collection);
        const stats = new Map(store.meta.requestStats(c.id).map((s) => [s.requestId, s]));
        const rows = flatten(c.items).map(({ node, folder }) => {
          const s = stats.get(node.id);
          return {
            id: node.id,
            name: node.name,
            folder: folder || undefined,
            method: node.kind === 'http' ? node.request.method : 'GRAPHQL',
            hasChecks: !!node.assertions?.length || !!node.testScript?.trim(),
            ...(s ? { responses: s.count, failed: s.failed, lastStatus: s.lastStatus, lastOk: s.lastOk, lastAt: s.lastAt, medianMs: s.medianMs } : { responses: 0 }),
          };
        });
        const rank = (r: (typeof rows)[number]) => (!r.responses ? 2 : 'lastOk' in r && !r.lastOk ? 0 : 1);
        return rows.sort((x, y) => rank(x) - rank(y) || ((y as { medianMs?: number }).medianMs ?? 0) - ((x as { medianMs?: number }).medianMs ?? 0));
      },
    },
    {
      name: 'collection_timing',
      description: "Where the time of a collection's HTTP requests went, over the responses sent in the TestPion app: totals of DNS lookup, TCP connect, TLS handshake (new connections only), waiting for the server (TTFB) and download, and how many requests opened a new connection or reused one. Use it to tell a slow server from slow connections.",
      inputSchema: { type: 'object', properties: { collection: str('Collection name or id') }, required: ['collection'] },
      run: (a) => collectionTiming(store, findCollection(a.collection).id) ?? { requests: 0, note: 'No responses with timing yet: send requests of this collection from the app.' },
    },
    {
      name: 'get_request',
      description: 'Show one saved request (headers, body, auth type, scripts, documentation and saved example names), or one of the collection’s gRPC calls (target, method, message, metadata) or connections (url, mode, message). Sensitive values are masked.',
      inputSchema: { type: 'object', properties: { collection: str('Collection name or id'), request: str('Request, gRPC call or connection: name or id') }, required: ['collection', 'request'] },
      run: (a) => {
        const col = findCollection(a.collection);
        // a gRPC call or connection of the collection (saved in the library, shown in the collection)
        const saved = collectionSavedItems(store, col.id);
        const ref = String(a.request);
        for (const kind of ['grpc', 'websocket'] as const) {
          const it = saved?.[kind]?.find((i) => i.id === ref) ?? saved?.[kind]?.find((i) => i.name.toLowerCase() === ref.toLowerCase());
          if (it) return { id: it.id, name: it.name, kind, folder: it.folder, ...(redactor.redact(it.data) as object) };
        }
        const { node, folder } = findRequest(col, a.request);
        const base = { id: node.id, name: node.name, folder: folder || undefined, request: redactor.redact(node.request) };
        return node.kind === 'http'
          ? { ...base, description: node.description, preRequestScript: node.preRequestScript, testScript: node.testScript, assertions: node.assertions, examples: node.examples?.map((e) => ({ name: e.name, status: e.status })) }
          : base;
      },
    },
    {
      name: 'list_environments',
      description: 'List environments and their variable names (values are not returned).',
      inputSchema: { type: 'object', properties: {} },
      run: () => store.listEnvironments().map((e) => ({ name: e.name, production: !!e.isProduction, variables: e.variables.filter((v) => v.enabled !== false).map((v) => (v.secret ? `${v.key} (secret)` : v.key)) })),
    },
    {
      name: 'collection_docs',
      description: 'Markdown documentation of a collection: description, every request with parameters, headers, body and saved examples.',
      inputSchema: { type: 'object', properties: { collection: str('Collection name or id') }, required: ['collection'] },
      run: (a) => collectionMarkdown(findCollection(a.collection), { redactor }),
    },
    {
      name: 'send_request',
      write: true,
      description:
        'Send an HTTP request and return status, headers, body and timing. Either name a saved request (collection + request: its scripts and assertions run too) or give method + url (+ headers, body) for an ad-hoc request. {{variables}} resolve from the environment. Server-Sent Events responses (text/event-stream) also return their parsed events.',
      inputSchema: {
        type: 'object',
        properties: {
          collection: str('Collection of a saved request (name or id)'),
          request: str('Saved request name or id'),
          method: str('HTTP method for an ad-hoc request (default GET)'),
          url: str('URL for an ad-hoc request; may use {{variables}}'),
          headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Headers for an ad-hoc request' },
          body: str('Raw body for an ad-hoc request (JSON is detected)'),
          snippet: str('Or: a cURL / fetch / PowerShell command to send as an ad-hoc request'),
          environment: str('Environment name'),
        },
      },
      run: async (a) => {
        const environment = checkEnvironment(a.environment);
        if (a.collection && a.request) {
          const c = findCollection(a.collection);
          const { node } = findRequest(c, a.request);
          const ctx = createEngineContext({ store, secrets, settings, environment, collectionId: c.id });
          let result: TestResult | undefined;
          try {
            await runCollection({ name: `mcp ${node.name}`, runId: shortId('mcp-'), collection: c, selection: [node.id], services: ctx.services, traceMode: 'none', onEvent: (e: RunEvent) => e.type === 'test-end' && (result = e.result) });
          } finally {
            await ctx.dispose();
          }
          if (!result) throw new ApsError('ProtocolError', 'The request did not run');
          return { ...summarizeResult(result), output: result.output && clip(result.output) };
        }
        if (!a.url && !a.snippet) throw new ApsError('ValidationError', 'Give collection + request for a saved request, or url (or snippet) for an ad-hoc one');
        const ctx = createEngineContext({ store, secrets, settings, environment });
        try {
          const spec: HttpRequestSpec = ctx.vars.resolveDeep(requestFrom(a).request);
          const { response, prepared } = await executeHttp({ ...spec, settings: { timeoutMs: settings.defaultTimeoutMs } }, { redactor: ctx.redactor, maxPreviewBytes: 1024 * 1024, cookieJar: ctx.services.cookieJar });
          recordCertificate(store, prepared.url, response.connection?.certificate);
          return {
            status: response.status,
            statusText: response.statusText,
            durationMs: response.durationMs,
            // DNS / TCP / TLS (on a new connection), time to first byte and download
            timing: timingSummary(response),
            // HTTPS: the server's certificate (subject, issuer, validity, days left)
            ...(response.connection?.certificate ? { certificate: { subject: response.connection.certificate.subject, issuer: response.connection.certificate.issuer, validTo: response.connection.certificate.validTo, daysLeft: response.connection.certificate.daysLeft } } : {}),
            size: response.size,
            url: response.url,
            headers: Object.fromEntries(ctx.redactor.redact(response.headers)),
            body: clip(ctx.redactor.redactString(response.bodyPreview)),
            // Server-Sent Events, parsed (an endless stream stops at the timeout and keeps what arrived)
            ...(response.events
              ? {
                  eventCount: response.events.length + (response.eventsDropped ?? 0),
                  events: response.events.slice(0, 100).map((e) => ({ event: e.event, ...(e.id !== undefined ? { id: e.id } : {}), data: clip(ctx.redactor.redactString(e.data)), atMs: e.atMs })),
                  ...(response.streamStopped ? { streamStopped: true } : {}),
                }
              : {}),
            unresolvedVariables: ctx.vars.unresolved.size ? [...ctx.vars.unresolved] : undefined,
          };
        } finally {
          await ctx.dispose();
        }
      },
    },
    {
      name: 'grpc_call',
      write: true,
      description:
        'Call a gRPC method described by .proto files in the workspace (or, without protos, by the server itself through server reflection), or list the methods (with example requests) when no method is given. Returns the gRPC status, the response message (or the streamed messages), metadata and trailers. {{variables}} resolve from the environment.',
      inputSchema: {
        type: 'object',
        properties: {
          target: str('Server address: host:port, or grpcs://host:port for TLS'),
          protos: { type: 'array', items: { type: 'string' }, description: '.proto files in the workspace (and the files they import), e.g. ["protos/vet/v1/pets.proto"]' },
          method: str('package.Service/Method; omit to list the methods'),
          message: { description: 'Request message as a JSON object (a list of messages for client-streaming methods)' },
          metadata: { type: 'object', additionalProperties: { type: 'string' }, description: 'Metadata (headers)' },
          environment: str('Environment name'),
        },
      },
      run: async (a) => {
        const protoFiles = ((a.protos as string[]) ?? []).map((name) => ({ name, text: readFileSync(store.safePath(String(name)), 'utf8') }));
        const environment = checkEnvironment(a.environment);
        const ctx = createEngineContext({ store, secrets, settings, environment });
        try {
          const r = ctx.vars.resolveDeep({ target: String(a.target ?? ''), message: a.message ?? {}, metadata: Object.entries((a.metadata as Record<string, string>) ?? {}).map(([key, value]) => ({ key, value })) });
          if (!protoFiles.length && !r.target) throw new ApsError('ValidationError', 'Give the server address (target), and protos unless the server offers reflection');
          // no proto files: the server describes itself (server reflection)
          const descriptorSet = protoFiles.length ? undefined : (await reflectServer(parseGrpcTarget(r.target), { metadata: r.metadata })).descriptorSet;
          if (!a.method) return describeRoot(grpcRoot({ protoFiles, descriptorSet })).map((m) => ({ method: m.name, clientStreaming: m.clientStreaming, serverStreaming: m.serverStreaming, example: m.example }));
          if (!r.target) throw new ApsError('ValidationError', 'Give the server address (target)');
          const out = await executeGrpc({ target: r.target, method: String(a.method), message: JSON.stringify(r.message), metadata: r.metadata, protoFiles, descriptorSet, timeoutMs: settings.defaultTimeoutMs }, { redactor: ctx.redactor });
          const body = (v: unknown) => clip(ctx.redactor.redactString(JSON.stringify(v)));
          return {
            code: out.code,
            status: out.codeName,
            details: out.details || undefined,
            durationMs: out.durationMs,
            ...(out.response !== undefined ? { response: body(out.response) } : {}),
            ...(out.messages ? { messageCount: out.messages.length, messages: out.messages.slice(0, 100).map((m) => body(m.data)) } : {}),
            metadata: Object.fromEntries(out.metadata),
            trailers: Object.fromEntries(out.trailers),
            unresolvedVariables: ctx.vars.unresolved.size ? [...ctx.vars.unresolved] : undefined,
          };
        } finally {
          await ctx.dispose();
        }
      },
    },
    {
      name: 'realtime_exchange',
      write: true,
      description:
        'Talk to a WebSocket, Socket.IO, MQTT or Kafka server: connect, send messages (WebSocket text frames), emit events (Socket.IO, optionally waiting for acknowledgements), subscribe and publish (MQTT), or read topics and produce messages (Kafka; reads use a consumer group of their own), in order, collect everything that arrives for waitMs, then close. Returns the messages with their direction, time, event name or topic (Kafka: key, partition, offset, headers). {{variables}} resolve from the environment (use one for a password).',
      inputSchema: {
        type: 'object',
        properties: {
          url: str('ws:// / wss:// for WebSocket; http(s)://host/namespace for Socket.IO; mqtt(s)://host:port for MQTT; kafka(s)://broker:9092 for Kafka (several brokers comma separated)'),
          mode: { type: 'string', enum: ['websocket', 'socketio', 'mqtt', 'kafka'], description: 'Default: kafka for kafka(s):// URLs, mqtt for mqtt(s):// URLs, socketio for http(s) URLs, websocket otherwise (give mqtt for a broker behind ws://)' },
          send: {
            type: 'array',
            description: 'WebSocket: strings (JSON as text). Socket.IO: { event, args?, ack? } objects. MQTT: { topic, payload?, qos?, retain? } messages to publish. Kafka: { topic, payload?, key?, headers?, partition? } messages to produce',
            items: {
              anyOf: [
                { type: 'string' },
                { type: 'object', properties: { event: { type: 'string' }, args: { type: 'array' }, ack: { type: 'boolean' } }, required: ['event'] },
                { type: 'object', properties: { topic: { type: 'string' }, payload: {}, qos: { type: 'number', enum: [0, 1, 2] }, retain: { type: 'boolean' }, key: { type: 'string' }, headers: { type: 'object', additionalProperties: { type: 'string' } }, partition: { type: 'number' } }, required: ['topic'] },
              ],
            },
          },
          subscribe: { type: 'array', items: { type: 'string' }, description: 'MQTT: topic filters to subscribe to before publishing (+ and # wildcards). Kafka: topics to read (new messages unless fromBeginning)' },
          fromBeginning: { type: 'boolean', description: 'Kafka: read the subscribed topics from the beginning (what they hold already, then new messages)' },
          groupId: str('Kafka consumer group (default: one of its own, so it never takes messages from a real consumer)'),
          mechanism: { type: 'string', enum: ['plain', 'scram-sha-256', 'scram-sha-512'], description: 'Kafka SASL mechanism for username / password' },
          clientId: str('MQTT or Kafka client ID'),
          username: str('MQTT or Kafka (SASL) username'),
          password: str('MQTT or Kafka password: give a {{variable}} holding it, not the value'),
          waitMs: { type: 'number', description: 'How long to listen after sending (default 1500, max 60000)' },
          headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Handshake headers' },
          auth: { type: 'object', description: 'Socket.IO handshake auth payload' },
          environment: str('Environment name'),
        },
        required: ['url'],
      },
      run: async (a) => {
        const environment = checkEnvironment(a.environment);
        const ctx = createEngineContext({ store, secrets, settings, environment });
        try {
          const r = ctx.vars.resolveDeep({
            url: String(a.url),
            send: a.send,
            headers: Object.entries((a.headers as Record<string, string>) ?? {}).map(([key, value]) => ({ key, value })),
            auth: a.auth,
            username: a.username as string | undefined,
            password: a.password as string | undefined,
            clientId: a.clientId as string | undefined,
          });
          return await runRealtimeExchange(
            {
              url: r.url,
              mode: a.mode as RealtimeExchange['mode'],
              send: r.send as RealtimeExchange['send'],
              subscribe: Array.isArray(a.subscribe) ? (a.subscribe as string[]).map((topic) => (a.fromBeginning ? { topic, fromBeginning: true } : topic)) : undefined,
              groupId: a.groupId ? String(a.groupId) : undefined,
              mechanism: a.mechanism as RealtimeExchange['mechanism'],
              waitMs: Number(a.waitMs) || undefined,
              headers: r.headers,
              auth: r.auth as Record<string, unknown> | undefined,
              username: r.username,
              password: r.password,
              clientId: r.clientId,
            },
            { redactor: ctx.redactor, cookieJar: ctx.services.cookieJar },
          );
        } finally {
          await ctx.dispose();
        }
      },
    },
    {
      name: 'decode_jwt',
      description: 'Decode a JSON Web Token (a "Bearer " prefix is fine): header, claims, issued at, expires at and seconds left. The signature is NOT verified (no keys). Use it to see what an access or id token says, e.g. its scopes, audience or expiry.',
      inputSchema: { type: 'object', properties: { token: str('The JWT') }, required: ['token'] },
      run: (a) => decodeJwt(String(a.token)),
    },
    {
      name: 'export_traces',
      write: true,
      description:
        'Send the workspace’s most recent traces (requests, test runs, MCP and LLM calls) to an OpenTelemetry collector as OTLP/HTTP JSON, redacted. Header values may be {{variables}} (e.g. a secret API key). Returns how many spans were sent.',
      inputSchema: {
        type: 'object',
        properties: {
          endpoint: str('Collector URL, e.g. http://localhost:4318 (…/v1/traces is added)'),
          headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Headers, e.g. { "x-honeycomb-team": "{{honeycombKey}}" }' },
          limit: { type: 'number', description: 'How many of the newest traces (default 50, max 1000)' },
          kind: str('Only traces of this kind: http, graphql, mcp, llm or test'),
          environment: str('Environment whose variables resolve the headers'),
        },
        required: ['endpoint'],
      },
      run: async (a) => {
        const ctx = createEngineContext({ store, secrets, settings, environment: checkEnvironment(a.environment) });
        try {
          const limit = Math.min(Math.max(Number(a.limit) || 50, 1), 1000);
          const ids = store.meta.listTraces({ kind: a.kind ? String(a.kind) : undefined, limit }).items.map((t) => t.id);
          const traces = ids.map((id) => store.loadTrace(id)).filter((t): t is NonNullable<typeof t> => !!t);
          if (!traces.length) return { spans: 0, traces: 0, message: 'No traces yet' };
          const headers = Object.fromEntries(Object.entries((a.headers as Record<string, string>) ?? {}).map(([k, v]) => [k, ctx.vars.resolve(String(v))]));
          const r = await exportOtlp(traces, { endpoint: ctx.vars.resolve(String(a.endpoint)), headers }, { redactor: ctx.redactor, resource: { 'testpion.workspace': store.workspace.name } });
          return { ...r, traces: traces.length };
        } finally {
          await ctx.dispose();
        }
      },
    },
    {
      name: 'compare_responses',
      description:
        'Compare two responses from the history (ids from request_history): status, timing, header changes (volatile ones like date are flagged) and a field-by-field JSON body diff ($.path added / removed / changed), or a line diff for text. Sensitive values are masked.',
      inputSchema: { type: 'object', properties: { before: str('History id of the older response'), after: str('History id of the newer response') }, required: ['before', 'after'] },
      run: (a) => redactDiff(redactor.redact(compareHistory(store, String(a.before), String(a.after))), redactor),
    },
    {
      name: 'parse_request_snippet',
      description:
        'Turn a request copied from browser devtools or docs (cURL for bash or cmd, fetch, fetch (Node.js), or PowerShell Invoke-WebRequest / Invoke-RestMethod) into a structured TestPion request: method, URL, params, headers, cookies, body and auth. Nothing is sent or saved. Secret values (tokens, keys, cookies, passwords) are replaced by {{variables}} listed in `placeholders`.',
      inputSchema: { type: 'object', properties: { snippet: str('The copied command or code') }, required: ['snippet'] },
      run: (a) => {
        const { request, format } = requestFrom({ snippet: a.snippet });
        // same rewrite as save_request: cookies, tokens and keys become {{variables}}, never values
        const { request: safe, placeholders } = externalizeSecrets(request, redactor);
        return { format, request: redactor.redact(safe), placeholders };
      },
    },
    {
      name: 'save_test',
      write: true,
      description:
        'Save a saved request (REST or GraphQL) of a collection as a YAML test file under tests/ (tests/rest or tests/graphql), with its checks or a first status / no-errors check, for `testpion test` and CI. {{variables}} are kept. Returns the file path.',
      inputSchema: { type: 'object', properties: { collection: str('Collection name or id'), request: str('Request name or id'), name: str('Test name (default: the request name)') }, required: ['collection', 'request'] },
      run: (a) => {
        const { node } = findRequest(findCollection(a.collection), a.request);
        const name = String(a.name ?? node.name);
        const t =
          node.kind === 'graphql'
            ? testFromRequest(name, { kind: 'graphql', endpoint: node.request.endpoint, query: node.request.query, variables: node.request.variables as Record<string, unknown> | undefined, operationName: node.request.operationName, headers: node.request.headers, auth: node.request.auth }, node.assertions)
            : testFromRequest(name, { kind: 'http', request: node.request, preRequestScript: node.preRequestScript, testScript: node.testScript }, node.assertions);
        let path = t.path;
        for (let i = 2; existsSync(store.safePath(path, store.path('tests'))); i++) path = t.path.replace(/\.yaml$/, `-${i}.yaml`);
        store.writeTestFile(path, t.yaml);
        return { path: `tests/${path}` };
      },
    },
    {
      name: 'save_request',
      write: true,
      description:
        'Save a request into a collection (and folder path such as "Auth / Tokens"). Give a snippet (cURL / fetch / PowerShell) or method + url (+ headers, body). Secret values (Authorization and other sensitive headers, auth credentials, cookies, sensitive query or body fields) are NOT written to the workspace: they are replaced by {{variables}}, listed in `placeholders`, and should be set as secret environment variables by the user.',
      inputSchema: {
        type: 'object',
        properties: {
          collection: str('Collection name or id'),
          create: { type: 'boolean', description: 'Create the collection when it does not exist (default false)' },
          folder: str('Folder path inside the collection, e.g. "Auth / Tokens" (created as needed)'),
          name: str('Request name (default: method and URL)'),
          description: str('Markdown documentation for the request'),
          snippet: str('cURL / fetch / PowerShell command to import'),
          method: str('HTTP method (when no snippet)'),
          url: str('URL, may use {{variables}} (when no snippet)'),
          headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Headers (when no snippet)' },
          body: str('Raw body (when no snippet; JSON is detected)'),
        },
        required: ['collection'],
      },
      run: (a) => {
        const { request, format } = requestFrom(a);
        const { request: safe, placeholders } = externalizeSecrets(request, redactor);
        const { collection, node, created } = addRequestToCollection(collections(), {
          collection: String(a.collection),
          create: a.create === true,
          folder: typeof a.folder === 'string' ? a.folder : undefined,
          name: typeof a.name === 'string' ? a.name : '',
          description: typeof a.description === 'string' ? a.description : undefined,
          request: safe,
        });
        const saved = store.saveCollection(collection);
        return {
          saved: { collection: saved.name, collectionId: saved.id, createdCollection: created, request: node.name, requestId: node.id, method: safe.method, url: safe.url },
          format,
          placeholders,
          next: placeholders.length
            ? `Ask the user to add ${placeholders.map((p) => p.variable).join(', ')} as secret variables of an environment (Environments view, or they stay unresolved).`
            : undefined,
        };
      },
    },
    {
      name: 'graphql_operation',
      // it sends an introspection request to the endpoint
      write: true,
      description:
        'Build a valid, ready-to-run GraphQL operation for one root field by introspecting the endpoint: a variable for each argument (with a placeholder value of the right type) and a selection of the scalar fields down to `depth` levels. Use it instead of guessing field names; then send it with send_request or save it. {{variables}} of the environment are resolved in the endpoint and headers.',
      inputSchema: {
        type: 'object',
        properties: {
          endpoint: str('GraphQL endpoint (http or https)'),
          field: str('Root field: "Query.patient", "Mutation.addPet" or just "patient"'),
          depth: { type: 'number', description: 'Levels of nested objects to select (default 2, max 6)' },
          requiredArgsOnly: { type: 'boolean', description: 'Only the required arguments (default: all)' },
          headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Headers for introspection, e.g. Authorization: Bearer {{token}}' },
          environment: str('Environment name'),
        },
        required: ['endpoint', 'field'],
      },
      run: async (a) => {
        const ctx = createEngineContext({ store, secrets, settings, environment: checkEnvironment(a.environment) });
        try {
          const headers = ctx.vars.resolveDeep(Object.entries((a.headers as Record<string, string>) ?? {}).map(([key, value]) => ({ key, value })));
          const { schema } = await introspect({ endpoint: ctx.vars.resolve(String(a.endpoint)), headers }, { cookieJar: ctx.services.cookieJar });
          return buildGraphQLOperation(schema, String(a.field), { depth: a.depth === undefined ? undefined : Number(a.depth), includeOptionalArgs: a.requiredArgsOnly !== true });
        } finally {
          await ctx.dispose();
        }
      },
    },
    {
      name: 'graphql_subscribe',
      write: true,
      description: 'Run a GraphQL subscription over WebSocket (graphql-transport-ws or graphql-ws) and return the events received: up to maxEvents (default 10) or durationSec (default 15, at most 60), whichever comes first. {{variables}} of the environment are resolved.',
      inputSchema: {
        type: 'object',
        properties: {
          endpoint: str('GraphQL endpoint (http(s) or ws(s))'),
          query: str('The subscription document'),
          variables: { type: 'object', description: 'Variables' },
          environment: str('Environment name'),
          maxEvents: { type: 'number' },
          durationSec: { type: 'number' },
        },
        required: ['endpoint', 'query'],
      },
      run: async (a) => {
        const ctx = createEngineContext({ store, secrets, settings, environment: checkEnvironment(a.environment) });
        try {
          const r = await collectSubscriptionEvents({
            url: ctx.vars.resolve(String(a.endpoint)),
            query: String(a.query),
            variables: a.variables && typeof a.variables === 'object' ? ctx.vars.resolveDeep(a.variables as Record<string, unknown>) : undefined,
            maxEvents: Math.min(100, Number(a.maxEvents) || 10),
            durationMs: Math.min(60, Number(a.durationSec) || 15) * 1000,
            cookieJar: ctx.services.cookieJar,
          });
          return ctx.redactor.redact(r);
        } finally {
          await ctx.dispose();
        }
      },
    },
    {
      name: 'security_review',
      description: "Security review of a collection's request definitions: secrets typed in instead of kept in secret variables, secrets in query strings, plain http to non-local hosts, credentials over http, turned-off TLS verification. Returns findings (high / medium / low) with where they are. Values are never returned.",
      inputSchema: { type: 'object', properties: { collection: str('Collection name or id'), environment: str('Environment whose variables count as defined') }, required: ['collection'] },
      run: async (a) => {
        const c = findCollection(a.collection);
        const ctx = createEngineContext({ store, secrets, settings, environment: checkEnvironment(a.environment), collectionId: c.id });
        try {
          return collectionSecurityFindings(store, c, ctx, settings.redactFields);
        } finally {
          await ctx.dispose();
        }
      },
    },
    {
      name: 'collection_openapi',
      description: 'An OpenAPI 3.1 document (YAML) describing a collection\'s HTTP requests: paths, parameters, request bodies with inferred schemas, saved examples as responses, folders as tags, auth as security schemes. Useful to document an API that only exists as a collection, or to compare it with a spec (openapi_diff).',
      inputSchema: { type: 'object', properties: { collection: str('Collection name or id') }, required: ['collection'] },
      run: (a) => collectionToOpenApiText(findCollection(a.collection)),
    },
    {
      name: 'variable_usages',
      description: 'Where a variable is used or defined in the workspace: {{name}} in requests (URL, headers, bodies, auth …), pm.environment.get("name") & co. in scripts, environments, collection / folder / workspace variables and test files.',
      inputSchema: { type: 'object', properties: { name: str('Variable name, without {{ }}') }, required: ['name'] },
      run: (a) => variableUsages(store, String(a.name ?? '')),
    },
    {
      name: 'rename_variable',
      write: true,
      description: 'Rename a variable everywhere in the workspace (requests, scripts, environments, collection / folder / workspace variables, test files); refuses when the new name is already defined. Secret values move with it.',
      inputSchema: { type: 'object', properties: { from: str('Current name'), to: str('New name') }, required: ['from', 'to'] },
      run: async (a) => {
        const r = await renameVariable(store, String(a.from ?? ''), String(a.to ?? ''), { secrets });
        return { files: r.files, places: r.changed.length, changed: r.changed };
      },
    },
    {
      name: 'openapi_diff',
      description:
        'Compare two versions of an OpenAPI / Swagger document and list breaking changes (removed operations or success responses, new required parameters or body fields, type changes, removed or now-optional response fields, narrowed enums) and non-breaking ones. `old` and `new` are each an http(s) link, a path inside the workspace (e.g. specs/pets.openapi.json) or the document text.',
      inputSchema: { type: 'object', properties: { old: str('Previous version: link, workspace path or text'), new: str('New version: link, workspace path or text') }, required: ['old', 'new'] },
      run: async (a) => diffOpenApi(await readSpec(String(a.old ?? '')), await readSpec(String(a.new ?? ''))),
    },
    {
      name: 'api_coverage',
      description:
        "API coverage of an OpenAPI / Swagger document: which operations and documented response codes the workspace's test runs (default: the latest run) and optionally its request history exercised, which were never called, observed codes the document doesn't describe, and requests to paths it doesn't have. Use it to find untested endpoints and error cases, then write tests for them (save_test / save_request). `spec` is an http(s) link, a path inside the workspace (e.g. specs/pets.yaml) or the document text.",
      inputSchema: {
        type: 'object',
        properties: {
          spec: str('OpenAPI document: link, workspace path or text'),
          runs: { type: 'array', items: { type: 'string' }, description: 'Run ids to use (default: the latest run)' },
          history: { type: 'number', description: 'Also use the last n request history entries' },
          baseUrl: str('Only count requests under this URL'),
          excludeDeprecated: { type: 'boolean', description: 'Leave deprecated operations out of the totals' },
        },
        required: ['spec'],
      },
      run: async (a) => {
        const { report, sources } = await workspaceApiCoverage(store, await readSpec(String(a.spec ?? '')), {
          runs: Array.isArray(a.runs) && a.runs.length ? a.runs.map(String) : undefined,
          history: typeof a.history === 'number' && a.history > 0 ? Math.min(a.history, 10_000) : undefined,
          baseUrl: a.baseUrl ? String(a.baseUrl) : undefined,
          excludeDeprecated: a.excludeDeprecated === true,
        });
        return { ...report, sources };
      },
    },
    {
      name: 'import_definition',
      write: true,
      description:
        'Import an API definition or collection into the workspace from a public http(s) link (`url`: OpenAPI/Swagger URL, a GitHub/GitLab/Bitbucket file page, a Postman collection API link) or from `text` (OpenAPI, AsyncAPI, Postman collection or environment, Insomnia, Bruno, Hoppscotch, WSDL, HAR, .env). OpenAPI imports keep the document in specs/ and add contract checks to each request. Returns what was created; secret values from a .env are never written to files (listed in `secretsToSet`).',
      inputSchema: {
        type: 'object',
        properties: {
          url: str('http(s) link to download and import'),
          text: str('Document text to import (when no url)'),
          name: str('Name for an imported .env environment'),
          contractChecks: { type: 'boolean', description: 'For OpenAPI: add a contract check to each request (default true)' },
        },
      },
      run: async (a) => {
        const f = typeof a.url === 'string' && a.url ? await fetchImportText(a.url) : undefined;
        const text = f?.text ?? (typeof a.text === 'string' ? a.text : '');
        if (!text.trim()) throw new ApsError('ValidationError', 'Give a url or text to import');
        const r = importIntoWorkspace(store, text, { contractChecks: a.contractChecks !== false, name: typeof a.name === 'string' ? a.name : undefined });
        return {
          format: r.format,
          source: f?.url,
          collection: r.collection ? { name: r.collection.name, id: r.collection.id } : undefined,
          environments: r.environments?.map((e) => e.name),
          specPath: r.specPath,
          contractChecks: r.contractChecks,
          secretsToSet: r.secretsToSet?.length ? r.secretsToSet : undefined,
          scriptWarnings: r.scriptWarnings,
        };
      },
    },
    {
      name: 'set_environment_variable',
      write: true,
      description: 'Set plain (non-secret) variables of an environment, e.g. { "baseUrl": "https://staging.example.com" }; `create` makes the environment if needed. Secret variables are refused: the user sets those in the app.',
      inputSchema: { type: 'object', properties: { environment: str('Environment name or id'), values: { type: 'object', additionalProperties: { type: 'string' }, description: 'key → value' }, create: { type: 'boolean' } }, required: ['environment', 'values'] },
      run: (a) => {
        const values = Object.fromEntries(Object.entries((a.values ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
        const env = setEnvironmentVariables(store, String(a.environment), values, { create: a.create === true });
        return { environment: env.name, set: Object.keys(values) };
      },
    },
    {
      name: 'reorder_environments',
      write: true,
      description: 'Set the display order of environments (the order of the environment picker). Environments not listed keep their order after the listed ones.',
      inputSchema: { type: 'object', properties: { order: { type: 'array', items: { type: 'string' }, description: 'Environment names or ids, first to last' } }, required: ['order'] },
      run: (a) => {
        const refs = Array.isArray(a.order) ? a.order.map((x) => String(x)) : [];
        return store.reorderEnvironments(refs.map((r) => requireEnvironment(store, r).id)).map((e) => e.name);
      },
    },
    {
      name: 'compare_environments',
      description:
        'Compare two environments variable by variable: keys only in one of them, keys whose values differ, disabled variables, and secrets that are set on one side only. Returns statuses, never values. Use it when a request works in one environment and fails in another.',
      inputSchema: { type: 'object', properties: { left: str('Environment name or id'), right: str('Environment name or id'), includeSame: { type: 'boolean', description: 'Also list variables that are the same' } }, required: ['left', 'right'] },
      run: (a) => {
        const get = (ref: unknown) => {
          const e = store.getEnvironment(String(ref));
          if (!e) throw new ApsError('ConfigurationError', `No environment "${String(ref)}". Available: ${store.listEnvironments().map((x) => x.name).join(', ') || 'none'}`);
          return e;
        };
        const d = compareEnvironments(get(a.left), get(a.right), { secrets, redactor });
        return a.includeSame ? d : { ...d, rows: d.rows.filter((r) => r.status !== 'same') };
      },
    },
    {
      name: 'environment_matrix',
      description: 'Every variable across every environment of the workspace: for each, whether it is set, empty, missing or disabled in each environment (and whether it is a secret), incomplete variables first. Never returns values. Use it to find a variable that one environment lacks.',
      inputSchema: { type: 'object', properties: { onlyIncomplete: { type: 'boolean', description: 'Only variables that are missing, empty or disabled somewhere' } } },
      run: (a) => {
        const m = environmentMatrix(store, { secrets });
        return a.onlyIncomplete ? { ...m, rows: m.rows.filter((r) => r.incompleteIn.length) } : m;
      },
    },
    {
      name: 'compare_request_across_environments',
      write: true,
      description:
        'Send one saved request with two environments (its scripts, auth and checks run as usual) and compare the responses: status, time, headers and a field-by-field JSON body diff. Sensitive values are masked. Production environments are refused unless the server allows them.',
      inputSchema: { type: 'object', properties: { collection: str('Collection name or id'), request: str('Request name or id'), left: str('First environment'), right: str('Second environment') }, required: ['collection', 'request', 'left', 'right'] },
      run: async (a) => {
        const left = checkEnvironment(a.left);
        const right = checkEnvironment(a.right);
        if (!left || !right) throw new ApsError('ConfigurationError', 'Give two environments (left and right)');
        const c = findCollection(a.collection);
        return compareRequestAcrossEnvironments({ collection: c, request: String(a.request), left, right, context: (environment) => createEngineContext({ store, secrets, settings, environment, collectionId: c.id }) });
      },
    },
    {
      name: 'ci_config',
      description:
        "A CI pipeline file that runs this workspace's tests on every push: GitHub Actions, GitLab CI, Azure Pipelines or Jenkins. Give one of suite, collection (+ folders) or tests; for integration tests, `start` (the command that starts the system under test) and `waitFor` (its health URL). Returns { path, content, secrets, command }: write content to path in the repository and create the listed CI secrets (values are never included).",
      inputSchema: {
        type: 'object',
        properties: {
          provider: { type: 'string', enum: ['github', 'gitlab', 'azure', 'jenkins'] },
          suite: str('Suite name (tests/<name>.suite.yaml)'),
          collection: str('Collection name or id'),
          folders: { type: 'array', items: { type: 'string' }, description: 'With collection: folder or request names' },
          tests: { type: 'array', items: { type: 'string' }, description: 'Test files or folders under tests/' },
          environment: str('Environment name'),
          workspaceDir: str('The workspace folder relative to the repository root (default ".")'),
          openapi: str('OpenAPI document in the repository (e.g. openapi.yaml): pull requests fail on breaking changes against the target branch'),
          start: str('Integration tests: a command that starts the system under test in the background first (e.g. "npm start", "docker compose up -d")'),
          waitFor: str('With start: a URL polled until it answers before the tests run (the health check)'),
          waitSeconds: { type: 'number', description: 'How long to wait for it (default 90)' },
        },
        required: ['provider'],
      },
      run: (a) => ciConfig(store, a as unknown as CiConfigOptions),
    },
    {
      name: 'list_certificates',
      description: 'TLS certificates of the HTTPS hosts this workspace has called (from the app, test runs, monitors and agents), soonest to expire first: host, subject, issuer, valid until, days left and when last seen. Use it to find certificates that expire soon.',
      inputSchema: { type: 'object', properties: { withinDays: { type: 'number', description: 'Only those that expire within this many days' } } },
      run: (a) => listCertificates(store).filter((c) => a.withinDays === undefined || (c.daysLeft !== undefined && c.daysLeft <= Number(a.withinDays))),
    },
    {
      name: 'llm_usage',
      description: 'What the prompts run in the TestPion AI Lab used, per provider and model, most tokens first: prompts run, input and output tokens, estimated cost (from the price table), median time and time to first token, last used.',
      inputSchema: { type: 'object', properties: {} },
      run: () => llmUsage(store),
    },
    {
      name: 'mcp_tool_usage',
      description: "How the tools of the workspace's MCP servers have been called from the TestPion app, most called first: server, tool, calls, failed (isError or no result), median and p95 time, last used. Use it to see which tools are used, slow or failing.",
      inputSchema: { type: 'object', properties: { server: str('Only this MCP server (name or id)') } },
      run: (a) => {
        const all = mcpToolUsage(store);
        if (!a.server) return all;
        const q = String(a.server).toLowerCase();
        return all.filter((u) => u.serverId === a.server || u.server.toLowerCase() === q);
      },
    },
    {
      name: 'check_certificate',
      description: "Connect to a host (host, host:port or https URL) and read its TLS certificate now: subject, issuer, valid until, days left, whether this machine trusts it (and why not), TLS protocol. The result is also recorded for list_certificates.",
      inputSchema: { type: 'object', properties: { target: str('host, host:port or https URL') }, required: ['target'] },
      run: async (a) => {
        const c = await checkCertificate(String(a.target));
        recordCertificate(store, `https://${c.host}:${c.port}/`, c);
        return c;
      },
    },
    {
      name: 'list_monitors',
      description: 'Monitors of the workspace (collections that run on a schedule): collection, folders, environment, schedule, enabled, last result (passed / failed / error with counts) and next run.',
      inputSchema: { type: 'object', properties: {} },
      run: () => listMonitors(store).map((m) => monitorStatus(store, m)),
    },
    {
      name: 'monitor_results',
      description: "A monitor's recent results, newest first: status, passed / failed / errors, duration, median response time, what started it and the run id. Use it to see when a check started failing.",
      inputSchema: { type: 'object', properties: { monitor: str('Monitor name or id'), limit: { type: 'number', description: 'How many (default 20, max 200)' } }, required: ['monitor'] },
      run: (a) => monitorResults(store, findMonitor(store, String(a.monitor)).id, Math.min(Math.max(Number(a.limit) || 20, 1), 200)),
    },
    {
      name: 'monitor_requests',
      description: "Each request of a monitor over its latest runs, slowest first: runs, failures, median and p95 time and the latest failure. Use it to find which request makes a monitor slow or fail.",
      inputSchema: { type: 'object', properties: { monitor: str('Monitor name or id'), runs: { type: 'number', description: 'How many of the latest runs (default 20, max 200)' } }, required: ['monitor'] },
      run: (a) => monitorRequestStats(store, findMonitor(store, String(a.monitor)).id, { runs: Number(a.runs) || 20 }),
    },
    {
      name: 'monitor_uptime',
      description: "A monitor's uptime per day over the last N days (oldest first): runs, passed, uptime percent and the slowest p95 response time of each day. Days without runs have runs: 0. Use it for an SLA view or to find when an API became unreliable.",
      inputSchema: { type: 'object', properties: { monitor: str('Monitor name or id'), days: { type: 'number', description: 'How many days (default 30, max 366)' } }, required: ['monitor'] },
      run: (a) => {
        const days = monitorDaily(store, findMonitor(store, String(a.monitor)).id, Number(a.days) || 30);
        const runs = days.reduce((n, d) => n + d.runs, 0);
        const passed = days.reduce((n, d) => n + d.passed, 0);
        return { uptime: runs ? Math.round((passed / runs) * 1000) / 10 : undefined, runs, passed, days };
      },
    },
    {
      name: 'run_monitor',
      write: true,
      description: 'Run a monitor now (outside its schedule) and record the result like a scheduled run. Returns the result with per-request details of failures.',
      inputSchema: { type: 'object', properties: { monitor: str('Monitor name or id') }, required: ['monitor'] },
      run: async (a) => {
        const m = findMonitor(store, String(a.monitor));
        checkEnvironment(m.environment);
        const failures: TestResult[] = [];
        const r = await executeMonitor({
          store,
          monitor: m,
          trigger: 'manual',
          context: (o) => createEngineContext({ store, secrets, settings, environment: o.environment, collectionId: o.collectionId }),
          onEvent: (e: RunEvent) => e.type === 'test-end' && e.result.status !== 'passed' && e.result.status !== 'skipped' && failures.push(e.result),
        });
        return { ...r, name: m.name, failures: failures.slice(0, 50).map(summarizeResult) };
      },
    },
    {
      name: 'run_collection',
      write: true,
      description:
        'Run a collection (or one folder) like the Collection Runner: requests in order with their scripts and assertions. Returns totals and per-request results. With `data` (a CSV / JSON / JSONL file or a SQLite database inside the workspace, plus `query` for SQLite) each row is one iteration ({{column}} in requests, pm.iterationData in scripts).',
      inputSchema: {
        type: 'object',
        properties: {
          collection: str('Collection name or id'),
          folder: str('Only run this folder or request (name or id)'),
          environment: str('Environment name'),
          data: str('Data file inside the workspace (relative path): .csv, .json, .jsonl, or a SQLite .db / .sqlite with `query`'),
          query: str('For a SQLite data file: one read-only SELECT whose rows are the iterations'),
          iterations: { type: 'number', description: 'How many iterations (default: one per data row, or 1)' },
        },
        required: ['collection'],
      },
      run: async (a) => {
        const environment = checkEnvironment(a.environment);
        const c = findCollection(a.collection);
        let selection: string[] | undefined;
        if (a.folder) {
          const r = String(a.folder).toLowerCase();
          const all: CollectionNode[] = [];
          const walk = (nodes: CollectionNode[]) => nodes.forEach((n) => (all.push(n), n.kind === 'folder' && walk(n.items)));
          walk(c.items);
          const n = all.find((x) => x.id.toLowerCase() === r) ?? all.find((x) => x.name.toLowerCase() === r);
          if (!n) throw new ApsError('ConfigurationError', `No folder or request "${String(a.folder)}" in "${c.name}"`);
          selection = [n.id];
        }
        // data files are read only from inside the workspace
        let data: DatasetRecord[] | undefined;
        if (a.data) {
          const database = !!dbKindOf(String(a.data)) || /^env:\w+$/.test(String(a.data));
          const file = database ? String(a.data) : store.safePath(String(a.data));
          if (!database && !existsSync(file)) throw new ApsError('ConfigurationError', `No data file ${String(a.data)} in the workspace`);
          data = [];
          for await (const r of readDataset({ path: file, query: a.query ? String(a.query) : undefined, limit: 10_000 })) data.push(r);
        }
        const iterations = a.iterations === undefined ? undefined : Math.min(Math.max(1, Math.floor(Number(a.iterations)) || 1), 1000);
        const ctx = createEngineContext({ store, secrets, settings, environment, collectionId: c.id });
        const results: TestResult[] = [];
        try {
          const summary = await runCollection({ name: c.name, runId: shortId('mcp-'), collection: c, selection, data, iterations, realtime: collectionRealtimeTests(store, c, selection), services: ctx.services, traceMode: 'none', environment, onEvent: (e: RunEvent) => e.type === 'test-end' && results.push(e.result) });
          return { total: summary.total, passed: summary.passed, failed: summary.failed, errors: summary.errors, skipped: summary.skipped, durationMs: summary.durationMs, results: results.slice(0, 200).map(summarizeResult) };
        } finally {
          await ctx.dispose();
        }
      },
    },
    {
      name: 'lint_tests',
      description:
        'Check test files for mistakes before running them: unknown test or check types, keys the runner does not read (typos, with the likely key), dependsOn ids nobody defines, methods that are not HTTP methods, tests the loader refuses. Each problem has a severity, a message and a line. Give `paths` (files or folders under tests/) or `content` (the text of one file) to check.',
      inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, description: 'Test files or folders under tests/ (default: all)' }, content: str('The text of one test file to check instead of files') } },
      run: (a) => {
        if (typeof a.content === 'string') return { problems: lintTestFile(a.content) };
        const tests = store.path('tests');
        const files: string[] = [];
        const walk = (p: string) => {
          const abs = store.safePath(p, tests);
          if (!existsSync(abs)) throw new ApsError('ValidationError', `No such test file or folder: ${p}`);
          if (statSync(abs).isDirectory()) for (const e of readdirSync(abs).sort()) walk(join(p, e));
          else if (/\.(ya?ml|json)$/.test(abs)) files.push(abs);
        };
        for (const p of ((a.paths as string[] | undefined) ?? ['.']).map(String)) walk(p);
        const out = files.map((f) => ({ file: relative(tests, f).split(sep).join('/'), problems: lintTestFile(readFileSync(f, 'utf8'), { file: f, suite: isSuiteFile(f) }) })).filter((x) => x.problems.length);
        return { files: files.length, problems: out.reduce((n, x) => n + x.problems.length, 0), results: out };
      },
    },
    {
      name: 'list_tests',
      description: 'The test files under tests/ (YAML / JSON) with the tests in each: id, name, type and tags. Run them with run_tests.',
      inputSchema: { type: 'object', properties: { path: str('Only this file or folder inside tests/') } },
      run: async (a) => {
        const out: Array<{ file: string; tests: Array<{ id?: string; name: string; type: string; tags?: string[] }> }> = [];
        const base = store.path('tests');
        for await (const t of streamTests([a.path ? String(a.path) : '.'], base)) {
          const file = relative(base, t.file ?? '').replace(/\\/g, '/');
          let f = out.find((x) => x.file === file);
          if (!f) out.push((f = { file, tests: [] }));
          if (f.tests.length < 200) f.tests.push({ id: t.id, name: t.name, type: t.type, ...(t.tags?.length ? { tags: t.tags } : {}) });
          if (out.length > 300) break;
        }
        return out;
      },
    },
    {
      name: 'run_tests',
      write: true,
      description:
        'Run test files under tests/ (all, or given files / folders), filtered by name (grep) or tags, like `testpion test`. `rerunFailed: true` runs only the tests that failed in the last run (or give a run id). Returns totals and per-test results with failed checks; the run is recorded in the workspace history.',
      inputSchema: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' }, description: 'Files or folders inside tests/ (default: all)' },
          grep: str('Only tests whose name or id matches this regular expression'),
          tags: { type: 'array', items: { type: 'string' }, description: 'Only tests with one of these tags' },
          environment: str('Environment name'),
          rerunFailed: { anyOf: [{ type: 'boolean' }, { type: 'string' }], description: 'true: the failed tests of the last run; or a run id' },
        },
      },
      run: async (a) => {
        const environment = checkEnvironment(a.environment);
        const rerun = a.rerunFailed ? store.failedTestIds(typeof a.rerunFailed === 'string' ? a.rerunFailed : 'last') : undefined;
        if (rerun && !rerun.ids.length) return { total: 0, message: `Nothing failed in ${rerun.runId}` };
        const paths = Array.isArray(a.paths) && a.paths.length ? (a.paths as unknown[]).map(String) : ['.'];
        const { summary, ...run } = await recordedRun(environment, {
          name: rerun ? `Failed tests of ${rerun.runId}` : paths.join(', '),
          tests: streamTests(paths, store.path('tests'), { grep: a.grep ? String(a.grep) : undefined, tags: Array.isArray(a.tags) ? (a.tags as unknown[]).map(String) : undefined, ...(rerun ? { ids: rerun.ids } : {}) }),
          concurrency: 4,
        });
        return { ...run, skipped: summary.skipped };
      },
    },
    {
      name: 'list_evaluations',
      description: 'Evaluations saved in the app (Evaluations ▸ Save): a dataset × prompt × model × evaluators. Returns id, name, folder, model, number of cases and evaluator types. Run one with run_evaluation.',
      inputSchema: { type: 'object', properties: {} },
      run: () => listSavedEvaluations(store),
    },
    {
      name: 'run_evaluation',
      write: true,
      description:
        'Run a saved evaluation by name or id, like `testpion eval run`: every dataset record through the model, scored by its evaluators (AI-judge scores are labelled as such). Returns totals, mean scores and per-case results with failed checks; the run is recorded in the workspace history. `limit` runs only the first n records (at most 500 here).',
      inputSchema: { type: 'object', properties: { name: str('Saved evaluation name or id'), environment: str('Environment name'), limit: { type: 'number', description: 'Only the first n dataset records' } }, required: ['name'] },
      run: async (a) => {
        const environment = checkEnvironment(a.environment);
        const saved = findSavedEvaluation(store, String(a.name ?? ''));
        const limit = Math.min(500, typeof a.limit === 'number' && a.limit > 0 ? a.limit : (saved.limit ?? 500));
        const { summary, ...run } = await recordedRun(environment, {
          name: saved.name,
          tests: evaluationTests({ ...saved, limit }),
          concurrency: Math.min(8, saved.concurrency || 4),
          retries: saved.retries ?? 0,
        });
        return { ...run, scores: summary.scores };
      },
    },
    {
      name: 'run_breakdown',
      description:
        'A finished run in detail (id from run_tests or the app): how many tests fell in each response-time range (passed and failed), results per test type, the slowest tests, flaky tests (passed only after a retry), the checks that failed most and, for AI evaluations, the score distribution of each evaluator. Use it to see why a run is slow or unstable.',
      inputSchema: { type: 'object', properties: { runId: str('Run id') }, required: ['runId'] },
      run: (a) => {
        if (!existsSync(runResultsFile(store, String(a.runId)))) throw new ApsError('ValidationError', `No finished run ${String(a.runId)}`);
        return breakdownOfRun(store, String(a.runId));
      },
    },
    {
      name: 'run_reviews',
      description:
        "A person's verdicts on a finished run's results (rated good or bad in the app, with a note): the counts, and each reviewed result with its status, checks' lowest score, rating and note. A bad rating on a passing result means the checks missed something; a good rating on a failing one means a check is too strict. Use it to improve tests and evaluators.",
      inputSchema: { type: 'object', properties: { runId: str('Run id') }, required: ['runId'] },
      run: (a) => runReviewReport(store, String(a.runId)),
    },
    {
      name: 'review_result',
      write: true,
      description:
        'Rate a result of a finished run good or bad, with a note (why), as the app\'s 👍 / 👎 does; rating null clears it. The review is marked as an agent\'s. Rate only after reading the result (its output and checks); people see the rating in the app.',
      inputSchema: {
        type: 'object',
        properties: {
          runId: str('Run id'),
          resultId: str('Result id (from run_reviews, run_tests or the run results)'),
          rating: { type: ['string', 'null'], enum: ['good', 'bad', null], description: 'good, bad, or null to clear' },
          note: str('Why (optional)'),
        },
        required: ['runId', 'resultId'],
      },
      run: (a) => ({
        review:
          reviewResult(store, String(a.runId), String(a.resultId), {
            rating: a.rating === undefined ? undefined : (a.rating as 'good' | 'bad' | null),
            note: a.note === undefined ? undefined : String(a.note),
            by: 'agent',
          }) ?? null,
      }),
    },
    {
      name: 'compare_runs',
      description:
        'What changed between two finished runs (ids from run_tests, run_collection results in the app, or list of runs): tests that started failing, tests that were fixed, tests that got slower beyond latencyPct (and, for AI tests, more tokens or a lower score), new and removed tests, and the change of totals (pass rate, latency percentiles, tokens, cost). `passed` is false when something regressed.',
      inputSchema: {
        type: 'object',
        properties: {
          before: str('Run id of the earlier run (the reference)'),
          after: str('Run id of the later run'),
          latencyPct: { type: 'number', description: 'A test counts as slower above this % (default 25)' },
        },
        required: ['before', 'after'],
      },
      run: (a) => compareRuns(store, String(a.before), String(a.after), { latencyPct: Number(a.latencyPct) || 25, tokensPct: 20, scoreDrop: 0.05 }),
    },
    {
      name: 'unused_variables',
      description:
        'Variables defined in environments and the workspace that nothing in the workspace reads ({{name}} in requests, saved items, MCP servers, test files or other variables, or a script get). Use it to clean up; variable_usages double-checks one name before deleting it.',
      inputSchema: { type: 'object', properties: {} },
      run: () => unusedVariables(store),
    },
    {
      name: 'variable_flow',
      description:
        'How variables flow through a collection run: for each variable, the requests (or collection / folder scripts) that set it with pm.environment.set etc., and the requests that use it ({{name}} or a script get), in run order. Flags used-before-set (a request uses it before any script sets it and no environment defines it), never-set and unused. Use it to debug request chaining.',
      inputSchema: { type: 'object', properties: { collection: str('Collection name or id') }, required: ['collection'] },
      run: (a) => {
        const c = findCollection(a.collection);
        return collectionVariableFlow(c, definedVariableNames(store, settings));
      },
    },
    {
      name: 'list_datasets',
      description:
        'Data files in the workspace datasets/ folder, newest first: path (give it to run_collection as `data`), size, format (csv, json, jsonl, markdown, sqlite) and, for SQLite databases, their tables (run_collection then needs a `query`). A response saved with the app\'s Table ▸ Save as dataset lands here too.',
      inputSchema: { type: 'object', properties: {} },
      run: () => listWorkspaceDatasets(store),
    },
    {
      name: 'add_dataset_row',
      write: true,
      description:
        'Add one record to a JSONL dataset in datasets/ (made when missing), e.g. an input and the answer it should get, as an evaluation case: { "message": "Cancel my booking", "expected": "cancellation" }. Each field is a {{variable}} of the evaluation prompt; `expected` is what evaluators compare with.',
      inputSchema: {
        type: 'object',
        properties: { dataset: str('File under datasets/ (".jsonl" is added when there is no extension), e.g. intent-cases'), row: { type: 'object', description: 'The record: field → value' } },
        required: ['dataset', 'row'],
      },
      run: (a) => appendDatasetRow(store, String(a.dataset), a.row as Record<string, unknown>),
    },
    {
      name: 'testpion_guide',
      description:
        'How to use this TestPion workspace: which tool to use for what, how variables resolve, every check type this engine knows (with examples) and the YAML test file format. Read it before writing checks or test files.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => agentGuide({ workspace: store.workspace.name, checkTypes: checkTypes(), readOnly: opts.readOnly }),
    },
    {
      name: 'set_request_checks',
      write: true,
      description:
        'Set the checks (assertions) of a saved REST or GraphQL request: they run whenever it is sent, in the app, in run_collection and in CI. `mode: "append"` (default) adds them, `"replace"` replaces the existing ones. Each check is { type, name?, path?, expected?, … } (see testpion_guide for the types); unknown types are refused. Returns the request\'s checks.',
      inputSchema: {
        type: 'object',
        properties: {
          collection: str('Collection name or id'),
          request: str('Request name or id'),
          checks: { type: 'array', items: { type: 'object', properties: { type: { type: 'string' } }, required: ['type'] }, description: 'Checks, e.g. [{ "type": "status", "expected": 200 }, { "type": "exists", "path": "$.id" }]' },
          mode: { type: 'string', enum: ['append', 'replace'], description: 'append (default) or replace' },
        },
        required: ['collection', 'request', 'checks'],
      },
      run: (a) => {
        const c = findCollection(a.collection);
        const { node } = findRequest(c, a.request);
        if ((node as { kind: string }).kind !== 'http' && (node as { kind: string }).kind !== 'graphql') throw new ApsError('ValidationError', `"${node.name}" is not a REST or GraphQL request`);
        const checks = Array.isArray(a.checks) ? (a.checks as CheckConfig[]) : [];
        const known = new Set(checkTypes());
        const unknown = checks.filter((k) => !k || typeof k.type !== 'string' || !known.has(k.type)).map((k) => String(k?.type));
        if (unknown.length) throw new ApsError('ValidationError', `Unknown check type: ${unknown.join(', ')}. Known: ${[...known].join(', ')}`);
        const next = a.mode === 'replace' ? checks : [...(node.assertions ?? []), ...checks];
        const map = (nodes: CollectionNode[]): CollectionNode[] => nodes.map((n) => (n.kind === 'folder' ? { ...n, items: map(n.items) } : n.id === node.id ? ({ ...n, assertions: next } as CollectionNode) : n));
        store.saveCollection({ ...c, items: map(c.items) });
        return { collection: c.name, request: node.name, checks: next };
      },
    },
    {
      name: 'write_test_file',
      write: true,
      description:
        'Write a YAML (or JSON) test file under tests/ for `testpion test`, run_tests and CI. The content is checked first: it must parse as TestPion tests or a suite (*.suite.yaml) and use known check types, otherwise nothing is written and the error says why. An existing file is only replaced with `overwrite: true`. See testpion_guide for the format. Returns the path and the tests it holds.',
      inputSchema: {
        type: 'object',
        properties: {
          path: str('Path inside tests/, e.g. "rest/pets.yaml" or "smoke.suite.yaml"'),
          content: str('The file content (YAML or JSON)'),
          overwrite: { type: 'boolean', description: 'Replace the file when it exists (default false)' },
        },
        required: ['path', 'content'],
      },
      run: async (a) => {
        const rel = String(a.path ?? '').replace(/\\/g, '/').replace(/^tests\//, '');
        if (!/\.(ya?ml|json)$/i.test(rel)) throw new ApsError('ValidationError', 'The path must end with .yaml, .yml or .json');
        const dest = store.safePath(rel, store.path('tests'));
        if (existsSync(dest) && a.overwrite !== true) throw new ApsError('ConfigurationError', `tests/${rel} exists; pass overwrite: true to replace it`);
        // parse a copy first, so a broken file never lands in the workspace
        const tmp = join(tmpdir(), `testpion-check-${shortId('t-')}-${rel.split('/').pop()}`);
        writeFileSync(tmp, String(a.content ?? ''));
        try {
          if (isSuiteFile(tmp)) {
            const suite = await loadSuite(tmp);
            store.writeTestFile(rel, String(a.content));
            return { path: `tests/${rel}`, suite };
          }
          const known = new Set(checkTypes());
          const tests: Array<{ id?: string; name: string; type: string; checks: number }> = [];
          const unknown = new Set<string>();
          for await (const t of loadTestsFromFile(tmp)) {
            const checks = ((t as { assertions?: CheckConfig[] }).assertions ?? []) as CheckConfig[];
            checks.forEach((k) => !known.has(k.type) && unknown.add(String(k.type)));
            tests.push({ id: t.id, name: t.name, type: t.type, checks: checks.length });
            if (tests.length >= 1000) break;
          }
          if (!tests.length) throw new ApsError('ValidationError', 'No tests in the content: give one test (type, url …) or a tests: list (see testpion_guide)');
          if (unknown.size) throw new ApsError('ValidationError', `Unknown check type: ${[...unknown].join(', ')}. Known: ${[...known].join(', ')}`);
          store.writeTestFile(rel, String(a.content));
          return { path: `tests/${rel}`, tests };
        } finally {
          rmSync(tmp, { force: true });
        }
      },
    },
    {
      name: 'load_history',
      description:
        'Earlier load tests of this workspace, newest first (from the app and from load_test): when, what was tested, virtual users, duration, requests, throughput (req/s), error rate, p50 / p95 / p99 in ms, status codes and pass/fail rules. Use it to see whether an API got slower or less reliable between runs.',
      inputSchema: { type: 'object', properties: { query: str('Only load tests whose name or target contains this'), limit: { type: 'number', description: 'How many (default 20, max 200)' } } },
      run: (a) => loadHistory(store, { query: a.query ? String(a.query) : undefined, limit: Math.min(Math.max(Number(a.limit) || 20, 1), 200) }),
    },
    {
      name: 'load_test',
      write: true,
      description:
        'Load-test a local API (localhost / private network only; remote hosts are never allowed from here): a URL, or a collection (every virtual user sends its requests in order, with per-user cookies). At most 50 virtual users and 60 seconds. `warmUp` runs the collection once with scripts first (e.g. to log in). Returns throughput, latency percentiles, error rate, status codes and, for collections, per-request numbers.',
      inputSchema: {
        type: 'object',
        properties: {
          url: str('URL to load-test (GET), or use collection'),
          collection: str('Collection name or id'),
          folder: str('With collection: only this folder or request (name or id)'),
          environment: str('Environment name'),
          virtualUsers: { type: 'number', description: 'Virtual users, 1–50 (default 5)' },
          durationSec: { type: 'number', description: 'Seconds, 1–60 (default 10)' },
          warmUp: { type: 'boolean', description: 'With collection: run it once with scripts first' },
          thresholds: { type: 'array', items: { type: 'string' }, description: 'Pass/fail rules, e.g. ["p95<500", "errors<1%", "rps>=20", "p99[Get pet]<800"]; the result says which passed' },
          grpc: { type: 'object', description: 'Instead of url/collection: a gRPC method, { target: "localhost:50051", method: "pkg.Service/Method", message: {…} } (the server is asked through reflection)', properties: { target: { type: 'string' }, method: { type: 'string' }, message: { type: 'object' } }, required: ['target', 'method'] },
        },
      },
      run: async (a) => {
        const environment = checkEnvironment(a.environment);
        const vus = Math.min(50, Math.max(1, Number(a.virtualUsers) || 5));
        const duration = Math.min(60, Math.max(1, Number(a.durationSec) || 10));
        const c = a.collection ? findCollection(a.collection) : undefined;
        const g = a.grpc as { target?: string; method?: string; message?: unknown } | undefined;
        if (!c && !a.url && !g) throw new ApsError('ValidationError', 'Give a url, a collection or grpc');
        const thresholds = Array.isArray(a.thresholds) ? (a.thresholds as unknown[]).map(String) : [];
        thresholds.forEach(parseThreshold); // a typo fails before the test runs
        const ctx = createEngineContext({ store, secrets, settings, environment, collectionId: c?.id });
        try {
          let target: LoadTarget;
          let prep: { requests: string[]; unresolved: string[] } | undefined;
          if (c) {
            let selection: string[] | undefined;
            if (a.folder) {
              const r = String(a.folder).toLowerCase();
              const all: CollectionNode[] = [];
              const walk = (nodes: CollectionNode[]) => nodes.forEach((n) => (all.push(n), n.kind === 'folder' && walk(n.items)));
              walk(c.items);
              const n = all.find((x) => x.id.toLowerCase() === r) ?? all.find((x) => x.name.toLowerCase() === r);
              if (!n) throw new ApsError('ConfigurationError', `No folder or request "${String(a.folder)}" in "${c.name}"`);
              selection = [n.id];
            }
            const t = await collectionLoadTarget({ collection: c, selection, services: ctx.services, warmUp: a.warmUp === true });
            target = t.target;
            prep = { requests: t.target.requests.map((x) => x.name), unresolved: t.unresolved };
          } else if (g) {
            const gt = ctx.vars.resolve(String(g.target));
            const descriptorSet = (await reflectServer(parseGrpcTarget(gt))).descriptorSet;
            target = { kind: 'grpc', request: { target: gt, method: String(g.method), message: JSON.stringify(ctx.vars.resolveDeep(g.message ?? {})), descriptorSet } };
          } else target = { kind: 'http', request: { method: 'GET', url: ctx.vars.resolve(String(a.url)) } };
          const startedAt = new Date().toISOString();
          const s = await runLoadTest(
            { target, virtualUsers: vus, durationSec: duration, allowRemoteHosts: false, environmentIsProduction: !!ctx.environment?.isProduction, maxVirtualUsers: 50 },
            { redactor: ctx.redactor },
          );
          const { series: _series, ...summary } = s;
          const checked = thresholds.length ? evaluateThresholds(thresholds, s) : undefined;
          // kept in the workspace's load history like the app's load tests (load_history reads it)
          if (s.requests) {
            const targetText = c ? `collection ${c.name}${a.folder ? ` / ${String(a.folder)}` : ''}` : g ? `gRPC ${String(g.target)} ${String(g.method)}` : `GET ${redactor.redactUrl(String(a.url))}`;
            recordLoadRun(
              store,
              loadRunRecord(s, { id: shortId('load-'), startedAt, name: targetText, target: targetText, environment, virtualUsers: vus, durationSec: duration, thresholds: checked?.map((t) => ({ expr: t.expr, passed: t.passed, actual: t.actual })) }),
            );
          }
          return { ...prep, ...summary, ...(checked ? { thresholds: checked, passed: checked.every((t) => t.passed) } : {}) };
        } finally {
          await ctx.dispose();
        }
      },
    },
    ...historyTools({ store, redactor, findCollection, findRequest }),
    ...gitTools({ store, findCollection, redactor }),
    ...openApiTools({ store, readSpecRef: readSpec, context: (environment) => createEngineContext({ store, secrets, settings, environment }) }),
    ...debuggerTools({ redactor, store }),
    ...workspaceEditTools({
      store,
      redactor,
      collections,
      findCollection,
      findRequest,
      // the workspace's MCP servers, with the environment's variables; a stdio server only when the user allowed its command
      mcpSession: async (ref) => {
        const ctx = createEngineContext({ store, secrets, settings });
        const r = ref.toLowerCase();
        const cfg = ctx.services.mcpServers.find((x) => x.id.toLowerCase() === r) ?? ctx.services.mcpServers.find((x) => x.name.toLowerCase() === r);
        if (!cfg) {
          await ctx.dispose();
          throw new ApsError('ConfigurationError', `No MCP server "${ref}" in the workspace. Available: ${ctx.services.mcpServers.map((x) => x.name).join(', ') || 'none'}`);
        }
        if (cfg.transport === 'stdio' && !isCommandTrusted(store, cfg.command, cfg.args ?? [])) {
          await ctx.dispose();
          throw new ApsError('ConfigurationError', `"${cfg.name}" is a program (${commandLine(cfg.command, cfg.args ?? [])}) the user has not allowed to run from here`, {
            suggestions: ['Ask the user to open the server in TestPion (MCP view), press Connect and choose "Always for this workspace"; then try again.'],
          });
        }
        const session = new McpSession(cfg, ctx.redactor, { cookieJar: ctx.services.cookieJar });
        await session.connect(30_000);
        const close = session.close.bind(session);
        session.close = async () => {
          await close();
          await ctx.dispose();
        };
        return session;
      },
    }),
  ];
  const tools = withEnvironmentSecrets(store, all.filter((t) => !(opts.readOnly && t.write)));
  tools.push(searchTool(tools, (name, write) => toolAnnotations(name, write).title));
  const listed = opts.profile === 'minimal' ? tools.filter((t) => MINIMAL_TOOLS.has(t.name)) : tools;

  const server = new Server(
    { name: 'testpion', version: opts.version ?? ENGINE_VERSION },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions: `TestPion workspace "${store.workspace.name}". what_needs_attention lists what is failing or about to (monitors, certificates, runs, requests, flaky tests). Use list_collections and list_requests to find requests, get_request or collection_docs to understand them${opts.readOnly ? '' : ', send_request to call one and run_collection to run tests'}. list_monitors and monitor_results show scheduled checks${opts.readOnly ? '' : ' (run_monitor runs one now)'}. parse_request_snippet reads a cURL / fetch / PowerShell command${opts.readOnly ? '' : ' and save_request stores it in a collection (secrets become {{variables}})'}. Values of secrets are never returned. Read testpion_guide (or the testpion://guide resource) for the check types and the test file format before writing tests${opts.readOnly ? '' : ' (set_request_checks, write_test_file)'}; the prompts investigate_failures, write_tests, debug_request, api_health_report and import_and_test walk through the common jobs. ${opts.profile === 'minimal' ? 'This is the minimal profile: the listed tools cover the common jobs; search_tools finds the others (mocks, the debugger, git, load tests, certificates …), and any tool it names can be called.' : 'search_tools finds a tool by what you want to do.'}`,
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listed.map(({ name, description, inputSchema, write }) => {
      const annotations = toolAnnotations(name, !!write);
      return { name, title: annotations.title, description, inputSchema, annotations };
    }),
  }));
  // resources: what an agent (or its user, e.g. with @ in Claude Code) can read as context without calling tools
  const json = (uri: string, data: unknown) => ({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] });
  const runTool = (name: string, args: Record<string, unknown> = {}) => all.find((t) => t.name === name)!.run(args);
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: 'testpion://guide', name: 'guide', title: 'TestPion guide for agents', description: 'Which tool to use for what, variables, check types and the test file format', mimeType: 'text/markdown' },
      { uri: 'testpion://workspace', name: 'workspace', title: `Workspace "${store.workspace.name}"`, description: 'Collections (with request counts), environments (variable names) and monitors', mimeType: 'application/json' },
      { uri: 'testpion://attention', name: 'attention', title: 'What needs attention', description: 'Failing monitors, expiring certificates, failed runs and requests, flaky tests', mimeType: 'application/json' },
      ...collections().map((c) => ({ uri: `testpion://collections/${encodeURIComponent(c.id)}`, name: c.name, title: `Collection "${c.name}"`, description: 'Its documentation: every request with parameters, headers, body and examples', mimeType: 'text/markdown' })),
    ],
  }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      { uriTemplate: 'testpion://collections/{collection}', name: 'collection', title: 'A collection\'s documentation', description: 'Collection name or id', mimeType: 'text/markdown' },
      { uriTemplate: 'testpion://collections/{collection}/requests/{request}', name: 'request', title: 'A saved request', description: 'Its method, URL, headers, body, auth type, scripts and checks (secrets masked)', mimeType: 'application/json' },
    ],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    if (uri === 'testpion://guide') return { contents: [{ uri, mimeType: 'text/markdown', text: agentGuide({ workspace: store.workspace.name, checkTypes: checkTypes(), readOnly: opts.readOnly }) }] };
    if (uri === 'testpion://workspace')
      return json(uri, { workspace: store.workspace.name, collections: await runTool('list_collections'), environments: await runTool('list_environments'), monitors: await runTool('list_monitors') });
    if (uri === 'testpion://attention') return json(uri, await runTool('what_needs_attention'));
    const m = /^testpion:\/\/collections\/([^/]+)(?:\/requests\/([^/]+))?$/.exec(uri);
    if (m) {
      const collection = decodeURIComponent(m[1]!);
      if (m[2]) return json(uri, await runTool('get_request', { collection, request: decodeURIComponent(m[2]) }));
      return { contents: [{ uri, mimeType: 'text/markdown', text: String(await runTool('collection_docs', { collection })) }] };
    }
    throw new ApsError('ConfigurationError', `Unknown resource ${uri}`);
  });
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: AGENT_PROMPTS.filter((p) => !opts.readOnly || p.name === 'investigate_failures' || p.name === 'api_health_report').map(({ name, title, description, arguments: args }) => ({ name, title, description, arguments: args })),
  }));
  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const p = AGENT_PROMPTS.find((x) => x.name === req.params.name);
    if (!p) throw new ApsError('ConfigurationError', `Unknown prompt ${req.params.name}. Available: ${AGENT_PROMPTS.map((x) => x.name).join(', ')}`);
    const args = (req.params.arguments ?? {}) as Record<string, string | undefined>;
    const missing = p.arguments.filter((x) => x.required && !args[x.name]).map((x) => x.name);
    if (missing.length) throw new ApsError('ValidationError', `Missing: ${missing.join(', ')}`);
    return { description: p.description, messages: [{ role: 'user', content: { type: 'text', text: p.text(args) } }] };
  });
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) return { isError: true, content: [{ type: 'text', text: `Unknown tool ${req.params.name}` }] };
    try {
      const out = await tool.run((req.params.arguments ?? {}) as Record<string, unknown>);
      if (typeof out === 'string') return { content: [{ type: 'text', text: out }] };
      // the JSON as text for every client, and as structured content for clients that read it (a list is wrapped: structured content is an object)
      const structured = Array.isArray(out) ? { items: out } : out && typeof out === 'object' ? (out as Record<string, unknown>) : { value: out };
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: structured };
    } catch (e) {
      const err = normalizeError(e);
      return { isError: true, content: [{ type: 'text', text: `${err.kind}: ${err.message}${err.suggestions.length ? `\n${err.suggestions.join('\n')}` : ''}` }] };
    }
  });
  return server;
}

/**
 * Serve the workspace over stdio until the client disconnects. `stdio` replaces process.stdin / stdout (the
 * desktop app passes streams on file descriptors 0 and 1: Electron's process.stdin reads nothing on Windows).
 */
export async function serveTestPionMcp(opts: TestPionMcpOptions & { stdio?: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } }): Promise<void> {
  const server = createTestPionMcpServer(opts);
  const transport = new StdioServerTransport(opts.stdio?.input as never, opts.stdio?.output as never);
  const closed = new Promise<void>((resolve) => (server.onclose = () => resolve()));
  await server.connect(transport);
  await closed;
}
