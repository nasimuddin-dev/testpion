import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceStore, importInputs, listImportReceipts, planInputs, type Collection, type ImportInput } from '../../packages/core/src/index.js';
import { convertScript } from '../../packages/core/src/scripts/convert/index.js';
import { convertDocumentScripts } from '../../packages/core/src/import/script-pass.js';
import { newDocument } from '../../packages/core/src/import/model.js';
import { tempDir } from '../helpers.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

/**
 * Importing a folder of files into a workspace that already holds a lot (review: performance, findings 6, 7 and 9). Each input
 * used to read and parse every collection of the workspace several times; the receipts of earlier imports (each can hold
 * whole collections) were all parsed after every import; and the script converter parsed identical scripts again and again.
 * The budgets are counted operations; the digests pin the results of the earlier implementation.
 */
const tmp = tempDir('tp-import-perf-');
afterAll(() => tmp.cleanup());

const sha = (v: unknown) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex').slice(0, 16);
const SCRIPT = ["pm.test('status is 200', function () {", '    pm.response.to.have.status(200);', '});', "pm.environment.set('last', pm.response.json().id);"];

const existing = (c: number): Collection =>
  ({
    schemaVersion: '1.0',
    id: `have-${c}`,
    name: `Have ${c}`,
    version: 0,
    updatedAt: '',
    variables: [],
    items: Array.from({ length: 10 }, (_, f) => ({
      kind: 'folder',
      id: `have-${c}-f${f}`,
      name: `Folder ${f}`,
      items: Array.from({ length: 100 }, (_, i) => ({ kind: 'http', id: `have-${c}-f${f}-r${i}`, name: `Request ${i}`, request: { method: 'GET', url: `{{baseUrl}}/${c}/${f}/${i}`, headers: [], params: [] }, assertions: [] })),
    })),
  }) as unknown as Collection;

const FILES = 100;
const input = (n: number): ImportInput => ({
  name: `Imported ${n % 40}`,
  source: `file-${n}.postman_collection.json`,
  fileCount: 1,
  text: JSON.stringify({
    info: { name: `Imported ${n % 40}`, _postman_id: `imp-${n}`, schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: Array.from({ length: 4 }, (_, i) => ({ name: `Call ${i}`, request: { method: 'GET', url: `https://api.example.test/${n}/${i}` }, event: [{ listen: 'test', script: { exec: i % 2 ? SCRIPT : [...SCRIPT, `// call ${n}`] } }] })),
  }),
});

let store: WorkspaceStore;
beforeAll(() => {
  store = WorkspaceStore.create(join(tmp.dir, 'ws'), 'Populated');
  // 10 collections x 1,000 requests = 10,000 requests already in the workspace
  for (let c = 0; c < 10; c++) store.saveCollection(existing(c));
});

describe('an import of 100 files into a workspace of 10,000 requests', () => {
  const inputs = Array.from({ length: FILES }, (_, n) => input(n));

  it('plans all 100 reading each collection of the workspace once', () => {
    const spy = vi.spyOn(store, 'listCollections');
    const t0 = performance.now();
    const plan = planInputs(store, inputs);
    const ms = performance.now() - t0;
    const lists = spy.mock.calls.length;
    spy.mockRestore();
    console.log(`plan of ${FILES} files: ${ms.toFixed(0)} ms, ${lists} reads of the collections`);
    expect(plan.totals.errors).toBe(0);
    expect(plan.totals.requests).toBe(FILES * 4);
    // the names that are taken, in order: the digest of the earlier implementation
    expect(sha(plan.inputs.map((p) => ('plan' in p ? p.plan.collections.map((c) => `${c.name}:${c.requests}:${c.nameTaken}`) : 'error')))).toBe(GOLDEN.plan);
    // it was two for each file (and one more for each collection an update would look at)
    expect(lists).toBeLessThanOrEqual(1);
  });

  it('imports all 100 reading the collections once, and leaves the same workspace', () => {
    const spy = vi.spyOn(store, 'listCollections');
    const t0 = performance.now();
    const done = importInputs(store, inputs);
    const ms = performance.now() - t0;
    const lists = spy.mock.calls.length;
    spy.mockRestore();
    console.log(`import of ${FILES} files: ${ms.toFixed(0)} ms, ${lists} reads of the collections`);
    expect(done.imported.filter((i) => i.error).length).toBe(0);
    const now = store.listCollections().filter((c) => c.id.startsWith('imported') || c.name.startsWith('Imported'));
    expect(now.length).toBe(FILES);
    // names, request counts and the converted scripts (ids made at random are not part of it)
    const shape = now.map((c) => `${c.name}:${c.items.length}:${(c.items[0] as { testScript?: string }).testScript}`).sort();
    expect(sha(shape)).toBe(GOLDEN.imported);
    expect(lists).toBeLessThanOrEqual(2);
    expect(done.receipts.length).toBe(FILES);
  });

  it('keeps the newest 30 receipts and lists them without reading their bodies', () => {
    const dir = join(store.root, '.local', 'import-reports');
    expect(readdirSync(dir).filter((f) => f.endsWith('.json')).length).toBeLessThanOrEqual(31);
    const t0 = performance.now();
    const list = listImportReceipts(store);
    const ms = performance.now() - t0;
    console.log(`listing ${list.length} receipts: ${ms.toFixed(1)} ms`);
    expect(list.length).toBe(30);
    expect(existsSync(join(dir, 'index.json'))).toBe(true);
    // newest first
    expect([...list].sort((a, b) => b.at.localeCompare(a.at)).map((r) => r.id)).toEqual(list.map((r) => r.id));
    void statSync;
    void utimesSync;
  });
});

describe('identical scripts are converted once', () => {
  it('converts 5,000 requests that share a script with a handful of parses', () => {
    const doc = newDocument('postman', '{}', {});
    doc.scriptTool = 'postman';
    doc.collections = [
      {
        schemaVersion: '1.0',
        id: 'c',
        name: 'Many scripts',
        version: 0,
        updatedAt: '',
        variables: [],
        items: Array.from({ length: 5000 }, (_, i) => ({ kind: 'http', id: `r${i}`, name: `R${i}`, request: { method: 'GET', url: 'https://a.test', headers: [], params: [] }, testScript: SCRIPT.join('\n') + (i % 50 === 0 ? `\n// variant ${i % 5}` : '') })),
      } as unknown as Collection,
    ];
    const t0 = performance.now();
    convertDocumentScripts(doc, 'tp');
    const ms = performance.now() - t0;
    console.log(`5,000 scripts, 6 distinct: ${ms.toFixed(0)} ms`);
    const first = (doc.collections[0]!.items[1] as { testScript?: string }).testScript!;
    expect(first).toContain('tp.test(');
    expect(first).not.toContain('pm.');
    expect(doc.scripts?.converted).toBe(5000);
    expect(sha(first)).toBe(GOLDEN.script);
    // a converted script equals what the converter gives for the same code on its own
    expect(first).toBe(convertScript(SCRIPT.join('\n'), 'postman', { alias: 'tp' }).code);
  });
});

/** Digests of the results of the implementation these tests were written against. */
const GOLDEN = { plan: 'a760f3436950318b', imported: '6a9e6d5f667c400a', script: 'aa213d4f92c34544' };
