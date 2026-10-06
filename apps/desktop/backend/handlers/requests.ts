/** RPC handlers: Sending requests: HTTP (with response history), GraphQL and WebSocket. */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import {
  ApsError,
  applyAuth,
  grpcurlCommand,
  parseGrpcurl,
  startGraphQLSubscription,
  WebSocketSession,
  introspect,
  normalizeError,
  summarizeSchema,
  parseCurl,
  schemaFromText,
  startGraphQLMockServer,
  compareHistory,
  parseRequestSnippet,
  detectRequestSnippet,
  CODE_LANGUAGES,
  type GraphQLRequestSpec,
  type HttpRequestSpec,
  historyResponse,
  historyToHar,
  SocketIoSession,
  KafkaSession,
  MqttSession,
  diffResponses,
  type HttpResponseData,
  buildGraphQLOperation,
  schemaFromSdl,
  workspaceStorage,
  deleteRunsBefore,
  listCertificates,
  checkCertificate,
  recordCertificate,
  workspaceAttention,
  collectionTiming,
} from '@testpion/core';
import type { Backend, Handlers, HttpSendParams, GqlSendParams } from '../backend.js';

export function requestsHandlers(be: Backend): Handlers {
  return {
    'http.send': (p: HttpSendParams) => be.httpSend(p),
    /**
     * Send the same request with two environments (one after the other, scripts included) and diff the
     * responses: status, time, headers and a field-by-field body diff.
     */
    'http.compareEnvironments': async (p: HttpSendParams & { left: string; right: string }) => {
      const run = async (environment: string) => {
        const r = (await be.httpSend({ ...p, id: undefined, environment })) as { response?: HttpResponseData; error?: { message: string } };
        return { environment, response: r.response, error: r.error?.message };
      };
      const a = await run(p.left);
      const b = await run(p.right);
      const comparable = (x: typeof a) => (x.response ? { status: x.response.status, durationMs: x.response.durationMs, size: x.response.size, headers: x.response.headers, body: x.response.bodyPreview } : { status: 'error', body: x.error ?? '' });
      const summary = (x: typeof a) => ({ environment: x.environment, status: x.response?.status, durationMs: x.response?.durationMs, error: x.error });
      return { left: summary(a), right: summary(b), diff: diffResponses(comparable(a), comparable(b)) };
    },
    'http.cancel': ({ id }: { id: string }) => be.controllers.get(id)?.abort(),
    /** A grpcurl command for the call, with {{variables}} resolved (like Copy as cURL, secrets included). */
    'grpc.grpcurl': (p: { target: string; method: string; message?: string; metadata?: Array<{ key: string; value: string; enabled?: boolean }>; tls?: boolean; protoFiles?: string[]; timeoutMs?: number; environment?: string }) => {
      const ctx = be.context({ environment: p.environment });
      try {
        return grpcurlCommand({ ...p, target: ctx.vars.resolve(p.target), message: ctx.vars.resolve(p.message ?? ''), metadata: ctx.vars.resolveDeep(p.metadata ?? []) });
      } finally {
        void ctx.dispose();
      }
    },
    /** Paste a grpcurl command into the gRPC view. */
    'grpc.parseGrpcurl': ({ text }: { text: string }) => parseGrpcurl(text),
    'http.curl': async (p: { request: HttpRequestSpec; environment?: string; collectionId?: string; requestId?: string }) => be.codeSnippet({ ...p, language: 'curl', revealSecrets: true }),
    'http.code': (p: { request: HttpRequestSpec; environment?: string; collectionId?: string; requestId?: string; language: string; revealSecrets?: boolean }) => be.codeSnippet(p),
    'http.codeLanguages': () => CODE_LANGUAGES,
    /**
     * "Copy as …" for a saved request: code (or `url`) with variables resolved and secret values
     * included, like Postman's and the browser's Copy as cURL; `containsSecrets` lets the UI say so.
     */
    'http.copyCode': async (p: { request: HttpRequestSpec; environment?: string; collectionId?: string; requestId?: string; language: string }) => {
      const text = await be.codeSnippet({ ...p, revealSecrets: true });
      const masked = await be.codeSnippet({ ...p, revealSecrets: false });
      return { text, containsSecrets: masked !== text };
    },
    'http.parseCurl': ({ text }: { text: string }) => parseCurl(text),
    /** Paste-to-request: cURL (bash/cmd), fetch, fetch (Node.js) or PowerShell from browser devtools. */
    'http.parseSnippet': ({ text }: { text: string }) => ({ format: detectRequestSnippet(text), request: parseRequestSnippet(text) }),
    'http.saveBody': async ({ payloadPath, name }: { payloadPath: string; name?: string }) => {
      // resolved first: a prefix test alone would accept payloads/../../anything
      if (!payloadPath || !be.ws.isInside(payloadPath, 'payloads')) throw new ApsError('ValidationError', 'Unknown payload');
      return be.saveOrDownload(name ?? 'response.bin', undefined, (dest) => copyFileSync(payloadPath, dest), () => readFileSync(payloadPath));
    },
    'history.list': (q: { query?: string; kind?: string; failed?: boolean; limit?: number; offset?: number }) => be.ws.meta.listHistory(q),
    /** Per-day requests, failures and runs for the Home dashboard charts. */
    'stats.activity': (q: { days?: number; tzOffsetMin?: number } = {}) => be.ws.meta.activity(q),
    /** Per saved request of a collection: responses, failures, latest status and median time (collection Overview). */
    'stats.requests': ({ collectionId }: { collectionId: string }) => be.ws.meta.requestStats(collectionId),
    /** Per collection: how many of its requests were sent from the app and how many of those are failing now. */
    'stats.collectionsHealth': () =>
      Object.fromEntries(
        be.ws.listCollections().map((c) => {
          const stats = be.ws.meta.requestStats(c.id);
          return [c.id, { sent: stats.length, failing: stats.filter((s) => !s.lastOk).length }];
        }),
      ),
    /** TLS certificates of the HTTPS hosts called, soonest to expire first. */
    'certificates.list': () => listCertificates(be.ws),
    /** Connect to a host now, read its certificate and record it (the list then shows the fresh one). */
    'certificates.check': async ({ host }: { host: string }) => {
      const c = await checkCertificate(host);
      recordCertificate(be.ws, `https://${c.host}:${c.port}/`, c);
      return c;
    },
    /** What needs attention: failing monitors, expiring certificates, the latest failed run, failing requests, flaky tests. */
    'stats.attention': () => workspaceAttention(be.ws),
    /** Where the time of a collection's requests went (DNS, TCP, TLS, server, download), from responses sent in the app. */
    'stats.collectionTiming': ({ collectionId }: { collectionId: string }) => collectionTiming(be.ws, collectionId) ?? null,
    'history.get': ({ id }: { id: string }) => be.ws.meta.getHistory(id),
    'history.delete': ({ id }: { id: string }) => be.ws.meta.deleteHistory(id),
    'history.clear': () => be.ws.meta.clearHistory(),
    /** What the workspace keeps on disk (runs, traces, response bodies, history) — Settings ▸ Storage. */
    'storage.usage': () => workspaceStorage(be.ws),
    'storage.deleteRunsBefore': ({ days }: { days: number }) => {
      const n = Math.max(1, Math.floor(Number(days) || 0));
      if (!n) throw new ApsError('ValidationError', 'Give a number of days');
      const r = deleteRunsBefore(be.ws, new Date(Date.now() - n * 86_400_000).toISOString());
      be.host.emit('data.changed', { kind: 'runs' });
      return r;
    },
    /** HTTP and GraphQL history (optionally filtered) as a HAR file, secrets redacted. */
    'history.exportHar': async ({ query, kind, limit }: { query?: string; kind?: string; limit?: number }) => {
      const items = be.ws.meta.listHistory({ query, kind: kind || undefined, limit: Math.min(limit ?? 500, 2000) }).items;
      const text = JSON.stringify(historyToHar(be.ws, items, be.logger.redactor), null, 2);
      return be.saveOrDownload('testpion-history.har', [{ name: 'HAR', extensions: ['har'] }], (dest) => writeFileSync(dest, text), () => Buffer.from(text));
    },
    /** Earlier responses of a saved request, newest first (response history). */
    'history.forRequest': ({ requestId, limit }: { requestId: string; limit?: number }) =>
      be.ws.meta.listHistory({ requestId, kind: 'http', limit: Math.min(limit ?? 50, 200) }).items,
    /** One response from history, with its body (from the saved payload) for viewing. */
    'history.response': ({ id }: { id: string }) => {
      const h = be.ws.meta.getHistory(id);
      if (!h) throw new ApsError('ConfigurationError', 'That response is no longer in the history');
      return { entry: h, ...historyResponse(be.ws, h) };
    },
    /** Compare two responses from history (`before`, `after` are history ids). */
    'history.compare': ({ before, after }: { before: string; after: string }) => compareHistory(be.ws, before, after),

    'gql.introspect': async ({ request, environment }: { request: Omit<GraphQLRequestSpec, 'query'>; environment?: string }) => {
      const ctx = be.context({ environment });
      const { sdl, schema } = await introspect(ctx.vars.resolveDeep(request), { redactor: ctx.redactor });
      return { sdl, summary: summarizeSchema(schema) };
    },
    'gql.send': (p: GqlSendParams) => be.gqlSend(p),
    /** A ready-to-run operation for a root field of the introspected schema (SDL from gql.introspect). */
    'gql.buildOperation': ({ sdl, field, depth, requiredArgsOnly }: { sdl: string; field: string; depth?: number; requiredArgsOnly?: boolean }) =>
      buildGraphQLOperation(schemaFromSdl(sdl), field, { depth, includeOptionalArgs: !requiredArgsOnly }),
    /**
     * Start a GraphQL subscription over WebSocket (graphql-transport-ws or graphql-ws). Events arrive as
     * `gql.subscription` { id, event }. The request's auth is sent as a handshake header.
     */
    'gql.subscribe': async (p: { request: GraphQLRequestSpec; environment?: string; operationName?: string; connectionParams?: string; collectionId?: string }) => {
      const ctx = be.context({ environment: p.environment, collectionId: p.collectionId });
      const spec = ctx.vars.resolveDeep(p.request);
      const headers = new Headers();
      for (const h of spec.headers ?? []) if (h.enabled !== false && h.key) headers.set(h.key, h.value);
      const auth = !spec.auth || spec.auth.type === 'inherit' ? (ctx.collection?.auth ? ctx.vars.resolveDeep(ctx.collection.auth) : undefined) : spec.auth;
      await applyAuth(auth, headers, new URL(spec.endpoint.replace(/^ws/i, 'http')), { redactor: ctx.redactor, openExternal: be.host.openExternal?.bind(be.host) });
      let variables: Record<string, unknown> | undefined;
      try {
        variables = typeof spec.variables === 'string' ? (spec.variables.trim() ? JSON.parse(spec.variables) : undefined) : spec.variables;
      } catch {
        throw new ApsError('ValidationError', 'The variables are not valid JSON');
      }
      let connectionParams: Record<string, unknown> | undefined;
      if (p.connectionParams?.trim()) {
        try {
          connectionParams = JSON.parse(ctx.vars.resolve(p.connectionParams));
        } catch {
          throw new ApsError('ValidationError', 'The connection parameters are not valid JSON');
        }
      }
      let subId = '';
      const sub = await startGraphQLSubscription({
        url: spec.endpoint,
        query: spec.query,
        variables,
        operationName: p.operationName,
        headers: [...headers].map(([key, value]) => ({ key, value, enabled: true })),
        connectionParams,
        cookieJar: ctx.services.cookieJar,
        onEvent: (event) => be.host.emit('gql.subscription', { id: subId, event: ctx.redactor.redact(event) }),
      });
      subId = sub.id;
      be.gqlSubs.set(sub.id, sub);
      void sub.done.finally(() => be.gqlSubs.delete(sub.id));
      return { id: sub.id, protocol: sub.protocol };
    },
    'gql.unsubscribe': ({ id }: { id: string }) => {
      be.gqlSubs.get(id)?.stop();
      be.gqlSubs.delete(id);
    },
    /** Serve fake data for a schema on localhost (restarts with the new schema when already running). */
    'gql.mock.start': async ({ sdl, port, overrides }: { sdl: string; port?: number; overrides?: Record<string, Record<string, unknown>> }) => {
      const schema = schemaFromText(sdl);
      if (be.gqlMock) {
        be.gqlMock.update(schema, { overrides });
        return { url: be.gqlMock.url };
      }
      be.gqlMock = await startGraphQLMockServer(schema, { port: port ?? 0, overrides });
      return { url: be.gqlMock.url };
    },
    'gql.mock.stop': async () => {
      await be.gqlMock?.close();
      be.gqlMock = undefined;
    },
    'gql.mock.status': () => (be.gqlMock ? { url: be.gqlMock.url } : null),

    'wsock.connect': async ({ url, protocols, headers, environment }: { url: string; protocols?: string[]; headers?: Array<{ key: string; value: string }>; environment?: string }) => {
      const ctx = be.context({ environment });
      const s = new WebSocketSession(ctx.vars.resolve(url), { protocols, headers: ctx.vars.resolveDeep(headers), cookieJar: ctx.services.cookieJar });
      const shown = ctx.redactor.redactUrl(ctx.vars.resolve(url));
      const b = be.batched<unknown>('wsock.messages');
      // the console gets connect, send and close (with message counts), not every received frame
      const counts = { sent: 0, received: 0, opened: 0 };
      s.onMessage((m) => {
        b.push({ id: s.id, message: m });
        if (m.direction === 'received') counts.received++;
      });
      s.onStatus((st) => {
        be.host.emit('wsock.status', { id: s.id, status: st });
        if (st === 'closed' && counts.opened)
          be.consoleProtocol('websocket', ctx.redactor, { name: shown, method: 'CLOSE', url: shown, status: 'closed', durationMs: Date.now() - counts.opened, logs: [`${counts.sent} sent · ${counts.received} received`] });
      });
      be.wsSessions.set(s.id, s);
      be.wsConsole.set(s.id, { url: shown, redactor: ctx.redactor, counts });
      const started = Date.now();
      try {
        await s.connect();
      } catch (e) {
        const err = normalizeError(e);
        be.consoleProtocol('websocket', ctx.redactor, { name: shown, method: 'CONNECT', url: shown, status: err.kind, durationMs: Date.now() - started, error: err.message });
        throw e;
      }
      counts.opened = Date.now();
      be.consoleProtocol('websocket', ctx.redactor, {
        name: shown,
        method: 'CONNECT',
        url: shown,
        status: 'open',
        durationMs: counts.opened - started,
        request: headers?.length || protocols?.length ? { protocols, headers: ctx.vars.resolveDeep(headers) } : undefined,
      });
      return { id: s.id };
    },
    'wsock.send': async ({ id, data: raw, environment }: { id: string; data: string; environment?: string }) => {
      const s = be.wsSessions.get(id);
      // {{variables}} in the message resolve like in requests (dynamic ones such as {{$guid}} too)
      const data = await be.resolveText(raw, environment);
      s?.send(data);
      const c = be.wsConsole.get(id);
      if (s && c) {
        c.counts.sent++;
        be.consoleProtocol('websocket', c.redactor, { name: c.url, method: 'SEND', url: c.url, status: 'sent', request: data, logs: [`${data.length} characters`] });
      }
    },
    'wsock.close': ({ id }: { id: string }) => {
      be.wsSessions.get(id)?.close();
      be.wsSessions.delete(id);
      be.wsConsole.delete(id);
    },

    /* Socket.IO: messages and status arrive on the WebSocket channels (wsock.messages / wsock.status) */
    'sio.connect': async (p: { url: string; path?: string; headers?: Array<{ key: string; value: string; enabled?: boolean }>; auth?: string; transport?: 'websocket' | 'polling'; environment?: string }) => {
      const ctx = be.context({ environment: p.environment });
      let auth: Record<string, unknown> | undefined;
      if (p.auth?.trim()) {
        try {
          auth = JSON.parse(ctx.vars.resolve(p.auth)) as Record<string, unknown>;
        } catch (e) {
          throw new ApsError('ValidationError', `The auth payload is not valid JSON: ${(e as Error).message}`);
        }
      }
      const s = new SocketIoSession(ctx.vars.resolve(p.url), { path: p.path ? ctx.vars.resolve(p.path) : undefined, headers: ctx.vars.resolveDeep(p.headers ?? []), auth, transports: p.transport === 'websocket' ? ['websocket'] : undefined });
      const b = be.batched<unknown>('wsock.messages');
      s.onMessage((m) => b.push({ id: s.id, message: m }));
      s.onStatus((st) => be.host.emit('wsock.status', { id: s.id, status: st }));
      be.sioSessions.set(s.id, s);
      try {
        await s.connect();
      } catch (e) {
        be.sioSessions.delete(s.id);
        throw e;
      } finally {
        await ctx.dispose();
      }
      return { id: s.id };
    },
    'sio.emit': async ({ id, event: rawEvent, args: rawArgs, ack, environment }: { id: string; event: string; args?: string; ack?: boolean; environment?: string }) => {
      const s = be.sioSessions.get(id);
      if (!s) throw new ApsError('ProtocolError', 'Socket.IO is not connected');
      const event = await be.resolveText(rawEvent, environment);
      const args = rawArgs === undefined ? undefined : await be.resolveText(rawArgs, environment);
      let list: unknown[] = [];
      if (args?.trim()) {
        try {
          const v = JSON.parse(args) as unknown;
          // a JSON list is the argument list; anything else is a single argument
          list = Array.isArray(v) ? v : [v];
        } catch {
          list = [args];
        }
      }
      return s.emit(event, list, ack);
    },
    'sio.close': ({ id }: { id: string }) => {
      be.sioSessions.get(id)?.close();
      be.sioSessions.delete(id);
    },

    /* MQTT: messages and status arrive on the WebSocket channels too (with the topic) */
    'mqtt.connect': async (p: { url: string; clientId?: string; username?: string; password?: string; protocolVersion?: 4 | 5; clean?: boolean; keepaliveSec?: number; subscriptions?: Array<{ topic: string; qos?: 0 | 1 | 2 }>; environment?: string }) => {
      const ctx = be.context({ environment: p.environment });
      const s = new MqttSession(ctx.vars.resolve(p.url), {
        clientId: p.clientId ? ctx.vars.resolve(p.clientId) : undefined,
        username: p.username ? ctx.vars.resolve(p.username) : undefined,
        password: p.password ? ctx.vars.resolve(p.password) : undefined,
        protocolVersion: p.protocolVersion,
        clean: p.clean,
        keepaliveSec: p.keepaliveSec,
      });
      const b = be.batched<unknown>('wsock.messages');
      s.onMessage((m) => b.push({ id: s.id, message: m }));
      s.onStatus((st) => be.host.emit('wsock.status', { id: s.id, status: st }));
      be.mqttSessions.set(s.id, s);
      try {
        await s.connect();
        for (const sub of p.subscriptions ?? []) if (sub.topic.trim()) await s.subscribe(ctx.vars.resolve(sub.topic), sub.qos ?? 0);
      } catch (e) {
        s.close();
        be.mqttSessions.delete(s.id);
        throw e;
      } finally {
        await ctx.dispose();
      }
      return { id: s.id };
    },
    'mqtt.subscribe': async ({ id, topic, qos, environment }: { id: string; topic: string; qos?: 0 | 1 | 2; environment?: string }) => {
      const s = be.mqttSessions.get(id);
      if (!s) throw new ApsError('ProtocolError', 'MQTT is not connected');
      return s.subscribe(await be.resolveText(topic, environment), qos ?? 0);
    },
    'mqtt.unsubscribe': async ({ id, topic, environment }: { id: string; topic: string; environment?: string }) => {
      const s = be.mqttSessions.get(id);
      if (!s) throw new ApsError('ProtocolError', 'MQTT is not connected');
      await s.unsubscribe(await be.resolveText(topic, environment));
    },
    'mqtt.publish': async ({ id, topic, payload, qos, retain, environment }: { id: string; topic: string; payload?: string; qos?: 0 | 1 | 2; retain?: boolean; environment?: string }) => {
      const s = be.mqttSessions.get(id);
      if (!s) throw new ApsError('ProtocolError', 'MQTT is not connected');
      // {{variables}} in the topic and payload resolve like in requests
      await s.publish(await be.resolveText(topic, environment), await be.resolveText(payload ?? '', environment), { qos, retain });
    },
    'mqtt.close': ({ id }: { id: string }) => {
      be.mqttSessions.get(id)?.close();
      be.mqttSessions.delete(id);
    },

    /* Kafka: messages and status arrive on the WebSocket channels too (with the topic, key, partition and offset) */
    'kafka.connect': async (p: {
      url: string;
      clientId?: string;
      groupId?: string;
      username?: string;
      password?: string;
      mechanism?: 'plain' | 'scram-sha-256' | 'scram-sha-512';
      reads?: Array<{ topic: string; fromBeginning?: boolean }>;
      environment?: string;
    }) => {
      const ctx = be.context({ environment: p.environment });
      const s = new KafkaSession(ctx.vars.resolve(p.url), {
        clientId: p.clientId ? ctx.vars.resolve(p.clientId) : undefined,
        groupId: p.groupId ? ctx.vars.resolve(p.groupId) : undefined,
        username: p.username ? ctx.vars.resolve(p.username) : undefined,
        password: p.password ? ctx.vars.resolve(p.password) : undefined,
        mechanism: p.mechanism,
      });
      if (p.password) ctx.redactor.addSecret(ctx.vars.resolve(p.password));
      const b = be.batched<unknown>('wsock.messages');
      s.onMessage((m) => b.push({ id: s.id, message: m }));
      s.onStatus((st) => be.host.emit('wsock.status', { id: s.id, status: st }));
      be.kafkaSessions.set(s.id, s);
      try {
        await s.connect();
        for (const r of p.reads ?? []) if (r.topic.trim()) await s.subscribe(ctx.vars.resolve(r.topic), { fromBeginning: !!r.fromBeginning });
      } catch (e) {
        await s.closeAndWait();
        be.kafkaSessions.delete(s.id);
        throw e;
      } finally {
        await ctx.dispose();
      }
      return { id: s.id };
    },
    'kafka.read': async ({ id, topic, fromBeginning, environment }: { id: string; topic: string; fromBeginning?: boolean; environment?: string }) => {
      const s = be.kafkaSessions.get(id);
      if (!s) throw new ApsError('ProtocolError', 'Kafka is not connected');
      await s.subscribe(await be.resolveText(topic, environment), { fromBeginning });
    },
    'kafka.stopReading': async ({ id, topic, environment }: { id: string; topic: string; environment?: string }) => {
      const s = be.kafkaSessions.get(id);
      if (!s) throw new ApsError('ProtocolError', 'Kafka is not connected');
      await s.unsubscribe(await be.resolveText(topic, environment));
    },
    'kafka.produce': async ({ id, topic, value, key, headers, partition, environment }: { id: string; topic: string; value?: string; key?: string; headers?: Array<{ key: string; value: string; enabled?: boolean }>; partition?: number; environment?: string }) => {
      const s = be.kafkaSessions.get(id);
      if (!s) throw new ApsError('ProtocolError', 'Kafka is not connected');
      // {{variables}} in the topic, key, value and headers resolve like in requests
      const h: Record<string, string> = {};
      for (const x of headers ?? []) if (x.enabled !== false && x.key.trim()) h[await be.resolveText(x.key, environment)] = await be.resolveText(x.value, environment);
      return s.produce(await be.resolveText(topic, environment), await be.resolveText(value ?? '', environment), { key: key ? await be.resolveText(key, environment) : undefined, headers: h, partition });
    },
    'kafka.topics': async ({ id }: { id: string }) => {
      const s = be.kafkaSessions.get(id);
      if (!s) throw new ApsError('ProtocolError', 'Kafka is not connected');
      return s.listTopics();
    },
    'kafka.close': async ({ id }: { id: string }) => {
      await be.kafkaSessions.get(id)?.closeAndWait();
      be.kafkaSessions.delete(id);
    },
  };
}
