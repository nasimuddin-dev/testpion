import { mkdirSync, readFileSync } from 'node:fs';
import { sha1Hex } from '../util/hash.js';
import { join } from 'node:path';
import type { Collection, CollectionFolder, CollectionNode } from '../model/types.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { atomicWrite } from '../storage/fsutil.js';
import { unifiedDiff } from '@testpion/shared';
import type { ImportDocument } from './model.js';

/**
 * Re-import that UPDATES (import-compat plan 4d, "re-import of the same source updates by provenance id instead of
 * duplicating"). Every import records, per collection of the workspace, what each item was in the source (the source
 * tool's own id when the importer has one: a Postman item id, an Insomnia `_id`; else its path of names) and a hash of
 * the item as imported and as it was saved. Importing the same source again then matches item by item:
 *
 * - **skip**    nothing changed in the source, or the item was edited here too (a conflict: choose Replace to take the source's),
 * - **replace** the source changed it and nobody edited it here (the item keeps its id; its folder keeps its other items),
 * - **new**     the source has it and the collection does not (or it was deleted here and `new` was chosen).
 *
 * Items that left the source are kept and listed (`gone`). The records live in `.local/import-sources.json` (per computer,
 * not in git); an update is one undo step like any import (the receipt keeps the collection as it was).
 */

export type ReimportAction = 'replace' | 'new' | 'skip';

export interface ReimportItem {
  /** The item's key (its source id or `path:A / B`): what `decisions` are keyed by. */
  key: string;
  path: string[];
  kind: 'folder' | 'http' | 'graphql';
  action: ReimportAction;
  reason: string;
  /** The source and this workspace both changed it. */
  conflict?: boolean;
  /** The scripts that differ, line by line (a unified diff from what is here to what the source has): shown so the choice is made on the lines, not on the item. */
  scripts?: ReimportScriptDiff[];
}

export interface ReimportScriptDiff {
  field: 'preRequestScript' | 'testScript';
  /** `--- a/…` `+++ b/…` hunks: `-` is what the workspace has now, `+` what the source has. */
  diff: string;
}

const SCRIPT_FIELDS = ['preRequestScript', 'testScript'] as const;
/** The longest diff kept for one script (a longer one is cut at a line and says so). */
const MAX_SCRIPT_DIFF = 12_000;

/** The scripts of a node (or the collection) that differ between what is here and what the source gives, as line diffs. */
function scriptDiffs(here: { preRequestScript?: string; testScript?: string } | undefined, source: { preRequestScript?: string; testScript?: string }, name: string): ReimportScriptDiff[] | undefined {
  const out: ReimportScriptDiff[] = [];
  for (const field of SCRIPT_FIELDS) {
    const before = here?.[field] ?? '';
    const after = source[field] ?? '';
    if (before === after) continue;
    let diff = unifiedDiff(before, after, `${name} ${field === 'testScript' ? 'test script' : 'pre-request script'}`);
    if (diff.length > MAX_SCRIPT_DIFF) diff = `${diff.slice(0, diff.lastIndexOf('\n', MAX_SCRIPT_DIFF))}\n… (the rest of the difference is not shown)`;
    if (diff) out.push({ field, diff });
  }
  return out.length ? out : undefined;
}

export interface ReimportPlan {
  collectionId: string;
  collectionName: string;
  /** The collection's own settings (variables, auth, headers, scripts) as one more item. */
  root: ReimportItem;
  items: ReimportItem[];
  /** Items of the collection that came from this source and are not in it any more (kept). */
  gone: string[][];
  counts: { replace: number; new: number; skip: number; conflicts: number };
}

interface NodeRecord {
  src: string;
  /** Hash of the item as the source gave it. */
  srcHash: string;
  /** Hash of the item as saved in the workspace (to tell whether it was edited since). */
  hash: string;
}
interface CollectionRecord {
  format: string;
  key: string;
  at: string;
  nodes: Record<string, NodeRecord>;
  root: Omit<NodeRecord, 'src'>;
}
type Store = { collections: Record<string, CollectionRecord> };

