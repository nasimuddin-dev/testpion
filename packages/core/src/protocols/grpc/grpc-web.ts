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

export async function executeGrpcWebCall(c: GrpcWebCall) {
  const t0 = performance.now();
  const ms = () => Math.round((performance.now() - t0) * 100) / 100;
  if (c.method.requestStream) throw new ApsError('ValidationError', 'gRPC-Web has no client streaming: call this method over gRPC (turn gRPC-Web off)');
  const reqType = c.method.resolvedRequestType!;
  const resType = c.method.resolvedResponseType!;
  const problem = reqType.verify(c.message as Record<string, unknown>);
  if (problem) throw new ApsError('ValidationError', `The request message: ${problem}`);
  const body = grpcWebFrame(0, reqType.encode(reqType.fromObject(c.message as Record<string, unknown>)).finish());
  const url = `${c.baseUrl.replace(/\/+$/, '')}/${c.service}/${c.method.name}`;
  const timeout = AbortSignal.timeout(c.timeoutMs);
  const signal = c.signal ? AbortSignal.any([c.signal, timeout]) : timeout;
  let res: Response;
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
    });
  } catch (e) {
    if (timeout.aborted) throw new ApsError('TimeoutError', `DEADLINE_EXCEEDED: no answer in ${c.timeoutMs} ms`, { suggestions: ['Raise the deadline or check the server.'] });
    if (c.signal?.aborted) return { code: 1, codeName: 'CANCELLED', details: 'Stopped by the user', metadata: [], trailers: [], durationMs: ms(), streamStopped: true };
    throw new ApsError('NetworkError', `UNAVAILABLE: ${(e as Error).message}`, {
      suggestions: ['Check the address, and whether the server speaks gRPC-Web (Envoy, a grpc-web proxy) over http or https.'],
    });
  }
  const headers: Array<[string, string]> = [...res.headers.entries()].filter(([k]) => !/^(content-type|content-length|date|server|connection|transfer-encoding|access-control-)/i.test(k));
  const status = (pairs: Array<[string, string]>) => pairs.find(([k]) => k === 'grpc-status')?.[1];
  const raw = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get('content-type') ?? '';
  // not gRPC-Web: an HTTP error page, a proxy that does not speak it
  if (!type.startsWith('application/grpc-web') && status(headers) === undefined)
    throw new ApsError('ProtocolError', `The server answered HTTP ${res.status} ${type ? `(${type})` : ''} instead of gRPC-Web`, {
      suggestions: ['Check that the address is the gRPC-Web endpoint (an Envoy grpc_web filter, a grpc-web proxy), or turn gRPC-Web off to call it over gRPC.'],
    });
  const messages: Array<{ data: unknown; atMs: number }> = [];
  let trailers: Array<[string, string]> = [];
  for (const f of raw.length ? grpcWebFrames(raw) : []) {
    if (f.trailer) trailers = lines(f.bytes.toString('utf8'));
    else {
      const data = toJson(resType, resType.decode(f.bytes));
      const at = ms();
      messages.push({ data, atMs: at });
      c.onMessage?.(data, at);
    }
  }
  // trailers-only: the status in the HTTP headers
  const code = Number(status(trailers) ?? status(headers) ?? (res.ok ? 0 : 2));
  const details = decodeURIComponent(trailers.find(([k]) => k === 'grpc-message')?.[1] ?? headers.find(([k]) => k === 'grpc-message')?.[1] ?? '');
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
