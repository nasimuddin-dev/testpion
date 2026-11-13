/**
 * What one item uses, and what uses it (`testpion item uses`, MCP `item_uses`, RPC `item.uses`, the app's "Uses and used
 * by…"): the direct edges of the same reading "Export with everything it uses" makes (uses.ts): workspace paths and names
 * in the item's text, the calls and monitors that belong to a collection, the environments that define what it needs.
 * Read only, nothing runs. A folder or a request of a collection answers for what its own text uses, and is used by
 * what uses its collection.
 */
import type { ItemRef } from '@testpion/shared';
import { ApsError } from '../errors.js';
import { SecretStripper } from '../storage/bundle-secrets.js';
import { itemRefOf } from '../kinds/ops.js';
import { bundleRefOfItemRef, openRefOfBundleItem } from '../kinds/transfer-refs.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { itemKey, type BundleKindId } from './format.js';
import { collectionIdOfRef } from './parts.js';
import { cachedReads } from './read-cache.js';
import { adapter, ALL_BUNDLE_KINDS } from './registry.js';
import { everythingRefs, parseSelector } from './selection.js';
import type { BundleRef } from './types.js';
import { collectUses } from './uses.js';

export interface UseRow {
  kind: BundleKindId;
  id: string;
  name: string;
  /** How it is used, in words ("specs/pets.yaml", "belongs to the collection", "defines {{baseUrl}}"). */
  via: string;
  /** The ref that opens it, for the kinds that open by ref. */
  ref?: ItemRef;
}

export interface ItemUses {
  item: { kind: BundleKindId; id: string; name: string };
  uses: UseRow[];
  usedBy: UseRow[];
  /** Named in the item's text but not in the workspace. */
  missing: Array<{ to: string; reason: string }>;
}

/** The edges an export follows from a collection to what names it. */
const BELONGS = /^(belongs to|refers to) the collection$/;

/** The item a selector names: kind:id as an export takes it, or any ItemRef form (saved:<library>:<id>, a link, the JSON). */
function rootOf(store: WorkspaceStore, selector: unknown): BundleRef {
  try {
    return parseSelector(store, selector);
  } catch (e) {
    let ref: BundleRef | undefined;
    try {
      ref = bundleRefOfItemRef(itemRefOf(selector));
    } catch {
      /* not a ref either: the message below */
    }
    if (ref) return ref;
    const text = typeof selector === 'string' ? selector : JSON.stringify(selector);
    throw new ApsError('ValidationError', `Not an item of the workspace: ${String(text).slice(0, 80)}`, {
      suggestions: ['The ref is kind:id (collection:<id>, spec:specs/<path>, dataset:<name>, test:<path>, environment:<id>), a testpion://open link, or the JSON of a "ref" field', '`testpion search <text>` finds items by name'],
      cause: e,
    });
  }
}

/** Every direct use in the workspace, read once (the catalog asks for all of them): the edges as an export follows them, and each item's name by its key (`kind:id`). */
export function workspaceUses(live: WorkspaceStore): { edges: Array<{ from: string; to: string; via: string }>; names: Map<string, string> } {
  const store = cachedReads(live);
  const texts = new Map<string, string | undefined>();
  const read = (r: BundleRef): string | undefined => {
    const key = itemKey(r.kind, r.id);
    if (!texts.has(key)) {
      const s = adapter(r.kind).snapshot(store, r.id, new SecretStripper());
      texts.set(key, s && !s.data.includes(0) ? s.data.toString('utf8') : undefined);
    }
    return texts.get(key);
  };
  const names = new Map<string, string>();
  for (const k of ALL_BUNDLE_KINDS) for (const i of adapter(k).list(store)) names.set(itemKey(k, i.id), i.name);
  return { edges: collectUses(store, everythingRefs(store, { providers: true }), read).edges, names };
}

export function itemUses(live: WorkspaceStore, selector: unknown): ItemUses {
  const store = cachedReads(live);
  const root = rootOf(store, selector);
  const texts = new Map<string, string | undefined>();
  const read = (r: BundleRef): string | undefined => {
    const key = itemKey(r.kind, r.id);
    if (!texts.has(key)) {
      const s = adapter(r.kind).snapshot(store, r.id, new SecretStripper());
      texts.set(key, s && !s.data.includes(0) ? s.data.toString('utf8') : undefined);
    }
    return texts.get(key);
  };
  const names = new Map<string, string>();
  for (const k of ALL_BUNDLE_KINDS) for (const i of adapter(k).list(store)) names.set(itemKey(k, i.id), i.name);
  const rowOf = (key: string, via: string): UseRow => {
    const at = key.indexOf(':');
    const kind = key.slice(0, at) as BundleKindId;
    const id = key.slice(at + 1);
    const ref = openRefOfBundleItem(kind, id);
    return { kind, id, name: names.get(key) ?? id, via, ...(ref ? { ref } : {}) };
  };
  const rootKey = itemKey(root.kind, root.id);
  if (!root.id || read(root) === undefined && !adapter(root.kind).snapshot(store, root.id, new SecretStripper()))
    throw new ApsError('ValidationError', `No ${adapter(root.kind).label.toLowerCase()} "${root.id}" in this workspace`, { suggestions: ['`testpion search <text>` finds items by name; the ref is kind:id (collection:<id>, spec:specs/<path>, dataset:<name>, test:<path>)'] });
  const own = collectUses(store, [root], read);
  // what uses it: every item's direct uses, read once (a part of a collection is used through its collection)
  const wholeKey = root.kind === 'collection' ? itemKey('collection', collectionIdOfRef(root.id)) : rootKey;
  const all = collectUses(store, everythingRefs(store, { providers: true }), read);
  const byName = (a: UseRow, b: UseRow) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name);
  // an export takes a collection's calls, monitors and tests along (collection → item), but it is the item that names the
  // collection: here those edges read the way the files do
  const uses = [
    ...own.edges.filter((e) => e.from === rootKey && !BELONGS.test(e.via)).map((e) => rowOf(e.to, e.via)),
    ...all.edges.filter((e) => e.to === rootKey && BELONGS.test(e.via)).map((e) => rowOf(e.from, 'its collection')),
  ];
  const usedBy = [
    ...all.edges.filter((e) => e.to === wholeKey && e.from !== rootKey && !BELONGS.test(e.via)).map((e) => rowOf(e.from, e.via)),
    ...all.edges.filter((e) => e.from === wholeKey && wholeKey === rootKey && BELONGS.test(e.via)).map((e) => rowOf(e.to, e.via)),
  ];
  return {
    item: { kind: root.kind, id: root.id, name: names.get(wholeKey) ?? root.id },
    uses: uses.sort(byName),
    usedBy: usedBy.sort(byName),
    missing: own.missing.filter((m) => m.from === rootKey).map((m) => ({ to: m.to, reason: m.reason })),
  };
}
