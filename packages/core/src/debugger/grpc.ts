import { gunzipSync, inflateSync } from 'node:zlib';
import type protobuf from 'protobufjs';
import { grpcRoot, type ProtoFile } from '../protocols/grpc/grpc.js';
import type { WorkspaceStore } from '../storage/workspace.js';

/**
 * gRPC through the HTTP Debugger (planning/http-debugger.md, DBG-5): the messages of a call are length-prefixed
 * protobuf (1 byte "compressed", 4 bytes length, the message). They are decoded with the workspace's .proto files
 * when one describes the method, else field by field without a schema (numbers, strings, nested messages as the
 * bytes allow), the way `protoc --decode_raw` does.
 */
export interface GrpcCapture {
  /** `package.Service` and `Method`, from the path `/package.Service/Method`. */
  service: string;
  method: string;
  /** How the messages were read: with the workspace's .proto files, or field by field. */
  decodedWith: 'proto' | 'raw';
  requests: unknown[];
  responses: unknown[];
  /** grpc-status and grpc-message from the trailers (0 is OK). */
  status?: number;
  statusName?: string;
  message?: string;
}

export const GRPC_STATUS = [
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

/** `/pkg.Service/Method` as its parts (undefined when the path is not a gRPC method). */
export function grpcMethodOf(path: string): { service: string; method: string } | undefined {
  const m = /^\/([^/]+)\/([^/?]+)$/.exec(path);
  return m ? { service: m[1]!, method: m[2]! } : undefined;
}

/** Reads length-prefixed gRPC messages from a stream of bytes in one direction; call `push` with every chunk. */
export function grpcMessageReader(onMessage: (bytes: Buffer, compressed: boolean) => void): { push(chunk: Buffer): void } {
  let buf: Buffer = Buffer.alloc(0);
  return {
    push(chunk: Buffer) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= 5) {
        const len = buf.readUInt32BE(1);
        if (buf.length < 5 + len) return;
        onMessage(Buffer.from(buf.subarray(5, 5 + len)), buf[0] === 1);
        buf = buf.subarray(5 + len);
      }
    },
  };
}

/** A compressed message as plain bytes (gzip and deflate; anything else stays as it is). */
export function grpcDecompress(bytes: Buffer, encoding: string | undefined): Buffer {
  try {
    if (/gzip/i.test(encoding ?? '')) return gunzipSync(bytes);
    if (/deflate/i.test(encoding ?? '')) return inflateSync(bytes);
  } catch {
    /* as it is */
  }
  return bytes;
}

/**
 * A protobuf message without its schema: `{ "1": 42, "2": "text", "3": { "1": … } }`. Repeated fields become lists;
 * a length-delimited field is a nested message when it parses as one, text when it is printable, else hex.
 */
export function decodeProtobufRaw(bytes: Buffer, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const repeated = new Set<string>();
  const add = (field: number, value: unknown) => {
    const k = String(field);
    if (!(k in out)) out[k] = value;
    else if (repeated.has(k)) (out[k] as unknown[]).push(value);
    else {
      out[k] = [out[k], value];
      repeated.add(k);
    }
  };
  let i = 0;
  const varint = () => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (i >= bytes.length) throw new Error('truncated varint');
      const b = bytes[i++]!;
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return result;
      shift += 7n;
      if (shift > 70n) throw new Error('varint too long');
    }
  };
  while (i < bytes.length) {
    const key = Number(varint());
    const field = key >>> 3;
    const wire = key & 7;
    if (field === 0) throw new Error('field 0');
    if (wire === 0) {
      const v = varint();
      add(field, v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString());
    } else if (wire === 1) {
      if (i + 8 > bytes.length) throw new Error('truncated fixed64');
      add(field, bytes.readDoubleLE(i));
      i += 8;
    } else if (wire === 5) {
      if (i + 4 > bytes.length) throw new Error('truncated fixed32');
      add(field, bytes.readFloatLE(i));
      i += 4;
    } else if (wire === 2) {
      const len = Number(varint());
      if (i + len > bytes.length) throw new Error('truncated bytes');
      const slice = bytes.subarray(i, i + len);
      i += len;
      add(field, lengthDelimited(slice, depth));
    } else throw new Error(`wire type ${wire}`);
  }
  return out;
}

