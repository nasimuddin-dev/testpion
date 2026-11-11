/**
 * Traces received live (rag import --listen): an application's OpenTelemetry exporter posts OTLP/JSON to 127.0.0.1 and
 * what arrives becomes dataset records. Protobuf and other signals are answered with what to change.
 */
import { spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { importOtelTraces, startOtlpReceiver } from '@testpion/core';
import { cliPath } from '../helpers.js';

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

describe('the OTLP receiver', () => {
  it('takes JSON traces (gzip too), and says what to change for protobuf, other paths and other bodies', async () => {
    const rx = await startOtlpReceiver({ port: 0 });
    try {
      expect(rx.endpoint).toBe(`http://127.0.0.1:${rx.port}`);
      const url = `${rx.endpoint}/v1/traces`;
      const ok = await post(url, trace('t1', 'When do you open?', 'At 8am.'));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ partialSuccess: {} });
      expect((await post(url, gzipSync(JSON.stringify(trace('t2', 'Do you treat rabbits?', 'Yes.'))), { 'content-type': 'application/json', 'content-encoding': 'gzip' })).status).toBe(200);
      const proto = await post(url, 'x', { 'content-type': 'application/x-protobuf' });
      expect(proto.status).toBe(415);
      expect(((await proto.json()) as { message: string }).message).toMatch(/OTEL_EXPORTER_OTLP_PROTOCOL=http\/json/);
      expect((await post(url, { hello: 1 })).status).toBe(400);
      expect((await post(`${rx.endpoint}/v1/metrics`, {})).status).toBe(200);
      expect((await post(`${rx.endpoint}/other`, {})).status).toBe(404);
      expect(rx.stats()).toEqual({ requests: 2, spans: 2, refused: 4, full: false });
      const records = importOtelTraces(rx.batches()).records;
      expect(records.map((r) => [r.question, r.answer])).toEqual([
        ['When do you open?', 'At 8am.'],
        ['Do you treat rabbits?', 'Yes.'],
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
});
