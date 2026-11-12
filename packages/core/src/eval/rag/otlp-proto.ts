/**
 * OTLP traces in their binary form (protobuf, `ExportTraceServiceRequest`: what an OpenTelemetry exporter sends by
 * default over HTTP) as the same object the JSON form gives (`{ resourceSpans: [...] }`), so otel-traces.ts reads both.
 * Only the fields a trace import uses are decoded (ids, names, times, attributes, events, status); the rest is skipped.
 * The reader is written out here (the wire format is small) so a trace import loads no protobuf library, and it is
 * bounded: nesting, and every length against the bytes that are there.
 */
import { ApsError } from '../../errors.js';

type Rec = Record<string, unknown>;
type Field = { no: number; wire: number; int: bigint; bytes: Buffer };

const MAX_DEPTH = 32;
const bad = (why: string): never => {
  throw new ApsError('ValidationError', `Not an OTLP trace export in protobuf (${why})`, { suggestions: ['Send traces to POST /v1/traces, as protobuf or as JSON (OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf or http/json).'] });
};

/** The fields of one message, in the order they were written. */
function* fields(buf: Buffer): Generator<Field> {
  let at = 0;
  const varint = (): bigint => {
    let v = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (at >= buf.length) bad('cut off in a number');
      const b = buf[at++]!;
      v |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return BigInt.asUintN(64, v);
    }
    return bad('a number of more than ten bytes');
  };
  const none = Buffer.alloc(0);
  while (at < buf.length) {
    const key = Number(varint());
    const no = key >>> 3;
    const wire = key & 7;
    if (!no) bad('field 0');
    if (wire === 0) yield { no, wire, int: varint(), bytes: none };
    else if (wire === 1) {
      if (at + 8 > buf.length) bad('cut off in a 64-bit value');
      yield { no, wire, int: buf.readBigUInt64LE(at), bytes: buf.subarray(at, at + 8) };
      at += 8;
    } else if (wire === 2) {
      const len = Number(varint());
      if (at + len > buf.length) bad('a length past the end');
      yield { no, wire, int: 0n, bytes: buf.subarray(at, at + len) };
      at += len;
    } else if (wire === 5) {
      if (at + 4 > buf.length) bad('cut off in a 32-bit value');
      yield { no, wire, int: BigInt(buf.readUInt32LE(at)), bytes: none };
      at += 4;
    } else bad(`wire type ${wire}`);
  }
}

const text = (f: Field) => f.bytes.toString('utf8');
const hex = (f: Field) => f.bytes.toString('hex');
const sub = (f: Field): Buffer => (f.wire === 2 ? f.bytes : bad(`field ${f.no} is not a message`));

function anyValue(buf: Buffer, depth: number): Rec {
  if (depth > MAX_DEPTH) bad('values nested too deep');
  let out: Rec = {};
  for (const f of fields(buf)) {
    if (f.no === 1) out = { stringValue: text(f) };
    else if (f.no === 2) out = { boolValue: f.int !== 0n };
    else if (f.no === 3) out = { intValue: BigInt.asIntN(64, f.int).toString() };
    else if (f.no === 4) out = { doubleValue: f.wire === 1 ? f.bytes.readDoubleLE(0) : 0 };
    else if (f.no === 5) out = { arrayValue: { values: [...fields(sub(f))].filter((x) => x.no === 1).map((x) => anyValue(sub(x), depth + 1)) } };
    else if (f.no === 6) out = { kvlistValue: { values: [...fields(sub(f))].filter((x) => x.no === 1).map((x) => keyValue(sub(x), depth + 1)) } };
    else if (f.no === 7) out = { bytesValue: f.bytes.toString('base64') };
  }
  return out;
}

function keyValue(buf: Buffer, depth = 0): Rec {
  const out: Rec = { key: '', value: {} };
  for (const f of fields(buf)) {
    if (f.no === 1) out.key = text(f);
    else if (f.no === 2) out.value = anyValue(sub(f), depth);
  }
  return out;
}

function event(buf: Buffer): Rec {
  const out: Rec = { name: '', attributes: [] as Rec[] };
  for (const f of fields(buf)) {
    if (f.no === 1) out.timeUnixNano = f.int.toString();
    else if (f.no === 2) out.name = text(f);
    else if (f.no === 3) (out.attributes as Rec[]).push(keyValue(sub(f)));
  }
  return out;
}

function span(buf: Buffer): Rec {
  const out: Rec = { attributes: [] as Rec[], events: [] as Rec[] };
  for (const f of fields(buf)) {
    if (f.no === 1) out.traceId = hex(f);
    else if (f.no === 2) out.spanId = hex(f);
    else if (f.no === 4 && f.bytes.length) out.parentSpanId = hex(f);
    else if (f.no === 5) out.name = text(f);
    else if (f.no === 6) out.kind = Number(f.int);
    else if (f.no === 7) out.startTimeUnixNano = f.int.toString();
    else if (f.no === 8) out.endTimeUnixNano = f.int.toString();
    else if (f.no === 9) (out.attributes as Rec[]).push(keyValue(sub(f)));
    else if (f.no === 11) (out.events as Rec[]).push(event(sub(f)));
    else if (f.no === 15) {
      const status: Rec = {};
      for (const s of fields(sub(f))) {
        if (s.no === 2) status.message = text(s);
        else if (s.no === 3) status.code = Number(s.int);
      }
      out.status = status;
    }
  }
  return out;
}

const attributesOf = (buf: Buffer, no: number): Rec[] => [...fields(buf)].filter((f) => f.no === no).map((f) => keyValue(sub(f)));

/** One protobuf `ExportTraceServiceRequest` (or `TracesData`: the same bytes) as its JSON form. */
export function decodeOtlpTraces(buf: Buffer): { resourceSpans: Rec[] } {
  const resourceSpans: Rec[] = [];
  for (const f of fields(buf)) {
    if (f.no !== 1) continue;
    const rs: Rec = { scopeSpans: [] as Rec[] };
    for (const r of fields(sub(f))) {
      if (r.no === 1) rs.resource = { attributes: attributesOf(sub(r), 1) };
      else if (r.no === 2) {
        const ss: Rec = { spans: [] as Rec[] };
        for (const s of fields(sub(r))) {
          if (s.no === 1) {
            const scope: Rec = {};
            for (const x of fields(sub(s))) {
              if (x.no === 1) scope.name = text(x);
              else if (x.no === 2) scope.version = text(x);
            }
            ss.scope = scope;
          } else if (s.no === 2) (ss.spans as Rec[]).push(span(sub(s)));
        }
        (rs.scopeSpans as Rec[]).push(ss);
      }
    }
    resourceSpans.push(rs);
  }
  return { resourceSpans };
}

/** True when the bytes are not JSON text (a file given to a trace import is then read as protobuf). */
export const looksBinary = (buf: Buffer): boolean => {
  const first = buf.find((b) => b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0xef && b !== 0xbb && b !== 0xbf);
  return first !== undefined && first !== 0x7b && first !== 0x5b;
};
