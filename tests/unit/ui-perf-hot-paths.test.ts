import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceStore, gitRefsStamp, gitStatus, pageRunResults, saveMonitor, type Collection } from '../../packages/core/src/index.js';
import { readJsonShared, readJson } from '../../packages/core/src/storage/fsutil.js';
import { openMetaStore } from '../../packages/core/src/storage/metastore.js';
import { WorkspaceSearch } from '../../packages/core/src/storage/search.js';
import { cachedAttention, filesSignature } from '../../apps/desktop/backend/stats-cache.js';
import { mergeEventBatch, mergeEvents, MAX_MCP_EVENTS, type McpEvent } from '../../apps/desktop/src/lib/mcp-events.js';
import { appendCapped } from '../../apps/desktop/src/lib/capped.js';
import { tempDir } from '../helpers.js';

// The hot paths of the UI performance audit (2026-10-21): what the window asks for often is answered from what was
// already read (F-26, F-28, F-30), and the merges it does per event batch stay linear (F-5, F-16).
const tmp = tempDir('tp-ui-perf-');
afterAll(() => tmp.cleanup());

const bigCollection = (id: string, n: number): Collection =>
  ({
    schemaVersion: '1.0',
    id,
    name: id,
    version: 0,
    updatedAt: '',
    variables: [],
    items: Array.from({ length: n }, (_, i) => ({ kind: 'http', id: `r${i}`, name: `Request ${i}`, request: { method: 'POST', url: `https://api.test/items/${i}`, headers: [{ key: 'accept', value: 'application/json' }], body: { mode: 'raw', content: JSON.stringify({ i, text: 'x'.repeat(200) }) } } })),
  }) as never;

describe('parsed workspace files are shared while unchanged (F-30)', () => {
  it('the engine context reads a ~1.4 MB collection 100 times and parses it once', () => {
    const store = WorkspaceStore.create(join(tmp.dir, 'big'), 'Big');
    store.saveCollection(bigCollection('big', 4000));
    const view = store.collectionView('big');
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) expect(store.collectionView('big')).toBe(view);
    const ms = performance.now() - t0;
    expect(ms, `100 reads took ${Math.round(ms)} ms`).toBeLessThan(150);
    expect(Object.isFrozen(view.items[0])).toBe(true);
    expect(view.items).toHaveLength(4000);
    // getCollection answers an object of the caller's own, as before
    expect(store.getCollection('big')).not.toBe(store.getCollection('big'));
    const file = store.path('collections', 'big.json');
    expect(readJsonShared(file)).toBe(readJsonShared(file));
    expect(Object.isFrozen(readJsonShared<{ items: object[] }>(file).items[0])).toBe(true);
    // readJson still gives an object of the caller's own
    expect(readJson(file)).not.toBe(readJson(file));
  });

  it('a saved collection is read again (the cache follows the file)', () => {
    const store = WorkspaceStore.create(join(tmp.dir, 'save'), 'Save');
    store.saveCollection(bigCollection('c', 3));
    expect(store.collectionView('c').items).toHaveLength(3);
    store.saveCollection(bigCollection('c', 5));
    expect(store.collectionView('c').items).toHaveLength(5);
    expect(store.collectionView('c').version).toBe(store.getCollection('c').version);
    // what a caller changes on its copy does not reach the next reader
    const c = store.getCollection('c');
    c.items.push(c.items[0]!);
    c.name = 'changed';
    expect(store.getCollection('c').items).toHaveLength(5);
    expect(store.getCollection('c').name).toBe('c');
  });

  it('the environment view answers as getEnvironment does, and follows a save', () => {
    const store = WorkspaceStore.create(join(tmp.dir, 'envs'), 'Envs');
    for (let i = 0; i < 30; i++) store.saveEnvironment({ id: `env-${i}`, name: `Env ${i}`, variables: [{ key: 'k', value: String(i) }] } as never);
    for (const q of ['env-7', 'Env 12', 'env 3', 'nope']) expect(store.environmentView(q)).toEqual(store.getEnvironment(q));
    expect(store.environmentView('env-7')).toBe(store.environmentView('env-7'));
    store.saveEnvironment({ id: 'env-7', name: 'Env 7', variables: [{ key: 'k', value: 'changed' }] } as never);
    expect(store.environmentView('env-7')?.variables[0]?.value).toBe('changed');
  });
});

