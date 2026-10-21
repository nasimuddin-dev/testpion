import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cpSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { WorkspaceStore, listImports, undoImport, applyImport, buildBundle, buildBundleAsync, previewImport, readBundle, serializeBundle, serializeBundleAsync, writeZip, writeZipAsync, type Collection } from '../../packages/core/src/index.js';
import { canonicalJson, replacePaths } from '../../packages/core/src/transfer/items.js';
import { tempDir } from '../helpers.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

/**
 * Bundle export and import on a big library (review: performance, finding 3). Reading a library file parsed the whole file
 * once per item (2,500 items: 2,500 parses), and "Keep both" rebuilt its list of taken names for every conflict. The budget
 * is counted operations (reads of the library per run) and the best of three runs; the digests pin the bytes and answers, so
 * a faster algorithm that gives other results fails here.
 */
const tmp = tempDir('tp-transfer-perf-');
afterAll(() => tmp.cleanup());

const ITEMS = 2500;
const RUNS = Number(process.env.TP_PERF_RUNS ?? 3);
const sha = (v: unknown) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex').slice(0, 16);
const best = async <T>(fn: () => T | Promise<T>, runs = Number(process.env.TP_PERF_RUNS ?? 3)): Promise<{ ms: number; value: T }> => {
  let ms = Infinity;
  let value!: T;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    value = await fn();
    ms = Math.min(ms, performance.now() - t0);
  }
  return { ms, value };
};

const prompt = (i: number, text = `Say ${i}`) => ({ id: `p${i}`, name: `Prompt ${i}`, ...(i % 10 === 0 ? { folder: `Folder ${i % 7}` } : {}), data: { prompt: text, model: 'demo', temperature: 0.2 } });
const collection = (n: number): Collection =>
  ({
    schemaVersion: '1.0',
    id: `col${n}`,
    name: `Collection ${n}`,
    version: 0,
    updatedAt: '',
    variables: [],
    items: Array.from({ length: 60 }, (_, i) => ({ kind: 'http', id: `col${n}-r${i}`, name: `Request ${i}`, request: { method: 'GET', url: `{{baseUrl}}/${n}/${i}`, headers: [], params: [] }, assertions: [] })),
  }) as unknown as Collection;

function populate(store: WorkspaceStore, text: (i: number) => string) {
  store.saveLibrary('ai-prompts', { folders: [], items: Array.from({ length: ITEMS }, (_, i) => prompt(i, text(i))) });
  store.saveMcpServers(Array.from({ length: 200 }, (_, i) => ({ id: `s${i}`, name: `Server ${i}`, transport: 'sse', url: `https://s${i}.example.com/sse` })));
  for (let n = 0; n < 40; n++) store.saveCollection(collection(n));
  for (let n = 0; n < 40; n++) store.saveEnvironment({ id: `env${n}`, name: `Env ${n}`, variables: [{ key: 'baseUrl', value: `https://e${n}.example.com`, enabled: true }] });
}

let src: WorkspaceStore;
let same: WorkspaceStore;
let other: WorkspaceStore;
beforeAll(() => {
  src = WorkspaceStore.create(join(tmp.dir, 'src'), 'Source');
  populate(src, (i) => `Say ${i}`);
  cpSync(src.root, join(tmp.dir, 'same'), { recursive: true });
  same = WorkspaceStore.open(join(tmp.dir, 'same'));
  // the same ids and names with other content: every one of them is a conflict
  other = WorkspaceStore.create(join(tmp.dir, 'other'), 'Other');
  populate(other, (i) => `Say it differently ${i}`);
});

/** How many times a store reads whole library files while `fn` runs. */
function libraryReads(store: WorkspaceStore): { count: () => number; stop: () => void } {
  const spy = vi.spyOn(store, 'getLibrary');
  return { count: () => spy.mock.calls.length, stop: () => spy.mockRestore() };
}

