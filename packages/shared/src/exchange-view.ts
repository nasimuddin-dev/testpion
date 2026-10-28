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
const no = (view: ExchangeViewName, side: 'request' | 'response', error: string): ExchangeViewResult => ({ view, side, ok: false, error });

export function exchangeView(e: ViewExchange, view: ExchangeViewName, side: 'request' | 'response' = 'response'): ExchangeViewResult {
  const s = sideOf(e, side);
  const kept = s.text !== undefined || s.bytes !== undefined;
  const need = (what: string) => no(view, side, `The ${side} body was not kept (${what}). Capture it again, or open a HAR that has it.`);
  try {
    switch (view) {
      case 'list': {
        const gql = graphqlOf({ method: e.method, url: e.url, requestContentType: e.requestContentType ?? headerOf(e.requestHeaders, 'content-type'), requestBody: e.requestBody, responseBody: e.responseBody });
        const views = bodyViewsOf({ contentType: s.ct, url: e.url, text: s.text, bytes: s.bytes, graphql: !!gql });
        return { view, side, ok: true, data: { views, contentType: s.ct, kept }, text: views.length ? `Views for the ${side}: ${views.join(', ')}` : `No special view for the ${side} (${s.ct ?? 'no content type'}): use the plain body.` };
      }
      case 'caching': {
        const r = cachingOf(e);
        return { view, side: 'response', ok: true, data: r, text: [r.summary, ...r.notes, r.validators.length ? `Validators: ${r.validators.map((v) => `${v.header}: ${v.value}`).join('; ')}` : ''].filter(Boolean).join('\n') };
      }
      case 'tls': {
        if (!e.connection) return no(view, 'response', 'No TLS details were recorded for this exchange (plain HTTP, a tunnel that was not decrypted, or captured before this was recorded).');
        const f = tlsFindings(e.connection, e.host ?? '');
        return { view, side: 'response', ok: true, data: { ...e.connection, findings: f }, text: [`${e.connection.version ?? '?'} ${e.connection.cipher ?? ''}${e.connection.alpn ? ` (${e.connection.alpn})` : ''}`, ...f.map((x) => `${x.level}: ${x.text}`)].join('\n') };
      }
      case 'graphql': {
        const g = graphqlOf({ method: e.method, url: e.url, requestContentType: e.requestContentType ?? headerOf(e.requestHeaders, 'content-type'), requestBody: e.requestBody, responseBody: e.responseBody });
        if (!g) return no(view, 'request', 'This is not a GraphQL call: its request has no "query".');
        const text = [
          g.label,
          ...g.operations.map((o) => `${o.query}${o.variables !== undefined ? `\nvariables: ${json(o.variables)}` : ''}`),
          ...(g.errors.length ? ['errors:', ...g.errors.map((x) => `- ${x.message}${x.path ? ` (at ${x.path})` : ''}${x.code ? ` [${x.code}]` : ''}`)] : []),
        ].join('\n');
        return { view, side: 'request', ok: true, data: g, text };
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
          return { view, side, ok: true, data: f, text: `${f.format}${f.width ? ` ${f.width}x${f.height}` : ''}, ${f.bytes} bytes${f.note ? `, ${f.note}` : ''}` };
        }
        if (s.text && /<svg[\s>]/i.test(s.text)) {
          const f = svgFacts(s.text, s.total ?? s.text.length);
          return { view, side, ok: true, data: f, text: `svg${f.width ? ` ${f.width}x${f.height}` : ''}, ${f.bytes} bytes${f.note ? `, ${f.note}` : ''}` };
        }
        return no(view, side, 'The body is not an image.');
      }
      case 'xml': {
        if (!s.text) return no(view, side, 'The body is not text.');
        const r = parseXml(s.text);
        if (!r.root) return no(view, side, r.error ?? 'Not XML.');
        return { view, side, ok: true, data: { elements: r.elements, truncated: r.truncated, error: r.error, root: r.root }, text: `${xmlOutline(r.root)}${r.error ? `\n(${r.error})` : ''}` };
      }
      case 'form': {
        if (!s.text) return no(view, side, 'The body is not text.');
        const r = parseForm(s.ct, s.text);
        if (!r) return no(view, side, 'The body is not a form: its type is not application/x-www-form-urlencoded or multipart/*.');
        return { view, side, ok: true, data: r, text: r.parts.map((p) => `${p.name}${p.filename ? ` (file ${p.filename}${p.contentType ? `, ${p.contentType}` : ''}, ${p.size} bytes)` : ''}${p.value !== undefined ? ` = ${p.value}` : ''}`).join('\n') };
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
          return { view, side, ok: true, data: { messages: m }, text: m.map((x) => `${x.kind}${x.name ? ` ${x.name}` : ''}${x.data !== undefined ? ` ${JSON.stringify(x.data)}` : ''}`).join('\n') };
        }
        const bytes = bytesForDecoding(s);
        if (!bytes) return no(view, side, 'There is no body to decode.');
        if (bytes.length > MAX_DECODE_BYTES) return no(view, side, `The body is over ${MAX_DECODE_BYTES / 1024} KB: it is not decoded.`);
        if (view === 'msgpack') {
          const r = decodeMessagePack(bytes);
          return { view, side, ok: true, data: { value: r.value, trailingBytes: r.trailing }, text: json(r.value) + (r.trailing ? `\n(${r.trailing} bytes follow the value)` : '') };
        }
        const fields = decodeProtobufRaw(bytes);
        return { view, side, ok: true, data: { fields, json: protobufToJson(fields) }, text: protobufText(fields) };
      }
      default:
        return no(view, side, `Unknown view ${String(view)}`);
    }
  } catch (err) {
    return no(view, side, `Could not decode the ${side} body as ${view}: ${(err as Error).message}`);
  }
}
