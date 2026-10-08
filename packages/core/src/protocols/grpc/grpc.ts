import * as grpc from '@grpc/grpc-js';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import * as protoLoader from '@grpc/proto-loader';
import protobuf from 'protobufjs';
import { ApsError } from '../../errors.js';
import type { KeyValue } from '../../model/types.js';
import { assertUrlAllowed } from '../../net/policy.js';
import type { Redactor } from '../../util/redact.js';
import { rootFromDescriptorSet } from './reflection.js';

/**
 * gRPC: calls described by .proto files (given as text, so nothing depends on local paths), with
 * unary, server-streaming, client-streaming and bidirectional methods, metadata, TLS and deadlines.
 * Messages are plain JSON objects (64-bit integers and enums as strings, defaults included).
 */

export interface ProtoFile {
  /** Path used by `import` statements, e.g. `vet/v1/pets.proto`. */
  name: string;
  text: string;
}

export interface GrpcMethodInfo {
  /** `package.Service/Method` */
  name: string;
  service: string;
  method: string;
  requestType: string;
  responseType: string;
  clientStreaming: boolean;
  serverStreaming: boolean;
  /** An example request message with every field (for the editor). */
  example: unknown;
  /** JSON Schema of the request message (editor completion and validation; a list for client streaming). */
  requestSchema: Record<string, unknown>;
}

const LOADER_OPTIONS: protoLoader.Options = { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true };

/** Parse .proto files (imports between them and Google's well-known types are resolved). */
export function parseProtos(files: ProtoFile[]): protobuf.Root {
  if (!files.length) throw new ApsError('ValidationError', 'Add a .proto file describing the service');
  const root = new protobuf.Root();
  const byName = new Map(files.map((f) => [normalize(f.name), f]));
  // each file (and well-known type) is parsed once, however it is referred to (`shop/v1/a.proto` or `protos/shop/v1/a.proto`)
  const done = new Set<ProtoFile | string>();
  const load = (name: string, from?: string) => {
    const key = normalize(name);
    const common = (protobuf.common as unknown as Record<string, { nested?: protobuf.INamespace['nested'] }>)[key];
    if (common) {
      if (!done.has(key)) root.addJSON(common.nested ?? {});
      done.add(key);
      return;
    }
    const file = byName.get(key) ?? [...byName.values()].find((f) => normalize(f.name).endsWith(`/${key}`) || key.endsWith(`/${normalize(f.name)}`));
    if (!file) throw new ApsError('ValidationError', `"${from ?? 'A proto file'}" imports "${name}", which was not provided`, { suggestions: ['Add the imported .proto file too (with the same path as in the import statement).'] });
    if (done.has(file)) return;
    done.add(file);
    let parsed: protobuf.IParserResult;
    try {
      parsed = protobuf.parse(file.text, root, { keepCase: true, alternateCommentMode: true });
    } catch (e) {
      throw new ApsError('ValidationError', `${file.name}: ${(e as Error).message}`);
    }
    for (const imp of [...(parsed.imports ?? []), ...(parsed.weakImports ?? [])]) load(imp, file.name);
  };
  for (const f of files) load(f.name);
  try {
    root.resolveAll();
  } catch (e) {
    throw new ApsError('ValidationError', `The proto files don't resolve: ${(e as Error).message}`);
  }
  return root;
}

const normalize = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');

/** Every RPC method in the files, with an example request. */
export function describeProtos(files: ProtoFile[]): GrpcMethodInfo[] {
  return describeRoot(parseProtos(files));
}

/** The service definitions of a call: its proto files, or descriptors from server reflection. */
export function grpcRoot(spec: { protoFiles?: ProtoFile[]; descriptorSet?: string }): protobuf.Root {
  if (spec.descriptorSet) return rootFromDescriptorSet(spec.descriptorSet);
  return parseProtos(spec.protoFiles ?? []);
}

/** Every RPC method of a parsed root, with an example request. */
export function describeRoot(root: protobuf.Root): GrpcMethodInfo[] {
  const out: GrpcMethodInfo[] = [];
  const walk = (ns: protobuf.NamespaceBase) => {
    for (const obj of ns.nestedArray) {
      if (obj instanceof protobuf.Service) {
        const service = obj.fullName.replace(/^\./, '');
        for (const m of obj.methodsArray) {
          m.resolve();
          out.push({
            name: `${service}/${m.name}`,
            service,
            method: m.name,
            requestType: m.resolvedRequestType!.fullName.replace(/^\./, ''),
            responseType: m.resolvedResponseType!.fullName.replace(/^\./, ''),
            clientStreaming: !!m.requestStream,
            serverStreaming: !!m.responseStream,
            example: exampleMessage(m.resolvedRequestType!),
            requestSchema: m.requestStream ? { type: 'array', items: messageSchema(m.resolvedRequestType!) } : messageSchema(m.resolvedRequestType!),
          });
        }
      } else if (obj instanceof protobuf.Namespace) walk(obj);
    }
  };
  walk(root);
  return out;
}

