/**
 * RPC handlers: what the app has running for the open workspace, in one list (the status bar's "Running"), and a way to
 * stop each: runs in progress, mock servers, the GraphQL mock, the traffic recorder, the HTTP Debugger's proxy, open connections
 * (WebSocket, Socket.IO, MQTT, Kafka), MCP sessions and GraphQL subscriptions. A stop goes through the handler the
 * view itself uses, so the view that started it shows it stopped too.
 */
import { ApsError } from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';

export type RunningKind = 'run' | 'mock' | 'graphql-mock' | 'recorder' | 'debugger' | 'websocket' | 'socketio' | 'mqtt' | 'kafka' | 'mcp' | 'subscription';

export interface RunningItem {
  kind: RunningKind;
  /** What stop() is given back. */
  id: string;
  /** What it is, in words ("Mock server of Petstore"). */
  label: string;
  /** Where (a URL, a port). */
  detail?: string;
}

/** Everything running now, in the order of the list. */
export function runningItems(be: Backend): RunningItem[] {
  const out: RunningItem[] = [];
  // runs in progress (a collection run, a test run, an evaluation): stopped as their own Stop does
  for (const [id, r] of be.runs) if (!r.done) out.push({ kind: 'run', id, label: 'Run in progress', detail: id });
  const collectionName = (id: string) => {
    try {
      return be.ws.listCollections().find((c) => c.id === id)?.name ?? id;
    } catch {
      return id;
    }
  };
  for (const [id, m] of be.mocks) out.push({ kind: 'mock', id, label: `Mock server of ${collectionName(id)}`, detail: m.url });
  if (be.gqlMock) out.push({ kind: 'graphql-mock', id: 'graphql-mock', label: 'GraphQL mock', detail: be.gqlMock.url });
  if (be.recorder) out.push({ kind: 'recorder', id: 'recorder', label: `Recorder for ${be.recorder.target}`, detail: be.recorder.url });
  const proxy = be.debugger?.proxy;
  if (proxy) out.push({ kind: 'debugger', id: 'debugger', label: 'HTTP Debugger capture', detail: `port ${proxy.port}` });
  for (const [id, s] of be.wsSessions) out.push({ kind: 'websocket', id, label: 'WebSocket', detail: s.url });
  for (const [id, s] of be.sioSessions) out.push({ kind: 'socketio', id, label: 'Socket.IO', detail: s.url });
  for (const [id, s] of be.mqttSessions) out.push({ kind: 'mqtt', id, label: 'MQTT', detail: s.url });
  for (const [id, s] of be.kafkaSessions) out.push({ kind: 'kafka', id, label: 'Kafka', detail: s.url });
  for (const [id, s] of be.mcpSessions) out.push({ kind: 'mcp', id, label: `MCP server ${s.config.name ?? id}` });
  for (const [id, s] of be.gqlSubs) out.push({ kind: 'subscription', id, label: 'GraphQL subscription', detail: s.protocol });
  return out;
}

/** The handler that stops each kind, with what it is given (the one its own view calls). */
const STOP: Record<RunningKind, (id: string) => [string, Record<string, unknown>]> = {
  run: (id) => ['runs.cancel', { runId: id }],
  mock: (id) => ['mock.stop', { collectionId: id }],
  'graphql-mock': () => ['gql.mock.stop', {}],
  recorder: () => ['record.stop', {}],
  debugger: () => ['debug.stop', {}],
  websocket: (id) => ['wsock.close', { id }],
  socketio: (id) => ['sio.close', { id }],
  mqtt: (id) => ['mqtt.close', { id }],
  kafka: (id) => ['kafka.close', { id }],
  mcp: (id) => ['mcp.disconnect', { serverId: id }],
  subscription: (id) => ['gql.unsubscribe', { id }],
};

export function runningHandlers(be: Backend): Handlers {
  return {
    /** What runs now for the open workspace (the status bar's Running list). */
    'app.running': () => runningItems(be),
    /** Stop one of them (`kind` and `id` as listed); answers the list after it. */
    'app.stopRunning': async ({ kind, id }: { kind: RunningKind; id: string }) => {
      const how = STOP[kind];
      if (!how) throw new ApsError('ValidationError', `Nothing of the kind "${kind}" can be stopped here`);
      const [method, params] = how(id);
      await be.invoke(method, params);
      return runningItems(be);
    },
  };
}
