import { parse as parseYaml } from 'yaml';
import type { Collection, Environment, KeyValue, LibraryItem } from '../model/types.js';
import { SCHEMA_VERSION } from '../model/types.js';
import { ApsError } from '../errors.js';
import { shortId, slugify } from '../util/ids.js';

/**
 * AsyncAPI 2.x and 3.0 → a collection of realtime connections (Kafka, MQTT, WebSocket, Socket.IO), the way an
 * OpenAPI import gives requests. Each channel becomes one saved connection: the topic to produce / publish to with an
 * example message for every message the channel carries, and the topic read / subscribed on connect when the
 * application sends on it. The document's servers become an environment ({{<server>Url}}), and a channel's
 * {parameters} become {{variables}}. Protocols TestPion doesn't speak (AMQP, NATS …) are reported, not guessed.
 */
type Json = Record<string, any>;

export interface AsyncApiImport {
  collection: Collection;
  environment?: Environment;
  savedItems?: { websocket: LibraryItem[] };
  /** Channels left out, with why. */
  skipped: string[];
}

type Mode = 'kafka' | 'mqtt' | 'websocket' | 'socketio';
const MODE: Record<string, Mode> = {
  kafka: 'kafka',
  'kafka-secure': 'kafka',
  mqtt: 'mqtt',
  mqtts: 'mqtt',
  'secure-mqtt': 'mqtt',
  mqtt5: 'mqtt',
  ws: 'websocket',
  wss: 'websocket',
  websocket: 'websocket',
  websockets: 'websocket',
  'socket.io': 'socketio',
  socketio: 'socketio',
};

export function isAsyncApi(d: unknown): boolean {
  return !!d && typeof d === 'object' && typeof (d as Json).asyncapi === 'string';
}

/** A JSON value for a message: its first example, the schema's example, or one made from the schema. */
function sample(schema: any, doc: Json, depth = 0): unknown {
  if (!schema || depth > 6) return null;
  if (schema.$ref) return sample(deref(doc, schema), doc, depth + 1);
  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if (schema.default !== undefined) return schema.default;
  if (schema.const !== undefined) return schema.const;
  if (schema.enum?.length) return schema.enum[0];
  if (schema.allOf) return Object.assign({}, ...schema.allOf.map((s: unknown) => sample(s, doc, depth + 1)));
  if (schema.oneOf || schema.anyOf) return sample((schema.oneOf ?? schema.anyOf)[0], doc, depth + 1);
  const type = Array.isArray(schema.type) ? schema.type.find((t: string) => t !== 'null') : (schema.type ?? (schema.properties ? 'object' : undefined));
  switch (type) {
    case 'object':
      return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([k, v]) => [k, sample(v, doc, depth + 1)]));
    case 'array':
      return [sample(schema.items, doc, depth + 1)];
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'string':
      return schema.format === 'date-time' ? new Date(0).toISOString() : schema.format === 'uuid' ? '00000000-0000-0000-0000-000000000000' : schema.format === 'email' ? 'user@example.com' : 'string';
    default:
      return null;
  }
}

function deref(doc: Json, node: any, seen = 0): any {
  if (!node || typeof node !== 'object' || typeof node.$ref !== 'string' || seen > 20) return node;
  if (!node.$ref.startsWith('#/')) return {};
  let cur: any = doc;
  for (const p of node.$ref.slice(2).split('/')) cur = cur?.[decodeURIComponent(p.replace(/~1/g, '/').replace(/~0/g, '~'))];
  return deref(doc, cur, seen + 1);
}

/** {param} → {{param}}, the TestPion way. */
const vars = (s: string) => s.replace(/\{([\w.-]+)\}/g, '{{$1}}');

interface Message {
  name: string;
  payload: unknown;
  key?: unknown;
  headers?: Record<string, unknown>;
}

