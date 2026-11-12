/**
 * Traces received live (rag import --listen): an application's OpenTelemetry exporter posts OTLP (protobuf or JSON) to
 * 127.0.0.1 and what arrives becomes dataset records. Other bodies and other signals are answered with what to change.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import protobuf from 'protobufjs';
import { decodeOtlpTraces, importOtelTraces, startOtlpReceiver } from '@testpion/core';
import { cliPath, runCli } from '../helpers.js';

const attr = (o: Record<string, string>) => Object.entries(o).map(([key, v]) => ({ key, value: { stringValue: v } }));
const trace = (id: string, question: string, answer: string) => ({
  resourceSpans: [
    {
      resource: { attributes: attr({ 'service.name': 'clinic-bot' }) },
      scopeSpans: [
        {
          spans: [
            {
              traceId: id,
              spanId: `${id}-1`,
              name: 'chat demo',
              startTimeUnixNano: '0',
              endTimeUnixNano: '100000000',
              attributes: attr({
                'gen_ai.operation.name': 'chat',
                'gen_ai.request.model': 'demo',
                'gen_ai.input.messages': JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: question }] }]),
                'gen_ai.output.messages': JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: answer }] }]),
              }),
            },
          ],
        },
      ],
    },
  ],
});
const post = (url: string, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  fetch(url, { method: 'POST', headers, body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body) });

// the OTLP trace messages as an exporter writes them (opentelemetry-proto, trace/v1), to make real protobuf bodies
const otlp = protobuf.parse(`
syntax = "proto3";
message AnyValue { oneof value { string string_value = 1; bool bool_value = 2; int64 int_value = 3; double double_value = 4; ArrayValue array_value = 5; KeyValueList kvlist_value = 6; bytes bytes_value = 7; } }
message ArrayValue { repeated AnyValue values = 1; }
message KeyValueList { repeated KeyValue values = 1; }
message KeyValue { string key = 1; AnyValue value = 2; }
message Resource { repeated KeyValue attributes = 1; }
message Scope { string name = 1; string version = 2; }
message Event { fixed64 time_unix_nano = 1; string name = 2; repeated KeyValue attributes = 3; }
message Status { string message = 2; int32 code = 3; }
message Span { bytes trace_id = 1; bytes span_id = 2; string trace_state = 3; bytes parent_span_id = 4; string name = 5; int32 kind = 6; fixed64 start_time_unix_nano = 7; fixed64 end_time_unix_nano = 8; repeated KeyValue attributes = 9; uint32 dropped_attributes_count = 10; repeated Event events = 11; Status status = 15; fixed32 flags = 16; }
message ScopeSpans { Scope scope = 1; repeated Span spans = 2; string schema_url = 3; }
message ResourceSpans { Resource resource = 1; repeated ScopeSpans scope_spans = 2; string schema_url = 3; }
message Request { repeated ResourceSpans resource_spans = 1; }
`).root;
const kv = (key: string, value: Record<string, unknown>) => ({ key, value });
const protoTrace = (question: string, answer: string) => {
  const Request = otlp.lookupType('Request');
  return Buffer.from(
    Request.encode(
      Request.fromObject({
        resourceSpans: [
          {
            resource: { attributes: [kv('service.name', { stringValue: 'clinic-bot' })] },
            scopeSpans: [
              {
                scope: { name: 'demo', version: '1' },
                schemaUrl: 'https://opentelemetry.io/schemas/1.30.0',
                spans: [
                  {
                    traceId: Buffer.from('0af7651916cd43dd8448eb211c80319c', 'hex'),
                    spanId: Buffer.from('b7ad6b7169203331', 'hex'),
                    traceState: 'a=b',
                    name: 'chat demo',
                    kind: 3,
                    startTimeUnixNano: '1700000000000000000',
                    endTimeUnixNano: '1700000000250000000',
                    droppedAttributesCount: 2,
                    flags: 1,
                    attributes: [
                      kv('gen_ai.operation.name', { stringValue: 'chat' }),
                      kv('gen_ai.usage.input_tokens', { intValue: 12 }),
                      kv('negative', { intValue: -5 }),
                      kv('temperature', { doubleValue: 0.5 }),
                      kv('stream', { boolValue: true }),
                      kv('tags', { arrayValue: { values: [{ stringValue: 'a' }, { kvlistValue: { values: [kv('deep', { stringValue: 'yes' })] } }] } }),
                      kv('gen_ai.input.messages', { stringValue: JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: question }] }]) }),
                      kv('gen_ai.output.messages', { stringValue: JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: answer }] }]) }),
                    ],
                    events: [{ timeUnixNano: '1700000000100000000', name: 'first token', attributes: [kv('n', { intValue: 1 })] }],
                    status: { message: 'fine', code: 1 },
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).finish(),
  );
};

describe('OTLP traces in protobuf', () => {
  it('decode to what the JSON form holds: ids in hex, times, every kind of value, events and the status', () => {
    const scoped = (decodeOtlpTraces(protoTrace('Q?', 'A.')).resourceSpans[0] as { scopeSpans: Array<{ scope: unknown; spans: Array<Record<string, unknown>> }> }).scopeSpans[0]!;
    expect(scoped.scope).toEqual({ name: 'demo', version: '1' });
    const s = scoped.spans[0]!;
    expect(s).toMatchObject({ traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331', name: 'chat demo', kind: 3, startTimeUnixNano: '1700000000000000000', endTimeUnixNano: '1700000000250000000', status: { message: 'fine', code: 1 } });
    expect(s.parentSpanId).toBeUndefined();
    const attrs = Object.fromEntries((s.attributes as Array<{ key: string; value: unknown }>).map((a) => [a.key, a.value]));
    expect(attrs['gen_ai.usage.input_tokens']).toEqual({ intValue: '12' });
    expect(attrs.negative).toEqual({ intValue: '-5' });
    expect(attrs.temperature).toEqual({ doubleValue: 0.5 });
    expect(attrs.stream).toEqual({ boolValue: true });
    expect(attrs.tags).toEqual({ arrayValue: { values: [{ stringValue: 'a' }, { kvlistValue: { values: [{ key: 'deep', value: { stringValue: 'yes' } }] } }] } });
    expect(s.events).toEqual([{ timeUnixNano: '1700000000100000000', name: 'first token', attributes: [{ key: 'n', value: { intValue: '1' } }] }]);
    expect(importOtelTraces([decodeOtlpTraces(protoTrace('When do you open?', 'At 8am.'))]).records.map((r) => [r.question, r.answer])).toEqual([['When do you open?', 'At 8am.']]);
  });

  it('bytes that are not a trace export are refused with the reason, however they are cut or nested', () => {
    const good = protoTrace('Q?', 'A.');
    expect(() => decodeOtlpTraces(Buffer.from('hello, not protobuf'))).toThrow(/Not an OTLP trace export/);
    // every prefix either decodes (a cut between fields) or is refused: never a crash, never a read past the end
    for (let n = 0; n < good.length; n += 7) {
      try {
        decodeOtlpTraces(good.subarray(0, n));
      } catch (e) {
        expect(String((e as Error).message)).toContain('Not an OTLP trace export');
      }
    }
    // an attribute value nested deeper than any exporter writes: array in array, 40 times
    const wrap = (no: number, inner: Buffer) => Buffer.concat([Buffer.from([(no << 3) | 2, ...(inner.length < 128 ? [inner.length] : [(inner.length & 0x7f) | 0x80, inner.length >> 7])]), inner]);
    let value = wrap(1, Buffer.from('x'));
    for (let i = 0; i < 40; i++) value = wrap(5, wrap(1, value));
    const request = wrap(1, wrap(2, wrap(2, wrap(9, wrap(2, value)))));
    expect(() => decodeOtlpTraces(request)).toThrow(/nested too deep/);
  });
});

describe('the OTLP receiver', () => {
  it('takes JSON and protobuf traces (gzip too), and says what to change for other bodies and other paths', async () => {
    const rx = await startOtlpReceiver({ port: 0 });
    try {
      expect(rx.endpoint).toBe(`http://127.0.0.1:${rx.port}`);
      const url = `${rx.endpoint}/v1/traces`;
      const ok = await post(url, trace('t1', 'When do you open?', 'At 8am.'));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ partialSuccess: {} });
      expect((await post(url, gzipSync(JSON.stringify(trace('t2', 'Do you treat rabbits?', 'Yes.'))), { 'content-type': 'application/json', 'content-encoding': 'gzip' })).status).toBe(200);
      const proto = await post(url, gzipSync(protoTrace('Is parking free?', 'Yes, behind the clinic.')), { 'content-type': 'application/x-protobuf', 'content-encoding': 'gzip' });
      expect(proto.status).toBe(200);
      expect(proto.headers.get('content-type')).toBe('application/x-protobuf');
      expect((await proto.arrayBuffer()).byteLength).toBe(0);
      expect((await post(url, 'x', { 'content-type': 'application/x-protobuf' })).status).toBe(400);
      const other = await post(url, 'x', { 'content-type': 'text/plain' });
      expect(other.status).toBe(415);
      expect(((await other.json()) as { message: string }).message).toContain('OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf');
      expect((await post(url, { hello: 1 })).status).toBe(400);
      expect((await post(`${rx.endpoint}/v1/metrics`, {})).status).toBe(200);
      expect((await post(`${rx.endpoint}/other`, {})).status).toBe(404);
      expect(rx.stats()).toEqual({ requests: 3, spans: 3, refused: 5, full: false });
      const records = importOtelTraces(rx.batches()).records;
      expect(records.map((r) => [r.question, r.answer])).toEqual([
        ['When do you open?', 'At 8am.'],
        ['Do you treat rabbits?', 'Yes.'],
        ['Is parking free?', 'Yes, behind the clinic.'],
      ]);
    } finally {
      await rx.close();
    }
  });

  it('a port in use is said so', async () => {
    const rx = await startOtlpReceiver({ port: 0 });
    try {
      await expect(startOtlpReceiver({ port: rx.port })).rejects.toThrow(/is in use/);
    } finally {
      await rx.close();
    }
  });
});

describe('testpion rag import --listen', () => {
  it('writes the records of what arrived when the time is up', async () => {
    const p = spawn(process.execPath, [cliPath, 'rag', 'import', '--listen', '0', '--for', '4'], { env: { ...process.env, NO_COLOR: '1' } });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const endpoint = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no listening line: ${err}`)), 15_000);
      p.stderr.on('data', () => {
        const m = /Listening for traces on (http:\/\/127\.0\.0\.1:\d+)\/v1\/traces/.exec(err);
        if (m) {
          clearTimeout(t);
          resolve(m[1]!);
        }
      });
    });
    expect((await post(`${endpoint}/v1/traces`, trace('t9', 'Is parking free?', 'Yes, behind the clinic.'))).status).toBe(200);
    const code = await new Promise<number | null>((resolve) => p.on('close', resolve));
    expect(code).toBe(0);
    expect(err).toMatch(/1 request, 1 span/);
    const lines = out
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { question: string; answer: string });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ question: 'Is parking free?', answer: 'Yes, behind the clinic.' });
  }, 40_000);

  it('says so when nothing arrived, and when neither a file nor --listen is given', async () => {
    const run = (args: string[]) =>
      new Promise<{ code: number | null; err: string }>((resolve) => {
        const p = spawn(process.execPath, [cliPath, ...args], { env: { ...process.env, NO_COLOR: '1' } });
        let err = '';
        p.stderr.on('data', (d) => (err += d));
        p.on('close', (code) => resolve({ code, err }));
      });
    const none = await run(['rag', 'import', '--listen', '0', '--for', '1']);
    expect(none.code).toBe(2);
    expect(none.err).toMatch(/No traces arrived/);
    const neither = await run(['rag', 'import']);
    expect(neither.code).toBe(2);
    expect(neither.err).toMatch(/Give the dataset file, or --listen/);
  }, 40_000);

  it('reads a trace export file in protobuf as it reads one in JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-otlp-'));
    try {
      const file = join(dir, 'traces.binpb');
      writeFileSync(file, protoTrace('Do you board cats?', 'Yes, up to two weeks.'));
      const r = await runCli(['rag', 'import', file, '--json']);
      expect(r.status, r.err).toBe(0);
      const data = JSON.parse(r.out).data as { from: string; records: Array<{ question: string; answer: string }> };
      expect(data.from).toBe('otel');
      expect(data.records.map((x) => [x.question, x.answer])).toEqual([['Do you board cats?', 'Yes, up to two weeks.']]);
      writeFileSync(file, Buffer.from([0xff, 0xff, 0xff, 0x01, 0x02]));
      const bad = await runCli(['rag', 'import', file, '--json']);
      expect(bad.status).not.toBe(0);
      expect(bad.out + bad.err).toContain('Not an OTLP trace export');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
});
