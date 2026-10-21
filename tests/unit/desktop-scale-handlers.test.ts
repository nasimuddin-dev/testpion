import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { WorkspaceStore } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';

// The lists the window opens, at the sizes the planning documents name: 10,000 saved requests, 5,000 test files and a full History
// (20,000 rows, the store's bound). Each handler must answer fast and, more to the point, must not hold the main process:
// the longest stall of its event loop is measured while it runs (the window's other calls wait behind it). The ceilings are
// several times what these take on an idle machine, so a loaded one passes and a handler that starts scanning everything per call
// does not.
const tmp = tempDir('tp-scale-handlers-');
let be: Backend;
const REQUESTS = 10_000;
const TEST_FILES = 5_000;
const HISTORY = 20_000;

beforeAll(() => {
  const root = join(tmp.dir, 'ws');
  const s = WorkspaceStore.create(root, 'Scale');
  const folders = 100;
  const items = Array.from({ length: folders }, (_, f) => ({
    kind: 'folder' as const,
    id: `f${f}`,
    name: `Folder ${f}`,
    items: Array.from({ length: REQUESTS / folders }, (_, r) => ({ kind: 'http' as const, id: `r${f}-${r}`, name: `Request ${f}-${r}`, request: { method: 'GET', url: `https://api.example.com/f${f}/r${r}`, headers: [] } })),
  }));
  s.saveCollection({ schemaVersion: '1.0', id: 'big', name: 'Big', version: 1, updatedAt: new Date().toISOString(), variables: [], items } as never);
  mkdirSync(join(root, 'tests', 'many'), { recursive: true });
  for (let i = 0; i < TEST_FILES; i++) writeFileSync(join(root, 'tests', 'many', `t${String(i).padStart(4, '0')}.yaml`), `tests:\n  - { id: t${i}, name: Test ${i}, url: "https://api.example.com/t${i}", assertions: [{ type: status, expected: 200 }] }\n`);
  for (let i = 0; i < HISTORY; i++)
    s.meta.addHistory({
      id: `h${i}`,
      timestamp: new Date(Date.now() - i * 1000).toISOString(),
      kind: 'http',
      name: `Request ${i % 500}`,
      method: 'GET',
      url: `https://api.example.com/items/${i}`,
      status: i % 17 === 0 ? 500 : 200,
      durationMs: 10 + (i % 90),
      size: 100,
      request: { method: 'GET', url: `https://api.example.com/items/${i}`, headers: [] },
    } as never);
  s.close();
  be = new Backend({ appDir: join(tmp.dir, 'app'), emit: () => {}, noMonitors: true });
  be.openStore(root);
}, 120_000);
afterAll(async () => {
  await be.dispose();
  tmp.cleanup();
});

/** Runs a handler and reports its duration and the longest stall of the event loop meanwhile. */
async function timed(method: string, params?: unknown) {
  // a ticker that only runs when the loop is free: the longest gap between its ticks is how long the handler held the process
  let last = performance.now();
  let stall = 0;
  const tick = setInterval(() => {
    const now = performance.now();
    stall = Math.max(stall, now - last - 1);
    last = now;
  }, 1);
  const t0 = performance.now();
  const p = be.invoke(method, params) as Promise<unknown>;
  // what ran before the handler's first wait is synchronous work: nothing else in the process moved meanwhile
  const sync = performance.now() - t0;
  const result = await p;
  const ms = performance.now() - t0;
  stall = Math.max(stall, sync, performance.now() - last - 1);
  clearInterval(tick);
  if (process.env.TP_SCALE_LOG) console.log(`${method} ${JSON.stringify(params ?? {})}: ${Math.round(ms)} ms, longest stall ${Math.round(stall)} ms (synchronous part ${Math.round(sync)} ms)`);
  return { result, ms, stall };
}

describe('the lists at scale: 10,000 requests, 5,000 test files, a full History', () => {
  it('col.tree answers the outline of 10,000 requests', async () => {
    const { result, ms, stall } = await timed('col.tree');
    const c = (result as Array<{ items: unknown[] }>)[0]!;
    expect(c.items.length).toBe(100);
    expect(ms).toBeLessThan(1500);
    expect(stall).toBeLessThan(600);
  });

  it('tests.tree lists 5,000 test files', async () => {
    const { result, ms, stall } = await timed('tests.tree');
    expect(JSON.stringify(result).length).toBeGreaterThan(5000);
    expect(ms).toBeLessThan(1500);
    expect(stall).toBeLessThan(600);
  });

  it('history.list pages a full History: the first page, a deep one and a search', async () => {
    const first = await timed('history.list', { limit: 50 });
    expect((first.result as { items?: unknown[] }).items?.length ?? (first.result as unknown[]).length).toBe(50);
    const deep = await timed('history.list', { limit: 50, offset: 15_000 });
    const search = await timed('history.list', { limit: 50, query: 'items/19' });
    const failed = await timed('history.list', { limit: 50, failed: true });
    for (const t of [first, deep, search, failed]) {
      expect(t.ms).toBeLessThan(800);
      expect(t.stall).toBeLessThan(400);
    }
  });
});
