import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  collectionToInsomniaV5,
  collectionToOpenCollectionBundle,
  detectFormat,
  exportPostmanCollection,
  importDocument,
  type Collection,
  type CollectionNode,
} from '../../packages/core/src/index.js';

// The collection corpus: 80 files, eight API collections (a pet store, payments, a code host, chat, maps, weather, a bank with
// OAuth 2, a vet clinic) in the file formats of ten exports (tests/fixtures/import/corpus/generate.mjs). Every file imports with
// the counts it should have, its scripts are tp.*, nothing is dropped silently, and the collection goes out to Postman, Insomnia
// and OpenCollection and comes back with the same requests.

const dir = resolve(__dirname, '..', 'fixtures', 'import', 'corpus');
const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as Record<string, { tool: string; domain: string; requests: number; folders: number; environments: number; tests: number }>;
const FORMAT: Record<string, string> = { postman: 'postman', 'insomnia-v5': 'insomnia', 'insomnia-v4': 'insomnia', opencollection: 'opencollection', bruno: 'bruno', hoppscotch: 'hoppscotch', thunder: 'thunder', yaak: 'yaak', httpie: 'httpie', apidog: 'apidog' };

const flat = (nodes: CollectionNode[]): CollectionNode[] => nodes.flatMap((n) => (n.kind === 'folder' ? [n, ...flat(n.items)] : [n]));
const requests = (c: Collection) => flat(c.items).filter((n) => n.kind !== 'folder');
const folders = (c: Collection) => flat(c.items).filter((n) => n.kind === 'folder');
const urlOf = (n: CollectionNode) => (n.kind === 'http' ? n.request.url : n.kind === 'graphql' ? n.request.endpoint : '');
const methodOf = (n: CollectionNode) => (n.kind === 'http' ? n.request.method : n.kind === 'graphql' ? 'POST' : '');
/** A request by what survives every format: method and name (a URL's query and variable forms differ). */
const key = (n: CollectionNode) => `${methodOf(n)} ${n.name}`;

describe('the corpus', () => {
  it('has at least 50 collections, from every tool', () => {
    expect(Object.keys(index).length).toBeGreaterThanOrEqual(50);
    expect(new Set(Object.values(index).map((x) => x.tool)).size).toBe(10);
    expect(new Set(Object.values(index).map((x) => x.domain)).size).toBe(8);
  });

  for (const [file, want] of Object.entries(index)) {
    describe(file, () => {
      const text = readFileSync(join(dir, ...file.split('/')), 'utf8');
      const { document, report } = importDocument(text);
      const c = document.collections[0]!;

      it('is detected, and imports with the folders, requests and environments it holds', () => {
        expect(detectFormat(text)).toBe(FORMAT[want.tool]);
        expect(c.name.length).toBeGreaterThan(0);
        expect(requests(c)).toHaveLength(want.requests);
        expect(folders(c)).toHaveLength(want.folders);
        expect(document.environments).toHaveLength(want.environments);
      });

      it('keeps method, URL and scripts: every request has a URL, tests are tp.*, and nothing is dropped silently', () => {
        for (const r of requests(c)) {
          expect(methodOf(r), r.name).toMatch(/^[A-Z]+$/);
          expect(urlOf(r).length, r.name).toBeGreaterThan(0);
        }
        // scripts speak TestPion's API (assertions of the tools' own no-code forms became checks or tests)
        const scripts = JSON.stringify(c.items, (k, v) => (k === 'testScript' || k === 'preRequestScript' ? v : k === 'items' || typeof v !== 'string' || /^(kind|id|name|url|method)$/.test(k) ? v : undefined));
        expect(scripts).not.toMatch(/\b(pm|insomnia|pw|hopp|tc)\.(test|expect|response|environment|variables)/);
        const withTests = requests(c).filter((r) => (r.kind === 'http' && (r.testScript || r.assertions?.length)) || (r.kind === 'graphql' && r.testScript));
        expect(withTests.length, 'requests with tests').toBe(want.tests);
        // nothing "not imported" in a collection of these ordinary shapes
        expect(report.findings.filter((f) => f.severity === 'not-imported').map((f) => f.message)).toEqual([]);
      });

      it('goes out as Postman, Insomnia and OpenCollection and comes back with the same requests', () => {
        const want2 = requests(c).map(key).sort();
        const postman = importDocument(JSON.stringify(exportPostmanCollection(c).collection)).document.collections[0]!;
        expect(requests(postman).map(key).sort(), 'postman').toEqual(want2);
        const insomnia = importDocument(collectionToInsomniaV5(c).text).document.collections[0]!;
        expect(requests(insomnia).map(key).sort(), 'insomnia').toEqual(want2);
        const oc = importDocument(collectionToOpenCollectionBundle(c).text).document.collections[0]!;
        expect(requests(oc).map(key).sort(), 'opencollection').toEqual(want2);
        // and the folders
        expect(folders(postman).map((f) => f.name).sort()).toEqual(folders(c).map((f) => f.name).sort());
        expect(folders(insomnia)).toHaveLength(folders(c).length);
        expect(folders(oc)).toHaveLength(folders(c).length);
      });
    });
  }
});
