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
import { canonicalJson, importedName, listIndex, mapStrings, replacePaths, seedOnce, type CommitWrite, type ItemAdapter, type JournalSink, type Listed } from './items.js';
import { isRecord } from '@testpion/shared';
import { partialCollection, splitPartId } from './parts.js';

/** The incoming item's JSON object, or why it is not one. */
function parseObject(data: Buffer): Record<string, unknown> | string {
  try {
    const v = parseJsonSafe(data.toString('utf8'));
    return isRecord(v) ? v : 'its content is not a JSON object';
  } catch {
    return 'its content is not valid JSON';
  }
}

const byIdOrName = (existing: readonly Listed[], x: { id: string; name: string }): Listed | undefined => {
  const ix = listIndex(existing);
  return ix.byId.get(x.id) ?? ix.byName.get(x.name.toLowerCase());
};
/** The counterpart of a collection or environment: the same id (or the same id once slugified), else the same name. */
const byIdSlugOrName = (existing: readonly Listed[], x: { id: string; name: string }): Listed | undefined => {
  const ix = listIndex(existing);
  return ix.bySlug.get(slugify(x.id)) ?? ix.byName.get(x.name.toLowerCase());
};

/** `id`, `id-2` … not in `taken.ids`; the name made "X (imported)" unique in `taken.names` (kept in lowercase). */
function freshTarget(existing: readonly Listed[], x: { id: string; name: string }, taken: { ids: Set<string>; names: Set<string> }) {
  // what is here is added once, not for every conflict
  seedOnce(taken.ids, () => {
    for (const e of existing) {
      taken.ids.add(e.id);
      taken.names.add(e.name.toLowerCase());
    }
  });
  return { id: uniqueId(taken.ids, x.id), name: importedName(taken.names, x.name) };
}

/** The item with this id in a library's list: an index made once per list (the list is read once per run), not a scan for each item. */
const itemIndexes = new WeakMap<readonly LibraryItem[], Map<string, LibraryItem>>();
function byIdIn(items: readonly LibraryItem[], id: string): LibraryItem | undefined {
  let ix = itemIndexes.get(items);
  if (!ix) {
    itemIndexes.set(items, (ix = new Map()));
    for (const i of items) if (!ix.has(i.id)) ix.set(i.id, i);
  }
  return ix.get(id);
}

/** The text of every `*Script` field of a JSON value that is not empty: scripts that will run when requests are sent. */
function countScripts(v: unknown): number {
  if (Array.isArray(v)) return v.reduce<number>((n, x) => n + countScripts(x), 0);
  if (!isRecord(v)) return 0;
  return Object.entries(v).reduce((n, [k, x]) => n + (/script$/i.test(k) && typeof x === 'string' && x.trim() ? 1 : countScripts(x)), 0);
}

function countRequests(items: unknown): number {
  if (!Array.isArray(items)) return 0;
  return items.reduce<number>((n, x) => n + (isRecord(x) && Array.isArray(x.items) ? countRequests(x.items) : 1), 0);
}

/**
 * References an imported provider or remote MCP server must not carry: `{{$secret…}}` / `{{$env…}}` (and a variable
 * that may hold a key) would be resolved on this computer and sent to the address the bundle names. They become
 * "values to enter": the person types the key after the import.
 */
