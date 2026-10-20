/**
 * The adapters of the kinds the workspace keeps as JSON: collections and environments (one file each), MCP servers and
 * AI providers (a list in one file), and the saved items of the libraries (gRPC calls, connections, prompts, load tests,
 * evaluations, monitors). Everything incoming is parsed with `parseJsonSafe` and shape-checked before it is believed.
 */
import type { Collection, Environment, LibraryItem, McpServerConfig, ProviderConfig } from '../model/types.js';
import { SCHEMA_VERSION } from '../model/types.js';
import { commandLine } from '../storage/trust.js';
import { slugify, uniqueId } from '../util/ids.js';
import { LIBRARY_OF, SAFE_ID, isPlainId, parseJsonSafe, type BundleKindId } from './format.js';
import { canonicalJson, importedName, mapStrings, replacePaths, type CommitWrite, type ItemAdapter, type JournalSink, type Listed } from './items.js';

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The incoming item's JSON object, or why it is not one. */
function parseObject(data: Buffer): Record<string, unknown> | string {
  try {
    const v = parseJsonSafe(data.toString('utf8'));
    return isObject(v) ? v : 'its content is not a JSON object';
  } catch {
    return 'its content is not valid JSON';
  }
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const byIdOrName = (existing: readonly Listed[], x: { id: string; name: string }): Listed | undefined => existing.find((e) => e.id === x.id) ?? existing.find((e) => same(e.name, x.name));

/** `id`, `id-2` … not in `taken.ids`; the name made "X (imported)" unique in `taken.names`. */
function freshTarget(existing: readonly Listed[], x: { id: string; name: string }, taken: { ids: Set<string>; names: Set<string> }) {
  for (const e of existing) {
    taken.ids.add(e.id);
    taken.names.add(e.name);
  }
  return { id: uniqueId(taken.ids, x.id), name: importedName(taken.names, x.name) };
}

/** The text of every `*Script` field of a JSON value that is not empty: scripts that will run when requests are sent. */
function countScripts(v: unknown): number {
  if (Array.isArray(v)) return v.reduce<number>((n, x) => n + countScripts(x), 0);
  if (!isObject(v)) return 0;
  return Object.entries(v).reduce((n, [k, x]) => n + (/script$/i.test(k) && typeof x === 'string' && x.trim() ? 1 : countScripts(x)), 0);
}

function countRequests(items: unknown): number {
  if (!Array.isArray(items)) return 0;
  return items.reduce<number>((n, x) => n + (isObject(x) && Array.isArray(x.items) ? countRequests(x.items) : 1), 0);
}

/* ------------------------------------------------------------------ collections */

const collection: ItemAdapter = {
  kind: 'collection',
  label: 'Collection',
  list: (store) =>
    store
      .listCollections()
      .filter((c) => !c.problem)
      .map((c) => ({ id: c.id, name: c.name })),
  snapshot(store, id, strip) {
    let c: Collection;
    try {
      c = store.getCollection(id);
    } catch {
      return undefined;
    }
    const { version: _v, updatedAt: _u, ...rest } = strip.collection(c) as Collection & Record<string, unknown>;
    void _v;
    void _u;
    return { id: c.id, name: c.name, data: canonicalJson(rest), summary: { requests: countRequests(c.items), scripts: countScripts(c) } };
  },
  check(item, data) {
    const o = parseObject(data);
    if (typeof o === 'string') return o;
    if (!SAFE_ID.test(item.id)) return `the id "${item.id.slice(0, 40)}" cannot be used as a file name`;
    if (o.id !== item.id) return 'its id does not match the manifest';
    if (!Array.isArray(o.items)) return 'it has no "items" list';
    return undefined;
  },
  review(_item, data) {
    const o = parseObject(data);
    const n = typeof o === 'string' ? 0 : countScripts(o);
    return n ? [`${n} script${n === 1 ? '' : 's'} in the collection run when you send its requests (nothing runs on import)`] : [];
  },
  match: (existing, x) => existing.find((e) => e.id === x.id || slugify(e.id) === slugify(x.id)) ?? existing.find((e) => same(e.name, x.name)),
  fresh: (existing, x, taken) => freshTarget(existing, { id: slugify(x.id), name: x.name }, taken),
  rewrite(_item, data, remap) {
    const o = parseObject(data);
    if (typeof o === 'string') return data;
    return canonicalJson(mapStrings(o, (s, k) => (k === 'server' ? (remap.serverName.get(s) ?? remap.serverId.get(s) ?? s) : replacePaths(s, remap.path))));
  },
  commit(store, writes, journal) {
    for (const w of writes) {
      // a collection kept in a file of another name (by hand, or from an older version) is that file, not a second one
      const file = store.collectionFileOf(w.target.id);
      journal.before(file);
      const c = parseObject(w.data) as unknown as Collection;
      store.saveCollection({ ...c, id: w.target.id, name: w.target.name, schemaVersion: SCHEMA_VERSION, version: 0, updatedAt: '' });
      journal.after(file);
    }
  },
};

/* ------------------------------------------------------------------ environments */

const environment: ItemAdapter = {
  kind: 'environment',
  label: 'Environment',
  list: (store) =>
    store
      .listEnvironments()
      .filter((e) => !e.problem)
      .map((e) => ({ id: e.id, name: e.name })),
  snapshot(store, id, strip) {
    const e = store.listEnvironments().find((x) => x.id === id && !x.problem);
    if (!e) return undefined;
    const { order: _o, problem: _p, ...rest } = strip.environment(e) as Environment;
    void _o;
    void _p;
    return { id: e.id, name: e.name, data: canonicalJson(rest), summary: { variables: e.variables.length, ...(e.isProduction ? { production: 1 } : {}) } };
  },
  check(item, data) {
    const o = parseObject(data);
    if (typeof o === 'string') return o;
    if (!SAFE_ID.test(item.id)) return `the id "${item.id.slice(0, 40)}" cannot be used as a file name`;
    if (o.id !== item.id) return 'its id does not match the manifest';
    if (!Array.isArray(o.variables) || !o.variables.every(isObject)) return 'its variables are not a list of objects';
    return undefined;
  },
  review(item, data) {
    const o = parseObject(data);
    return typeof o !== 'string' && o.isProduction ? [`Environment "${item.name}" is marked production: data-changing requests to it ask first`] : [];
  },
  match: (existing, x) => existing.find((e) => e.id === x.id || slugify(e.id) === slugify(x.id)) ?? existing.find((e) => same(e.name, x.name)),
  fresh: (existing, x, taken) => freshTarget(existing, { id: slugify(x.id), name: x.name }, taken),
  rewrite: (_item, data) => data,
  commit(store, writes, journal) {
    for (const w of writes) {
      const file = `environments/${slugify(w.target.id)}.json`;
      journal.before(file);
      const e = parseObject(w.data) as unknown as Environment;
      store.saveEnvironment({ ...e, id: w.target.id, name: w.target.name });
      journal.after(file);
    }
  },
};

/* ------------------------------------------------------------------ lists kept in one file */

const TRANSPORTS = new Set(['stdio', 'streamable-http', 'sse', 'mock']);

/** Rewrite, add and replace the items of a list: `read` gives the list, `write` saves it whole (once for all writes). */
function commitList<T extends { id: string; name: string }>(
  writes: CommitWrite[],
  read: () => T[],
  write: (list: T[]) => void,
  journal: JournalSink,
  kind: BundleKindId,
  file: 'mcp-servers' | 'providers',
  existingId: (w: CommitWrite) => string | undefined,
) {
  const list = read();
  for (const w of writes) {
    const v = parseObject(w.data) as unknown as T;
    const next = { ...v, id: w.target.id, name: w.target.name };
    const at = list.findIndex((x) => x.id === (existingId(w) ?? w.target.id));
    if (w.op === 'replaced' && at >= 0) {
      journal.listItem({ kind, id: w.target.id, file, before: list[at] });
      list[at] = next;
    } else {
      journal.listItem({ kind, id: w.target.id, file });
      list.push(next);
    }
  }
  write(list);
}

const mcpServer: ItemAdapter = {
  kind: 'mcp-server',
  label: 'MCP server',
  list: (store) => store.getMcpServers().map((s) => ({ id: s.id, name: s.name })),
  snapshot(store, id, strip) {
    const s = store.getMcpServers().find((x) => x.id === id);
    if (!s) return undefined;
    return { id: s.id, name: s.name, data: canonicalJson(strip.mcpServer(s)), summary: { transport: s.transport } };
  },
  check(item, data) {
    const o = parseObject(data);
    if (typeof o === 'string') return o;
    if (!isPlainId(item.id) || o.id !== item.id) return 'its id does not match the manifest';
    if (typeof o.transport !== 'string' || !TRANSPORTS.has(o.transport)) return 'its transport is not one this version knows';
    if (o.transport === 'stdio' && typeof o.command !== 'string') return 'a stdio server needs a command';
    if (o.transport === 'mock' && typeof o.mockFile !== 'string') return 'a mock server needs a mock file';
    if ((o.transport === 'sse' || o.transport === 'streamable-http') && typeof o.url !== 'string') return 'a remote server needs a url';
    return undefined;
  },
  review(item, data) {
    const o = parseObject(data);
    if (typeof o === 'string' || o.transport !== 'stdio') return [];
    const args = Array.isArray(o.args) ? o.args.filter((a): a is string => typeof a === 'string') : [];
    return [`MCP server "${item.name}" starts a program (${commandLine(String(o.command), args).slice(0, 200)}) when you connect: it is not trusted until you allow it`];
  },
  match: byIdOrName,
  fresh: (existing, x, taken) => freshTarget(existing, x, taken),
  rewrite(_item, data, remap) {
    const o = parseObject(data);
    if (typeof o === 'string' || typeof o.mockFile !== 'string') return data;
    return canonicalJson({ ...o, mockFile: replacePaths(o.mockFile, remap.path) });
  },
  commit(store, writes, journal) {
    // a program an import brought is never trusted: the trust list is the user's (storage/trust.ts), nothing here touches it
    commitList<McpServerConfig>(
      writes,
      () => store.getMcpServers(),
      (l) => store.saveMcpServers(l),
      journal,
      'mcp-server',
      'mcp-servers',
      (w) => (w.op === 'replaced' ? w.target.id : undefined),
    );
  },
};

const provider: ItemAdapter = {
  kind: 'provider',
  label: 'AI provider',
  list: (store) => store.getProviders().map((p) => ({ id: p.id, name: p.name })),
  snapshot(store, id, strip) {
    const p = store.getProviders().find((x) => x.id === id);
    return p ? { id: p.id, name: p.name, data: canonicalJson(strip.provider(p)), summary: { kind: p.kind } } : undefined;
  },
  check(item, data) {
    const o = parseObject(data);
    if (typeof o === 'string') return o;
    if (!isPlainId(item.id) || o.id !== item.id) return 'its id does not match the manifest';
    if (typeof o.kind !== 'string' || typeof o.baseUrl !== 'string') return 'it has no kind or base URL';
    if (typeof o.apiKey === 'string' && o.apiKey && !/\{\{.+\}\}/.test(o.apiKey)) return 'it holds a literal API key (providers keep a {{$secret…}} or {{$env…}} reference)';
    return undefined;
  },
  review: () => [],
  match: byIdOrName,
  fresh: (existing, x, taken) => freshTarget(existing, x, taken),
  rewrite: (_item, data) => data,
  commit(store, writes, journal) {
    commitList<ProviderConfig>(
      writes,
      () => store.getProviders(),
      (l) => store.saveProviders(l),
      journal,
      'provider',
      'providers',
      (w) => (w.op === 'replaced' ? w.target.id : undefined),
    );
  },
};

/* ------------------------------------------------------------------ saved items of the libraries */

function libraryAdapter(kind: BundleKindId, label: string): ItemAdapter {
  const library = LIBRARY_OF[kind]!;
  return {
    kind,
    label,
    list: (store) => store.getLibrary(library).items.map((i) => ({ id: i.id, name: i.name })),
    snapshot(store, id, strip) {
      const i = store.getLibrary(library).items.find((x) => x.id === id);
      if (!i) return undefined;
      const { updatedAt: _u, ...rest } = i;
      void _u;
      return { id: i.id, name: i.name, data: canonicalJson({ ...rest, data: strip.data('library', `${library} ${i.name}`, i.data) }) };
    },
    check(item, data) {
      const o = parseObject(data);
      if (typeof o === 'string') return o;
      if (!isPlainId(item.id) || o.id !== item.id) return 'its id does not match the manifest';
      if (typeof o.name !== 'string') return 'it has no name';
      return undefined;
    },
    review: () => [],
    match: (existing, x) => existing.find((e) => e.id === x.id),
    fresh: (existing, x, taken) => {
      for (const e of existing) taken.ids.add(e.id);
      return { id: uniqueId(taken.ids, x.id), name: x.name };
    },
    rewrite(_item, data, remap) {
      const o = parseObject(data);
      if (typeof o === 'string') return data;
      const out = mapStrings(o, (s, k) => (k === 'collectionId' ? (remap.collection.get(s) ?? s) : replacePaths(s, remap.path)));
      // a monitor's or a load test's own collection reference lives inside `data`
      return canonicalJson(out);
    },
    commit(store, writes, journal) {
      const lib = store.getLibrary(library);
      const items = [...lib.items];
      for (const w of writes) {
        const v = parseObject(w.data) as unknown as LibraryItem;
        const next: LibraryItem = { ...v, id: w.target.id, name: w.target.name };
        const at = items.findIndex((x) => x.id === w.target.id);
        if (w.op === 'replaced' && at >= 0) {
          journal.listItem({ kind, id: w.target.id, file: 'library', library, before: items[at] });
          items[at] = next;
        } else {
          journal.listItem({ kind, id: w.target.id, file: 'library', library });
          items.push(next);
        }
      }
      store.saveLibrary(library, { folders: lib.folders, items });
    },
  };
}

export const JSON_ADAPTERS: ItemAdapter[] = [
  collection,
  environment,
  mcpServer,
  provider,
  libraryAdapter('grpc-call', 'gRPC call'),
  libraryAdapter('ws-connection', 'Connection'),
  libraryAdapter('prompt', 'Prompt'),
  libraryAdapter('load-test', 'Load test'),
  libraryAdapter('evaluation', 'Evaluation'),
  libraryAdapter('monitor', 'Monitor'),
];
