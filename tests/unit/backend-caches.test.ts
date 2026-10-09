import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { collectionTreeOf, gitVersion, repoRoot, watchWorkspace, WorkspaceStore, type Collection, type WorkspaceChange } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';

// What the window reads often is kept light and remembered: the collections' outline (col.tree), the Debugger's
// list (paged), git's answers, the watcher's view of the files (no file read at open).
const tmp = tempDir('tp-caches-');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const backends: Backend[] = [];
afterAll(async () => {
  for (const be of backends) await be.dispose();
  tmp.cleanup();
});

const shop: Collection = {
  schemaVersion: '1.0',
  id: 'shop',
  name: 'Shop',
  version: 0,
  updatedAt: '',
  variables: [{ key: 'base', value: 'http://shop.test' }],
  items: [
    {
      kind: 'folder',
      id: 'f1',
      name: 'Orders',
      preRequestScript: 'tp.variables.set("a", 1)',
      items: [
        {
          kind: 'http',
          id: 'r1',
          name: 'List orders',
          favorite: true,
          request: { method: 'GET', url: '{{base}}/orders', headers: [{ key: 'x-secret', value: 'top' }], body: { mode: 'raw', content: '{"big":true}' } },
          testScript: 'tp.test("ok", () => {})',
          examples: [{ id: 'e1', name: 'OK', status: 200, body: '[]', headers: [] }],
        },
      ],
    },
    {
      kind: 'http',
      id: 'r2',
      name: 'Soap',
      request: { method: 'POST', url: '{{base}}/soap', headers: [{ key: 'SOAPAction', value: 'x' }], body: { mode: 'raw', content: '<Envelope/>' } },
    },
    { kind: 'graphql', id: 'g1', name: 'Query', request: { endpoint: '{{base}}/graphql', query: '{ a }' } },
  ],
} as never;

describe('col.tree: the collections without their weight', () => {
  it('keeps ids, names, methods, URLs, folders, favourites and examples; drops bodies, headers and scripts', () => {
    const t = collectionTreeOf(shop);
    expect(t).toMatchObject({ id: 'shop', name: 'Shop', slim: true, variableCount: 1 });
    expect(t.items[0]).toEqual({
      kind: 'folder',
      id: 'f1',
      name: 'Orders',
      logic: true,
      items: [{ kind: 'http', id: 'r1', name: 'List orders', method: 'GET', url: '{{base}}/orders', favorite: true, examples: [{ id: 'e1', name: 'OK', status: 200 }] }],
    });
    expect(t.items[1]).toMatchObject({ kind: 'http', id: 'r2', soap: true });
    expect(t.items[2]).toEqual({ kind: 'graphql', id: 'g1', name: 'Query', endpoint: '{{base}}/graphql' });
    const text = JSON.stringify(t);
    for (const gone of ['top', 'big', 'tp.test', 'tp.variables']) expect(text).not.toContain(gone);
  });

  it('is served whole or by ids, and an outline is never saved as the collection', async () => {
    const root = join(tmp.dir, 'ws-tree');
    const s = WorkspaceStore.create(root, 'Tree');
    s.saveCollection(shop);
    s.close();
    const be = new Backend({ appDir: join(tmp.dir, 'app-tree'), emit: () => undefined, noMonitors: true });
    backends.push(be);
    be.openStore(root);
    const all = (await be.invoke('col.tree', {})) as Array<{ id: string; slim: boolean }>;
    expect(all.map((c) => [c.id, c.slim])).toEqual([['shop', true]]);
    expect(await be.invoke('col.tree', { ids: ['shop', 'gone'] })).toMatchObject([{ id: 'shop' }, undefined]);
    await expect(be.invoke('col.save', all[0])).rejects.toThrow(/outline/);
    expect(JSON.stringify(await be.invoke('col.get', { id: 'shop' }))).toContain('{\\"big\\":true}');
  });
});

describe('the Debugger list pages', () => {
  it('answers the newest 200 by default, everything with limit 0, older ones with offset', async () => {
    const be = new Backend({ appDir: join(tmp.dir, 'app-dbg'), emit: () => undefined, noMonitors: true });
    backends.push(be);
    const entries = Array.from({ length: 250 }, (_, i) => ({
      startedDateTime: new Date(Date.parse('2026-10-01T10:00:00Z') + i * 1000).toISOString(),
      time: 1,
      request: { method: 'GET', url: `http://api.test/items/${i}`, httpVersion: 'HTTP/1.1', headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: 0 },
      response: { status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', headers: [], cookies: [], content: { size: 0, mimeType: 'text/plain' }, redirectURL: '', headersSize: -1, bodySize: 0 },
      cache: {},
      timings: { send: 0, wait: 1, receive: 0 },
    }));
    await be.invoke('debug.openSession', { text: JSON.stringify({ log: { version: '1.2', creator: { name: 't', version: '1' }, entries } }) });
    type Row = { url: string };
    const page = (await be.invoke('debug.exchanges', {})) as Row[];
    expect(page).toHaveLength(200);
    expect(page[0]!.url).toMatch(/items\/50$/);
    expect(page.at(-1)!.url).toMatch(/items\/249$/);
    expect((await be.invoke('debug.exchanges', { limit: 0 })) as Row[]).toHaveLength(250);
    const older = (await be.invoke('debug.exchanges', { limit: 10, offset: 245 })) as Row[];
    expect(older.map((r) => r.url.split('/').pop())).toEqual(['0', '1', '2', '3', '4']);
    expect((await be.invoke('debug.exchanges', { idsOnly: true })) as string[]).toHaveLength(250);
  });
});

describe('git answers are remembered', () => {
  it('asks git for its version once per process', async () => {
    expect(gitVersion()).toBe(gitVersion());
    await gitVersion();
  });

  it('remembers a folder outside any repository until a .git appears in it', async () => {
    if (!(await gitVersion())) return;
    const dir = join(tmp.dir, 'plain');
    mkdirSync(dir, { recursive: true });
    // the temp folder itself may sit inside a repository on some machines: then there is nothing to remember
    if (await repoRoot(dir)) return;
    const t = performance.now();
    for (let i = 0; i < 20; i++) expect(await repoRoot(dir)).toBeUndefined();
    expect(performance.now() - t).toBeLessThan(200); // no git spawned for these
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    for (const d of ['objects', 'refs']) mkdirSync(join(dir, '.git', d));
    expect(await repoRoot(dir)).toBeTruthy();
  });
});

describe('the watcher reads no file at open', () => {
  it('notices a changed file by its size and time, and a same-bytes rewrite after that by its content', async () => {
    const root = join(tmp.dir, 'watched');
    mkdirSync(join(root, 'collections'), { recursive: true });
    const file = join(root, 'collections', 'a.json');
    writeFileSync(file, '{"v":1}');
    const batches: WorkspaceChange[][] = [];
    const stop = watchWorkspace(root, (b) => batches.push(b), { debounceMs: 100 });
    try {
      await sleep(200);
      // only the access time moves: no change
      readFileSync(file);
      utimesSync(file, new Date(), statSync(file).mtime);
      await sleep(500);
      expect(batches.flat()).toEqual([]);
      writeFileSync(file, '{"v":2}');
      await sleep(500);
      expect(batches.flat().map((c) => c.path)).toEqual(['collections/a.json']);
      // the content is known from the first event on: the same bytes again are no change
      writeFileSync(file, '{"v":2}');
      await sleep(500);
      expect(batches.flat().map((c) => c.path)).toEqual(['collections/a.json']);
    } finally {
      stop();
    }
  });
});
