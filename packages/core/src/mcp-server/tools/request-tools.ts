import { readFileSync } from 'node:fs';
import { createEngineContext } from '../../engine.js';
import { ApsError } from '../../errors.js';
import { addRequestToCollection, externalizeSecrets } from '../../import/save-request.js';
import type { HttpRequestSpec, TestResult } from '../../model/types.js';
import { assertProductionStep, isDataChangingMethod, isGrpcReadMethod } from '../../net/production-guard.js';
import { describeRoot, executeGrpc, grpcRoot, parseGrpcTarget } from '../../protocols/grpc/grpc.js';
import { reflectServer } from '../../protocols/grpc/reflection.js';
import { executeHttp, timingSummary } from '../../protocols/http/client.js';
import { runRealtimeExchange, type RealtimeExchange } from '../../protocols/realtime.js';
import { redactDiff } from '../../report/response-diff.js';
import { runCollection } from '../../runner/collection-run.js';
import type { RunEvent } from '../../runner/runner.js';
import { saveTest } from '../../runner/test-from-ref.js';
import { recordCertificate } from '../../storage/certificates.js';
import { requireEnvironment } from '../../storage/env-edit.js';
import { compareHistory } from '../../storage/history-compare.js';
import { exportOtlp } from '../../trace/otlp.js';
import { shortId } from '../../util/ids.js';
import { decodeJwt } from '../../util/jwt.js';
import { str } from '../tool.js';
import { toItemRef } from '@testpion/shared';
import type { Tool } from '../tool.js';
import type { ModuleToolDeps } from './deps.js';

/** Sending a request (HTTP, gRPC, realtime), reading what came back, and saving requests and tests. */
export function requestTools(d: ModuleToolDeps): Tool[] {
  const { store, secrets, settings, redactor, collections, findCollection, findRequest, checkEnvironment, clip, summarizeResult, requestFrom } = d;
  return [
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
        // an unknown environment, or one whose file cannot be read, is an error (never a send without its variables)
        if (a.environment !== undefined && a.environment !== null && a.environment !== '') requireEnvironment(store, String(a.environment));
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
          assertProductionStep(ctx.services.production, { action: `${spec.method} ${spec.url}`, changesData: isDataChangingMethod(spec.method) });
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
          assertProductionStep(ctx.services.production, { action: `gRPC ${String(a.method)}`, changesData: !isGrpcReadMethod(String(a.method)) });
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
          assertProductionStep(ctx.services.production, { action: `messages sent to ${r.url}`, changesData: Array.isArray(r.send) && r.send.length > 0 });
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
        'Save as a YAML test file under tests/, with its checks or a first status / no-errors check, for `testpion test` and CI: a saved request (collection + request), or any item by its `ref` (a request, a folder or whole collection as one file with a test per request, a saved gRPC call or connection, a History entry). {{variables}} are kept. Returns the file path and its ref.',
      inputSchema: { type: 'object', properties: { collection: str('Collection name or id'), request: str('Request name or id'), ref: { type: 'object', description: 'Or: the item as an ItemRef ({ kind: "folder", collectionId, folderId } …)' }, name: str('Test name (default: the request name)') } },
      run: (a) => {
        const ref = a.ref ? toItemRef(a.ref) : undefined;
        if (a.ref && !ref) throw new ApsError('ValidationError', 'ref is not an ItemRef');
        const target = ref ?? (() => {
          const c = findCollection(a.collection);
          return { kind: 'request' as const, collectionId: c.id, requestId: findRequest(c, a.request).node.id };
        })();
        const r = saveTest(store, { name: a.name === undefined ? undefined : String(a.name), ref: target });
        return { path: `tests/${r.path}`, tests: r.tests, ref: { kind: 'test', path: r.path } };
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
  ];
}