/** A message with every field set to an example value (nested messages to a limited depth). */
function exampleMessage(type: protobuf.Type, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const oneofSeen = new Set<string>();
  for (const f of type.fieldsArray) {
    f.resolve();
    if (f.partOf) {
      if (oneofSeen.has(f.partOf.name)) continue;
      oneofSeen.add(f.partOf.name);
    }
    const v = exampleValue(f, depth);
    out[f.name] = f.map ? {} : f.repeated ? (v === undefined ? [] : [v]) : v;
  }
  return out;
}

/** JSON Schema of a message in the JSON form used here (64-bit integers as strings, enums as names). */
function messageSchema(type: protobuf.Type, depth = 0): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const f of type.fieldsArray) {
    f.resolve();
    const one = fieldSchema(f, depth);
    properties[f.name] = f.map ? { type: 'object', additionalProperties: one } : f.repeated ? { type: 'array', items: one } : one;
    if (f.comment) (properties[f.name] as Record<string, unknown>).description = f.comment;
  }
  return { type: 'object', title: type.name, properties, additionalProperties: false, ...(type.comment ? { description: type.comment } : {}) };
}

function fieldSchema(f: protobuf.Field, depth: number): Record<string, unknown> {
  if (f.resolvedType instanceof protobuf.Enum) return { enum: [...Object.keys(f.resolvedType.values), ...Object.values(f.resolvedType.values)] };
  if (f.resolvedType instanceof protobuf.Type) {
    const t = f.resolvedType.fullName;
    if (t === '.google.protobuf.Timestamp' || t === '.google.protobuf.Duration') return { type: 'object', properties: { seconds: { type: ['string', 'number'] }, nanos: { type: 'integer' } } };
    if (t === '.google.protobuf.Struct' || t === '.google.protobuf.Value' || t === '.google.protobuf.Any') return {};
    return depth >= 4 ? { type: 'object' } : messageSchema(f.resolvedType, depth + 1);
  }
  if (f.type === 'string') return { type: 'string' };
  if (f.type === 'bool') return { type: 'boolean' };
  if (f.type === 'bytes') return { type: 'string', description: 'base64' };
  if (/64/.test(f.type)) return { type: ['string', 'integer'], description: '64-bit integer (a string keeps large values exact)' };
  if (f.type === 'double' || f.type === 'float') return { type: 'number' };
  return { type: 'integer' };
}

function exampleValue(f: protobuf.Field, depth: number): unknown {
  if (f.resolvedType instanceof protobuf.Enum) return Object.keys(f.resolvedType.values)[0];
  if (f.resolvedType instanceof protobuf.Type) {
    const t = f.resolvedType.fullName;
    if (t === '.google.protobuf.Timestamp') return { seconds: String(Math.floor(Date.now() / 1000)), nanos: 0 };
    if (t === '.google.protobuf.Duration') return { seconds: '1', nanos: 0 };
    if (/^\.google\.protobuf\.\w+Value$/.test(t)) return { value: exampleScalar(f.resolvedType.fields.value?.type ?? 'string') };
    return depth >= 3 ? {} : exampleMessage(f.resolvedType, depth + 1);
  }
  return exampleScalar(f.type);
}

function exampleScalar(type: string): unknown {
  if (type === 'string') return '';
  if (type === 'bool') return false;
  if (type === 'bytes') return '';
  if (/^(u?int64|s?fixed64|sint64)$/.test(type)) return '0';
  return 0;
}

export interface GrpcRequestSpec {
  /** `host:port`; `grpcs://host:port` or `https://…` for TLS, `grpc://` or `http://` for plaintext. */
  target: string;
  /** `package.Service/Method` */
  method: string;
  /** The request message as JSON; for client-streaming methods, an array of messages. */
  message?: string;
  metadata?: KeyValue[];
  /** .proto files describing the service (or `descriptorSet`). */
  protoFiles?: ProtoFile[];
  /** FileDescriptorSet (base64) from server reflection, instead of proto files. */
  descriptorSet?: string;
  /** Use TLS (default: from the target's scheme; plain `host:port` is plaintext). */
  tls?: boolean;
  /** Certificates for TLS (PEM text): a custom CA, and a client certificate + key for mutual TLS. Turns TLS on. */
  tlsOptions?: GrpcTlsOptions;
  /** Deadline in ms (default 30 s). */
  timeoutMs?: number;
}