function messagesOf(doc: Json, list: unknown[]): Message[] {
  return list
    .map((m0, i): Message | undefined => {
      const m = deref(doc, m0) as Json;
      if (!m || typeof m !== 'object') return undefined;
      const ex = Array.isArray(m.examples) ? (m.examples[0] as Json | undefined) : undefined;
      const payload = ex?.payload !== undefined ? ex.payload : sample(m.payload, doc);
      const headers = ex?.headers ?? (m.headers ? (sample(m.headers, doc) as Record<string, unknown>) : undefined);
      const keySchema = m.bindings?.kafka?.key;
      return {
        name: String(m.title ?? m.name ?? m.messageId ?? ex?.name ?? `Message ${i + 1}`),
        payload,
        headers: headers && typeof headers === 'object' ? headers : undefined,
        key: keySchema ? sample(keySchema, doc) : undefined,
      };
    })
    .filter((m): m is Message => !!m);
}

const text = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v, null, 2));

export function importAsyncApi(input: string): AsyncApiImport {
  const t = input.trim();
  let doc: Json;
  try {
    doc = (t.startsWith('{') ? JSON.parse(t) : parseYaml(t)) as Json;
  } catch (e) {
    throw new ApsError('ValidationError', `The AsyncAPI document is not valid YAML or JSON: ${(e as Error).message}`);
  }
  if (!isAsyncApi(doc)) throw new ApsError('ValidationError', 'Not an AsyncAPI document (no "asyncapi" version)');
  const v3 = /^3\./.test(String(doc.asyncapi));
  const name = String(doc.info?.title ?? 'AsyncAPI');

  // servers → variables of one environment, and the protocol each one speaks
  const servers = new Map<string, { protocol: string; variable: string; url: string }>();
  const envVars: KeyValue[] = [];
  for (const [sname, s0] of Object.entries((doc.servers as Json) ?? {})) {
    const s = deref(doc, s0) as Json;
    const protocol = String(s?.protocol ?? '').toLowerCase();
    const mode = MODE[protocol];
    // 2.x: url (host[:port][/path], maybe with a scheme); 3.0: host and pathname
    let where = String(v3 ? `${s.host ?? ''}${s.pathname ?? ''}` : (s.url ?? '')).replace(/^[a-z][\w+.-]*:\/\//i, '');
    where = where.replace(/\{([\w.-]+)\}/g, (_m, v: string) => String(s.variables?.[v]?.default ?? `{{${v}}}`));
    const secure = /secure|mqtts|wss/.test(protocol) || (protocol === 'kafka' && /SASL_SSL|SSL/i.test(String(s.security ?? '')));
    const scheme =
      mode === 'kafka'
        ? secure
          ? 'kafkas'
          : 'kafka'
        : mode === 'mqtt'
          ? secure
            ? 'mqtts'
            : 'mqtt'
          : mode === 'websocket'
            ? protocol === 'wss'
              ? 'wss'
              : 'ws'
            : mode === 'socketio'
              ? 'http'
              : protocol;
    const variable = `${slugify(sname).replace(/-(\w)/g, (_m, c: string) => c.toUpperCase()) || 'server'}Url`;
    const url = `${scheme}://${where.replace(/\/$/, '')}`;
    servers.set(sname, { protocol, variable, url });
    envVars.push({ key: variable, value: url, enabled: true });
  }
  const firstServer = [...servers.values()][0];

  // channels with what this application sends (we read) and receives (we send)
  interface Channel {
    id: string;
    address: string;
    serverNames: string[];
    send: Message[];
    read: Message[];
    tags: string[];
    description?: string;
  }
  const channels: Channel[] = [];
  if (v3) {
    for (const [id, c0] of Object.entries((doc.channels as Json) ?? {})) {
      const c = deref(doc, c0) as Json;
      const serverNames = ((c.servers as Json[]) ?? [])
        .map((r) =>
          String(r?.$ref ?? '')
            .split('/')
            .pop()!,
        )
        .filter(Boolean);
      channels.push({ id, address: String(c.address ?? id), serverNames, send: [], read: [], tags: [], description: c.description ?? c.summary });
    }
    for (const op0 of Object.values((doc.operations as Json) ?? {})) {
      const op = deref(doc, op0) as Json;
      const ref = String(op?.channel?.$ref ?? '');
      const ch = channels.find((c) => ref === `#/channels/${c.id}`);
      if (!ch) continue;
      const channelMessages = (deref(doc, op.channel) as Json)?.messages ?? {};
      const list = Array.isArray(op.messages) && op.messages.length ? op.messages : Object.values(channelMessages);
      const msgs = messagesOf(doc, list);
      // the application sends: a test client reads; the application receives: a test client sends
      if (op.action === 'send') ch.read.push(...msgs);
      else ch.send.push(...msgs);
      ch.tags.push(...((op.tags as Json[]) ?? []).map((x) => String(x?.name ?? '')).filter(Boolean));
    }
  } else {
    for (const [address, c0] of Object.entries((doc.channels as Json) ?? {})) {
      const c = deref(doc, c0) as Json;
      const ch: Channel = { id: address, address, serverNames: (c.servers as string[]) ?? [], send: [], read: [], tags: [], description: c.description };
      // 2.x: publish = others send to the application (a test client sends); subscribe = the application sends
      for (const [kind, op] of [
        ['publish', c.publish],
        ['subscribe', c.subscribe],
      ] as const) {
        if (!op) continue;
        const m = op.message ? deref(doc, op.message) : undefined;
        const msgs = messagesOf(doc, m?.oneOf ?? (m ? [m] : []));
        if (kind === 'publish') ch.send.push(...(msgs.length ? msgs : [{ name: op.operationId ?? 'Message', payload: null }]));
        else ch.read.push(...msgs);
        ch.tags.push(...((op.tags as Json[]) ?? []).map((x) => String(x?.name ?? '')).filter(Boolean));
      }
      channels.push(ch);
    }
  }

  const skipped: string[] = [];
  const items: LibraryItem[] = [];
  for (const ch of channels) {
    const sname = ch.serverNames.find((n) => servers.has(n)) ?? [...servers.keys()][0];
    const server = sname ? servers.get(sname) : firstServer;
    const mode = server ? MODE[server.protocol] : undefined;
    if (!server || !mode) {
      skipped.push(`${ch.address}: ${server ? `the ${server.protocol} protocol is not supported (Kafka, MQTT, WebSocket and Socket.IO are)` : 'no server'}`);
      continue;
    }
    const topic = vars(ch.address);
    const first = ch.send[0] ?? ch.read[0];
    const saved = [...ch.send, ...ch.read].map((m) => ({ name: m.name, message: text(m.payload), ...(mode === 'socketio' ? { event: topic } : mode === 'websocket' ? {} : { topic }) }));
    const base = { url: `{{${server.variable}}}`, mode, protocols: '', headers: [] as KeyValue[], message: text(first?.payload ?? ''), savedMessages: saved.length > 1 ? saved : undefined };
    let data: Record<string, unknown>;
    if (mode === 'kafka') {
      const h = first?.headers ? Object.entries(first.headers).map(([key, v]) => ({ key, value: text(v), enabled: true })) : undefined;
      data = { ...base, topic, key: first?.key !== undefined ? text(first.key) : undefined, kafkaHeaders: h, reads: ch.read.length ? [{ topic }] : [], groupId: undefined };
    } else if (mode === 'mqtt') {
      const q = (deref(doc, (doc.channels as Json)?.[ch.id]) as Json)?.bindings?.mqtt?.qos;
      const qos = q === 1 || q === 2 ? q : 0;
      data = { ...base, topic, qos, subscriptions: ch.read.length ? [{ topic: topic.replace(/\{\{[\w.-]+\}\}/g, '+'), qos }] : [] };
    } else if (mode === 'socketio') data = { ...base, event: topic };
    else data = { ...base, url: `{{${server.variable}}}${topic.startsWith('/') ? topic : `/${topic}`}` };
    items.push({ id: shortId('lib-'), name: ch.address, folder: ch.tags[0] || undefined, data });
  }
  if (!items.length && channels.length) throw new ApsError('ValidationError', `Nothing to import from this AsyncAPI document: ${skipped.join('; ')}`);

  const collection: Collection = {
    schemaVersion: SCHEMA_VERSION,
    id: slugify(name) || shortId('col-'),
    name,
    description: [doc.info?.description, skipped.length ? `Not imported: ${skipped.join('; ')}` : ''].filter(Boolean).join('\n\n') || undefined,
    version: 1,
    variables: [],
    items: [],
    updatedAt: new Date().toISOString(),
  };
  const environment: Environment | undefined = envVars.length ? { id: slugify(`${name}-servers`) || 'asyncapi-servers', name: `${name} servers`, variables: envVars } : undefined;
  return { collection, environment, savedItems: items.length ? { websocket: items } : undefined, skipped };
}
