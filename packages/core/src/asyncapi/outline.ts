import { parse as parseYaml } from 'yaml';
import { ApsError } from '../errors.js';
import { schemaOutline } from '../openapi/outline.js';
import { deref } from '../util/json-ref.js';

/**
 * An AsyncAPI 2 / 3 document as a reader sees it (the API definition's Preview for an AsyncAPI document): its servers,
 * and each channel with what the application does on it (sends or receives) and the messages it carries, their
 * payloads as short type outlines and their first example.
 */
type Json = Record<string, any>;

export interface AsyncOutlineMessage {
  name: string;
  summary?: string;
  contentType?: string;
  payload?: string;
  example?: unknown;
}

export interface AsyncOutlineChannel {
  id: string;
  address: string;
  description?: string;
  /** What the application does: `send` (others read it) or `receive` (others send it). */
  actions: Array<'send' | 'receive'>;
  servers: string[];
  messages: AsyncOutlineMessage[];
}

export interface AsyncApiOutline {
  title: string;
  version?: string;
  description?: string;
  asyncapi: string;
  servers: Array<{ name: string; url: string; protocol: string }>;
  channels: AsyncOutlineChannel[];
}

function message(doc: Json, m0: unknown, i: number): AsyncOutlineMessage {
  const m = (deref(doc, m0) ?? {}) as Json;
  const p = m.payload && typeof m.payload === 'object' && 'schemaFormat' in m.payload && 'schema' in m.payload ? m.payload.schema : m.payload;
  const ex = Array.isArray(m.examples) ? (m.examples[0] as Json | undefined)?.payload : undefined;
  return {
    name: String(m.name ?? m.title ?? m.messageId ?? `Message ${i + 1}`),
    summary: m.summary ?? m.description,
    contentType: m.contentType,
    payload: p ? schemaOutline(doc, p) : undefined,
    example: ex,
  };
}

export function asyncApiOutline(text: string): AsyncApiOutline {
  let doc: Json;
  try {
    doc = (text.trim().startsWith('{') ? JSON.parse(text) : parseYaml(text)) as Json;
  } catch (e) {
    throw new ApsError('ValidationError', `The AsyncAPI document is not valid YAML or JSON: ${(e as Error).message}`);
  }
  if (!doc || typeof doc.asyncapi !== 'string') throw new ApsError('ValidationError', 'Not an AsyncAPI document (no "asyncapi" version)');
  const v3 = /^3\./.test(doc.asyncapi);
  const servers = Object.entries((doc.servers as Json) ?? {}).map(([name, s0]) => {
    const s = deref(doc, s0) as Json;
    return { name, url: String(v3 ? `${s?.host ?? ''}${s?.pathname ?? ''}` : (s?.url ?? '')), protocol: String(s?.protocol ?? '') };
  });
  const channels: AsyncOutlineChannel[] = [];
  for (const [id, c0] of Object.entries((doc.channels as Json) ?? {})) {
    const c = deref(doc, c0) as Json;
    const serverNames = v3
      ? ((c?.servers as Json[]) ?? [])
          .map((r) =>
            String(r?.$ref ?? '')
              .split('/')
              .pop()!,
          )
          .filter(Boolean)
      : ((c?.servers as string[]) ?? []);
    const ch: AsyncOutlineChannel = { id, address: String(v3 ? (c?.address ?? id) : id), description: c?.description ?? c?.summary, actions: [], servers: serverNames, messages: [] };
    if (v3) ch.messages = Object.values((c?.messages as Json) ?? {}).map((m, i) => message(doc, m, i));
    else
      for (const [kind, op] of [
        ['receive', c?.publish],
        ['send', c?.subscribe],
      ] as const) {
        if (!op) continue;
        // 2.x: publish = others send to the application (it receives), subscribe = the application sends
        ch.actions.push(kind);
        const m = op.message ? deref(doc, op.message) : undefined;
        for (const x of m?.oneOf ?? (m ? [m] : [])) if (!ch.messages.some((y) => y.name === message(doc, x, 0).name)) ch.messages.push(message(doc, x, ch.messages.length));
      }
    channels.push(ch);
  }
  if (v3)
    for (const op0 of Object.values((doc.operations as Json) ?? {})) {
      const op = deref(doc, op0) as Json;
      const ch = channels.find((c) => op?.channel?.$ref === `#/channels/${c.id}`);
      if (ch && (op.action === 'send' || op.action === 'receive') && !ch.actions.includes(op.action)) ch.actions.push(op.action);
    }
  return {
    title: String(doc.info?.title ?? 'AsyncAPI'),
    version: doc.info?.version !== undefined ? String(doc.info.version) : undefined,
    description: doc.info?.description,
    asyncapi: doc.asyncapi,
    servers,
    channels,
  };
}