export interface GrpcTlsOptions {
  /** CA certificate(s) the server's certificate must chain to (default: the system's trusted CAs). */
  ca?: string;
  /** Client certificate chain, for servers that require mutual TLS. */
  cert?: string;
  /** Private key of the client certificate. */
  key?: string;
}

/** Channel credentials: plaintext, TLS with the system CAs, or TLS with a custom CA and/or a client certificate. */
export function grpcCredentials(tls: boolean, o?: GrpcTlsOptions, host?: string): grpc.ChannelCredentials {
  if (!tls && !o?.ca && !o?.cert) return grpc.credentials.createInsecure();
  if (!!o?.cert !== !!o?.key) throw new ApsError('ValidationError', 'Mutual TLS needs both the client certificate and its private key');
  const pem = (s?: string) => (s?.trim() ? Buffer.from(s) : null);
  // an IP address can't be the TLS server name (SNI): the certificate is still checked against the IP itself
  const ip = host && isIP(host.replace(/^\[|\]$/g, '')) ? host.replace(/^\[|\]$/g, '') : undefined;
  try {
    return grpc.credentials.createSsl(pem(o?.ca), pem(o?.key), pem(o?.cert), ip ? { checkServerIdentity: (_name, cert) => checkServerIdentity(ip, cert) } : undefined);
  } catch (e) {
    throw new ApsError('ValidationError', `The TLS certificates can't be used: ${(e as Error).message}`, { suggestions: ['Use PEM text (-----BEGIN CERTIFICATE----- …).'] });
  }
}

/** Credentials and channel options for an address (`host:port`). */
export function grpcChannel(address: string, tls: boolean, o?: GrpcTlsOptions): { credentials: grpc.ChannelCredentials; options: grpc.ChannelOptions } {
  const host = address.replace(/:\d+$/, '');
  const credentials = grpcCredentials(tls, o, host);
  const secure = tls || !!o?.ca || !!o?.cert;
  return { credentials, options: secure && isIP(host.replace(/^\[|\]$/g, '')) ? { 'grpc.ssl_target_name_override': 'ip-address.invalid' } : {} };
}

export interface GrpcResponseData {
  /** gRPC status (0 = OK). */
  code: number;
  codeName: string;
  details: string;
  /** Unary / client-streaming response. */
  response?: unknown;
  /** Server-streaming / bidirectional responses, in order. */
  messages?: Array<{ data: unknown; atMs: number }>;
  metadata: Array<[string, string]>;
  trailers: Array<[string, string]>;
  durationMs: number;
  method: string;
  target: string;
  /** The stream was stopped by the user. */
  streamStopped?: boolean;
}

const CODE_NAMES = Object.fromEntries(Object.entries(grpc.status).filter(([, v]) => typeof v === 'number').map(([k, v]) => [v as number, k]));

/** Address and TLS of a target (`host:port`, `grpcs://host:port`, `grpc://…`, `https://…`). */
export function parseGrpcTarget(target: string, tls?: boolean): { address: string; tls: boolean } {
  const t = target.trim();
  const m = /^(grpcs?|https?):\/\/([^/]+)\/?$/i.exec(t);
  if (m) {
    const secure = /^(grpcs|https)$/i.test(m[1]!);
    const address = m[2]!.includes(':') ? m[2]! : `${m[2]}:${secure ? 443 : 80}`;
    return { address, tls: tls ?? secure };
  }
  if (!/^[\w.-]+(:\d+)?$|^\[[0-9a-f:]+\](:\d+)?$/i.test(t)) throw new ApsError('ValidationError', `"${target}" is not a gRPC server address`, { suggestions: ['Use host:port, e.g. localhost:50051, or grpcs://api.example.com for TLS.'] });
  return { address: t.includes(':') && !t.endsWith(']') ? t : `${t}:${tls ? 443 : 80}`, tls: !!tls };
}

const metaPairs = (m: grpc.Metadata | undefined, redactor?: Redactor): Array<[string, string]> => {
  const pairs: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(m?.getMap() ?? {})) pairs.push([k, Buffer.isBuffer(v) ? v.toString('base64') : String(v)]);
  return redactor ? (redactor.redact(pairs) as Array<[string, string]>) : pairs;
};

function parseMessage(text: string | undefined, what: string): unknown {
  if (!text?.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ApsError('ValidationError', `The ${what} is not valid JSON: ${(e as Error).message}`);
  }
}

