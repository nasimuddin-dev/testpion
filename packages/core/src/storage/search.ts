import { readdirSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { kindOfLibrary, type ItemRef } from '@testpion/shared';
import type { Collection, CollectionNode } from '../model/types.js';
import { readJson } from './fsutil.js';
import { normalizeCollection } from './normalize.js';
import type { TestFileNode, WorkspaceStore } from './workspace.js';
import { listSpecs } from '../openapi/spec-files.js';
import { pageOf, type ListPage } from '../util/page.js';

export interface SearchHit {
  kind: 'request' | 'graphql' | 'collection' | 'test' | 'environment' | 'environment-variable' | 'mcp-server' | 'provider' | 'history' | 'trace' | 'run' | 'saved' | 'spec' | 'dataset';
  id: string;
  title: string;
  subtitle?: string;
  /**
   * Where it is: an ItemRef (@testpion/shared; `openRef` in the app opens it), plus the older flat names some readers
   * still use (`testPath` of a test file).
   */
  ref: ItemRef & Record<string, string>;
  score: number;
}

/** SOAP is an HTTP request with an XML envelope or a SOAPAction header (as the explorer files it). */
const isSoap = (r: { headers?: Array<{ key: string; value: string }>; body?: unknown }) =>
  !!r.headers?.some((h) => h.key.toLowerCase() === 'soapaction' || (h.key.toLowerCase() === 'content-type' && /application\/soap\+xml/i.test(h.value))) ||
  /<(\w+:)?Envelope[\s>]/.test(String((r.body as { content?: unknown } | undefined)?.content ?? ''));

/** Data files under datasets/ by name (no file is opened: a search must stay cheap). */
function datasetNames(root: string, dir = '', depth = 0, out: string[] = []): string[] {
  if (depth > 3) return out;
  let entries: Dirent[];
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) datasetNames(root, rel, depth + 1, out);
    else if (/\.(csv|tsv|json|jsonl|ndjson|md|db|db3|sqlite|sqlite3)$/i.test(e.name) && !e.name.startsWith('inline-')) out.push(rel);
  }
  return out;
}

interface IndexedDoc {
  hit: Omit<SearchHit, 'score'>;
  /** What is searched; lowercased once, the first time a query reaches the doc (it was lowercased again for every doc on every query). */
  text: string;
  lowered?: { title: string };
}

/**
 * Workspace search. Workspace definitions are indexed in memory and re-indexed only for files whose
 * mtime changed; history, traces and runs are queried through the indexed metadata database.
 */
export class WorkspaceSearch {
  private fileCache = new Map<string, { mtime: number; docs: IndexedDoc[] }>();

  constructor(private store: WorkspaceStore) {}

