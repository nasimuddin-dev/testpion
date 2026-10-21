/** The operations of a tidy plan on a collection (rename, move, extract a variable, chain a request, drop a duplicate …) and the checks of the result. See tidy-import.ts. */
import { ApsError } from '../errors.js';
import type { AuthConfig, Collection, CollectionFolder, CollectionNode, KeyValue, SavedGraphQLRequest, SavedHttpRequest } from '../model/types.js';
import { shortId } from '../util/ids.js';
import { jsonClone } from '../util/json-clone.js';

export type Saved = SavedHttpRequest | SavedGraphQLRequest;

export const clone = jsonClone;

/** At most this many requests are described to the model (a bigger import is sampled: noise and duplicates first). */
export const TIDY_MAX_REQUESTS = 120;

/* ------------------------------------------------------------------ operations */

export type TidyOp =
  | { op: 'rename'; id: string; name: string }
  /** To a folder path from the root (created when missing); [] is the root. */
  | { op: 'move'; id: string; folder: string[] }
  | { op: 'drop'; id: string }
  /** The origin typed at the start of URLs becomes `{{variable}}`; the variable keeps the origin as its value. */
  | { op: 'host'; origin: string; variable: string }
  /** A literal credential (an Authorization header or a bearer / API-key auth) becomes `{{variable}}`; the variable keeps it. */
  | { op: 'token'; variable: string; value: string; header?: string; prefix?: string }
  /** A literal id in the requests `to` becomes `{{variable}}` (default: the literal); `from` sets it from its response at `path`. */
  | { op: 'chain'; variable: string; from: string; to: string[]; path: string; literal: string };

/** The requests of a collection in order, with their folder path, folder ids and inherited auth. */
export interface FlatRequest {
  node: Saved;
  folder: string[];
  auth?: AuthConfig;
}

export function flatRequests(c: Collection): FlatRequest[] {
  const out: FlatRequest[] = [];
  const own = (a: AuthConfig | undefined) => (a && a.type !== 'inherit' ? a : undefined);
  const walk = (nodes: CollectionNode[], path: string[], auth: AuthConfig | undefined) => {
    for (const n of nodes) {
      if (n.kind === 'folder') walk(n.items, [...path, n.name], own(n.auth) ?? auth);
      else out.push({ node: n, folder: path, auth: own(n.request.auth as AuthConfig | undefined) ?? auth });
    }
  };
  walk(c.items, [], own(c.auth));
  return out;
}

export const urlOf = (n: Saved) => (n.kind === 'http' ? n.request.url : n.request.endpoint);

export const setUrl = (n: Saved, url: string) => {
  if (n.kind === 'http') n.request.url = url;
  else n.request.endpoint = url;
};

export const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function locate(items: CollectionNode[], id: string): { node: CollectionNode; list: CollectionNode[]; index: number } | undefined {
  for (let i = 0; i < items.length; i++) {
    const n = items[i]!;
    if (n.id === id) return { node: n, list: items, index: i };
    if (n.kind === 'folder') {
      const r = locate(n.items, id);
      if (r) return r;
    }
  }
  return undefined;
}

const ensureFolder = (c: Collection, path: string[]): CollectionNode[] => {
  let list = c.items;
  for (const name of path) {
    let f = list.find((n): n is CollectionFolder => n.kind === 'folder' && n.name === name);
    if (!f) {
      f = { kind: 'folder', id: shortId('fld-'), name, items: [] };
      list.push(f);
    }
    list = f.items;
  }
  return list;
};

const setVariable = (c: Collection, key: string, value: string): void => {
  const have = (c.variables ?? []).find((v) => v.key === key);
  if (have && have.value !== value) throw new ApsError('ValidationError', `The collection variable "${key}" already has another value`, { suggestions: ['Run the tidy again: it picks a free name.'] });
  if (!have) c.variables = [...(c.variables ?? []), { key, value }];
};

/** A literal as a whole token: not inside a longer word, number or path segment. */
export const literalRe = (literal: string, flags = 'g') => new RegExp(`(?<![A-Za-z0-9_-])${literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`, flags);

export const mapStrings = (v: unknown, f: (s: string) => string): unknown => {
  if (typeof v === 'string') return f(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, f));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, f)]));
  return v;
};

