/**
 * One entry point for "show this exchange's body as ...": the CLI (`testpion debug show <har> <id> --view xml --json`) and the
 * MCP `debugger_exchange` tool (`view`) both call `exchangeView`, so an agent reads what the Debugger window shows.
 * Pure; a decoder that cannot read the body says so in `error` and never throws.
 */
import { MAX_DECODE_BYTES, bytesFromBase64, decodeMessagePack, decodeProtobufRaw, decodeSignalR, decodeSocketIo, protobufText, protobufToJson, type Bytes } from './binary-decode.js';
import { bodyViewsOf, bytesOfBase64, imageFacts, parseForm, parseXml, svgFacts, syntaxLanguageOf, xmlOutline } from './body-views.js';
import { cachingOf } from './caching.js';
import { headerOf } from './debugger-inspect.js';
import { tlsFindings, type TlsInfo } from './connection-info.js';
import { graphqlOf } from './graphql-view.js';

export interface ViewExchange {
  method?: string;
  url: string;
  host?: string;
  status?: number;
  contentType?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestContentType?: string;
  requestBody?: string;
  responseBody?: string;
  /** Bodies kept as bytes (images and binary protocols), as base64. */
  requestBodyBase64?: string;
  responseBodyBase64?: string;
  requestBodyBytes?: number;
  responseBodyBytes?: number;
  connection?: TlsInfo;
}

export const EXCHANGE_VIEWS = ['list', 'image', 'xml', 'form', 'graphql', 'msgpack', 'protobuf', 'signalr', 'socketio', 'syntax', 'caching', 'tls'] as const;
export type ExchangeViewName = (typeof EXCHANGE_VIEWS)[number];

export interface ExchangeViewResult {
  view: ExchangeViewName;
  side: 'request' | 'response';
  /** The view could be produced for this body. */
  ok: boolean;
  /** Why not, in a sentence that says what to do. */
  error?: string;
  /** The view as data. */
  data?: unknown;
  /** The view as text a person or a model reads. */
  text?: string;
}

/** The bytes and text of one side. */
function sideOf(e: ViewExchange, side: 'request' | 'response') {
  const text = side === 'request' ? e.requestBody : e.responseBody;
  const b64 = side === 'request' ? e.requestBodyBase64 : e.responseBodyBase64;
  const ct = side === 'request' ? (e.requestContentType ?? headerOf(e.requestHeaders, 'content-type')) : (e.contentType ?? headerOf(e.responseHeaders, 'content-type'));
  const bytes = bytesOfBase64(b64);
  const total = side === 'request' ? e.requestBodyBytes : e.responseBodyBytes;
  return { text, bytes, ct, total };
}

/** The bytes of a body: kept bytes, else base64 or hex text, else the text as UTF-8 (a decoder asked for a text body). */
function bytesForDecoding(s: ReturnType<typeof sideOf>): Bytes | undefined {
  if (s.bytes) return s.bytes;
  if (!s.text) return undefined;
  const t = s.text.trim();
  if (/^[0-9a-fA-F\s]+$/.test(t) && t.replace(/\s/g, '').length % 2 === 0 && t.length > 1) {
    const h = t.replace(/\s/g, '');
    return Uint8Array.from({ length: h.length / 2 }, (_, i) => parseInt(h.slice(i * 2, i * 2 + 2), 16));
  }
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(t) && t.length >= 4) {
    try {
      return bytesFromBase64(t);
    } catch {
      /* not base64 */
    }
  }
  return new TextEncoder().encode(s.text);
}

const json = (v: unknown) => JSON.stringify(v, null, 2);
/** How the text of a result is drawn from its data, so masked data can be drawn again. */
const renderers = new WeakMap<object, (d: any) => string>(); // bounded: keys are results, collected with them
const made = (view: ExchangeViewName, side: 'request' | 'response', data: unknown, render: (d: any) => string): ExchangeViewResult => {
  const r: ExchangeViewResult = { view, side, ok: true, data, text: render(data) };
  renderers.set(r, render);
  return r;
};
const no = (view: ExchangeViewName, side: 'request' | 'response', error: string): ExchangeViewResult => ({ view, side, ok: false, error });

