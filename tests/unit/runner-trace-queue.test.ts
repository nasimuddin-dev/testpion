import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChainSecretStore, EnvSecretStore, WorkspaceStore, createEngineContext, defaultSettings, runTests, type RunEvent, type TestCase } from '../../packages/core/src/index.js';

let server: Server;
let base = '';
let dir = '';
beforeAll(async () => {
  server = createServer((_req, res) => res.end('{"ok":true}'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = mkdtempSync(join(tmpdir(), 'tp-trace-queue-'));
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

describe('runner trace persistence', () => {
  it('writes traces in batches off the test path, all of them by the end of the run', async () => {
    const store = WorkspaceStore.create(join(dir, 'ws'), 'Traces');
    const ctx = createEngineContext({ store, secrets: new ChainSecretStore([new EnvSecretStore()]), settings: defaultSettings() });
    const tests: TestCase[] = Array.from(
      { length: 12 },
      (_, i) => ({ id: `t${i}`, name: `T${i}`, type: 'http', request: { method: 'GET', url: `${base}/${i}`, headers: [] }, assertions: [{ type: 'status', equals: 200 }] }) as TestCase,
    );
    const order: string[] = [];
    let batches = 0;
    const saved: string[] = [];
    try {
      const summary = await runTests({
        name: 'q',
        runId: 'run-q',
        tests,
        concurrency: 2,
        services: ctx.services,
        traceMode: 'all',
        traceBatch: (fn) => {
          batches++;
          store.meta.batch(fn);
        },
        onTrace: async (t) => {
          order.push('trace');
          saved.push(store.saveTrace(t, 'test', 'run-q'));
        },
        onEvent: (e: RunEvent) => e.type === 'test-end' && order.push('end'),
      });
      expect(summary.passed).toBe(12);
      expect(saved).toHaveLength(12);
      expect(saved.every((p) => existsSync(join(dir, 'ws', p)))).toBe(true);
      expect(store.meta.listTraces({ limit: 50 }).total).toBe(12);
      // fewer batches than traces, and tests did not wait for their trace
      expect(batches).toBeLessThan(12);
      expect(order.indexOf('trace')).toBeGreaterThan(order.indexOf('end'));
    } finally {
      await ctx.dispose();
      store.close();
    }
  });
});

// R-1: a 500-trace batch was 500 synchronous writes + SHA-1 inside one SQLite transaction (about 750 ms in one block on the main thread)
describe('trace batch persistence', () => {
  const makeTrace = (i: number) => ({
    traceId: `batch-${i}`,
    name: `Trace ${i}`,
    startTime: Date.parse('2026-10-22T10:00:00Z') + i,
    endTime: Date.parse('2026-10-22T10:00:00Z') + i + 5,
    status: 'ok' as const,
    spans: Array.from({ length: 3 }, (_, k) => ({ spanId: `s${k}`, name: `span ${k}`, kind: 'http', startTime: 0, endTime: 1, status: 'ok', attributes: { body: 'x'.repeat(3000) } })),
  });

  it('writes 500 traces with the event loop free: every file and row there, small transactions, no long block', async () => {
    const store = WorkspaceStore.create(join(dir, 'ws-batch'), 'Batch');
    try {
      // rows added inside one transaction
      let widest = 0;
      let inBatch = 0;
      const realBatch = store.meta.batch.bind(store.meta);
      store.meta.batch = ((fn: () => unknown) => {
        inBatch = 0;
        return realBatch(fn);
      }) as typeof store.meta.batch;
      const realAdd = store.meta.addTrace.bind(store.meta);
      store.meta.addTrace = (t) => {
        widest = Math.max(widest, ++inBatch);
        realAdd(t);
      };
      // the longest gap between two turns of the event loop, counted in this thread's CPU time (a thread kept off the CPU by other programs is not a block of ours)
      const cpu = () => {
        const u = process.threadCpuUsage?.();
        return u ? (u.user + u.system) / 1000 : Infinity;
      };
      let worst = 0;
      let last = performance.now();
      let lastCpu = cpu();
      const timer = setInterval(() => {
        const n = performance.now();
        const c = cpu();
        worst = Math.max(worst, Math.min(n - last, c - lastCpu));
        last = n;
        lastCpu = c;
      }, 1);
      const items = Array.from({ length: 500 }, (_, i) => ({ trace: makeTrace(i) as never, kind: 'test', runId: 'run-b' }));
      const t0 = performance.now();
      await store.saveTraces(items);
      const total = performance.now() - t0;
      clearInterval(timer);
      console.log(`500 traces: ${total.toFixed(0)} ms in all, longest event-loop block ${worst.toFixed(0)} ms, widest transaction ${widest} rows`);
      expect(store.meta.listTraces({ limit: 1 }).total).toBe(500);
      expect(existsSync(join(dir, 'ws-batch', 'traces', '2026-10-22', 'batch-499.json'))).toBe(true);
      expect(widest).toBeLessThanOrEqual(50);
      expect(worst, `longest block ${worst.toFixed(0)} ms`).toBeLessThan(50 * Number(process.env.TESTPION_PERF_SLACK ?? 1));
    } finally {
      store.close();
    }
  });
});