const file = (store: WorkspaceStore) => join(store.root, '.local', 'import-sources.json');
function read(store: WorkspaceStore): Store {
  try {
    const d = JSON.parse(readFileSync(file(store), 'utf8')) as Store;
    return d && typeof d.collections === 'object' ? d : { collections: {} };
  } catch {
    return { collections: {} };
  }
}
function write(store: WorkspaceStore, s: Store): void {
  try {
    mkdirSync(join(store.root, '.local'), { recursive: true });
    atomicWrite(file(store), JSON.stringify(s));
  } catch {
    /* a read-only workspace still imports; it just cannot update later */
  }
}

/** JSON without `id` keys, children of folders and volatile fields: the same item hashes the same on every parse. */
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) if (k !== 'id' && k !== 'items' && k !== 'updatedAt' && k !== 'createdAt' && k !== 'version' && k !== 'schemaVersion') o[k] = stable((v as Record<string, unknown>)[k]);
    return o;
  }
  return v;
}
const hashOf = (v: unknown) => sha1Hex(JSON.stringify(stable(v))).slice(0, 16);
const rootOf = (c: Collection) => ({ description: c.description, variables: c.variables, auth: c.auth, headers: c.headers, settings: c.settings, preRequestScript: c.preRequestScript, testScript: c.testScript });

/** The keys of an imported collection's nodes by node id (the source's own id, else the path of names; repeats get #2, #3 …). */
function nodeKeys(doc: ImportDocument, c: Collection): Map<string, { key: string; path: string[]; node: CollectionNode }> {
  const out = new Map<string, { key: string; path: string[]; node: CollectionNode }>();
  const seen = new Map<string, number>();
  const walk = (nodes: CollectionNode[], path: string[]) => {
    for (const n of nodes) {
      const p = [...path, n.name];
      let key = doc.sourceIds?.[n.id] ?? `path:${p.join(' / ')}${n.kind === 'folder' ? '/' : ''}`;
      const k = (seen.get(key) ?? 0) + 1;
      seen.set(key, k);
      if (k > 1) key += `#${k}`;
      out.set(n.id, { key, path: p, node: n });
      if (n.kind === 'folder') walk(n.items, p);
    }
  };
  walk(c.items, []);
  return out;
}

const collectionKey = (doc: ImportDocument, c: Collection) => doc.sourceKey ?? `name:${c.name}`;

function locate(nodes: CollectionNode[], id: string): { node: CollectionNode; list: CollectionNode[]; index: number } | undefined {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    if (n.id === id) return { node: n, list: nodes, index: i };
    if (n.kind === 'folder') {
      const r = locate(n.items, id);
      if (r) return r;
    }
  }
  return undefined;
}

/** The workspace collection an import of `doc`'s collection `c` would update, with its record, or undefined. */
function findUpdateTarget(store: WorkspaceStore, doc: ImportDocument, c: Collection): { collection: Collection; record: CollectionRecord } | undefined {
  const s = read(store);
  const key = collectionKey(doc, c);
  const live = new Map(store.listCollections().filter((x) => !x.problem).map((x) => [x.id, x]));
  for (const [id, rec] of Object.entries(s.collections)) if (rec.format === doc.format && rec.key === key && live.has(id)) return { collection: live.get(id)!, record: rec };
  return undefined;
}

