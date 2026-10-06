import { ApsError } from '../errors.js';
import type { KeyValue } from '../model/types.js';
import type { CookieJar } from '../cookies/cookie-jar.js';
import type { Redactor } from '../util/redact.js';
import { MqttSession, type MqttQos } from './mqtt/mqtt.js';
import { KafkaSession } from './kafka/kafka.js';
import { SocketIoSession } from './socketio/socketio.js';
import { WebSocketSession } from './websocket/websocket.js';

/**
 * One scripted exchange with a real-time server, for the CLI and AI agents: connect (WebSocket,
 * Socket.IO, MQTT or Kafka), send messages / emit events / publish / produce in order, collect everything received
 * for a while, close.
 */
export interface RealtimeExchange {
  url: string;
  mode?: RealtimeMode;
  /** WebSocket: text frames. Socket.IO: `{ event, args?, ack? }`. MQTT: `{ topic, payload?, qos?, retain? }`. Kafka: `{ topic, payload?, key?, headers?, partition? }`. */
  send?: Array<string | { event: string; args?: unknown[]; ack?: boolean } | MqttPublish | KafkaProduce>;
  /** MQTT: topic filters to subscribe to before publishing (`+` and `#` wildcards). Kafka: topics to read (`fromBeginning` to read what is there already). */
  subscribe?: Array<string | { topic: string; qos?: MqttQos; fromBeginning?: boolean }>;
  /** Kafka: the consumer group (default: one of its own) and the SASL mechanism for username / password. */
  groupId?: string;
  mechanism?: 'plain' | 'scram-sha-256' | 'scram-sha-512';
  /** MQTT: client ID, username and password, protocol version (4 = 3.1.1, 5). */
  clientId?: string;
  username?: string;
  password?: string;
  protocolVersion?: 4 | 5;
  /** How long to keep listening after the last message was sent (ms, default 1500, max 60000). */
  waitMs?: number;
  headers?: KeyValue[];
  protocols?: string[];
  /** Socket.IO handshake auth payload, and path. */
  auth?: Record<string, unknown>;
  path?: string;
}

export type RealtimeMode = 'websocket' | 'socketio' | 'mqtt' | 'kafka';
export interface KafkaProduce {
  topic: string;
  payload?: unknown;
  key?: string;
  headers?: Record<string, string>;
  partition?: number;
}
export interface MqttPublish {
  topic: string;
  payload?: unknown;
  qos?: MqttQos;
  retain?: boolean;
}

export interface RealtimeResult {
  mode: RealtimeMode;
  connected: boolean;
  messages: Array<{ atMs: number; direction: 'sent' | 'received' | 'system'; event?: string; topic?: string; ack?: boolean; data: string; key?: string; partition?: number; offset?: string; headers?: Record<string, string> }>;
  durationMs: number;
}

/** The mode a URL implies: kafka(s):// → Kafka, mqtt(s):// → MQTT, http(s):// → Socket.IO, otherwise WebSocket. */
export function realtimeModeFor(url: string): RealtimeMode {
  return /^kafkas?:/i.test(url) ? 'kafka' : /^(mqtts?|tcp|tls):/i.test(url) ? 'mqtt' : /^https?:/i.test(url) ? 'socketio' : 'websocket';
}

