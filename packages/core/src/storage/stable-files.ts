import { isRecord, kindOfPath, libraryOfPath, type KindId } from '@testpion/shared';

/**
 * Stable files (planning/git-everything.md §4b): what a workspace file holds when the app writes it, so a file changes
 * only when what people wrote changes, and two people editing different items merge cleanly in git.
 *
 * The guarantees of every JSON kind (collections, environments, workspace.json, library files, MCP servers,
 * providers, the Debugger rules):
 *  - a fixed key order: the kind's known keys first, then the rest sorted (by code unit, the same on every computer);
 *  - no volatile field (a save counter, a saved-at time, a run id): those live in `.local/` (collections) or are
 *    dropped (library items' `updatedAt`);
 *  - LF line endings, two-space indent and exactly one trailing newline;
 *  - arrays keep their order (it is the order people see), and undefined values are not written.
 * A raw document (a spec, a dataset, a script package, a test file) is the user's own text and is never reordered; a
 * test file only gets LF line endings and a final newline (`normalizeText`).
 *
 * Reading never needs the stable form: an older file loads as it is, and gets the stable form the next time its item is
 * saved (or when "Fix git setup" tidies the workspace).
 */

type Json = unknown;
type Obj = Record<string, Json>;

/** Keys that lead any object that has them (identity first, then the usual pairs), before the sorted rest. */
const LEADING = ['schemaVersion', 'kind', 'id', 'key', 'name', 'type', 'value', 'enabled', 'secret'];


/** Code-unit order: the same on every computer and locale (localeCompare is not). */
const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Where a key sits in the head of an object: its place in `first`, else after those its place among the shared leading keys; -1 for any other key. */
const LEADING_RANK = new Map(LEADING.map((k, i) => [k, i]));
function rankOf(k: string, first: readonly string[]): number {
  const i = first.length ? first.indexOf(k) : -1;
  if (i >= 0) return i;
  const j = LEADING_RANK.get(k);
  return j === undefined ? -1 : first.length + j;
}

/**
 * The keys of an object that are written, in the stable order: the head (`first` as given, the shared leading keys), then the
 * rest sorted. `same` says the object already has its keys in that order (checked in one pass, nothing allocated), so a caller
 * can keep it as it is.
 */
function orderedKeys(o: Obj, first: readonly string[] = []): { keys: string[]; same: boolean } {
  const own = Object.keys(o);
  let same = true;
  let undef = false;
  let prev = -1;
  let inRest = false;
  let last = '';
  for (let i = 0; i < own.length; i++) {
    const k = own[i]!;
    if (o[k] === undefined) {
      same = false;
      undef = true;
      continue;
    }
    const rank = rankOf(k, first);
    if (rank >= 0) {
      if (inRest || rank <= prev) same = false;
      prev = rank;
    } else {
      if (inRest && k < last) same = false;
      inRest = true;
      last = k;
    }
  }
  if (same) return { keys: own, same };
  const head: string[] = [];
  const rest: string[] = [];
  for (const k of own) {
    if (undef && o[k] === undefined) continue;
    (rankOf(k, first) >= 0 ? head : rest).push(k);
  }
  head.sort((x, y) => rankOf(x, first) - rankOf(y, first));
  return { keys: head.concat(rest.sort(byCode)), same: false };
}

/** Sets a key as an own property (a plain `out[k] = v` would change the prototype for a key named __proto__). */
function put(out: Obj, k: string, v: Json): void {
  if (k === '__proto__') Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
  else out[k] = v;
}

/**
 * A value with every object's keys in the stable order, all the way down (arrays keep their order). One pass: a part that
 * is already in order comes back as the very same object (nothing is cloned), so saving a big document that is already
 * stable allocates almost nothing. The result may therefore share parts with `v`: it is for writing or comparing, never
 * to be changed in place.
 */
export function stableValue(v: Json, first?: readonly string[]): Json {
  if (Array.isArray(v)) {
    let out: Json[] | undefined;
    for (let i = 0; i < v.length; i++) {
      const x = v[i];
      // a number, a string, a boolean or null cannot need reordering
      const y = x !== null && typeof x === 'object' ? stableValue(x) : x;
      if (out) out.push(y);
      else if (y !== x) (out = v.slice(0, i)), out.push(y);
    }
    return out ?? v;
  }
  if (!isRecord(v)) return v;
  const { keys: ks, same } = orderedKeys(v, first);
  let out: Obj | undefined = same ? undefined : {};
  for (let i = 0; i < ks.length; i++) {
    const k = ks[i]!;
    const x = v[k];
    const y = x !== null && typeof x === 'object' ? stableValue(x) : x;
    if (out) put(out, k, y);
    else if (y !== x) {
      out = {};
      for (let j = 0; j < i; j++) put(out, ks[j]!, v[ks[j]!]);
      put(out, k, y);
    }
  }
  return out ?? v;
}

/**
 * Whether two values are the same content, whatever the order of their keys (an older file against its stable form is no
 * change). Most pairs asked are plainly equal, which one stringify of each settles; only a pair that differs there is put
 * in the stable order, to tell a different order from a different content.
 */
export function sameValue(a: Json, b: Json): boolean {
  if (a === b) return true;
  const x = JSON.stringify(a ?? null);
  const y = JSON.stringify(b ?? null);
  if (x === y) return true;
  // different as written, and no object in either: key order cannot be the difference
  if (!x.includes('{') && !y.includes('{')) return false;
  return JSON.stringify(stableValue(a ?? null)) === JSON.stringify(stableValue(b ?? null));
}