/** What importing `c` again would do to the collection that came from the same source. */
export function planReimport(store: WorkspaceStore, doc: ImportDocument, c: Collection): ReimportPlan | undefined {
  const target = findUpdateTarget(store, doc, c);
  if (!target) return undefined;
  const { collection: ex, record } = target;
  const items: ReimportItem[] = [];
  const keys = nodeKeys(doc, c);
  const seen = new Set<string>();
  const idBySrc = new Map(Object.entries(record.nodes).map(([nodeId, r]) => [r.src, nodeId]));
  for (const { key, path, node } of keys.values()) {
    seen.add(key);
    const srcHash = hashOf(node);
    const existingId = idBySrc.get(key);
    const found = existingId ? locate(ex.items, existingId) : undefined;
    const rec = existingId ? record.nodes[existingId] : undefined;
    let action: ReimportAction;
    let reason: string;
    let conflict: boolean | undefined;
    if (!found || !rec) {
      action = existingId ? 'skip' : 'new';
      reason = existingId ? 'you deleted it here (choose New to bring it back)' : 'not in the collection yet';
    } else if (rec.srcHash === srcHash) {
      action = 'skip';
      reason = 'unchanged in the source';
    } else if (hashOf(found.node) === rec.hash) {
      action = 'replace';
      reason = 'changed in the source';
    } else {
      action = 'skip';
      reason = 'changed in the source, but you edited it here too (choose Replace to take the source version)';
      conflict = true;
    }
    // the line-by-line script difference, for an item the source changed (a replace, or a conflict the person may decide to replace)
    const scripts = found && (action === 'replace' || conflict) ? scriptDiffs(found.node as { preRequestScript?: string; testScript?: string }, node as { preRequestScript?: string; testScript?: string }, path.join(' / ')) : undefined;
    items.push({ key, path, kind: node.kind, action, reason, ...(conflict ? { conflict } : {}), ...(scripts ? { scripts } : {}) });
  }
  const gone = Object.entries(record.nodes)
    .filter(([id, r]) => !seen.has(r.src) && locate(ex.items, id))
    .map(([id]) => {
      const names: string[] = [];
      const walk = (nodes: CollectionNode[], path: string[]): boolean => {
        for (const n of nodes) {
          if (n.id === id) return names.push(...path, n.name) > 0;
          if (n.kind === 'folder' && walk(n.items, [...path, n.name])) return true;
        }
        return false;
      };
      walk(ex.items, []);
      return names;
    });
  const rootHash = hashOf(rootOf(c));
  const rootAction: ReimportItem = (() => {
    if (record.root.srcHash === rootHash) return { key: 'collection', path: [], kind: 'folder' as const, action: 'skip' as const, reason: 'unchanged in the source' };
    if (hashOf(rootOf(ex)) === record.root.hash) return { key: 'collection', path: [], kind: 'folder' as const, action: 'replace' as const, reason: "the collection's variables, auth, headers or scripts changed in the source" };
    return { key: 'collection', path: [], kind: 'folder' as const, action: 'skip' as const, reason: 'changed in the source, but you edited the collection settings here too (choose Replace)', conflict: true };
  })();
  if (rootAction.action === 'replace' || rootAction.conflict) {
    const scripts = scriptDiffs(ex, c, c.name);
    if (scripts) rootAction.scripts = scripts;
  }
  const all = [rootAction, ...items];
  return {
    collectionId: ex.id,
    collectionName: ex.name,
    root: rootAction,
    items,
    gone,
    counts: { replace: all.filter((i) => i.action === 'replace').length, new: all.filter((i) => i.action === 'new').length, skip: all.filter((i) => i.action === 'skip').length, conflicts: all.filter((i) => i.conflict).length },
  };
}

/** Put the imported item's content on the existing node (it keeps its id and, for a folder, its items). */
function replaceNode(ex: CollectionNode, imported: CollectionNode): CollectionNode {
  if (ex.kind === 'folder' && imported.kind === 'folder') {
    const { items: _i, id: _id, ...rest } = imported;
    void _i;
    void _id;
    return { ...rest, id: ex.id, items: ex.items } as CollectionFolder;
  }
  return { ...imported, id: ex.id } as CollectionNode;
}

interface ReimportResult {
  collection: Collection;
  before: Collection;
  applied: { replaced: number; added: number; skipped: number };
  plan: ReimportPlan;
}