/** What masks secrets: the redactor of the host (core's `Redactor` fits). */
export interface ViewMask {
  redact(v: unknown): unknown;
  redactString(s: string): string;
}

/**
 * The body of one side read as `view`. With a `mask`, what a decoder read out (a token inside a MessagePack map, a variable of a
 * GraphQL call) is masked on the data and the text is drawn again from the masked data, so a key-based mask holds in the text too.
 */
export function exchangeView(e: ViewExchange, view: ExchangeViewName, side: 'request' | 'response' = 'response', mask?: ViewMask): ExchangeViewResult {
  const r = exchangeViewRaw(e, view, side);
  if (!mask || !r.ok || r.view === 'image') return r;
  const data = r.data === undefined ? undefined : mask.redact(r.data);
  const render = renderers.get(r);
  const text = render && data !== undefined ? render(data) : r.text;
  return { ...r, data, ...(text !== undefined ? { text: mask.redactString(text) } : {}) };
}

function exchangeViewRaw(e: ViewExchange, view: ExchangeViewName, side: 'request' | 'response'): ExchangeViewResult {
  const s = sideOf(e, side);
  const kept = s.text !== undefined || s.bytes !== undefined;
  const need = (what: string) => no(view, side, `The ${side} body was not kept (${what}). Capture it again, or open a HAR that has it.`);
  try {
    switch (view) {
      case 'list': {
        const gql = graphqlOf({ method: e.method, url: e.url, requestContentType: e.requestContentType ?? headerOf(e.requestHeaders, 'content-type'), requestBody: e.requestBody, responseBody: e.responseBody });
        const views = bodyViewsOf({ contentType: s.ct, url: e.url, text: s.text, bytes: s.bytes, graphql: !!gql });
        return made(view, side, { views, contentType: s.ct, kept }, (d) => (d.views.length ? `Views for the ${side}: ${d.views.join(', ')}` : `No special view for the ${side} (${s.ct ?? 'no content type'}): use the plain body.`));
      }
      case 'caching': {
        const r = cachingOf(e);
        return made(view, 'response', r, (d) => [d.summary, ...d.notes, d.validators.length ? `Validators: ${d.validators.map((v: { header: string; value: string }) => `${v.header}: ${v.value}`).join('; ')}` : ''].filter(Boolean).join('\n'));
      }
      case 'tls': {
        if (!e.connection) return no(view, 'response', 'No TLS details were recorded for this exchange (plain HTTP, a tunnel that was not decrypted, or captured before this was recorded).');
        const f = tlsFindings(e.connection, e.host ?? '');
        return made(view, 'response', { ...e.connection, findings: f }, (d) => [`${d.version ?? '?'} ${d.cipher ?? ''}${d.alpn ? ` (${d.alpn})` : ''}`, ...d.findings.map((x: { level: string; text: string }) => `${x.level}: ${x.text}`)].join('\n'));
      }
      case 'graphql': {
        const g = graphqlOf({ method: e.method, url: e.url, requestContentType: e.requestContentType ?? headerOf(e.requestHeaders, 'content-type'), requestBody: e.requestBody, responseBody: e.responseBody });
        if (!g) return no(view, 'request', 'This is not a GraphQL call: its request has no "query".');
        return made(view, 'request', g, (d: typeof g) =>
          [
            d.label,
            ...d.operations.map((o) => `${o.query}${o.variables !== undefined ? `\nvariables: ${json(o.variables)}` : ''}`),
            ...(d.errors.length ? ['errors:', ...d.errors.map((x) => `- ${x.message}${x.path ? ` (at ${x.path})` : ''}${x.code ? ` [${x.code}]` : ''}`)] : []),
          ].join('\n'),
        );
      }
      default:
        break;
    }
    if (!kept) return need(s.total ? `${s.total} bytes went by but are not held` : 'empty or let go to keep memory in budget');
    switch (view) {
      case 'image': {
        if (s.bytes) {
          const f = imageFacts(s.bytes, s.total ?? s.bytes.length);
          if (!f) return no(view, side, 'The bytes are not a PNG, JPEG, GIF, WebP, BMP or ICO image.');
          return made(view, side, f, (d) => `${d.format}${d.width ? ` ${d.width}x${d.height}` : ''}, ${d.bytes} bytes${d.note ? `, ${d.note}` : ''}`);
        }
        if (s.text && /<svg[\s>]/i.test(s.text)) {
          const f = svgFacts(s.text, s.total ?? s.text.length);
          return made(view, side, f, (d) => `svg${d.width ? ` ${d.width}x${d.height}` : ''}, ${d.bytes} bytes${d.note ? `, ${d.note}` : ''}`);
        }
        return no(view, side, 'The body is not an image.');
      }
      case 'xml': {
        if (!s.text) return no(view, side, 'The body is not text.');
        const r = parseXml(s.text);
        if (!r.root) return no(view, side, r.error ?? 'Not XML.');
        return made(view, side, { elements: r.elements, truncated: r.truncated, error: r.error, root: r.root }, (d) => `${xmlOutline(d.root)}${d.error ? `\n(${d.error})` : ''}`);
      }
      case 'form': {
        if (!s.text) return no(view, side, 'The body is not text.');
        const r = parseForm(s.ct, s.text);
        if (!r) return no(view, side, 'The body is not a form: its type is not application/x-www-form-urlencoded or multipart/*.');
        return made(view, side, r, (d: typeof r) => d.parts.map((p) => `${p.name}${p.filename ? ` (file ${p.filename}${p.contentType ? `, ${p.contentType}` : ''}, ${p.size} bytes)` : ''}${p.value !== undefined ? ` = ${p.value}` : ''}`).join('\n'));
      }
      case 'syntax': {
        if (!s.text) return no(view, side, 'The body is not text.');
        return { view, side, ok: true, data: { language: syntaxLanguageOf(s.ct, e.url) ?? 'plain' }, text: s.text };
      }
      case 'msgpack':
      case 'protobuf':
      case 'signalr':
      case 'socketio': {
        if (view === 'signalr' || view === 'socketio') {
          if (!s.text) return no(view, side, 'The body is not text.');
          const m = view === 'signalr' ? decodeSignalR(s.text) : decodeSocketIo(s.text);
          if (!m) return no(view, side, `The body is not ${view === 'signalr' ? 'SignalR JSON (messages end with the 0x1e separator)' : 'Socket.IO / Engine.IO text packets'}.`);
          return made(view, side, { messages: m }, (d) => d.messages.map((x: { kind: string; name?: string; data?: unknown }) => `${x.kind}${x.name ? ` ${x.name}` : ''}${x.data !== undefined ? ` ${JSON.stringify(x.data)}` : ''}`).join('\n'));
        }
        const bytes = bytesForDecoding(s);
        if (!bytes) return no(view, side, 'There is no body to decode.');
        if (bytes.length > MAX_DECODE_BYTES) return no(view, side, `The body is over ${MAX_DECODE_BYTES / 1024} KB: it is not decoded.`);
        if (view === 'msgpack') {
          const r = decodeMessagePack(bytes);
          // a lone number, string or flag followed by more data is how plain text reads as MessagePack: not MessagePack
          if (r.trailing > 0 && (r.value === null || typeof r.value !== 'object')) return no(view, side, 'This does not look like MessagePack: the first value is followed by data that is not part of it.');
          return made(view, side, { value: r.value, trailingBytes: r.trailing }, (d) => json(d.value) + (d.trailingBytes ? `\n(${d.trailingBytes} bytes follow the value)` : ''));
        }
        const fields = decodeProtobufRaw(bytes);
        return made(view, side, { fields, json: protobufToJson(fields) }, (d) => protobufText(d.fields));
      }
      default:
        return no(view, side, `Unknown view ${String(view)}`);
    }
  } catch (err) {
    return no(view, side, `Could not decode the ${side} body as ${view}: ${(err as Error).message}`);
  }
}