/** Call a gRPC method. Stopping (signal) a streaming call keeps the messages received so far. */
/**
 * A reusable caller for load tests: the protos are parsed and the client (one HTTP/2 connection) is
 * created once, then call() runs the method again and again. Unary and server-streaming methods
 * (a streamed call counts when the stream ends).
 */
export async function prepareGrpcCall(spec: GrpcRequestSpec): Promise<{ method: string; call(signal?: AbortSignal): Promise<{ code: number; codeName: string }>; close(): void }> {
  const { address, tls: tlsFromTarget } = parseGrpcTarget(spec.target, spec.tls);
  const tls = tlsFromTarget || !!spec.tlsOptions?.ca || !!spec.tlsOptions?.cert;
  await assertUrlAllowed(new URL(`${tls ? 'https' : 'http'}://${address}`));
  const root = grpcRoot(spec);
  const name = spec.method.replace(/^\//, '');
  const info = describeRoot(root).find((m) => m.name === name || `${m.service.split('.').pop()}/${m.method}` === name);
  if (!info) throw new ApsError('ValidationError', `Method "${spec.method}" is not in the proto files`);
  if (info.clientStreaming) throw new ApsError('ValidationError', 'Load tests call unary and server-streaming methods');
  const pkg = grpc.loadPackageDefinition(protoLoader.fromJSON(root.toJSON(), LOADER_OPTIONS));
  const Ctor = info.service.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], pkg) as grpc.ServiceClientConstructor | undefined;
  if (!Ctor) throw new ApsError('ValidationError', `Service ${info.service} could not be loaded`);
  const channel = grpcChannel(address, tls, spec.tlsOptions);
  const client = new Ctor(address, channel.credentials, channel.options);
  const fn = (client as unknown as Record<string, (...a: unknown[]) => unknown>)[info.method]!.bind(client);
  const input = parseMessage(spec.message, 'request message');
  const md = new grpc.Metadata();
  for (const h of spec.metadata ?? []) if (h.enabled !== false && h.key) md.add(h.key.toLowerCase(), h.value);
  return {
    method: info.name,
    call: (signal) =>
      new Promise((resolve, reject) => {
        const callOpts: grpc.CallOptions = { deadline: new Date(Date.now() + (spec.timeoutMs ?? 30_000)) };
        const done = (code: number) => resolve({ code, codeName: CODE_NAMES[code] ?? String(code) });
        let c: grpc.ClientUnaryCall | grpc.ClientReadableStream<unknown>;
        if (info.serverStreaming) {
          const r = fn(input, md, callOpts) as grpc.ClientReadableStream<unknown>;
          r.on('data', () => undefined);
          r.on('error', (e: grpc.ServiceError) => done(e.code ?? grpc.status.UNKNOWN));
          r.on('status', (s: grpc.StatusObject) => s.code === grpc.status.OK && done(s.code));
          c = r;
        } else c = fn(input, md, callOpts, (err: grpc.ServiceError | null) => done(err ? (err.code ?? grpc.status.UNKNOWN) : grpc.status.OK)) as grpc.ClientUnaryCall;
        signal?.addEventListener('abort', () => (c.cancel(), reject(new ApsError('CancelledError', 'cancelled'))), { once: true });
      }),
    close: () => client.close(),
  };
}

