/**
 * gRPC-Web: the same service and messages as gRPC, over HTTP/1.1 (or HTTP/2 through a proxy) as a browser calls it,
 * through Envoy, a grpc-web proxy or a server that speaks it (ASP.NET Core, Connect). A call is one POST of
 * `application/grpc-web+proto`: the request message in a frame (a flag byte, a 4-byte length, the bytes), and the
 * response is frames too: messages (flag 0) and, last, the trailers as HTTP header lines (flag 0x80). A server may
 * also answer with the status in the HTTP headers only (a "trailers-only" answer). Unary and server-streaming methods:
 * a client stream is not part of gRPC-Web.
 */
import type * as protobuf from 'protobufjs';
import { ApsError } from '../../errors.js';
import { netFetch } from '../../net/proxy.js';
import type { Redactor } from '../../util/redact.js';

/** The gRPC status names (OK, CANCELLED …), as the gRPC client says them. */
const STATUS = [
  'OK',
  'CANCELLED',
  'UNKNOWN',
  'INVALID_ARGUMENT',
  'DEADLINE_EXCEEDED',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'PERMISSION_DENIED',
  'RESOURCE_EXHAUSTED',
  'FAILED_PRECONDITION',
  'ABORTED',
  'OUT_OF_RANGE',
  'UNIMPLEMENTED',
  'INTERNAL',
  'UNAVAILABLE',
  'DATA_LOSS',
  'UNAUTHENTICATED',
];

/** What a call needs: the method (its types resolved), where, the message, metadata and the deadline. */
export interface GrpcWebCall {
  method: protobuf.Method;
  service: string;
  /** `http(s)://host:port` (a path prefix is kept: `https://api.example.com/grpc`). */
  baseUrl: string;
  message: unknown;
  metadata: Array<[string, string]>;
  timeoutMs: number;
  signal?: AbortSignal;
  redactor?: Redactor;
  onMessage?(data: unknown, atMs: number): void;
  /** A dispatcher for the call's own TLS settings (a private CA, a client certificate). */
  dispatcher?: unknown;
}

/** A message as JSON: the same options the gRPC client reads with (longs and enums as strings, defaults, oneofs). */
const toJson = (type: protobuf.Type, m: protobuf.Message) => type.toObject(m, { longs: String, enums: String, defaults: true, oneofs: true });

/** One frame: the flag byte, the length (4 bytes, big-endian) and the bytes. */
export function grpcWebFrame(flag: number, bytes: Uint8Array): Buffer {
  const out = Buffer.alloc(5 + bytes.length);
  out[0] = flag;
  out.writeUInt32BE(bytes.length, 1);
  out.set(bytes, 5);
  return out;
}

/** The frames of a response body: messages (flag bit 0x80 off) and trailers (on). A frame cut short is an error. */
export function grpcWebFrames(body: Buffer): Array<{ trailer: boolean; bytes: Buffer }> {
  const out: Array<{ trailer: boolean; bytes: Buffer }> = [];
  for (let i = 0; i < body.length;) {
    if (body.length - i < 5) throw new ApsError('ProtocolError', 'The gRPC-Web answer ends in the middle of a frame header');
    const len = body.readUInt32BE(i + 1);
    if (body.length - i - 5 < len) throw new ApsError('ProtocolError', 'The gRPC-Web answer ends in the middle of a message');
    if (body[i]! & 0x01) throw new ApsError('ProtocolError', 'The gRPC-Web answer is compressed, which is not supported: ask the server for an uncompressed answer');
    out.push({ trailer: (body[i]! & 0x80) !== 0, bytes: body.subarray(i + 5, i + 5 + len) });
    i += 5 + len;
  }
  return out;
}

/** Header lines (`grpc-status: 0\r\ngrpc-message: …`) as pairs, names in lower case. */
const lines = (text: string): Array<[string, string]> =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const at = l.indexOf(':');
      return [l.slice(0, at).trim().toLowerCase(), l.slice(at + 1).trim()] as [string, string];
    });

/** The most a call's answer may hold (a stream that never ends is stopped here, keeping what came). */
const MAX_ANSWER_BYTES = 64 * 1024 * 1024;

/** A grpc-message as sent (percent-encoded); a malformed one is shown as it came. */
const decodeMessage = (v: string) => {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
};

