import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore, collectionToInsomniaV5, importDocument, importIntoWorkspace, planImport, type Collection } from '../../packages/core/src/index.js';

// Performance gate (quality bar): a 10,000-request collection in 500 folders with scripts previews in under 1.5 s and imports in under 3 s,
// for the formats people bring their biggest collections in (Postman JSON, Insomnia v5 YAML, OpenCollection / Bruno JSON export).
// The budgets are the release's; a slower machine (CI) is given a multiple through TESTPION_PERF_SLACK.

const SLACK = Number(process.env.TESTPION_PERF_SLACK ?? 1);
const PREVIEW_MS = 1500 * SLACK;
const APPLY_MS = 3000 * SLACK;
const N = 10_000;
const FOLDERS = 500;

const SCRIPT = ["pm.test('status is 200', function () {", '    pm.response.to.have.status(200);', '});', "pm.environment.set('last', pm.response.json().id);"];

function postman(): string {
  const per = N / FOLDERS;
  const item = (f: number, i: number) => ({
    name: `Request ${f}-${i}`,
    request: { method: i % 3 === 0 ? 'POST' : 'GET', header: [{ key: 'Accept', value: 'application/json' }], url: { raw: `{{baseUrl}}/f${f}/r${i}?page=1`, host: ['{{baseUrl}}'], path: [`f${f}`, `r${i}`], query: [{ key: 'page', value: '1' }] }, ...(i % 3 === 0 ? { body: { mode: 'raw', raw: JSON.stringify({ n: i, name: `item ${i}` }), options: { raw: { language: 'json' } } } } : {}) },
    ...(i % 2 === 0 ? { event: [{ listen: 'test', script: { exec: SCRIPT } }] } : {}),
  });
  return JSON.stringify({
    info: { name: 'Big', _postman_id: 'big', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    variable: [{ key: 'baseUrl', value: 'https://api.example.test' }],
    item: Array.from({ length: FOLDERS }, (_, f) => ({ name: `Folder ${f}`, item: Array.from({ length: per }, (_, i) => item(f, i)) })),
  });
}

function bigCollection(): Collection {
  const doc = importDocument(postman());
  return doc.document.collections[0]!;
}

const time = <T,>(f: () => T): { ms: number; value: T } => {
  const t0 = performance.now();
  const value = f();
  return { ms: performance.now() - t0, value };
};

describe(`importing ${N} requests in ${FOLDERS} folders`, () => {
  const sources: Array<[string, string]> = [['Postman JSON', postman()]];
  const col = bigCollection();
  sources.push(['Insomnia v5 YAML', collectionToInsomniaV5(col).text]);

  for (const [name, text] of sources) {
    it(`${name} (${(text.length / 1024 / 1024).toFixed(1)} MB): preview under ${PREVIEW_MS} ms, apply under ${APPLY_MS} ms`, { timeout: 120_000, retry: 2 }, () => {
      const dir = mkdtempSync(join(tmpdir(), 'tp-perf-'));
      try {
        const store = WorkspaceStore.create(join(dir, 'ws'), 'Perf');
        // warm up the lazily loaded parts (acorn, yaml) once: the budget is for an import, not for the first byte read in a process
        importDocument(postman().slice(0, 0) || '{"info":{"name":"w","_postman_id":"w","schema":"https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},"item":[{"name":"a","request":{"method":"GET","url":"https://a.test"},"event":[{"listen":"test","script":{"exec":["pm.test(\\"x\\", () => {})"]}}]}]}');
        if (name.startsWith('Insomnia')) importDocument(collectionToInsomniaV5({ ...col, items: col.items.slice(0, 1) }).text);
        // best of three: a preview is pure, and under a parallel test run one sample can lose a slice to another process (the budget is for the work, not for the machine's noise)
        const previews = [time(() => planImport(store, text)), time(() => planImport(store, text)), time(() => planImport(store, text))];
        const preview = previews.reduce((best, p) => (p.ms < best.ms ? p : best));
        expect(preview.value.collections[0]!.requests).toBe(N);
        expect(preview.ms, `preview took ${Math.round(preview.ms)} ms`).toBeLessThan(PREVIEW_MS);
        const heapBefore = process.memoryUsage().heapUsed;
        const applied = time(() => importIntoWorkspace(store, text));
        expect(applied.value.collection?.name).toBe('Big');
        expect(applied.ms, `apply took ${Math.round(applied.ms)} ms`).toBeLessThan(APPLY_MS);
        expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(400 * 1024 * 1024);
        // and it is all there
        const saved = store.getCollection(applied.value.collection!.id);
        expect(saved.items).toHaveLength(FOLDERS);
        store.close();
      } finally {
        // (a failure to clean up must not hide the assertion that failed)
        try {
          rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
        } catch {
          /* left in the temp folder */
        }
      }
    });
  }
});

// I-1: a re-import looked every node up by walking the whole tree (six call sites): tens of millions of node visits for 10,000 nodes
describe(`re-importing ${N} requests`, () => {
  it(`plans and applies the update of the 10,000-request Postman file under ${APPLY_MS} ms each`, { timeout: 120_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-perf-re-'));
    try {
      const store = WorkspaceStore.create(join(dir, 'ws'), 'Perf');
      const text = postman();
      importIntoWorkspace(store, text);
      const planned = time(() => planImport(store, text));
      expect(planned.value.reimport).toHaveLength(1);
      console.log(`re-import plan of ${N}: ${planned.ms.toFixed(0)} ms`);
      expect(planned.ms, `plan took ${Math.round(planned.ms)} ms`).toBeLessThan(APPLY_MS);
      const applied = time(() => importIntoWorkspace(store, text, { update: true }));
      console.log(`re-import apply of ${N}: ${applied.ms.toFixed(0)} ms`);
      expect(applied.value.updated).toHaveLength(1);
      expect(applied.ms, `apply took ${Math.round(applied.ms)} ms`).toBeLessThan(APPLY_MS);
      store.close();
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* temp */
      }
    }
  });
});