/** Update the collection from a new parse of its source. `decisions` (by item key) override the plan's actions. */
export function applyReimport(store: WorkspaceStore, doc: ImportDocument, c: Collection, decisions: Record<string, ReimportAction> = {}): ReimportResult | undefined {
  const plan = planReimport(store, doc, c);
  if (!plan) return undefined;
  const target = findUpdateTarget(store, doc, c)!;
  const before = JSON.parse(JSON.stringify(target.collection)) as Collection;
  const next = JSON.parse(JSON.stringify(target.collection)) as Collection;
  const record = target.record;
  const keys = nodeKeys(doc, c);
  const byKey = new Map(plan.items.map((i) => [i.key, i]));
  const idBySrc = new Map(Object.entries(record.nodes).map(([nodeId, r]) => [r.src, nodeId]));
  const act = (key: string): ReimportAction => decisions[key] ?? byKey.get(key)?.action ?? 'skip';
  let replaced = 0;
  let added = 0;
  let skipped = 0;
  /** Imported node id → the id it has in the collection now (for the records). */
  const placed = new Map<string, string>();

  const merge = (imported: CollectionNode[], into: CollectionNode[]) => {
    for (const n of imported) {
      const k = keys.get(n.id)!;
      const action = act(k.key);
      const existingId = idBySrc.get(k.key);
      const found = existingId ? locate(next.items, existingId) : undefined;
      if (found) {
        if (action === 'replace') {
          found.list[found.index] = replaceNode(found.node, n);
          replaced++;
        } else skipped++;
        placed.set(n.id, found.node.id);
        const now = found.list[found.index]!;
        if (n.kind === 'folder' && now.kind === 'folder') merge(n.items, now.items);
      } else if (action === 'new') {
        // a new item (a new folder with everything in it) goes to the end of the folder it belongs to
        const copy = JSON.parse(JSON.stringify(n)) as CollectionNode;
        into.push(copy);
        added++;
        const walk = (a: CollectionNode, b: CollectionNode) => {
          placed.set(a.id, b.id);
          if (a.kind === 'folder' && b.kind === 'folder') a.items.forEach((x, i) => walk(x, b.items[i]!));
        };
        walk(n, copy);
      } else skipped++;
    }
  };
  merge(c.items, next.items);
  if (decisions.collection ? decisions.collection === 'replace' : plan.root.action === 'replace') {
    const r = rootOf(c);
    Object.assign(next, { description: r.description, variables: r.variables ?? [], auth: r.auth, headers: r.headers, settings: r.settings, preRequestScript: r.preRequestScript, testScript: r.testScript });
    for (const k of Object.keys(r) as Array<keyof typeof r>) if (r[k] === undefined) delete (next as unknown as Record<string, unknown>)[k];
    replaced++;
  }
  const saved = store.saveCollection(next);
  // records: what was applied is now in sync with the source; a skipped conflict keeps its old record, so it stays a conflict
  const s = read(store);
  const nodes: Record<string, NodeRecord> = {};
  const savedKeys = nodeKeys({ ...doc, sourceIds: undefined }, saved);
  void savedKeys;
  const hashAt = (id: string) => {
    const f = locate(saved.items, id);
    return f ? hashOf(f.node) : '';
  };
  for (const [nodeId, r] of Object.entries(record.nodes)) if (locate(saved.items, nodeId)) nodes[nodeId] = r;
  for (const k of keys.values()) {
    const id = placed.get(k.node.id);
    if (!id) continue;
    const action = act(k.key);
    const was = record.nodes[id];
    if (action === 'skip' && was) continue;
    nodes[id] = { src: k.key, srcHash: hashOf(k.node), hash: hashAt(id) };
  }
  for (const [id, r] of Object.entries(nodes)) if (!r.hash) nodes[id] = { ...r, hash: hashAt(id) };
  const rootNow = { srcHash: hashOf(rootOf(c)), hash: hashOf(rootOf(saved)) };
  s.collections[saved.id] = { ...record, at: new Date().toISOString(), nodes, root: (decisions.collection ?? plan.root.action) === 'skip' ? record.root : rootNow };
  write(store, s);
  return { collection: saved, before, applied: { replaced, added, skipped }, plan };
}

/** Remember where a saved collection came from, so a later import of the same source can update it. */
export function recordProvenance(store: WorkspaceStore, doc: ImportDocument, imported: Collection, saved: Collection): void {
  const keys = nodeKeys(doc, imported);
  // the saved collection holds the same nodes under the same ids (saveCollection keeps them); hash what was written
  const savedById = new Map<string, CollectionNode>();
  const index = (nodes: CollectionNode[]) => nodes.forEach((n) => (savedById.set(n.id, n), n.kind === 'folder' && index(n.items)));
  index(saved.items);
  const nodes: Record<string, NodeRecord> = {};
  for (const [id, k] of keys) {
    const sn = savedById.get(id);
    if (sn) nodes[id] = { src: k.key, srcHash: hashOf(k.node), hash: hashOf(sn) };
  }
  const s = read(store);
  s.collections[saved.id] = { format: doc.format, key: collectionKey(doc, imported), at: new Date().toISOString(), nodes, root: { srcHash: hashOf(rootOf(imported)), hash: hashOf(rootOf(saved)) } };
  // collections that are gone from the workspace are forgotten
  const live = new Set(store.listCollections().map((x) => x.id));
  for (const id of Object.keys(s.collections)) if (!live.has(id) && id !== saved.id) delete s.collections[id];
  write(store, s);
}