function lengthDelimited(slice: Buffer, depth: number): unknown {
  const text = slice.toString('utf8');
  const printable = slice.length > 0 && !/[\u0000-\u0008\u000e-\u001f�]/.test(text);
  if (depth < 8 && slice.length > 0) {
    try {
      const nested = decodeProtobufRaw(slice, depth + 1);
      // a short printable string can also parse as a message; text reads better then
      if (!(printable && text.length < 64 && /^[\x20-\x7e]+$/.test(text))) return nested;
    } catch {
      /* not a message */
    }
  }
  if (printable || slice.length === 0) return text;
  return `0x${slice.toString('hex')}`;
}

/** The request and response types of every method the given roots describe, by gRPC path. */
export function grpcMethodIndex(roots: protobuf.Root[]): Map<string, { request: protobuf.Type; response: protobuf.Type }> {
  const index = new Map<string, { request: protobuf.Type; response: protobuf.Type }>();
  const visit = (ns: protobuf.NamespaceBase) => {
    for (const child of ns.nestedArray) {
      const svc = child as protobuf.Service;
      if ((svc as { methods?: unknown }).methods && typeof (svc as protobuf.Service).methodsArray !== 'undefined') {
        const full = svc.fullName.replace(/^\./, '');
        for (const m of svc.methodsArray) {
          try {
            m.resolve();
            if (m.resolvedRequestType && m.resolvedResponseType) index.set(`/${full}/${m.name}`, { request: m.resolvedRequestType, response: m.resolvedResponseType });
          } catch {
            /* an unresolved type: raw decoding for this one */
          }
        }
      }
      if ((child as protobuf.NamespaceBase).nestedArray) visit(child as protobuf.NamespaceBase);
    }
  };
  for (const r of roots) {
    try {
      r.resolveAll();
    } catch {
      /* partial roots still help */
    }
    visit(r);
  }
  return index;
}

/** A decoder for the proxy: the message as JSON with the method's type, or field by field. */
export function grpcDecoder(index: Map<string, { request: protobuf.Type; response: protobuf.Type }>) {
  return (path: string, direction: 'request' | 'response', bytes: Buffer): { value: unknown; with: 'proto' | 'raw' } => {
    const types = index.get(path);
    const type = types ? (direction === 'request' ? types.request : types.response) : undefined;
    if (type) {
      try {
        return { value: type.toObject(type.decode(bytes), { longs: String, enums: String, bytes: String, defaults: false }), with: 'proto' };
      } catch {
        /* the bytes do not match the schema: raw */
      }
    }
    try {
      return { value: decodeProtobufRaw(bytes), with: 'raw' };
    } catch {
      return { value: `0x${bytes.toString('hex')}`, with: 'raw' };
    }
  };
}

/** The protos the workspace's gRPC calls carry (collections and the library), to decode captured gRPC messages. */
export function workspaceProtoRoots(store?: Pick<WorkspaceStore, 'listCollections' | 'getLibrary'>): protobuf.Root[] {
  if (!store) return [];
  const roots: protobuf.Root[] = [];
  const seen = new Set<string>();
  const visit = (node: unknown, depth = 0): void => {
    if (!node || typeof node !== 'object' || depth > 12) return;
    const o = node as { protoFiles?: ProtoFile[]; descriptorSet?: string };
    if ((Array.isArray(o.protoFiles) && o.protoFiles.length) || typeof o.descriptorSet === 'string') {
      const key = JSON.stringify([o.protoFiles?.map((f) => f.name) ?? null, o.descriptorSet?.length ?? 0]);
      if (!seen.has(key)) {
        seen.add(key);
        try {
          roots.push(grpcRoot({ protoFiles: o.protoFiles, descriptorSet: o.descriptorSet }));
        } catch {
          /* field by field for this one */
        }
      }
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') visit(v, depth + 1);
  };
  try {
    for (const c of store.listCollections()) visit(c.items);
    visit(store.getLibrary('grpc').items);
  } catch {
    /* no workspace */
  }
  return roots;
}