export async function executeGrpcWebCall(c: GrpcWebCall) {
  const t0 = performance.now();
  const ms = () => Math.round((performance.now() - t0) * 100) / 100;
  if (c.method.requestStream) throw new ApsError('ValidationError', 'gRPC-Web has no client streaming: call this method over gRPC (turn gRPC-Web off)');
  const reqType = c.method.resolvedRequestType!;
  const resType = c.method.resolvedResponseType!;
  const problem = reqType.verify(c.message as Record<string, unknown>);
  if (problem) throw new ApsError('ValidationError', `The request message: ${problem}`);
  // metadata becomes HTTP headers: a name or a value a header cannot carry is said here, not as a network error
  for (const [k, v] of c.metadata)
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(k) || /[\r\n\0]/.test(v))
      throw new ApsError('ValidationError', `The metadata "${k}" cannot be sent as an HTTP header (gRPC-Web): use letters, digits and - in names, no line breaks in values`);
  const body = grpcWebFrame(0, reqType.encode(reqType.fromObject(c.message as Record<string, unknown>)).finish());
  const url = `${c.baseUrl.replace(/\/+$/, '')}/${c.service}/${c.method.name}`;
  const timeout = AbortSignal.timeout(c.timeoutMs);
  const signal = c.signal ? AbortSignal.any([c.signal, timeout]) : timeout;
  const messages: Array<{ data: unknown; atMs: number }> = [];
  let trailers: Array<[string, string]> = [];
  let res: Response | undefined;
  /** What came, when the call stops early (the user's Stop, the deadline): the messages so far. */
  const stoppedEarly = () => {
    if (timeout.aborted && !c.signal?.aborted) {
      if (!res) throw new ApsError('TimeoutError', `DEADLINE_EXCEEDED: no answer in ${c.timeoutMs} ms`, { suggestions: ['Raise the deadline or check the server.'] });
      return {
        code: 4,
        codeName: 'DEADLINE_EXCEEDED',
        details: `The deadline (${c.timeoutMs} ms) passed`,
        ...(c.method.responseStream ? { messages } : {}),
        metadata: [],
        trailers: [],
        durationMs: ms(),
      };
    }
    return { code: 1, codeName: 'CANCELLED', details: 'Stopped by the user', ...(c.method.responseStream ? { messages } : {}), metadata: [], trailers: [], durationMs: ms(), streamStopped: true };
  };
  try {
    res = await netFetch(url, {
      method: 'POST',
      headers: [
        ['content-type', 'application/grpc-web+proto'],
        ['accept', 'application/grpc-web+proto'],
        ['x-grpc-web', '1'],
        ['x-user-agent', 'grpc-web-testpion/1'],
        ...c.metadata.filter(([k]) => k),
      ],
      body,
      signal,
      // a redirect would send the call and its metadata elsewhere: it is said, not followed
      redirect: 'manual',
      ...(c.dispatcher ? { dispatcher: c.dispatcher } : {}),
    } as RequestInit);
  } catch (e) {
    if (signal.aborted) return stoppedEarly();
    throw new ApsError('NetworkError', `UNAVAILABLE: ${(e as Error).message}`, {
      suggestions: ['Check the address, and whether the server speaks gRPC-Web (Envoy, a grpc-web proxy) over http or https.'],
    });
  }
  const headers: Array<[string, string]> = [...res.headers.entries()].filter(([k]) => !/^(content-type|content-length|date|server|connection|keep-alive|transfer-encoding|access-control-)/i.test(k));
  const status = (pairs: Array<[string, string]>) => pairs.find(([k]) => k === 'grpc-status')?.[1];
  const type = res.headers.get('content-type') ?? '';
  // not gRPC-Web: an HTTP error page, a redirect, a proxy that does not speak it
  if (!type.startsWith('application/grpc-web') && status(headers) === undefined) {
    void res.body?.cancel().catch(() => undefined);
    throw new ApsError('ProtocolError', `The server answered HTTP ${res.status} ${type ? `(${type})` : ''} instead of gRPC-Web`, {
      suggestions: ['Check that the address is the gRPC-Web endpoint (an Envoy grpc_web filter, a grpc-web proxy), or turn gRPC-Web off to call it over gRPC.'],
    });
  }
  // the frames as they arrive: a stream's messages show one by one, and a Stop keeps what came
  let pending = Buffer.alloc(0);
  let total = 0;
  const take = () => {
    while (pending.length >= 5) {
      const len = pending.readUInt32BE(1);
      if (pending.length < 5 + len) break;
      const [f] = grpcWebFrames(pending.subarray(0, 5 + len));
      pending = pending.subarray(5 + len);
      if (f!.trailer) trailers = lines(f!.bytes.toString('utf8'));
      else {
        const data = toJson(resType, resType.decode(f!.bytes));
        const at = ms();
        messages.push({ data, atMs: at });
        c.onMessage?.(data, at);
      }
    }
  };
  try {
    for await (const chunk of (res.body ?? []) as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      if (total > MAX_ANSWER_BYTES) {
        void res.body?.cancel().catch(() => undefined);
        throw new ApsError('ProtocolError', `The gRPC-Web answer is larger than ${MAX_ANSWER_BYTES / 1024 / 1024} MB: stopped`);
      }
      pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
      take();
    }
  } catch (e) {
    if (signal.aborted) return stoppedEarly();
    throw e;
  }
  if (pending.length) grpcWebFrames(pending); // a frame cut short: said
  // trailers-only: the status in the HTTP headers; none at all is not OK (UNKNOWN), as gRPC-Web says
  const code = Number(status(trailers) ?? status(headers) ?? 2);
  const details = decodeMessage(
    trailers.find(([k]) => k === 'grpc-message')?.[1] ?? headers.find(([k]) => k === 'grpc-message')?.[1] ?? ((status(trailers) ?? status(headers)) ? '' : 'The answer carried no grpc-status'),
  );
  const redact = (p: Array<[string, string]>) => (c.redactor ? (c.redactor.redact(p) as Array<[string, string]>) : p);
  return {
    code,
    codeName: STATUS[code] ?? String(code),
    details,
    ...(c.method.responseStream ? { messages } : messages[0] ? { response: messages[0].data } : {}),
    metadata: redact(headers.filter(([k]) => k !== 'grpc-status' && k !== 'grpc-message')),
    trailers: redact(trailers.filter(([k]) => k !== 'grpc-status' && k !== 'grpc-message')),
    durationMs: ms(),
  };
}
