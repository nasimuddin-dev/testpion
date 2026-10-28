/**
 * Binary protocol decoders for the Debugger's body views and the CLI / MCP `view` option (FG-19): MessagePack, Protobuf
 * field by field (no .proto file: the way `protoc --decode_raw` reads), and the text framings of SignalR and Socket.IO.
 * Pure and bounded: input over MAX_DECODE_BYTES is refused, nesting over MAX_DEPTH and more than MAX_NODES values stop the
 * read with a note instead of running away. Nothing is executed or fetched.
 */

export const MAX_DECODE_BYTES = 1024 * 1024;
const MAX_DEPTH = 32;
const MAX_NODES = 20_000;
const HEX_PREVIEW = 64;

export class DecodeError extends Error {}

export type Bytes = Uint8Array;

/** Base64 (or base64url) text as bytes; throws on text that is not base64. */
export function bytesFromBase64(b64: string): Bytes {
  const clean = b64.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  const bin = atob(clean + '='.repeat((4 - (clean.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function base64Of(bytes: Bytes): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const hexOf = (b: Bytes, max = HEX_PREVIEW) =>
  Array.from(b.subarray(0, max), (x) => x.toString(16).padStart(2, '0')).join('') + (b.length > max ? '…' : '');

const utf8 = (b: Bytes) => new TextDecoder().decode(b);

/** A value that is a byte string in the source: shown as a short hex preview and its length. */
export interface BinaryValue {
  $bytes: number;
  hex: string;
}

/** An application-specific extension value of MessagePack. */
export interface ExtValue {
  $ext: number;
  hex: string;
}

/* ---------------------------------------------------------------- MessagePack */

class Budget {
  nodes = 0;
  take() {
    if (++this.nodes > MAX_NODES) throw new DecodeError(`More than ${MAX_NODES} values: stopped reading`);
  }
}

function mpRead(b: Bytes, at: { i: number }, depth: number, budget: Budget): unknown {
  if (depth > MAX_DEPTH) throw new DecodeError(`Nested deeper than ${MAX_DEPTH} levels`);
  budget.take();
  const need = (n: number) => {
    if (at.i + n > b.length) throw new DecodeError('The data ends in the middle of a value');
  };
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const t = b[at.i++];
  if (t === undefined) throw new DecodeError('The data ends in the middle of a value');
  if (t <= 0x7f) return t;
  if (t >= 0xe0) return t - 0x100;
  const str = (n: number) => {
    need(n);
    const s = utf8(b.subarray(at.i, at.i + n));
    at.i += n;
    return s;
  };
  const bin = (n: number): BinaryValue => {
    need(n);
    const v = { $bytes: n, hex: hexOf(b.subarray(at.i, at.i + n)) };
    at.i += n;
    return v;
  };
  const arr = (n: number) => {
    // a length larger than what is left cannot be true: refuse before allocating
    if (n > b.length - at.i) throw new DecodeError('An array longer than the data');
    const out: unknown[] = [];
    for (let k = 0; k < n; k++) out.push(mpRead(b, at, depth + 1, budget));
    return out;
  };
  const map = (n: number) => {
    if (n * 2 > b.length - at.i) throw new DecodeError('A map larger than the data');
    const out: Record<string, unknown> = {};
    for (let k = 0; k < n; k++) {
      const key = mpRead(b, at, depth + 1, budget);
      const val = mpRead(b, at, depth + 1, budget);
      const name = typeof key === 'string' ? key : JSON.stringify(key);
      // a "__proto__" key must stay data
      Object.defineProperty(out, name, { value: val, enumerable: true, writable: true, configurable: true });
    }
    return out;
  };
  const ext = (n: number): unknown => {
    need(n + 1);
    const type = dv.getInt8(at.i++);
    const data = b.subarray(at.i, at.i + n);
    at.i += n;
    if (type === -1) {
      // the timestamp extension: seconds (32 bit), or nanoseconds + seconds (64 bit), or (96 bit)
      const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
      if (n === 4) return new Date(d.getUint32(0) * 1000).toISOString();
      if (n === 8) {
        const hi = d.getUint32(0);
        const secs = (hi & 3) * 2 ** 32 + d.getUint32(4);
        return new Date(secs * 1000 + Math.floor((hi >>> 2) / 1e6)).toISOString();
      }
      if (n === 12) return new Date(Number(d.getBigInt64(4)) * 1000 + Math.floor(d.getUint32(0) / 1e6)).toISOString();
    }
    return { $ext: type, hex: hexOf(data) } satisfies ExtValue;
  };
  switch (t) {
    case 0xc0:
      return null;
    case 0xc2:
      return false;
    case 0xc3:
      return true;
    case 0xc4:
      need(1);
      return bin(b[at.i++]!);
    case 0xc5:
      need(2);
      at.i += 2;
      return bin(dv.getUint16(at.i - 2));
    case 0xc6:
      need(4);
      at.i += 4;
      return bin(dv.getUint32(at.i - 4));
    case 0xc7:
      need(1);
      return ext(b[at.i++]!);
    case 0xc8:
      need(2);
      at.i += 2;
      return ext(dv.getUint16(at.i - 2));
    case 0xc9:
      need(4);
      at.i += 4;
      return ext(dv.getUint32(at.i - 4));
    case 0xca:
      need(4);
      at.i += 4;
      return dv.getFloat32(at.i - 4);
    case 0xcb:
      need(8);
      at.i += 8;
      return dv.getFloat64(at.i - 8);
    case 0xcc:
      need(1);
      return b[at.i++]!;
    case 0xcd:
      need(2);
      at.i += 2;
      return dv.getUint16(at.i - 2);
    case 0xce:
      need(4);
      at.i += 4;
      return dv.getUint32(at.i - 4);
    case 0xcf: {
      need(8);
      at.i += 8;
      const v = dv.getBigUint64(at.i - 8);
      return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
    }
    case 0xd0:
      need(1);
      at.i += 1;
      return dv.getInt8(at.i - 1);
    case 0xd1:
      need(2);
      at.i += 2;
      return dv.getInt16(at.i - 2);
    case 0xd2:
      need(4);
      at.i += 4;
      return dv.getInt32(at.i - 4);
    case 0xd3: {
      need(8);
      at.i += 8;
      const v = dv.getBigInt64(at.i - 8);
      return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
    }
    case 0xd4:
      return ext(1);
    case 0xd5:
      return ext(2);
    case 0xd6:
      return ext(4);
    case 0xd7:
      return ext(8);
    case 0xd8:
      return ext(16);
    case 0xd9:
      need(1);
      return str(b[at.i++]!);
    case 0xda:
      need(2);
      at.i += 2;
      return str(dv.getUint16(at.i - 2));
    case 0xdb:
      need(4);
      at.i += 4;
      return str(dv.getUint32(at.i - 4));
    case 0xdc:
      need(2);
      at.i += 2;
      return arr(dv.getUint16(at.i - 2));
    case 0xdd:
      need(4);
      at.i += 4;
      return arr(dv.getUint32(at.i - 4));
    case 0xde:
      need(2);
      at.i += 2;
      return map(dv.getUint16(at.i - 2));
    case 0xdf:
      need(4);
      at.i += 4;
      return map(dv.getUint32(at.i - 4));
    default:
      if (t >= 0xa0 && t <= 0xbf) return str(t & 0x1f);
      if (t >= 0x90 && t <= 0x9f) return arr(t & 0x0f);
      if (t >= 0x80 && t <= 0x8f) return map(t & 0x0f);
      throw new DecodeError(`Not MessagePack: byte 0x${t.toString(16)} is not a type`);
  }
}

/** One MessagePack value; the whole input must be used (`trailing` says how many bytes were left otherwise). */
export function decodeMessagePack(bytes: Bytes): { value: unknown; trailing: number } {
  if (bytes.length > MAX_DECODE_BYTES) throw new DecodeError(`Over ${MAX_DECODE_BYTES / 1024} KB: not decoded`);
  if (!bytes.length) throw new DecodeError('Empty');
  const at = { i: 0 };
  const value = mpRead(bytes, at, 0, new Budget());
  return { value, trailing: bytes.length - at.i };
}

/** All MessagePack values back to back (SignalR's MessagePack protocol length-prefixes each; a stream of values also reads here). */
export function decodeMessagePackStream(bytes: Bytes): unknown[] {
  if (bytes.length > MAX_DECODE_BYTES) throw new DecodeError(`Over ${MAX_DECODE_BYTES / 1024} KB: not decoded`);
  const out: unknown[] = [];
  const at = { i: 0 };
  const budget = new Budget();
  while (at.i < bytes.length) out.push(mpRead(bytes, at, 0, budget));
  return out;
}

/* ---------------------------------------------------------------- Protobuf (no schema) */

export type ProtoValue = number | string | BinaryValue | ProtoField[];
export interface ProtoField {
  field: number;
  /** 'varint' | 'fixed64' | 'bytes' | 'fixed32', as on the wire; a bytes field also tells how it was read. */
  wire: 'varint' | 'fixed64' | 'bytes' | 'fixed32';
  kind?: 'message' | 'string' | 'bytes';
  value: ProtoValue;
  /** Fixed-width values read as a float too (the wire does not say which). */
  asFloat?: number;
}

function varint(b: Bytes, at: { i: number }): bigint {
  let r = 0n;
  let shift = 0n;
  for (let n = 0; n < 10; n++) {
    const x = b[at.i++];
    if (x === undefined) throw new DecodeError('The data ends in a number');
    r |= BigInt(x & 0x7f) << shift;
    if (!(x & 0x80)) return r;
    shift += 7n;
  }
  throw new DecodeError('A number longer than 10 bytes');
}

const num = (v: bigint): number | string => (v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString());

const printable = (s: string) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f�]/.test(s);

function pbRead(b: Bytes, depth: number, budget: Budget): ProtoField[] {
  if (depth > MAX_DEPTH) throw new DecodeError(`Nested deeper than ${MAX_DEPTH} levels`);
  const at = { i: 0 };
  const out: ProtoField[] = [];
  while (at.i < b.length) {
    budget.take();
    const key = varint(b, at);
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (field < 1 || field > 536870911) throw new DecodeError(`Not Protobuf: field number ${field}`);
    const dv = (n: number) => {
      if (at.i + n > b.length) throw new DecodeError('The data ends in a value');
      const d = new DataView(b.buffer, b.byteOffset + at.i, n);
      at.i += n;
      return d;
    };
    if (wire === 0) out.push({ field, wire: 'varint', value: num(varint(b, at)) });
    else if (wire === 1) {
      const d = dv(8);
      out.push({ field, wire: 'fixed64', value: num(d.getBigUint64(0, true)), asFloat: d.getFloat64(0, true) });
    } else if (wire === 5) {
      const d = dv(4);
      out.push({ field, wire: 'fixed32', value: d.getUint32(0, true), asFloat: d.getFloat32(0, true) });
    } else if (wire === 2) {
      const len = Number(varint(b, at));
      if (at.i + len > b.length) throw new DecodeError('A field longer than the data');
      const slice = b.subarray(at.i, at.i + len);
      at.i += len;
      let nested: ProtoField[] | undefined;
      if (len > 0) {
        try {
          nested = pbRead(slice, depth + 1, budget);
        } catch (e) {
          if (e instanceof DecodeError && /More than/.test(e.message)) throw e;
        }
      }
      if (nested && nested.length) out.push({ field, wire: 'bytes', kind: 'message', value: nested });
      else {
        const s = utf8(slice);
        if (printable(s)) out.push({ field, wire: 'bytes', kind: 'string', value: s });
        else out.push({ field, wire: 'bytes', kind: 'bytes', value: { $bytes: len, hex: hexOf(slice) } });
      }
    } else throw new DecodeError(`Not Protobuf: wire type ${wire} (groups are not read)`);
  }
  return out;
}

/** The fields of a protobuf message, in order, without a schema. A field that parses as a message is shown nested. */
export function decodeProtobufRaw(bytes: Bytes): ProtoField[] {
  if (bytes.length > MAX_DECODE_BYTES) throw new DecodeError(`Over ${MAX_DECODE_BYTES / 1024} KB: not decoded`);
  if (!bytes.length) throw new DecodeError('Empty');
  return pbRead(bytes, 0, new Budget());
}

/** The fields as an object (repeated fields as arrays): the shape JSON tools take. */
export function protobufToJson(fields: ProtoField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const repeated = new Set<string>();
  for (const f of fields) {
    const v = Array.isArray(f.value) ? protobufToJson(f.value) : f.value;
    const k = String(f.field);
    if (!(k in out)) out[k] = v;
    else if (repeated.has(k)) (out[k] as unknown[]).push(v);
    else {
      repeated.add(k);
      out[k] = [out[k], v];
    }
  }
  return out;
}

/** The `protoc --decode_raw` text: `1: 150`, `2: "text"`, `3 {` … `}`. */
export function protobufText(fields: ProtoField[], indent = 0): string {
  const pad = '  '.repeat(indent);
  return fields
    .map((f) => {
      if (f.kind === 'message') return `${pad}${f.field} {\n${protobufText(f.value as ProtoField[], indent + 1)}\n${pad}}`;
      const v = f.kind === 'string' ? JSON.stringify(f.value) : typeof f.value === 'object' && !Array.isArray(f.value) ? `<${(f.value as BinaryValue).$bytes} bytes> ${(f.value as BinaryValue).hex}` : String(f.value);
      const fl = f.asFloat !== undefined && Number.isFinite(f.asFloat) && f.asFloat !== 0 && Math.abs(f.asFloat) > 1e-6 && Math.abs(f.asFloat) < 1e12 ? `  # as float: ${f.asFloat}` : '';
      return `${pad}${f.field}: ${v}${fl}`;
    })
    .join('\n');
}

/* ---------------------------------------------------------------- SignalR and Socket.IO (text framings) */

export interface RealtimeMessage {
  /** The kind in words: "invocation", "completion", "ping", "event", "ack", "connect" … */
  kind: string;
  /** Hub method / event name / target, when it has one. */
  name?: string;
  /** The message's own fields as JSON. */
  data?: unknown;
  raw: string;
}

const SIGNALR_TYPES: Record<number, string> = { 1: 'invocation', 2: 'stream item', 3: 'completion', 4: 'stream invocation', 5: 'cancel invocation', 6: 'ping', 7: 'close' };

/** SignalR's JSON protocol: messages end with the record separator (0x1e); a type number says what each is. */
export function decodeSignalR(text: string): RealtimeMessage[] | undefined {
  if (text.length > MAX_DECODE_BYTES) throw new DecodeError(`Over ${MAX_DECODE_BYTES / 1024} KB: not decoded`);
  if (!text.includes('\u001e')) return undefined;
  const out: RealtimeMessage[] = [];
  for (const part of text.split('\u001e')) {
    if (!part.trim()) continue;
    if (out.length >= 500) break;
    let j: unknown;
    try {
      j = JSON.parse(part);
    } catch {
      return undefined;
    }
    if (!j || typeof j !== 'object') return undefined;
    const o = j as Record<string, unknown>;
    if ('protocol' in o && 'version' in o) out.push({ kind: 'handshake', name: String(o.protocol), data: o, raw: part });
    else if (typeof o.type === 'number') out.push({ kind: SIGNALR_TYPES[o.type] ?? `type ${o.type}`, name: typeof o.target === 'string' ? o.target : undefined, data: o.arguments ?? o.item ?? o.result ?? o.error ?? o, raw: part });
    else out.push({ kind: Object.keys(o).length ? 'handshake response' : 'handshake accepted', data: o, raw: part });
  }
  return out.length ? out : undefined;
}

const SIO_TYPES = ['connect', 'disconnect', 'event', 'ack', 'connect error', 'binary event', 'binary ack'];
const EIO_TYPES = ['open', 'close', 'ping', 'pong', 'message', 'upgrade', 'noop'];

/**
 * Socket.IO over Engine.IO text frames: `42["event",{…}]` (Engine.IO message 4, Socket.IO event 2), with an optional namespace
 * and ack id, and the long-polling form where packets are joined by the record separator or length-prefixed (`23:42[...]`).
 */
export function decodeSocketIo(text: string): RealtimeMessage[] | undefined {
  if (text.length > MAX_DECODE_BYTES) throw new DecodeError(`Over ${MAX_DECODE_BYTES / 1024} KB: not decoded`);
  let packets: string[];
  if (text.includes('\u001e')) packets = text.split('\u001e');
  else if (/^\d+:/.test(text)) {
    packets = [];
    let i = 0;
    while (i < text.length && packets.length < 500) {
      const m = /^(\d+):/.exec(text.slice(i, i + 12));
      if (!m) return undefined;
      const len = Number(m[1]);
      const start = i + m[0].length;
      packets.push(text.slice(start, start + len));
      i = start + len;
    }
  } else packets = [text];
  const out: RealtimeMessage[] = [];
  for (const p of packets.slice(0, 500)) {
    if (!p) continue;
    const eio = p.charCodeAt(0) - 48;
    if (eio < 0 || eio > 6) return undefined;
    const rest = p.slice(1);
    if (eio !== 4) {
      let data: unknown = rest || undefined;
      if (eio === 0 && rest.startsWith('{')) {
        try {
          data = JSON.parse(rest);
        } catch {
          /* keep the text */
        }
      }
      out.push({ kind: `engine.io ${EIO_TYPES[eio]}`, data, raw: p });
      continue;
    }
    const m = /^(\d)(?:(\d+)-)?(\/[^,]*,)?(\d+)?([\s\S]*)$/.exec(rest);
    if (!m) return undefined;
    const sio = Number(m[1]);
    if (sio > 6) return undefined;
    let payload: unknown;
    if (m[5]) {
      try {
        payload = JSON.parse(m[5]);
      } catch {
        return undefined;
      }
    }
    const isEvent = (sio === 2 || sio === 5) && Array.isArray(payload) && typeof payload[0] === 'string';
    out.push({
      kind: SIO_TYPES[sio] ?? `type ${sio}`,
      name: isEvent ? (payload as string[])[0] : m[3] ? m[3].slice(0, -1) : undefined,
      data: isEvent ? (payload as unknown[]).slice(1) : payload,
      raw: p,
    });
  }
  return out.length ? out : undefined;
}
