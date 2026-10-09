import { parseYaml } from '../util/lazy-yaml.js';
import { registerCheck, type CheckContext } from '../eval/checks.js';
import type { CheckConfig, CheckResult } from '../model/types.js';
import { schemaProblems, type OpenApiDoc } from '../openapi/contract.js';
import { deref } from '../util/json-ref.js';
import { escapeRegex } from '../util/redact.js';

/**
 * Contract testing for realtime tests: every message a WebSocket, Socket.IO, MQTT or Kafka test received must be one of
 * the messages its channel declares in an AsyncAPI 2 / 3 document (the `asyncapi` check). The channel is the message's
 * topic (MQTT, Kafka) or event (Socket.IO), matched against the channels' addresses with their {parameters}, or the
 * check's `channel` (WebSocket, where the channel is the URL path).
 */
type Json = Record<string, any>;

export interface AsyncApiChannel {
  id: string;
  address: string;
  /** The payload schemas of the messages the channel carries. */
  payloads: Array<{ name: string; schema: unknown }>;
  match: RegExp;
}

/** The channels of an AsyncAPI document with their messages' payload schemas. */
export function asyncApiChannels(doc: Json): AsyncApiChannel[] {
  const v3 = /^3\./.test(String(doc.asyncapi));
  const payloadOf = (m0: unknown, i: number) => {
    const m = deref(doc, m0) as Json;
    // AsyncAPI 3 may wrap a schema with its format: { schemaFormat, schema }
    const p = m?.payload && typeof m.payload === 'object' && 'schemaFormat' in m.payload && 'schema' in m.payload ? m.payload.schema : m?.payload;
    return { name: String(m?.name ?? m?.title ?? m?.messageId ?? `message ${i + 1}`), schema: p };
  };
  const out: AsyncApiChannel[] = [];
  for (const [id, c0] of Object.entries((doc.channels as Json) ?? {})) {
    const c = deref(doc, c0) as Json;
    const address = String(v3 ? (c?.address ?? id) : id);
    let messages: unknown[] = [];
    if (v3) messages = Object.values((c?.messages as Json) ?? {});
    else
      for (const op of [c?.publish, c?.subscribe]) {
        const m = op?.message ? deref(doc, op.message) : undefined;
        if (m) messages.push(...(m.oneOf ?? [m]));
      }
    const pattern = address
      .split(/(\{[^}]+\})/)
      .map((part) => (/^\{[^}]+\}$/.test(part) ? '[^/]+' : escapeRegex(part)))
      .join('');
    out.push({ id, address, payloads: messages.map(payloadOf).filter((p) => p.schema !== undefined), match: new RegExp(`^/?${pattern.replace(/^\\?\//, '')}$`) });
  }
  return out;
}

export interface AsyncApiMessageCheck {
  passed: boolean;
  problems: string[];
  checked: number;
}

/** Check received messages ({ topic | event, data } or plain data with `channel`) against the document. */
export function checkAsyncApiMessages(doc: Json, received: unknown[], opts: { channel?: string; allowUnknownChannels?: boolean } = {}): AsyncApiMessageCheck {
  const channels = asyncApiChannels(doc);
  const problems: string[] = [];
  let checked = 0;
  received.forEach((r0, i) => {
    const r = r0 as Json;
    const wrapped = r && typeof r === 'object' && 'data' in r && ('topic' in r || 'event' in r);
    const where = opts.channel ?? (wrapped ? String(r.topic ?? r.event ?? '') : '');
    const data = wrapped ? r.data : r0;
    const ch = channels.find((c) => c.id === where || c.address === where) ?? channels.find((c) => c.match.test(where));
    if (!ch) {
      if (!opts.allowUnknownChannels) problems.push(`message ${i + 1}${where ? ` on ${where}` : ''}: no channel of the document ${where ? 'matches it' : 'given (set channel in the check)'}`);
      return;
    }
    checked++;
    if (!ch.payloads.length) return;
    const errs: string[] = [];
    for (const p of ch.payloads) {
      let e: string[];
      try {
        e = schemaProblems(doc as OpenApiDoc, p.schema, data);
      } catch (x) {
        e = [`the schema of ${p.name} cannot be used: ${(x as Error).message}`];
      }
      if (!e.length) return;
      errs.push(ch.payloads.length > 1 ? `${p.name}: ${e[0]}` : e.join('; '));
    }
    problems.push(`message ${i + 1} on ${ch.address}: ${errs.join(' | ')}`);
  });
  return { passed: !problems.length, problems, checked };
}

registerCheck('asyncapi', (cfg: CheckConfig, ctx: CheckContext): CheckResult => {
  const res = (passed: boolean, message: string, extra: Partial<CheckResult> = {}): CheckResult => ({
    type: cfg.type,
    name: cfg.name ?? 'AsyncAPI contract',
    passed,
    source: 'deterministic',
    message,
    ...extra,
  });
  if (ctx.testType !== 'websocket') return res(false, 'The asyncapi check applies to WebSocket, Socket.IO, MQTT and Kafka tests');
  let doc: Json;
  try {
    if (cfg.spec && typeof cfg.spec === 'object') doc = cfg.spec as Json;
    else if (typeof cfg.spec === 'string' && cfg.spec.trim()) {
      if (!ctx.readFile) return res(false, 'AsyncAPI files can only be read inside a workspace; put the document inline in "spec"');
      const text = ctx.readFile(cfg.spec);
      doc = (text.trim().startsWith('{') ? JSON.parse(text) : parseYaml(text)) as Json;
    } else return res(false, 'Set "spec" to the AsyncAPI document (a workspace file such as specs/events.asyncapi.yaml)');
  } catch (e) {
    return res(false, `Could not load the AsyncAPI document: ${(e as Error).message}`);
  }
  if (!doc || typeof doc.asyncapi !== 'string') return res(false, 'Not an AsyncAPI document (no "asyncapi" version)');
  const received = ((ctx.body as { received?: unknown[] } | undefined)?.received ?? []) as unknown[];
  if (!received.length) return res(false, 'No message was received to check');
  const r = checkAsyncApiMessages(doc, received, { channel: typeof cfg.channel === 'string' ? cfg.channel : undefined, allowUnknownChannels: cfg.allowUnknownChannels === true });
  return res(
    r.passed,
    r.passed
      ? `${received.length === 1 ? '1 message matches' : `${received.length} messages match`} the document`
      : `${r.problems.length} of ${received.length} messages don't match: ${r.problems[0]}`,
    { metadata: { problems: r.problems.slice(0, 50) } },
  );
});