export async function executeGrpc(spec: GrpcRequestSpec, opts: { signal?: AbortSignal; redactor?: Redactor; onMessage?: (data: unknown, atMs: number) => void } = {}): Promise<GrpcResponseData> {
  const t0 = performance.now();
  const ms = () => Math.round((performance.now() - t0) * 100) / 100;
  const { address, tls: tlsFromTarget } = parseGrpcTarget(spec.target, spec.tls);
  const tls = tlsFromTarget || !!spec.tlsOptions?.ca || !!spec.tlsOptions?.cert;
  await assertUrlAllowed(new URL(`${tls ? 'https' : 'http'}://${address}`));

  const root = grpcRoot(spec);
  const methods = describeRoot(root);
  const name = spec.method.replace(/^\//, '');
  const info = methods.find((m) => m.name === name || `${m.service.split('.').pop()}/${m.method}` === name);
  if (!info) throw new ApsError('ValidationError', `Method "${spec.method}" is not in the proto files`, { suggestions: [`Available: ${methods.map((m) => m.name).slice(0, 10).join(', ') || 'none'}`] });

  const pkg = grpc.loadPackageDefinition(protoLoader.fromJSON(root.toJSON(), LOADER_OPTIONS));
  const Ctor = info.service.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], pkg) as grpc.ServiceClientConstructor | undefined;
  if (!Ctor) throw new ApsError('ValidationError', `Service ${info.service} could not be loaded`);
  const channel = grpcChannel(address, tls, spec.tlsOptions);
  const client = new Ctor(address, channel.credentials, channel.options);

  const md = new grpc.Metadata();
  for (const h of spec.metadata ?? []) if (h.enabled !== false && h.key) md.add(h.key.toLowerCase(), h.value);
  const callOpts: grpc.CallOptions = { deadline: new Date(Date.now() + (spec.timeoutMs ?? 30_000)) };
  const input = parseMessage(spec.message, info.clientStreaming ? 'list of messages' : 'request message');
  const outgoing = info.clientStreaming ? (Array.isArray(input) ? input : [input]) : [input];

  let headers: grpc.Metadata | undefined;
  let trailers: grpc.Metadata | undefined;
  const messages: Array<{ data: unknown; atMs: number }> = [];
  const fn = (client as unknown as Record<string, (...a: unknown[]) => unknown>)[info.method]!.bind(client);

  return await new Promise<GrpcResponseData>((resolve, reject) => {
    let call: grpc.ClientUnaryCall | grpc.ClientReadableStream<unknown> | grpc.ClientWritableStream<unknown> | grpc.ClientDuplexStream<unknown, unknown>;
    let stopped = false;
    const finish = (err: grpc.ServiceError | null, response?: unknown, status?: grpc.StatusObject) => {
      opts.signal?.removeEventListener('abort', onAbort);
      client.close();
      const code = err?.code ?? status?.code ?? grpc.status.OK;
      if (stopped && code === grpc.status.CANCELLED) {
        resolve(result(grpc.status.CANCELLED, 'Stopped by the user', undefined, true));
        return;
      }
      if (err && (err.code === grpc.status.UNAVAILABLE || err.code === grpc.status.DEADLINE_EXCEEDED) && !messages.length && !headers) {
        reject(
          new ApsError(err.code === grpc.status.DEADLINE_EXCEEDED ? 'TimeoutError' : 'NetworkError', `${CODE_NAMES[err.code]}: ${err.details || err.message}`, {
            suggestions: err.code === grpc.status.UNAVAILABLE ? ['Check the address and port, and whether the server uses TLS (grpcs://) or plaintext.'] : ['Raise the deadline or check the server.'],
          }),
        );
        return;
      }
      const details = err?.details ?? status?.details ?? '';
      // a successful call's details just repeat "OK"
      resolve(result(code, code === grpc.status.OK && details === 'OK' ? '' : details, response, false, err?.metadata ?? status?.metadata));
    };
    const result = (code: number, details: string, response: unknown, streamStopped: boolean, trailerMd?: grpc.Metadata): GrpcResponseData => ({
      code,
      codeName: CODE_NAMES[code] ?? String(code),
      details,
      ...(response !== undefined ? { response } : {}),
      ...(info.serverStreaming ? { messages } : {}),
      metadata: metaPairs(headers, opts.redactor),
      trailers: metaPairs(trailers ?? trailerMd, opts.redactor),
      durationMs: ms(),
      method: info.name,
      target: address,
      ...(streamStopped ? { streamStopped: true } : {}),
    });
    const onAbort = () => {
      stopped = true;
      call?.cancel();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const unaryCb = (err: grpc.ServiceError | null, response?: unknown) => finish(err, response);
    if (!info.clientStreaming && !info.serverStreaming) call = fn(outgoing[0], md, callOpts, unaryCb) as grpc.ClientUnaryCall;
    else if (info.clientStreaming && !info.serverStreaming) {
      const w = fn(md, callOpts, unaryCb) as grpc.ClientWritableStream<unknown>;
      for (const m of outgoing) w.write(m);
      w.end();
      call = w;
    } else {
      const r = (info.clientStreaming ? fn(md, callOpts) : fn(outgoing[0], md, callOpts)) as grpc.ClientReadableStream<unknown> | grpc.ClientDuplexStream<unknown, unknown>;
      r.on('data', (d: unknown) => {
        const at = ms();
        messages.push({ data: d, atMs: at });
        opts.onMessage?.(d, at);
      });
      r.on('error', (e: grpc.ServiceError) => finish(e));
      r.on('status', (s: grpc.StatusObject) => {
        trailers = s.metadata;
        if (s.code === grpc.status.OK) finish(null, undefined, s);
      });
      if ('write' in r) {
        for (const m of outgoing) r.write(m);
        r.end();
      }
      call = r;
    }
    call.on('metadata', (m: grpc.Metadata) => (headers = m));
    if (!info.serverStreaming) call.on('status', (s: grpc.StatusObject) => (trailers = s.metadata));
  });
}