const REFERENCE = /\{\{/;
const SECRET_REFERENCE = /\{\{\s*\$(secret|env)\b/i;

/** The host an address points to (lower case), or undefined when it is not a URL. */
function hostOf(address: unknown): string | undefined {
  if (typeof address !== 'string') return undefined;
  try {
    return new URL(address).host.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

type Header = { key: string; value: string; enabled?: boolean };
const headersOf = (v: unknown): Header[] => (Array.isArray(v) ? v.filter((h): h is Header => isRecord(h) && typeof h.key === 'string' && typeof h.value === 'string') : []);

/** Headers as imported: a value that is a reference is replaced by the person's own value for that header (or emptied); nothing but key, value and enabled is kept. */
const importedHeaders = (v: unknown, keep: readonly Header[] = []): Header[] =>
  headersOf(v).map((h) => ({ key: h.key, value: REFERENCE.test(h.value) ? (keep.find((k) => k.key.toLowerCase() === h.key.toLowerCase() && !REFERENCE.test(k.value))?.value ?? '') : h.value, ...(typeof h.enabled === 'boolean' ? { enabled: h.enabled } : {}) }));

/** The references an incoming provider or server holds in its key, headers and variables, for the review lines. */
function referencesOf(o: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof o.apiKey === 'string' && REFERENCE.test(o.apiKey)) out.push(`the key ${o.apiKey.slice(0, 80)}`);
  for (const h of headersOf(o.headers)) if (REFERENCE.test(h.value)) out.push(`the header ${h.key.slice(0, 40)}: ${h.value.slice(0, 80)}`);
  if (isRecord(o.env)) for (const [k, v] of Object.entries(o.env)) if (typeof v === 'string' && REFERENCE.test(v)) out.push(`the variable ${k.slice(0, 40)}: ${v.slice(0, 80)}`);
  return out;
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
    // `<collection>#<ids>` names a part of a collection (folders and requests): it travels as a collection of its own
    const part = splitPartId(id);
    let whole: Collection;
    try {
      whole = store.getCollection(part?.collectionId ?? id);
    } catch {
      return undefined;
    }
    const c = part ? partialCollection(whole, part.nodeIds).collection : whole;
    const { version: _v, updatedAt: _u, ...rest } = strip.collection(c) as Collection & Record<string, unknown>;
    void _v;
    void _u;
    return { id: c.id, name: c.name, data: canonicalJson(rest), summary: { requests: countRequests(c.items), scripts: countScripts(c), ...(part ? { partOf: whole.name.slice(0, 120) } : {}) } };
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
  match: byIdSlugOrName,
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
    if (!Array.isArray(o.variables) || !o.variables.every(isRecord)) return 'its variables are not a list of objects';
    return undefined;
  },
  review(item, data) {
    const o = parseObject(data);
    return typeof o !== 'string' && o.isProduction ? [`Environment "${item.name}" is marked production: data-changing requests to it ask first`] : [];
  },
  match: byIdSlugOrName,
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
  /** Copies the known fields of an incoming item and drops what an import must not bring; `was` is the item it replaces. */
  shape?: (v: T, was?: T) => T,
) {
  const list = read();
  for (const w of writes) {
    const v = parseObject(w.data) as unknown as T;
    const at = list.findIndex((x) => x.id === (existingId(w) ?? w.target.id));
    const named = { ...v, id: w.target.id, name: w.target.name };
    const next = shape ? { ...shape(named, w.op === 'replaced' && at >= 0 ? list[at] : undefined), id: w.target.id, name: w.target.name } : named;
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

/** An incoming MCP server reduced to the fields this version knows, with no reference to a secret or environment variable (an allow-list copy). */
function importedServer(o: Record<string, unknown>, was?: McpServerConfig): McpServerConfig {
  const base = { id: String(o.id), name: String(o.name), ...(typeof o.folder === 'string' ? { folder: o.folder } : {}) };
  if (o.transport === 'stdio') {
    const env = isRecord(o.env) ? Object.fromEntries(Object.entries(o.env).filter(([, v]) => typeof v === 'string' && !REFERENCE.test(v))) : undefined;
    return {
      ...base,
      transport: 'stdio',
      command: String(o.command),
      ...(Array.isArray(o.args) ? { args: o.args.filter((a): a is string => typeof a === 'string') } : {}),
      ...(env && Object.keys(env).length ? { env: env as Record<string, string> } : {}),
      ...(typeof o.cwd === 'string' ? { cwd: o.cwd } : {}),
    };
  }
  if (o.transport === 'sse' || o.transport === 'streamable-http') {
    // the person's own header values stay when the server they replace is at the same address
    const keep = was && 'url' in was && hostOf(was.url) === hostOf(o.url) ? (was.headers ?? []) : [];
    const headers = importedHeaders(o.headers, keep);
    return { ...base, transport: o.transport, url: String(o.url), ...(headers.length ? { headers } : {}) };
  }
  return { ...base, transport: 'mock', mockFile: String(o.mockFile) };
}

/** An incoming provider reduced to the fields this version knows, with no key and no reference in a header: the person enters them. */
function importedProvider(o: Record<string, unknown>, was?: ProviderConfig): ProviderConfig {
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : undefined);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const rl = isRecord(o.rateLimit) ? o.rateLimit : undefined;
  const rate = rl ? Object.fromEntries((['requestsPerSecond', 'requestsPerMinute', 'tokensPerMinute', 'concurrency'] as const).flatMap((k) => (num(rl[k]) !== undefined ? [[k, num(rl[k])]] : []))) : undefined;
  // a key the person already has stays only when the provider it replaces is at the same address
  const sameHost = !!was && hostOf(was.baseUrl) === hostOf(o.baseUrl);
  const headers = importedHeaders(o.headers, sameHost ? (was!.headers ?? []) : []);
  return {
    id: String(o.id),
    name: String(o.name),
    kind: o.kind as ProviderConfig['kind'],
    baseUrl: String(o.baseUrl),
    ...(sameHost && was!.apiKey ? { apiKey: was!.apiKey } : {}),
    ...(str('defaultModel') ? { defaultModel: str('defaultModel') } : {}),
    ...(str('embeddingModel') ? { embeddingModel: str('embeddingModel') } : {}),
    ...(str('apiVersion') ? { apiVersion: str('apiVersion') } : {}),
    ...(str('region') ? { region: str('region') } : {}),
    ...(headers.length ? { headers } : {}),
    ...(rate && Object.keys(rate).length ? { rateLimit: rate } : {}),
    ...(num(o.timeoutMs) !== undefined ? { timeoutMs: num(o.timeoutMs) } : {}),
  };
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
    if (typeof o.url === 'string' && SECRET_REFERENCE.test(o.url)) return 'its address holds a secret or environment reference (that would send the secret to the address)';
    return undefined;
  },
  review(item, data) {
    const o = parseObject(data);
    if (typeof o === 'string') return [];
    const out: string[] = [];
    if (o.transport === 'stdio') {
      const args = Array.isArray(o.args) ? o.args.filter((a): a is string => typeof a === 'string') : [];
      out.push(`MCP server "${item.name}" starts a program (${commandLine(String(o.command), args).slice(0, 200)}) when you connect: it is not trusted until you allow it`);
    } else if (o.transport === 'sse' || o.transport === 'streamable-http') out.push(`MCP server "${item.name}" connects to ${hostOf(o.url) ?? String(o.url).slice(0, 100)}: everything you call on it goes there`);
    const refs = referencesOf(o);
    if (refs.length) out.push(`MCP server "${item.name}" names ${refs.join(', ')}: references are not imported, you enter these values yourself after the import`);
    return out;
  },
  reviewAgainst(store, existingId, item, data) {
    const o = parseObject(data);
    const mine = store.getMcpServers().find((x) => x.id === existingId);
    const was = mine && 'url' in mine ? hostOf(mine.url) : undefined;
    const now = typeof o === 'string' ? undefined : hostOf(o.url);
    return mine && was && now && was !== now ? [`MCP server "${item.name}" would move your server "${mine.name}" from ${was} to ${now}`] : [];
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
      (v, was) => importedServer(v as unknown as Record<string, unknown>, was),
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
    if (SECRET_REFERENCE.test(o.baseUrl)) return 'its address holds a secret or environment reference (that would send the secret to the address)';
    return undefined;
  },
  review(item, data) {
    const o = parseObject(data);
    if (typeof o === 'string') return [];
    const out = [`AI provider "${item.name}" sends your prompts to ${hostOf(o.baseUrl) ?? String(o.baseUrl).slice(0, 100)}`];
    const refs = referencesOf(o);
    if (refs.length) out.push(`AI provider "${item.name}" names ${refs.join(', ')}: references are not imported, you enter the key yourself after the import`);
    if (typeof o.baseUrl === 'string' && REFERENCE.test(o.baseUrl)) out.push(`AI provider "${item.name}" builds its address from variables (${o.baseUrl.slice(0, 100)}): check what they hold before using it`);
    return out;
  },
  reviewAgainst(store, existingId, item, data) {
    const o = parseObject(data);
    const mine = store.getProviders().find((x) => x.id === existingId);
    if (!mine || typeof o === 'string') return [];
    const was = hostOf(mine.baseUrl);
    const now = hostOf(o.baseUrl);
    return was !== now ? [`AI provider "${item.name}" would move your provider "${mine.name}" from ${was ?? mine.baseUrl} to ${now ?? String(o.baseUrl)}: its key is dropped`] : [];
  },
  match: byIdOrName,
  fresh: (existing, x, taken) => freshTarget(existing, x, taken),
  rewrite: (_item, data) => data,
  commit(store, writes, journal) {
    // the key of an imported provider is never the bundle's reference: the person enters it (a replaced provider at the same address keeps its own)
    commitList<ProviderConfig>(
      writes,
      () => store.getProviders(),
      (l) => store.saveProviders(l),
      journal,
      'provider',
      'providers',
      (w) => (w.op === 'replaced' ? w.target.id : undefined),
      (v, was) => importedProvider(v as unknown as Record<string, unknown>, was),
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
      const i = byIdIn(store.getLibrary(library).items, id);
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
    match: (existing, x) => listIndex(existing).byId.get(x.id),
    fresh: (existing, x, taken) => {
      seedOnce(taken.ids, () => existing.forEach((e) => taken.ids.add(e.id)));
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
