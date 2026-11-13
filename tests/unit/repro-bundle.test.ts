import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { WorkspaceStore, openShareBundle, reproBundle, type Trace } from '../../packages/core/src/index.js';
import { addRun, httpResult } from '../ai/run-fixtures.js';
import { tempDir } from '../helpers';

/**
 * A repro bundle of a run's failures (debugger/repro.ts): the failing HTTP steps as sent and answered, in the share
 * bundle the Debugger opens, with notes that say what failed. Secrets are masked the strict way.
 */
let t: ReturnType<typeof tempDir>;
let store: WorkspaceStore;
const API = 'https://api.example.test';

beforeAll(async () => {
  t = tempDir('tp-repro-', { alias: true });
  store = WorkspaceStore.create(join(t.dir, 'ws'), 'Repro');
  // what the runner keeps of a request: the trace's HTTP span (headers and body as sent, the response)
  const trace = {
    traceId: 'tr-orders',
    name: 'Create order',
    status: 'error',
    startTime: Date.parse('2026-11-01T10:00:00Z'),
    endTime: Date.parse('2026-11-01T10:00:01Z'),
    spans: [
      {
        spanId: 's1',
        traceId: 'tr-orders',
        name: 'POST /orders',
        kind: 'http',
        status: 'error',
        startTime: Date.parse('2026-11-01T10:00:00Z'),
        input: { headers: { Authorization: 'Bearer sk-live-abcdef0123456789abcdef', 'Content-Type': 'application/json' }, body: '{"item":"collar","qty":2}' },
        output: { status: 422, headers: [['content-type', 'application/json']], body: '{"error":"qty must be 1"}' },
      },
    ],
  } as unknown as Trace;
  store.saveTrace(trace, 'http', 'run-1');
  await addRun(store, {
    id: 'run-1',
    name: 'Orders smoke',
    startedAt: '2026-11-01T10:00:00.000Z',
    environment: 'Staging',
    results: [
      httpResult({ id: 'health@1', name: 'Health', url: `${API}/health`, status: 200, body: { status: 'up' }, checks: [{ name: 'status', passed: true }] }),
      {
        ...httpResult({ id: 'order@1', name: 'Create order', method: 'POST', url: `${API}/orders?api_key=sk-live-abcdef0123456789abcdef`, status: 422, body: { error: 'qty must be 1' }, checks: [{ name: 'status is 201', passed: false, message: 'expected 201, got 422', expected: 201, actual: 422 }] }),
        traceId: 'tr-orders',
      },
      { ...httpResult({ id: 'grpc@1', name: 'Say hello', url: 'grpc://x', status: 0, error: { kind: 'NetworkError', message: 'unavailable' } }), type: 'grpc' as never },
    ],
  });
  await addRun(store, { id: 'run-green', startedAt: '2026-11-01T11:00:00.000Z', results: [httpResult({ id: 'health@1', name: 'Health', url: `${API}/health`, status: 200, checks: [{ name: 'status', passed: true }] })] });
});
afterAll(() => {
  store?.close();
  t?.cleanup();
});

describe('a repro bundle of a run', () => {
  it('holds the failed HTTP steps as sent and answered, and notes that say what failed', async () => {
    const r = await reproBundle(store, 'run-1', { notes: 'Seen since the deploy of Friday.' });
    expect(r.name).toBe('repro-run-1.tpbundle');
    expect(r.steps).toEqual([{ id: 'order@1', name: 'Create order', status: 'failed' }]);
    expect(r.skipped).toEqual([{ id: 'grpc@1', name: 'Say hello', why: 'a grpc step: the bundle carries HTTP requests' }]);
    const opened = openShareBundle(r.bytes);
    expect(opened.manifest).toMatchObject({ exchanges: 1, masked: true, hasNotes: true });
    const x = opened.exchanges[0]!;
    expect(x).toMatchObject({ method: 'POST', status: 422, requestBody: '{"item":"collar","qty":2}', responseBody: '{"error":"qty must be 1"}' });
    expect(x.url).toContain('/orders');
    expect(r.notes).toMatch(/^Seen since the deploy of Friday\.\n\n# Repro: Orders smoke/);
    expect(r.notes).toContain('environment Staging');
    expect(r.notes).toContain('answered 422');
    expect(r.notes).toContain('**status is 201**: expected 201, got 422 (expected 201, got 422)');
    expect(r.notes).toContain('- Say hello: a grpc step');
  });

  it('never carries a secret: not in a header, the URL or the notes', async () => {
    const r = await reproBundle(store, 'run-1');
    const opened = openShareBundle(r.bytes);
    const SECRET = 'sk-live-abcdef0123456789abcdef';
    expect(JSON.stringify(opened.exchanges), 'the exchanges').not.toContain(SECRET);
    expect(String(opened.notes ?? ''), 'the notes in the bundle').not.toContain(SECRET);
    expect(r.notes, 'the notes returned').not.toContain(SECRET);
    const x = opened.exchanges[0]!;
    expect(Object.keys(x.requestHeaders).map((k) => k.toLowerCase())).toContain('authorization');
    expect(x.requestHeaders.authorization ?? x.requestHeaders.Authorization).not.toContain('sk-live');
  });

  it('takes every HTTP step with `all`, or the results named', async () => {
    const all = await reproBundle(store, 'run-1', { all: true });
    expect(all.steps.map((s) => s.id)).toEqual(['health@1', 'order@1']);
    expect(openShareBundle(all.bytes).exchanges.map((x) => x.mark)).toEqual([undefined, 'red']);
    const one = await reproBundle(store, 'run-1', { results: ['health@1'] });
    expect(one.steps).toEqual([{ id: 'health@1', name: 'Health', status: 'passed' }]);
    await expect(reproBundle(store, 'run-1', { results: ['nope'] })).rejects.toThrow(/has no result "nope"/);
  });

  it('says so when there is nothing to reproduce', async () => {
    await expect(reproBundle(store, 'run-green')).rejects.toThrow(/has no failed step: nothing to reproduce/);
    await expect(reproBundle(store, 'run-1', { results: ['grpc@1'] })).rejects.toThrow(/a grpc step/);
    await expect(reproBundle(store, 'no-such-run')).rejects.toThrow();
  });
});