describe('stats.attention is answered from its cache after an unrelated change (F-26)', () => {
  it('keys on the files it reads, not on every data.changed', async () => {
    const store = WorkspaceStore.create(join(tmp.dir, 'att'), 'Att');
    for (let i = 0; i < 50; i++) store.saveCollection(bigCollection(`c${i}`, 20));
    saveMonitor(store, { id: 'm1', name: 'Health', collectionId: 'c0', everyMinutes: 5, enabled: true });
    const first = cachedAttention(store);
    await first;
    // a run's results (no workspace file) changes nothing it reads: the same answer, not computed again
    mkdirSync(store.path('runs', 'run-x'), { recursive: true });
    writeFileSync(store.path('runs', 'run-x', 'results.jsonl'), '{}\n');
    expect(cachedAttention(store)).toBe(first);
    // a collection saved: computed again
    store.saveCollection(bigCollection('c1', 21));
    expect(cachedAttention(store)).not.toBe(first);
    // a monitor's result appended: computed again
    const second = cachedAttention(store);
    mkdirSync(store.path('runs', 'monitors'), { recursive: true });
    writeFileSync(store.path('runs', 'monitors', 'm1.jsonl'), JSON.stringify({ monitorId: 'm1', runId: 'r', startedAt: new Date().toISOString(), status: 'failed', total: 1, passed: 0, failed: 1, errors: 0 }) + '\n');
    const third = cachedAttention(store);
    expect(third).not.toBe(second);
    expect((await third).some((a) => a.kind === 'monitor')).toBe(true);
    expect(filesSignature(join(tmp.dir, 'no-such-folder'))).toBe('');
  });
});