  private cached(path: string, build: () => IndexedDoc[]): IndexedDoc[] {
    let mtime = 0;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      return [];
    }
    const c = this.fileCache.get(path);
    if (c && c.mtime === mtime) return c.docs;
    const docs = build();
    this.fileCache.set(path, { mtime, docs });
    return docs;
  }

  /**
   * The collections' entries, by file: a file whose time did not change is not read (Quick Open parsed every collection
   * before it looked at this cache). A file named otherwise than its id is indexed too; two files with the same id: the
   * second goes by its file name, as the collection list does.
   */
  private collectionDocs(): IndexedDoc[] {
    const dir = this.store.path('collections');
    let files: string[] = [];
    try {
      files = readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort();
    } catch {
      return [];
    }
    const docs: IndexedDoc[] = [];
    const seen = new Set<string>();
    for (const f of files) {
      const path = join(dir, f);
      const base = f.slice(0, -'.json'.length);
      let mine = this.cached(path, () => this.docsOfCollectionFile(path, base));
      const id = mine[0]?.hit.id;
      if (id && seen.has(id)) mine = this.docsOfCollectionFile(path, base, true);
      if (mine[0]) seen.add(mine[0].hit.id);
      docs.push(...mine);
    }
    return docs;
  }

  private docsOfCollectionFile(path: string, base: string, byFileName = false): IndexedDoc[] {
    let c: Collection;
    try {
      c = normalizeCollection(readJson<Collection>(path));
    } catch {
      return []; // unreadable: the explorer lists it, with why
    }
    if (byFileName || !c.id) c = { ...c, id: base };
    const out: IndexedDoc[] = [{ hit: { kind: 'collection', id: c.id, title: c.name, subtitle: 'Collection', ref: { kind: 'collection', collectionId: c.id } }, text: `${c.name} ${c.description ?? ''}` }];
    const walk = (nodes: CollectionNode[], path: string[]) => {
      for (const n of nodes) {
        if (n.kind === 'folder') walk(n.items, [...path, n.name]);
        else if (n.kind === 'http') {
          // every request under its own protocol: a SOAP call says so (it opens in the HTTP editor, as in the explorer)
          const soap = isSoap(n.request);
          const ref = { kind: 'request' as const, collectionId: c.id, requestId: n.id, protocol: soap ? ('soap' as const) : ('http' as const) };
          out.push({ hit: { kind: 'request', id: n.id, title: n.name, subtitle: `${soap ? 'SOAP ' : ''}${n.request.method} ${n.request.url} · ${[c.name, ...path].join(' / ')}`, ref }, text: `${n.name} ${n.request.method} ${n.request.url}${soap ? ' soap' : ''}` });
        } else if (n.kind === 'graphql')
          out.push({ hit: { kind: 'graphql', id: n.id, title: n.name, subtitle: `GraphQL · ${[c.name, ...path].join(' / ')}`, ref: { kind: 'request', collectionId: c.id, requestId: n.id, protocol: 'graphql' } }, text: `${n.name} ${n.request.query}` });
        // a node of a kind this version doesn't know (a newer app's, a hand edit) is not listed as something it isn't
      }
    };
    walk(c.items, []);
    return out;
  }

  private definitionDocs(): IndexedDoc[] {
    const docs: IndexedDoc[] = this.collectionDocs();
    for (const e of this.store.listEnvironments()) {
      docs.push({ hit: { kind: 'environment', id: e.id, title: e.name, subtitle: `Environment · ${e.variables.length} variable${e.variables.length === 1 ? '' : 's'}`, ref: { kind: 'environment', environmentId: e.id } }, text: `${e.name} environment` });
      for (const v of e.variables)
        docs.push({ hit: { kind: 'environment-variable', id: `${e.id}:${v.key}`, title: v.key, subtitle: `Variable in ${e.name}${v.secret ? ' (secret)' : ''}`, ref: { kind: 'variable', key: v.key, environmentId: e.id } }, text: `${v.key} ${v.secret ? '' : v.value}` });
    }
    for (const s of this.store.getMcpServers()) docs.push({ hit: { kind: 'mcp-server', id: s.id, title: s.name, subtitle: `MCP · ${s.transport}`, ref: { kind: 'mcp-server', serverId: s.id } }, text: `${s.name} ${'command' in s ? s.command : ''} ${'url' in s ? s.url : ''}` });
    for (const p of this.store.getProviders()) docs.push({ hit: { kind: 'provider', id: p.id, title: p.name, subtitle: `AI provider · ${p.kind}`, ref: { kind: 'provider', providerId: p.id } }, text: `${p.name} ${p.kind} ${p.defaultModel ?? ''}` });
    // API definitions and datasets are things of their own (not only something a request or test mentions)
    for (const path of listSpecs(this.store, { includeAsync: true })) docs.push({ hit: { kind: 'spec', id: path, title: path.replace(/^.*\//, ''), subtitle: `API definition · ${path}`, ref: { kind: 'spec', path } }, text: path });
    for (const name of datasetNames(this.store.path('datasets'))) docs.push({ hit: { kind: 'dataset', id: name, title: name.replace(/^.*\//, ''), subtitle: `Dataset · datasets/${name}`, ref: { kind: 'dataset', name } }, text: `datasets/${name}` });
    const walkTests = (nodes: TestFileNode[]) => {
      for (const n of nodes) {
        if (n.kind === 'dir') walkTests(n.children ?? []);
        else
          docs.push(
            ...this.cached(this.store.path('tests', n.path), () => {
              let content = '';
              try {
                content = this.store.readTestFile(n.path).slice(0, 200_000);
              } catch {
                /* ignore */
              }
              const names = [...content.matchAll(/^\s*-?\s*name:\s*(.+)$/gm)].map((m) => m[1]!.trim().replace(/^["']|["']$/g, ''));
              return [{ hit: { kind: 'test', id: n.path, title: names[0] ?? n.name, subtitle: `Test file · ${n.path}${names.length > 1 ? ` · ${names.length} tests` : ''}`, ref: { kind: 'test', path: n.path, testPath: n.path } }, text: `${n.path} ${content}` }];
            }),
          );
      }
    };
    walkTests(this.store.testTree());
    // saved WebSocket connections, gRPC requests, AI prompts … (library/<kind>.json)
    // (the registry's library kinds that can be found: each one's search label)
    for (const kind of this.store.libraryKinds()) {
      const info = kindOfLibrary(kind);
      const label = info?.capabilities.search === true ? info.searchLabel : undefined;
      if (!label) continue;
      docs.push(
        ...this.cached(this.store.path('library', `${kind}.json`), () =>
          this.store.getLibrary<Record<string, unknown>>(kind).items.map((i) => {
            const d = i.data ?? {};
            const detail = String(d.url ?? d.method ?? d.model ?? (kind === 'monitors' && typeof d.everyMinutes === 'number' ? `every ${d.everyMinutes} min` : ''));
            return {
              hit: { kind: 'saved' as const, id: `${kind}:${i.id}`, title: i.name, subtitle: `${label}${i.folder ? ` · ${i.folder}` : ''}${detail ? ` · ${detail}` : ''}`, ref: { kind: 'saved', library: kind, itemId: i.id } },
              text: `${i.name} ${i.folder ?? ''} ${detail} ${String(d.target ?? '')} ${String(d.prompt ?? '').slice(0, 2000)} ${String(d.event ?? '')}`,
            };
          }),
        ),
      );
    }
    return docs;
  }

  search(query: string, limit = 50): SearchHit[] {
    return this.ranked(query).slice(0, limit);
  }

  /** A page of the hits, best first: `limit` (20 unless asked, at most 1,000) from the position `cursor` names. */
  searchPage(query: string, o: { limit?: number; cursor?: string | number } = {}): ListPage<SearchHit> {
    return pageOf(this.ranked(query), o, { limit: 20, max: 1000 });
  }

  private ranked(query: string): SearchHit[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const terms = q.split(/\s+/);
    const hits: SearchHit[] = [];
    for (const d of this.definitionDocs()) {
      if (!d.lowered) {
        d.text = d.text.toLowerCase();
        d.lowered = { title: d.hit.title.toLowerCase() };
      }
      const title = d.lowered.title;
      const text = d.text;
      if (!terms.every((t) => text.includes(t) || title.includes(t))) continue;
      const score = (title === q ? 100 : 0) + (title.startsWith(q) ? 50 : 0) + terms.filter((t) => title.includes(t)).length * 10 + 1;
      hits.push({ ...d.hit, score });
    }
    for (const h of this.store.meta.listHistory({ query, limit: 20 }).items)
      hits.push({ kind: 'history', id: h.id, title: h.name, subtitle: `History · ${h.method ?? h.kind} ${h.url ?? ''} · ${h.status ?? ''}`, ref: { kind: 'history', historyId: h.id }, score: 0.5 });
    for (const t of this.store.meta.listTraces({ query, limit: 10 }).items)
      hits.push({ kind: 'trace', id: t.id, title: t.name, subtitle: `Trace · ${t.kind} · ${t.status}`, ref: { kind: 'trace', traceId: t.id }, score: 0.4 });
    for (const r of this.store.meta.listRuns({ query, limit: 10 }).items)
      hits.push({ kind: 'run', id: r.id, title: r.name, subtitle: `Run · ${r.passed}/${r.total} passed`, ref: { kind: 'run', runId: r.id }, score: 0.3 });
    return hits.sort((a, b) => b.score - a.score);
  }
}
