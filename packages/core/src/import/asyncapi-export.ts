import { stringifyYaml as stringify } from '../util/lazy-yaml.js';
import type { Collection, LibraryItem } from '../model/types.js';

/**
 * A collection's realtime connections (Kafka, MQTT, WebSocket, Socket.IO) as an AsyncAPI 3.0 document: the opposite of
 * the AsyncAPI import. Each distinct broker or server URL is a server; each topic, event or path is a channel with the
 * saved messages as examples (their JSON schema inferred from the example); what the connection sends is a `receive`
 * operation of the API, what it reads or subscribes to a `send` operation.
 */
type Json = Record<string, any>;

interface Conn {
  url?: string;
  mode?: 'websocket' | 'socketio' | 'mqtt' | 'kafka';
  message?: string;
  topic?: string;
  event?: string;
  key?: string;
  subscriptions?: Array<{ topic: string }>;
  reads?: Array<{ topic: string }>;
  savedMessages?: Array<{ name: string; message: string; topic?: string; event?: string }>;
}

const parse = (s: string | undefined): unknown => {
  if (s === undefined || !s.trim()) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

/** A JSON schema that a value matches (types and properties, no constraints). */
function schemaOf(v: unknown, depth = 0): Json {
  if (v === null) return { type: 'null' };
  if (Array.isArray(v)) return { type: 'array', ...(v.length && depth < 6 ? { items: schemaOf(v[0], depth + 1) } : {}) };
  if (typeof v === 'object') return { type: 'object', ...(depth < 6 ? { properties: Object.fromEntries(Object.entries(v as Json).map(([k, x]) => [k, schemaOf(x, depth + 1)])) } : {}) };
  if (typeof v === 'number') return { type: Number.isInteger(v) ? 'integer' : 'number' };
  if (typeof v === 'boolean') return { type: 'boolean' };
  return { type: 'string' };
}

const id = (s: string) =>
  s
    .replace(/\{\{([^}]+)\}\}/g, '$1')
    .replace(/[^\w]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'channel';

export function collectionToAsyncApi(c: Pick<Collection, 'name' | 'description'>, items: LibraryItem[]): { doc: Json; text: string; notes: string[] } {
  const notes: string[] = [];
  const servers: Json = {};
  const channels: Json = {};
  const operations: Json = {};
  const serverFor = (url: string, mode: string) => {
    // a URL kept in a {{variable}}: the server's host is an AsyncAPI server variable of the same name
    const v = /^\{\{\s*([\w.-]+)\s*\}\}(\/[^?#]*)?/.exec(url);
    if (v) {
      const key = id(v[1]!);
      servers[key] ??= { host: `{${v[1]}}`, protocol: mode === 'kafka' ? 'kafka' : mode === 'mqtt' ? 'mqtt' : mode === 'socketio' ? 'socket.io' : 'ws', variables: { [v[1]!]: { description: `The TestPion variable {{${v[1]}}}` } } };
      return { key, path: v[2] ?? '' };
    }
    const m = /^([a-z][\w+.-]*):\/\/([^/?#]*)(\/[^?#]*)?/i.exec(url);
    const protocol =
      mode === 'kafka'
        ? /^kafkas/i.test(url)
          ? 'kafka-secure'
          : 'kafka'
        : mode === 'mqtt'
          ? /^mqtts/i.test(url)
            ? 'secure-mqtt'
            : 'mqtt'
          : mode === 'socketio'
            ? 'socket.io'
            : /^wss/i.test(url)
              ? 'wss'
              : 'ws';
    const host = m?.[2] ?? url;
    const key = id(`${protocol}_${host}`);
    servers[key] ??= { host, protocol, ...(m?.[3] && mode !== 'websocket' ? { pathname: m[3] } : {}) };
    return { key, path: m?.[3] ?? '' };
  };
  for (const item of items) {
    const d = item.data as Conn;
    const mode = d.mode ?? 'websocket';
    if (!d.url) {
      notes.push(`${item.name}: no URL`);
      continue;
    }
    const server = serverFor(d.url, mode);
    // where it sends, and what it reads
    const sendTo = mode === 'websocket' ? server.path || '/' : mode === 'socketio' ? d.event || 'message' : d.topic;
    const reads = mode === 'kafka' ? (d.reads ?? []).map((r) => r.topic) : mode === 'mqtt' ? (d.subscriptions ?? []).map((s) => s.topic) : mode === 'websocket' ? [server.path || '/'] : [];
    const channel = (address: string) => {
      const key = id(address);
      channels[key] ??= { address, servers: [{ $ref: `#/servers/${server.key}` }], messages: {} };
      return key;
    };
    const examples = [{ name: item.name, message: d.message ?? '', topic: d.topic, event: d.event }, ...(d.savedMessages ?? [])].filter((m) => m.message?.trim());
    if (sendTo) {
      const ch = channel(sendTo);
      for (const ex of examples) {
        const where = mode === 'socketio' ? ex.event : ex.topic;
        const target = where && where !== sendTo ? channel(where) : ch;
        const payload = parse(ex.message);
        const mid = id(ex.name);
        channels[target].messages[mid] ??= { name: ex.name, payload: schemaOf(payload), examples: [{ payload }] };
      }
      operations[`receive_${ch}`] ??= { action: 'receive', channel: { $ref: `#/channels/${ch}` }, summary: `${item.name} sends here` };
    } else if (!reads.length) notes.push(`${item.name}: nothing to send or read`);
    for (const r of reads) {
      const ch = channel(r);
      operations[`send_${ch}`] ??= { action: 'send', channel: { $ref: `#/channels/${ch}` }, summary: `${item.name} reads this` };
    }
  }
  const doc: Json = {
    asyncapi: '3.0.0',
    info: { title: c.name, version: '1.0.0', ...(c.description ? { description: c.description } : {}) },
    servers,
    channels,
    operations,
  };
  if (!items.length) notes.push('The collection has no connections (Kafka, MQTT, WebSocket, Socket.IO)');
  return { doc, text: stringify(doc, { lineWidth: 0 }), notes };
}