/** A JSONPath of plain keys and indexes (`$.data.id`, `$.items[0].id`) as the JavaScript that reads it, or undefined. */
export function pathAccessor(path: string): string | undefined {
  if (!/^\$((\.[A-Za-z_][A-Za-z0-9_]*)|(\[\d+\])|(\['[^'\\]+'\]))+$/.test(path)) return undefined;
  return path.slice(1).replace(/\.([A-Za-z_][A-Za-z0-9_]*)/g, '?.$1').replace(/\[(\d+)\]/g, '?.[$1]').replace(/\['([^']+)'\]/g, "?.['$1']");
}

/** The post-response script a chain adds to the request whose response carries the value (tp.* only). */
export function chainScript(variable: string, path: string): string {
  return `// Added by TestPion (tidy import): pass ${path} on as {{${variable}}} to the requests that use it\nconst ${variable}Value = tp.response.json()${pathAccessor(path)};\nif (${variable}Value !== undefined && ${variable}Value !== null) tp.variables.set('${variable}', String(${variable}Value));\n`;
}

/** Apply operations to a copy of the collection; throws when one cannot be (an id that is gone, a variable name taken). */
export function applyTidyOps(source: Collection, ops: TidyOp[]): Collection {
  const c = clone(source);
  const folderCounts = new Map<string, number>();
  const count = (nodes: CollectionNode[]) => {
    for (const n of nodes)
      if (n.kind === 'folder') {
        folderCounts.set(n.id, n.items.length);
        count(n.items);
      }
  };
  count(c.items);
  for (const o of ops) {
    switch (o.op) {
      case 'rename': {
        const at = locate(c.items, o.id);
        if (!at) throw new ApsError('ConfigurationError', `The request "${o.id}" is no longer in ${c.name}`);
        at.node.name = o.name;
        break;
      }
      case 'move': {
        const at = locate(c.items, o.id);
        if (!at || at.node.kind === 'folder') throw new ApsError('ConfigurationError', `The request "${o.id}" is no longer in ${c.name}`);
        at.list.splice(at.index, 1);
        ensureFolder(c, o.folder).push(at.node);
        break;
      }
      case 'drop': {
        const at = locate(c.items, o.id);
        if (!at) throw new ApsError('ConfigurationError', `The request "${o.id}" is no longer in ${c.name}`);
        at.list.splice(at.index, 1);
        break;
      }
      case 'host': {
        setVariable(c, o.variable, o.origin);
        for (const r of flatRequests(c)) {
          const u = urlOf(r.node);
          if (u.toLowerCase().startsWith(o.origin.toLowerCase())) setUrl(r.node, `{{${o.variable}}}${u.slice(o.origin.length)}`);
        }
        break;
      }
      case 'token': {
        setVariable(c, o.variable, o.value);
        const header = (o.header ?? 'Authorization').toLowerCase();
        const full = `${o.prefix ?? ''}${o.value}`;
        const ref = `{{${o.variable}}}`;
        const fixAuth = (a: AuthConfig | undefined): AuthConfig | undefined => {
          if (!a) return a;
          if (a.type === 'bearer' && a.token === o.value) return { ...a, token: ref };
          if (a.type === 'apiKey' && (a as { value?: string }).value === o.value) return { ...a, value: ref } as AuthConfig;
          return a;
        };
        for (const r of flatRequests(c)) {
          const req = r.node.request as { headers?: KeyValue[]; auth?: AuthConfig };
          for (const h of req.headers ?? []) if (h.key.toLowerCase() === header && h.value === full) h.value = `${o.prefix ?? ''}${ref}`;
          req.auth = fixAuth(req.auth);
        }
        c.auth = fixAuth(c.auth);
        const walk = (nodes: CollectionNode[]) => {
          for (const n of nodes)
            if (n.kind === 'folder') {
              n.auth = fixAuth(n.auth);
              walk(n.items);
            }
        };
        walk(c.items);
        break;
      }
      case 'chain': {
        const acc = pathAccessor(o.path);
        if (!acc) throw new ApsError('ValidationError', `"${o.path}" is not a path of plain keys and indexes ($.id, $.data.items[0].id)`);
        const from = locate(c.items, o.from);
        if (!from || from.node.kind === 'folder') throw new ApsError('ConfigurationError', `The request "${o.from}" is no longer in ${c.name}`);
        setVariable(c, o.variable, o.literal);
        const re = literalRe(o.literal);
        for (const id of o.to) {
          const at = locate(c.items, id);
          if (!at || at.node.kind === 'folder') throw new ApsError('ConfigurationError', `The request "${id}" is no longer in ${c.name}`);
          const n = at.node as Saved;
          n.request = mapStrings(n.request, (s) => s.replace(re, `{{${o.variable}}}`)) as never;
        }
        const n = from.node as Saved;
        n.testScript = `${(n.testScript ?? '').trimEnd()}${n.testScript?.trim() ? '\n\n' : ''}${chainScript(o.variable, o.path)}`;
        break;
      }
    }
  }
  // folders the moves and drops emptied go with them
  const prune = (nodes: CollectionNode[]): CollectionNode[] =>
    nodes
      .map((n) => (n.kind === 'folder' ? { ...n, items: prune(n.items) } : n))
      .filter((n) => !(n.kind === 'folder' && n.items.length === 0 && (folderCounts.get(n.id) ?? 0) > 0));
  c.items = prune(c.items);
  return c;
}

/* ------------------------------------------------------------------ the verifier's two questions */

/** What is wrong with a collection as a file (ids, names, requests, variables): empty when it is valid. */
export function collectionProblems(c: Collection): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  const walk = (nodes: CollectionNode[], where: string) => {
    for (const n of nodes) {
      if (!n || typeof n !== 'object') {
        out.push(`${where}: an item is not an object`);
        continue;
      }
      if (typeof n.id !== 'string' || !n.id) out.push(`${where}: an item has no id`);
      else if (ids.has(n.id)) out.push(`${where}: the id "${n.id}" is used twice`);
      else ids.add(n.id);
      if (typeof n.name !== 'string' || !n.name.trim()) out.push(`${where}: "${n.id}" has no name`);
      if (n.kind === 'folder') {
        if (!Array.isArray(n.items)) out.push(`${where}: folder "${n.name}" has no items`);
        else walk(n.items, `${where} / ${n.name}`);
      } else if (n.kind === 'http') {
        if (!n.request || typeof n.request.method !== 'string' || typeof n.request.url !== 'string') out.push(`${where}: "${n.name}" has no method or URL`);
      } else if (n.kind === 'graphql') {
        if (!n.request || typeof n.request.endpoint !== 'string' || typeof n.request.query !== 'string') out.push(`${where}: "${n.name}" has no endpoint or query`);
      } else out.push(`${where}: "${String((n as { name?: string }).name)}" is of an unknown kind`);
    }
  };
  walk(c.items ?? [], c.name);
  const keys = new Set<string>();
  for (const v of c.variables ?? []) {
    if (!VAR_NAME.test(v.key)) out.push(`variable "${v.key}" is not a valid name`);
    if (keys.has(v.key)) out.push(`variable "${v.key}" is defined twice`);
    keys.add(v.key);
  }
  return out;
}

const TPL = /\{\{\s*([^{}\s]+)\s*\}\}/g;

const resolveString = (s: string, vars: Record<string, string>): string => {
  let cur = s;
  for (let i = 0; i < 5; i++) {
    const next = cur.replace(TPL, (m, name: string) => (name in vars ? vars[name]! : m));
    if (next === cur) break;
    cur = next;
  }
  return cur;
};

export const canon = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]));
  return v;
};