export async function runRealtimeExchange(x: RealtimeExchange, opts: { redactor?: Redactor; cookieJar?: CookieJar; signal?: AbortSignal } = {}): Promise<RealtimeResult> {
  const t0 = Date.now();
  const mode = x.mode ?? realtimeModeFor(x.url);
  const wait = Math.min(Math.max(x.waitMs ?? 1500, 0), 60_000);
  const messages: RealtimeResult['messages'] = [];
  const redact = (s: string) => opts.redactor?.redactString(s) ?? s;
  const record = (m: { direction: 'sent' | 'received' | 'system'; data: string; event?: string; topic?: string; ack?: boolean; key?: string; partition?: number; offset?: string; headers?: Record<string, string> }) =>
    messages.length < 1000 &&
    messages.push({
      atMs: Date.now() - t0,
      direction: m.direction,
      ...(m.event ? { event: m.event } : {}),
      ...(m.topic ? { topic: m.topic } : {}),
      ...(m.ack ? { ack: true } : {}),
      ...(m.key !== undefined ? { key: redact(m.key) } : {}),
      ...(m.partition !== undefined ? { partition: m.partition } : {}),
      ...(m.offset !== undefined ? { offset: m.offset } : {}),
      ...(m.headers ? { headers: Object.fromEntries(Object.entries(m.headers).map(([k, v]) => [k, opts.redactor?.isSensitiveKey(k) ? '***' : redact(v)])) } : {}),
      data: redact(m.data).slice(0, 20_000),
    });

  if (mode === 'kafka') {
    const s = new KafkaSession(x.url, { clientId: x.clientId, groupId: x.groupId, username: x.username, password: x.password, mechanism: x.mechanism });
    s.onMessage((m) => record({ direction: m.direction, data: m.data, topic: m.topic, key: m.key, partition: m.partition, offset: m.offset, headers: m.headers }));
    try {
      await s.connect();
    } catch (e) {
      const msg = (e as Error).message;
      if (!messages.some((m) => msg.includes(m.data.replace(/^Error: /, '')))) record({ direction: 'system', data: msg });
      return { mode, connected: false, messages, durationMs: Date.now() - t0 };
    }
    try {
      for (const sub of x.subscribe ?? []) {
        const o = typeof sub === 'string' ? { topic: sub } : sub;
        await s.subscribe(o.topic, { fromBeginning: !!o.fromBeginning });
      }
      for (const item of x.send ?? []) {
        if (opts.signal?.aborted) break;
        if (typeof item === 'string' || !('topic' in item)) throw new ApsError('ValidationError', 'Kafka messages are { topic, payload?, key?, headers?, partition? } objects');
        const k = item as KafkaProduce;
        const value = k.payload === undefined ? '' : typeof k.payload === 'string' ? k.payload : JSON.stringify(k.payload);
        await s.produce(k.topic, value, { key: k.key, headers: k.headers, partition: k.partition });
      }
      await sleep(wait, opts.signal);
      return { mode, connected: true, messages, durationMs: Date.now() - t0 };
    } finally {
      await s.closeAndWait();
    }
  }

  if (mode === 'mqtt') {
    const s = new MqttSession(x.url, { clientId: x.clientId, username: x.username, password: x.password, protocolVersion: x.protocolVersion });
    s.onMessage((m) => record({ direction: m.direction, data: m.data, topic: m.topic }));
    try {
      await s.connect();
    } catch (e) {
      const msg = (e as Error).message;
      if (!messages.some((m) => msg.includes(m.data.replace(/^Error: /, '')))) record({ direction: 'system', data: msg });
      return { mode, connected: false, messages, durationMs: Date.now() - t0 };
    }
    try {
      for (const sub of x.subscribe ?? []) {
        const o = typeof sub === 'string' ? { topic: sub } : sub;
        await s.subscribe(o.topic, o.qos ?? 0);
      }
      for (const item of x.send ?? []) {
        if (opts.signal?.aborted) break;
        if (typeof item === 'string' || !('topic' in item)) throw new ApsError('ValidationError', 'MQTT messages are { topic, payload?, qos?, retain? } objects');
        const p = item as MqttPublish;
        const payload = p.payload === undefined ? '' : typeof p.payload === 'string' ? p.payload : JSON.stringify(p.payload);
        await s.publish(p.topic, payload, { qos: p.qos, retain: p.retain });
      }
      await sleep(wait, opts.signal);
      return { mode, connected: true, messages, durationMs: Date.now() - t0 };
    } finally {
      s.close();
    }
  }

  if (mode === 'socketio') {
    const s = new SocketIoSession(x.url, { headers: x.headers, auth: x.auth, path: x.path });
    s.onMessage(record);
    try {
      await s.connect();
      for (const item of x.send ?? []) {
        if (opts.signal?.aborted) break;
        if (typeof item !== 'string' && !('event' in item)) throw new ApsError('ValidationError', 'Socket.IO messages are { event, args?, ack? } objects');
        const e = typeof item === 'string' ? { event: item, args: [] } : item;
        await s.emit(e.event, e.args ?? [], e.ack).catch(() => undefined); // a missing ack is recorded as a message
      }
      await sleep(wait, opts.signal);
      return { mode, connected: true, messages, durationMs: Date.now() - t0 };
    } catch (e) {
      if (s.status === 'closed' && !messages.some((m) => m.direction === 'received')) {
        if (!messages.some((m) => m.data.includes((e as Error).message))) record({ direction: 'system', data: (e as Error).message });
        return { mode, connected: false, messages, durationMs: Date.now() - t0 };
      }
      throw e;
    } finally {
      s.close();
    }
  }

  const s = new WebSocketSession(x.url, { protocols: x.protocols, headers: x.headers, cookieJar: opts.cookieJar });
  s.onMessage((m) => record({ direction: m.direction, data: m.data }));
  try {
    await s.connect();
  } catch (e) {
    // the session already logged the reason as a system message
    const msg = (e as Error).message;
    if (!messages.some((m) => m.data.includes(msg))) record({ direction: 'system', data: msg });
    return { mode, connected: false, messages, durationMs: Date.now() - t0 };
  }
  try {
    for (const item of x.send ?? []) {
      if (opts.signal?.aborted) break;
      if (typeof item !== 'string') throw new ApsError('ValidationError', 'WebSocket messages are text: give strings (JSON as text)');
      s.send(item);
      await sleep(20);
    }
    await sleep(wait, opts.signal);
    return { mode, connected: true, messages, durationMs: Date.now() - t0 };
  } finally {
    s.close();
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((ok) => {
    const t = setTimeout(ok, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), ok()), { once: true });
  });