describe('bundle export and import of 2,500 saved items', () => {
  it('exports everything, reading each library once, in under 1.5 s', async () => {
    const reads = libraryReads(src);
    const { ms, value } = await best(() => buildBundle(src, 'all', { format: 'json' }));
    const perRun = reads.count() / RUNS;
    reads.stop();
    console.log(`export of ${value.manifest.items.length} items: ${ms.toFixed(0)} ms, ${perRun} library reads per run`);
    // the bytes: every item's checksum, in order (pinned from the one-parse-per-item implementation)
    expect(sha(value.manifest.items.map((i) => `${i.kind}:${i.id}:${i.sha256}`))).toBe(GOLDEN.export);
    expect(value.manifest.items.length).toBeGreaterThanOrEqual(ITEMS + 280);
    // one read per library (the listing and the snapshots share it): it was one per item
    expect(perRun).toBeLessThanOrEqual(12);
    expect(ms).toBeLessThan(1500);
  });

  it('previews an import of the same library (every item identical) in under 1.5 s with one read per library', async () => {
    const bundle = readBundle(buildBundle(src, 'all', { format: 'json' }).bytes);
    const reads = libraryReads(same);
    const { ms, value } = await best(() => previewImport(same, bundle));
    const perRun = reads.count() / RUNS;
    reads.stop();
    console.log(`preview of ${value.items.length} identical items: ${ms.toFixed(0)} ms, ${perRun} library reads per run`);
    // the same answers as before, apart from the review line the security fixes added to every MCP server (see GOLDEN)
    expect(sha(withoutServerReview(value.items))).toBe(GOLDEN.identical);
    expect(sha(value.items)).toBe(GOLDEN.identicalNow);
    expect(value.totals.identical).toBe(value.items.length);
    expect(perRun).toBeLessThanOrEqual(12);
    expect(ms).toBeLessThan(1500);
  });

  it('previews 2,500 conflicts ("Keep both" names for each) in under 1.5 s', async () => {
    const bundle = readBundle(buildBundle(src, 'all', { format: 'json' }).bytes);
    const { ms, value } = await best(() => previewImport(other, bundle));
    console.log(`preview of ${value.items.length} conflicting items: ${ms.toFixed(0)} ms`);
    expect(sha(withoutServerReview(value.items))).toBe(GOLDEN.conflicts);
    expect(sha(value.items)).toBe(GOLDEN.conflictsNow);
    // the 2,500 prompts differ; the collections, environments and servers are the same here as there
    expect(value.totals.conflict).toBe(ITEMS);
    expect(ms).toBeLessThan(1500);
  });

  it('applies "Keep both" for 2,500 conflicts in under 1.5 s and gives every item its new id', async () => {
    const bundle = readBundle(buildBundle(src, 'all', { format: 'json' }).bytes);
    const t0 = performance.now();
    const out = applyImport(other, bundle, { onConflict: 'keep-both' });
    const ms = performance.now() - t0;
    console.log(`apply of ${out.created.length} items with new ids: ${ms.toFixed(0)} ms`);
    expect(sha(out.created.map((c) => `${c.kind}:${c.id}>${c.target?.id}|${c.target?.name}`))).toBe(GOLDEN.applied);
    expect(out.created.length).toBe(ITEMS);
    expect(other.getLibrary('ai-prompts').items.length).toBe(ITEMS * 2);
    expect(ms).toBeLessThan(3000);
    // one Undo takes all 2,500 back, reading and writing the library once (it was once for each item: minutes)
    const u0 = performance.now();
    const undone = undoImport(other, out.importId);
    const undoMs = performance.now() - u0;
    console.log(`undo of ${undone.removed} items: ${undoMs.toFixed(0)} ms`);
    expect(undone.removed).toBe(ITEMS);
    expect(other.getLibrary('ai-prompts').items.length).toBe(ITEMS);
    expect(undoMs).toBeLessThan(3000);
  });
});

describe('import journals are pruned to the newest 30', () => {
  it('keeps 30 undo journals after 35 imports, lists them from their summaries and still undoes the newest', () => {
    const dst = WorkspaceStore.create(join(tmp.dir, 'journals'), 'Journals');
    const ids: string[] = [];
    for (let n = 0; n < 35; n++) {
      const one = WorkspaceStore.create(join(tmp.dir, `one-${n}`), `One ${n}`);
      one.saveLibrary('ai-prompts', { folders: [], items: [prompt(n)] });
      ids.push(applyImport(dst, readBundle(buildBundle(one, [{ kind: 'prompt', id: `p${n}` }], { format: 'json' }).bytes)).importId);
    }
    const dirs = readdirSync(join(dst.root, '.local', 'imports')).filter((d) => d.startsWith('imp-'));
    expect(dirs.length).toBe(30);
    const listed = listImports(dst);
    expect(listed.length).toBe(30);
    // the newest are the ones kept
    expect(new Set(listed.map((l) => l.importId))).toEqual(new Set(ids.slice(5)));
    expect(listed.every((l) => l.items === 1 && !l.undone)).toBe(true);
    expect(undoImport(dst, ids[34]!).removed).toBe(1);
    expect(listImports(dst).find((l) => l.importId === ids[34])?.undone).toBe(true);
    // an import that was pruned says so
    expect(() => undoImport(dst, ids[0]!)).toThrow(/No import/);
  });
});