/** What a JSON file holds as text: two-space indent, LF, one trailing newline. */
export const stableText = (v: Json): string => JSON.stringify(v, null, 2) + '\n';

/** A text file as it is written: no byte order mark, LF line endings, exactly one final newline (an empty file stays empty). */
export function normalizeText(text: string): string {
  const t = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  return t.trim() === '' ? '' : t.replace(/\n*$/, '\n');
}

/* ------------------------------------------------------------------ per-kind shapes */

const COLLECTION_KEY_ORDER = ['schemaVersion', 'id', 'name', 'description', 'variables', 'auth', 'preRequestScript', 'testScript', 'items'];
const ENVIRONMENT_KEY_ORDER = ['id', 'name', 'isProduction', 'color', 'order', 'variables'];
const WORKSPACE_KEY_ORDER = ['schemaVersion', 'id', 'name', 'description', 'variables', 'createdAt', 'updatedAt'];
const LIBRARY_KEY_ORDER = ['schemaVersion', 'folders', 'items'];
const LIBRARY_ITEM_KEY_ORDER = ['id', 'name', 'folder', 'collectionId', 'data'];
const MCP_SERVER_KEY_ORDER = ['id', 'name', 'folder', 'transport', 'command', 'args', 'cwd', 'env', 'url', 'headers', 'mockFile'];
const PROVIDER_KEY_ORDER = ['id', 'name', 'kind', 'baseUrl', 'apiKey', 'defaultModel', 'embeddingModel', 'apiVersion', 'region', 'headers', 'rateLimit', 'timeoutMs'];
const RULES_KEY_ORDER = ['active', 'profiles', 'filterPresets'];

/** An object's keys in the kind's order; its list under `listKey` has each item's keys in `itemOrder` (less the `drop` keys). */
function withList(v: Json, top: readonly string[], listKey: string, itemOrder: readonly string[], drop: readonly string[] = []): Json {
  if (!isRecord(v)) return stableValue(v);
  const item = (i: Json): Json => (isRecord(i) ? stableValue(Object.fromEntries(Object.entries(i).filter(([k]) => !drop.includes(k))), itemOrder) : stableValue(i));
  return Object.fromEntries(orderedKeys(v, top).keys.map((k) => [k, k === listKey && Array.isArray(v[k]) ? (v[k] as Json[]).map(item) : stableValue(v[k])]));
}

/** A collection as its file holds it: no `version` / `updatedAt` (they are this computer's, see `.local/meta.json`). */
export function collectionFileValue(c: Json): Json {
  if (!isRecord(c)) return c;
  const { version: _v, updatedAt: _u, problem: _p, ...rest } = c;
  void _v;
  void _u;
  void _p;
  return stableValue(rest, COLLECTION_KEY_ORDER);
}

export const environmentFileValue = (e: Json): Json => (isRecord(e) ? stableValue(Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'problem')), ENVIRONMENT_KEY_ORDER) : e);
export const workspaceFileValue = (w: Json): Json => stableValue(w, WORKSPACE_KEY_ORDER);
/** A library file: folders sorted, items by their order, no `updatedAt` on an item. */
export function libraryFileValue(lib: Json): Json {
  const out = withList(lib, LIBRARY_KEY_ORDER, 'items', LIBRARY_ITEM_KEY_ORDER, ['updatedAt']);
  if (isRecord(out) && Array.isArray(out.folders)) out.folders = [...(out.folders as string[])].sort(byCode);
  return out;
}
export const mcpServersFileValue = (f: Json): Json => withList(f, ['schemaVersion', 'servers'], 'servers', MCP_SERVER_KEY_ORDER);
export const providersFileValue = (f: Json): Json => withList(f, ['schemaVersion', 'providers'], 'providers', PROVIDER_KEY_ORDER);
export const debuggerRulesFileValue = (f: Json): Json => stableValue(f, RULES_KEY_ORDER);

/** The stable shape of each kind that is a JSON file the app writes (the registry's kind of the path picks it). */
const SHAPES: Partial<Record<KindId, (v: Json) => Json>> = {
  collection: collectionFileValue,
  environment: environmentFileValue,
  workspace: workspaceFileValue,
  'mcp-server': mcpServersFileValue,
  provider: providersFileValue,
  'debugger-rules': debuggerRulesFileValue,
};

/**
 * The stable form of a workspace file's text, or undefined when the file is a raw document (kept as the user wrote it)
 * or is not valid JSON (a broken file is left for the user to fix). `path` is relative to the workspace, `/` or `\`.
 * Idempotent: `canonicalText(p, canonicalText(p, t)!) === canonicalText(p, t)`.
 */
export function canonicalText(path: string, text: string): string | undefined {
  const p = path.replace(/\\/g, '/').replace(/^\.?\//, '');
  const kind = kindOfPath(p, { raw: true });
  if (kind?.kind === 'test' && /\.ya?ml$/i.test(p)) return normalizeText(text);
  // an item file (a collection, an environment) only when the path names one, not a folder
  const shape = libraryOfPath(p, { raw: true }) ? libraryFileValue : kind && (kind.id || (kind.kind !== 'collection' && kind.kind !== 'environment')) ? SHAPES[kind.kind] : undefined;
  if (!shape) return undefined;
  let value: Json;
  try {
    value = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return undefined;
  }
  return stableText(shape(value));
}
