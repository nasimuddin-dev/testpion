/**
 * What to export: the selectors a person, a script or an agent gives (`collection:clinic`, `spec:specs/pets.yaml`,
 * `dataset:users.csv`, an ItemRef or a testpion://open link, a collection's name), a whole section of a kind, or the
 * whole workspace. Each becomes a `{ kind, id }` of the bundle; an item that is not in the workspace is an error that
 * says what is, never an empty bundle.
 */
import { kindByName } from '@testpion/shared';
import { ApsError } from '../errors.js';
import { itemRefOf } from '../kinds/ops.js';
import { bundleRefOfItemRef } from '../kinds/transfer-refs.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { ALL_BUNDLE_KINDS, adapter, bundleKindOf, normalizeId } from './registry.js';
import { LIBRARY_OF, itemKey } from './format.js';
import { partId, resolveNodeIds } from './parts.js';
import type { BundleRef } from './types.js';

export type { BundleRef };
export { bundleRefOfItemRef };

/** One selector as a bundle ref. A bare word is a collection (by id or name), as `testpion export <collection>` always took. */
export function parseSelector(store: WorkspaceStore, selector: unknown): BundleRef {
  if (selector && typeof selector === 'object') {
    const r = bundleRefOfItemRef(itemRefOf(selector));
    if (!r) throw new ApsError('ValidationError', `That item cannot be exported on its own: ${JSON.stringify(selector).slice(0, 120)}`);
    return r;
  }
  const text = String(selector ?? '').trim();
  if (!text) throw new ApsError('ValidationError', 'Name what to export: kind:id (collection:<id>, spec:specs/<path>, dataset:<name>, mcp-server:<id> …)');
  const colon = text.indexOf(':');
  const info = colon > 0 && !/^[a-z]+:\/\//i.test(text) ? kindByName(text.slice(0, colon)) : undefined;
  if (info && (info.id === 'folder' || info.id === 'request')) return partSelector(store, info.id, text.slice(colon + 1));
  if (info) {
    const k = bundleKindOf(info.id);
    if (!k) throw new ApsError('ValidationError', `${info.plural} are not exported in bundles (use \`testpion kinds ${info.id}\` to see what each kind can do)`);
    return { kind: k, id: normalizeId(k, text.slice(colon + 1)) };
  }
  if (/^testpion:\/\//i.test(text) || text.startsWith('{')) {
    const r = bundleRefOfItemRef(itemRefOf(text));
    if (r) return r;
  }
  const c = store.listCollections().find((x) => !x.problem && (x.id === text || x.name.toLowerCase() === text.toLowerCase()));
  if (c) return { kind: 'collection', id: c.id };
  throw new ApsError('ValidationError', `Nothing to export for "${text.slice(0, 80)}"`, {
    suggestions: ['Use kind:id, e.g. collection:<id>, spec:specs/<path>, dataset:<name>, mcp-server:<id>', 'A bare word is a collection name or id'],
  });
}

/**
 * `folder:<collection>/<folder>[,<folder>…]` and `request:<collection>/<request>[,…]`: the collection by id or name, the
 * folders and requests by id or name. Several may be named (comma); they travel together as one part of the collection.
 */
function partSelector(store: WorkspaceStore, what: 'folder' | 'request', rest: string): BundleRef {
  const slash = rest.indexOf('/');
  const where = slash > 0 ? rest.slice(0, slash).trim() : '';
  const names = (slash > 0 ? rest.slice(slash + 1) : '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!where || !names.length) throw new ApsError('ValidationError', `Name the ${what} as ${what}:<collection>/<${what} id or name>`);
  const c = store.listCollections().find((x) => !x.problem && (x.id === where || x.name.toLowerCase() === where.toLowerCase()));
  if (!c) throw new ApsError('ValidationError', `No collection "${where.slice(0, 80)}" in this workspace`);
  return { kind: 'collection', id: partId(c.id, resolveNodeIds(store.getCollection(c.id), names)) };
}

/** Every item of one section (a kind, by id or alias: `datasets`, `mcp`, `specs`, `collection` …). */
export function sectionRefs(store: WorkspaceStore, section: string): BundleRef[] {
  const k = bundleKindOf(section);
  if (!k) {
    throw new ApsError('ValidationError', `"${section}" is not a section a bundle can hold`, { suggestions: [`Sections: ${ALL_BUNDLE_KINDS.join(', ')}`] });
  }
  return adapter(k)
    .list(store)
    .map((i) => ({ kind: k, id: i.id }));
}

/**
 * The items in one folder of a list: `kind` is the list (an API definition, a dataset, an MCP server, a test file, a saved
 * item of a library) and `folder` the folder's name (a test folder: its path under tests/). Folders of a list are one level
 * deep, except test folders; the files in a virtual folder never moved, so the refs are the files' own.
 */
export function folderRefs(store: WorkspaceStore, kind: string, folder: string): BundleRef[] {
  const k = bundleKindOf(kind);
  const name = String(folder ?? '').trim();
  if (!k) throw new ApsError('ValidationError', `"${kind}" has no folders a bundle can hold`);
  if (!name) throw new ApsError('ValidationError', 'Name the folder to export');
  const all = adapter(k).list(store);
  let ids: string[];
  if (k === 'test') {
    const dir = `tests/${name.replace(/^\/+|\/+$/g, '')}/`;
    ids = all.filter((i) => i.id.startsWith(dir)).map((i) => i.id);
  } else if (k === 'spec' || k === 'dataset') {
    const lib = store.getLibrary(k === 'spec' ? 'spec-folders' : 'dataset-folders');
    const inside = new Set(lib.items.filter((i) => i.folder === name).map((i) => (k === 'dataset' ? `datasets/${i.id}` : i.id)));
    ids = all.filter((i) => inside.has(i.id)).map((i) => i.id);
  } else if (k === 'mcp-server') {
    ids = store.getMcpServers().filter((s) => s.folder === name).map((s) => s.id);
  } else {
    const lib = LIBRARY_OF[k];
    ids = lib ? store.getLibrary(lib).items.filter((i) => i.folder === name).map((i) => i.id) : [];
  }
  if (!ids.length) throw new ApsError('ValidationError', `The ${adapter(k).label.toLowerCase()} folder "${name.slice(0, 80)}" holds nothing to export`, { suggestions: ['A folder is exported with the items in it; an empty folder has none'] });
  return ids.map((id) => ({ kind: k, id }));
}

/** The whole workspace: every item of every kind (AI providers only when asked: they are a person's setup, not a project's). */
export function everythingRefs(store: WorkspaceStore, o: { providers?: boolean } = {}): BundleRef[] {
  return ALL_BUNDLE_KINDS.filter((k) => k !== 'provider' || o.providers).flatMap((k) => sectionRefs(store, k));
}

/** Refs without repeats, in the order given. */
export function uniqueRefs(refs: readonly BundleRef[]): BundleRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => !seen.has(itemKey(r.kind, r.id)) && !!seen.add(itemKey(r.kind, r.id)));
}