/** The collection's own variables (enabled ones) by name. */
const varsOf = (c: Collection): Record<string, string> => Object.fromEntries((c.variables ?? []).filter((v) => v.enabled !== false && v.key).map((v) => [v.key, v.value]));

/** What a request sends, with the collection's variables resolved: the thing a tidy must not change. */
export function resolvedRequest(r: FlatRequest, vars: Record<string, string>): string {
  const n = r.node;
  const body = { kind: n.kind, request: n.request, inheritedAuth: r.auth ?? null };
  return JSON.stringify(canon(mapStrings(body, (s) => resolveString(s, vars))));
}

/** Requests whose sent form differs between two collections (matched by id), except the ones dropped on purpose. */
export function sendDifferences(before: Collection, after: Collection, dropped: Set<string>): string[] {
  const vb = varsOf(before);
  const va = varsOf(after);
  const now = new Map(flatRequests(after).map((r) => [r.node.id, r]));
  const out: string[] = [];
  for (const r of flatRequests(before)) {
    if (dropped.has(r.node.id)) continue;
    const a = now.get(r.node.id);
    if (!a) {
      out.push(`"${r.node.name}" is gone and was not dropped on purpose`);
      continue;
    }
    // the inherited auth is resolved against its own collection's variables
    if (resolvedRequest(r, vb) !== resolvedRequest(a, va)) out.push(`"${r.node.name}" would send something different (${diffField(r, vb, a, va)})`);
  }
  return out;
}

function diffField(b: FlatRequest, vb: Record<string, string>, a: FlatRequest, va: Record<string, string>): string {
  const x = JSON.parse(resolvedRequest(b, vb)) as Record<string, any>;
  const y = JSON.parse(resolvedRequest(a, va)) as Record<string, any>;
  const keys = new Set([...Object.keys(x.request ?? {}), ...Object.keys(y.request ?? {})]);
  const changed = [...keys].filter((k) => JSON.stringify(x.request?.[k]) !== JSON.stringify(y.request?.[k]));
  if (JSON.stringify(x.inheritedAuth) !== JSON.stringify(y.inheritedAuth)) changed.push('inherited auth');
  return changed.join(', ') || 'the request';
}

/* ------------------------------------------------------------------ finding what to tidy */

export interface TidyGroup {
  id: string;
  kind: 'names' | 'host' | 'token' | 'chain' | 'drop' | 'dedupe';
  title: string;
  ops: TidyOp[];
  reason?: string;
  source: 'draft' | 'ai';
  /** Not ticked when the review opens (the model's own suggestion to drop requests, a chain nothing confirms). */
  optIn?: boolean;
  /** chain: what confirms it (the saved example of the earlier response). */
  evidence?: { confirmed: boolean; example?: string; value?: string };
}