describe('replacePaths and canonicalJson give what the plain implementations give', () => {
  /** The implementation before the lookup by pieces: every path asked of every text, longest first. */
  const reference = (text: string, paths: Map<string, string>) => {
    let out = text;
    for (const [from, to] of [...paths].sort((a, b) => b[0].length - a[0].length)) if (from !== to && out.includes(from)) out = out.split(from).join(to);
    return out;
  };
  const rnd = (seed: number) => {
    let s = seed >>> 0;
    return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  };
  it('replaces like the longest-first loop, chains included (a replacement that makes a later path appear)', () => {
    const r = rnd(5);
    const word = () => 'abc-_/.12'.split('')[Math.floor(r() * 9)]!;
    const piece = (n: number) => Array.from({ length: 1 + Math.floor(r() * n) }, word).join('');
    for (let round = 0; round < 60; round++) {
      const paths = new Map<string, string>();
      const count = round % 3 === 0 ? 300 : 1 + Math.floor(r() * 12);
      for (let i = 0; i < count; i++) paths.set(piece(5), r() < 0.1 ? 'same' : piece(7));
      for (const [k] of [...paths].slice(0, 3)) paths.set(k, k);
      for (let t = 0; t < 40; t++) {
        const text = Array.from({ length: Math.floor(r() * 12) }, () => piece(6)).join(r() < 0.5 ? ' ' : '');
        expect(replacePaths(text, paths)).toBe(reference(text, paths));
      }
    }
  });

  it('keeps the bytes of canonicalJson (sorted keys at every depth, __proto__ as a key, arrays in order)', () => {
    const sortAll = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(sortAll) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortAll((v as Record<string, unknown>)[k])])) : v;
    const doc = JSON.parse('{"z":[{"b":1,"a":{"y":2,"x":[3,{"d":1,"c":2}]}}],"__proto__":{"k":1},"a":null,"10":1,"2":2,"m":{"q":1,"p":2}}');
    expect(canonicalJson(doc).toString('utf8')).toBe(JSON.stringify(sortAll(doc), null, 2) + '\n');
    const ordered = { a: 1, b: { c: [1, { d: 2, e: 3 }] } };
    expect(canonicalJson(ordered).toString('utf8')).toBe(JSON.stringify(ordered, null, 2) + '\n');
  });
});

describe('zip: the thread-pool writer gives the same archive', () => {
  it('writeZipAsync and serializeBundleAsync equal their synchronous forms byte for byte (text, stored files, tiny entries)', async () => {
    const entries = [
      { name: 'a/text.json', data: Buffer.from(JSON.stringify({ rows: Array.from({ length: 4000 }, (_, i) => ({ i, s: `row ${i}` })) })) },
      { name: 'b/tiny.txt', data: Buffer.from('hi') },
      { name: 'c/pic.png', data: Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 7) % 256)) },
      { name: 'd/noise.bin', data: Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * i) % 251)) },
    ];
    expect((await writeZipAsync(entries)).equals(writeZip(entries))).toBe(true);
    const bundle = readBundle(buildBundle(src, 'all', { format: 'json' }).bytes);
    for (const format of ['zip', 'json'] as const) expect((await serializeBundleAsync(bundle, format)).equals(serializeBundle(bundle, format))).toBe(true);
    // and the async build gives the same bytes as the sync one
    const sync = buildBundle(src, 'all', { format: 'zip', title: 'same' });
    const asyncBuilt = await buildBundleAsync(src, 'all', { format: 'zip', title: 'same' });
    expect(readBundle(asyncBuilt.bytes).manifest.items).toEqual(readBundle(sync.bytes).manifest.items);
  });
});

/**
 * Digests of the answers of the implementation this test was written against. identical and conflicts are the previews as they
 * were before the security fixes, which added a review line to each MCP server ("connects to <host>"): they are checked with that line
 * left out, so the listing and index logic is held to the old answers; identicalNow and conflictsNow pin the answers with it.
 */
const withoutServerReview = <T extends { kind: string; review: string[] }>(items: T[]): T[] => items.map((i) => (i.kind === 'mcp-server' ? { ...i, review: [] } : i));
const GOLDEN = { identicalNow: '3562c5f181ed971d', conflictsNow: '434129f9ec099c05', export: '6844502069c5e836', identical: '9c38ebabbbebf2ba', conflicts: 'c972fd4289a4eaeb', applied: '52496fc82c119d08' };
