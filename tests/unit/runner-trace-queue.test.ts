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