describe("a run's results are paged from an index (F-28)", () => {
  it('pages a 50,000-line results file without reading it all again', async () => {
    const store = WorkspaceStore.create(join(tmp.dir, 'runs'), 'Runs');
    const dir = store.runDir('run-big');
    mkdirSync(dir, { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < 50_000; i++) lines.push(JSON.stringify({ id: `t${i}`, name: `Test ${i} ✓`, type: 'http', status: i % 10 ? 'passed' : 'failed', checks: [], latencyMs: i % 300, output: 'y'.repeat(100) }));
    writeFileSync(join(dir, 'results.jsonl'), lines.join('\n') + '\n');
    const first = await pageRunResults(store, { runId: 'run-big', limit: 200 });
    expect(first.total).toBe(50_000);
    expect(first.items.map((r) => r.id)).toEqual(Array.from({ length: 200 }, (_, i) => `t${i}`));
    let t0 = performance.now();
    const again = await pageRunResults(store, { runId: 'run-big', limit: 200, offset: 49_900 });
    const ms = performance.now() - t0;
    expect(again.items.map((r) => r.id)).toEqual(Array.from({ length: 100 }, (_, i) => `t${49_900 + i}`));
    // ceilings loose enough for a busy machine (a whole-file parse of these 50,000 lines takes several hundred ms)
    expect(ms, `a page from the index took ${Math.round(ms)} ms`).toBeLessThan(150);
    t0 = performance.now();
    const failed = await pageRunResults(store, { runId: 'run-big', status: 'failed', query: 'test 1', limit: 10 });
    expect(performance.now() - t0).toBeLessThan(250);
    expect(failed.items.every((r) => r.status === 'failed' && r.name.toLowerCase().includes('test 1'))).toBe(true);
    expect(failed.total).toBe(lines.filter((l) => /"status":"failed"/.test(l) && /"name":"Test 1/.test(l)).length);
    // the file grows (a run still writing): the index follows
    writeFileSync(join(dir, 'results.jsonl'), lines.join('\n') + '\n' + JSON.stringify({ id: 'tLast', name: 'Last', type: 'http', status: 'passed', checks: [] }) + '\n');
    expect((await pageRunResults(store, { runId: 'run-big', query: 'last' })).items.map((r) => r.id)).toEqual(['tLast']);
  });
});

describe('the window merges event batches in linear time (F-5, F-16)', () => {
  const ev = (i: number, t = i): McpEvent => ({ id: `e${i}`, timestamp: t, direction: 'incoming', method: 'tools/call', kind: 'response' });
  it('10,000 MCP events in 100 batches merge in well under 50 ms per batch, in order, capped', () => {
    let state: Record<string, McpEvent[]> = {};
    const t0 = performance.now();
    for (let b = 0; b < 100; b++) state = mergeEventBatch(state, Array.from({ length: 100 }, (_, i) => ({ serverId: b % 2 ? 'a' : 'b', event: ev(b * 100 + i) })));
    const ms = performance.now() - t0;
    expect(ms, `100 batches took ${Math.round(ms)} ms`).toBeLessThan(500);
    expect(state.a).toHaveLength(MAX_MCP_EVENTS);
    expect(state.a!.every((e, i, a) => !i || a[i - 1]!.timestamp <= e.timestamp)).toBe(true);
    // a duplicate batch changes nothing (the same list: no render)
    const a = state.a!;
    expect(mergeEvents(a, [a[10]!])).toBe(a);
    // one out of order is put in its place
    expect(mergeEvents([ev(1), ev(3)], [ev(2)]).map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
  });

  it('the console log keeps the entries it keeps (their rows stay mounted) and drops the oldest past the cap', () => {
    const list = Array.from({ length: 500 }, (_, i) => ({ i }));
    const next = appendCapped(list, [{ i: 500 }, { i: 501 }], 500);
    expect(next).toHaveLength(500);
    expect(next[0]).toBe(list[2]);
    expect(next[497]).toBe(list[499]);
    expect(appendCapped([], Array.from({ length: 700 }, (_, i) => i), 500)[0]).toBe(200);
  });
});

describe('the second pass (F-25, F-32, F-35)', () => {
  it('git.status carries the commit HEAD points at, and a stamp of the branches that moves with them, also outside the app', async () => {
    const dir = join(tmp.dir, 'repo');
    mkdirSync(dir, { recursive: true });
    const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'e2e@example.com');
    git('config', 'user.name', 'e2e');
    writeFileSync(join(dir, 'a.txt'), 'a');
    git('add', '-A');
    git('commit', '-q', '-m', 'one');
    const st = await gitStatus(dir);
    expect(st.head).toBe(git('rev-parse', 'HEAD').trim());
    const before = await gitRefsStamp(dir);
    expect(await gitRefsStamp(dir)).toBe(before); // nothing moved: the same stamp
    // a branch made in a terminal: another stamp, the same HEAD
    await new Promise((r) => setTimeout(r, 30));
    git('branch', 'feature');
    expect(await gitRefsStamp(dir)).not.toBe(before);
    expect((await gitStatus(dir)).head).toBe(st.head);
    // a commit (as a merge made outside the app): HEAD moves
    writeFileSync(join(dir, 'a.txt'), 'b');
    git('commit', '-qam', 'two');
    expect((await gitStatus(dir)).head).not.toBe(st.head);
  });

  it('a folder of test files moves in one call (written first, then the old folder removed)', () => {
    const store = WorkspaceStore.create(join(tmp.dir, 'moves'), 'Moves');
    for (let i = 0; i < 50; i++) store.writeTestFile(`old/sub/t${i}.yaml`, `name: t${i}\n`);
    writeFileSync(store.path('tests', 'old', 'data.bin'), Buffer.from([0, 1, 2, 255]));
    const moved = store.moveTestPath('old', 'new/place');
    expect(moved).toHaveLength(51);
    expect(store.readTestFile('new/place/sub/t7.yaml')).toBe('name: t7\n');
    expect([...readFileSync(store.path('tests', 'new', 'place', 'data.bin'))]).toEqual([0, 1, 2, 255]);
    expect(existsSync(store.path('tests', 'old'))).toBe(false);
    // never onto another folder; a single file renames
    store.writeTestFile('x/a.yaml', 'a: 1\n');
    expect(() => store.moveTestPath('x', 'new')).toThrow(/exists already/);
    expect(store.moveTestPath('x/a.yaml', 'x/b.yaml')).toEqual([{ from: 'x/a.yaml', to: 'x/b.yaml' }]);
    expect(store.readTestFile('x/b.yaml')).toBe('a: 1\n');
  });

  it('Quick Open reads only the collection files that changed, and finds one whose file is named otherwise', () => {
    const store = WorkspaceStore.create(join(tmp.dir, 'search'), 'Search');
    for (let i = 0; i < 30; i++) store.saveCollection(bigCollection(`c${i}`, 300));
    // a file named otherwise than the id it holds (by hand, an older version)
    writeFileSync(store.path('collections', 'by-hand.json'), JSON.stringify({ ...bigCollection('handmade', 2), name: 'Handmade' }));
    const index = new WorkspaceSearch(store);
    expect(index.search('Handmade').some((h) => h.kind === 'collection' && h.id === 'handmade')).toBe(true);
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) index.search('Request 7');
    const ms = performance.now() - t0;
    // 30 × 300 requests were parsed for every search; now a stat per file
    expect(ms, `20 searches took ${Math.round(ms)} ms`).toBeLessThan(1500);
  });

  it('the JSON-lines fallback store keeps the database limits, loads in one pass and pages from its end', () => {
    const dir = join(tmp.dir, 'jsonl');
    mkdirSync(join(dir, 'database.sqlite'), { recursive: true }); // the database cannot open: the fallback store
    const meta = openMetaStore(dir);
    expect(meta.backend).toBe('jsonl');
    const at = (i: number) => new Date(1_700_000_000_000 + i * 1000).toISOString();
    for (let i = 0; i < 20_500; i++) meta.addHistory({ id: `h${i}`, timestamp: at(i), kind: 'http', name: `R${i}`, method: 'GET', url: `https://x/${i}`, status: 200 });
    // one out of order goes in its place
    meta.addHistory({ id: 'late', timestamp: at(10_000), kind: 'http', name: 'late', status: 200 });
    expect(meta.listHistory({ limit: 1 }).total).toBe(20_000);
    expect(meta.listHistory({ limit: 3 }).items.map((h) => h.id)).toEqual(['h20499', 'h20498', 'h20497']);
    // a page is read from the end of the list kept in order (it sorted all 20,000 per page before)
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) meta.listHistory({ limit: 100, offset: i * 100 });
    expect(performance.now() - t0, '50 pages').toBeLessThan(250);
    meta.close();
    // read again: one pass, the same newest first
    const l0 = performance.now();
    const again = openMetaStore(dir);
    expect(performance.now() - l0, 'load').toBeLessThan(2000);
    expect(again.listHistory({ limit: 1 }).items[0]!.id).toBe('h20499');
    expect(again.listHistory({ limit: 1 }).total).toBe(20_000);
    again.close();
  });
});
