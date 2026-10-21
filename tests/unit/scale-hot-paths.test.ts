import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceStore, createTestPionMcpServer, MemorySecretStore, openMetaStore, kinds, describeKinds, type MetaStore } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/**
 * The hot paths at the sizes a big workspace reaches: 10,000 requests in 50 collections, 100,000 History rows. Each is
 * measured best of five and held to a budget several times what an idle machine needs (the box is shared), so only a
 * scan that should be an index (or a page that reads everything) fails: the numbers are printed for the record.
 */
const t = tempDir('tp-scale-');
const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
let store: WorkspaceStore;
let meta: MetaStore;
const best = async (name: string, fn: () => unknown, runs = 5) => {
  const ms: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    ms.push(performance.now() - t0);
  }
  const b = Math.min(...ms);
  console.log(`${name}: ${b.toFixed(1)} ms`);
  return b;
};

beforeAll(() => {
  mkdirSync(join(t.dir, 'collections'), { recursive: true });
  writeFileSync(join(t.dir, 'workspace.json'), json({ schemaVersion: '1.0', id: 'ws', name: 'Scale', variables: [] }));
  for (let c = 0; c < 50; c++) {
    const items = Array.from({ length: 200 }, (_, i) => ({ kind: 'http', id: `c${c}-r${i}`, name: `Request ${c}.${i}`, request: { method: 'GET', url: `{{baseUrl}}/c${c}/r${i}`, headers: [], params: [] }, assertions: [] }));
    writeFileSync(join(t.dir, 'collections', `c${c}.json`), json({ schemaVersion: '1.0', id: `c${c}`, name: `Collection ${c}`, variables: [], items }));
  }
  store = WorkspaceStore.open(t.dir);
  meta = openMetaStore(join(t.dir, '.meta-scale'));
  meta.batch(() => {
    for (let i = 0; i < 100_000; i++)
      meta.addHistory({ id: `h${i}`, timestamp: new Date(1.7e12 + i * 1000).toISOString(), kind: 'http', name: `GET /r${i % 500}`, status: i % 17 === 0 ? 500 : 200, durationMs: 5 + (i % 90), requestId: `c${i % 50}-r${i % 200}`, request: { method: 'GET', url: `http://x/r${i}` } } as never);
  });
}, 120_000);
afterAll(() => {
  meta?.close();
  store?.close();
  t.cleanup();
});

describe('10,000 requests', () => {
  it('lists the collections and opens each one in well under a second', async () => {
    expect(await best('listCollections (10,000 requests)', () => store.listCollections())).toBeLessThan(1000);
    expect(store.listCollections()).toHaveLength(50);
    expect(await best('getCollection x50', () => { for (let c = 0; c < 50; c++) store.getCollection(`c${c}`); })).toBeLessThan(1000);
  });

  it('builds the MCP server and answers tools/list without touching the workspace', async () => {
    const settings = { redactFields: [] } as never;
    expect(await best('createTestPionMcpServer', () => createTestPionMcpServer({ store, secrets: new MemorySecretStore(), settings }), 3)).toBeLessThan(500);
  });

  it('derives the kind registry (kinds, describeKinds) without a per-call rebuild', async () => {
    expect(await best('kinds() x1000', () => { for (let i = 0; i < 1000; i++) kinds(); })).toBeLessThan(200);
    expect(await best('describeKinds', () => describeKinds({}, store))).toBeLessThan(200);
  });
});

describe('100,000 History rows', () => {
  it('pages, searches and aggregates through the index, not by reading every row', async () => {
    // the History is bounded (the oldest rows are dropped past its cap), so 100,000 inserts leave fewer
    const total = meta.listHistory({ limit: 1 }).total;
    console.log(`History rows kept of 100,000 added: ${total}`);
    expect(total).toBeGreaterThan(1000);
    expect(total).toBeLessThan(100_000);
    expect(await best('listHistory first page', () => meta.listHistory({ limit: 200, brief: true }))).toBeLessThan(100);
    expect(await best('listHistory deep offset', () => meta.listHistory({ limit: 200, offset: 99_000, brief: true }))).toBeLessThan(150);
    expect(await best('listHistory failed only', () => meta.listHistory({ failed: true, limit: 200, brief: true }))).toBeLessThan(250);
    expect(await best('historyByCollection', () => meta.historyByCollection())).toBeLessThan(500);
    expect(await best('activity(30 days)', () => meta.activity({ days: 30 }))).toBeLessThan(500);
    expect(meta.listHistory({ limit: 200, brief: true }).items).toHaveLength(200);
  });
});
