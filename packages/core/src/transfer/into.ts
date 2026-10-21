/**
 * Import here: a bundle's collection is added under a collection or a folder of the workspace instead of becoming a
 * collection of its own. Its folders and requests are copied (an id that is taken in the target gets a new one, so nothing
 * is replaced and nothing is lost), and the collection variables the requests rely on are added when the target has none
 * of that name. The target's own settings (auth, headers, scripts) are never changed. The target file is journaled, so one
 * Undo takes the import back.
 */
import { ApsError } from '../errors.js';
import type { Collection, CollectionFolder, CollectionNode } from '../model/types.js';
import { shortId } from '../util/ids.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { parseJsonSafe } from './format.js';
import type { CommitWrite, JournalSink } from './items.js';
import { isRecord } from '@testpion/shared';

/** Where the bundle's items go: a collection, or a folder inside it. */
export interface ImportInto {
  collectionId: string;
  folderId?: string;
}

const walkIds = (nodes: readonly CollectionNode[], used: Set<string>) => {
  for (const n of nodes) {
    used.add(n.id);
    if (n.kind === 'folder') walkIds(n.items, used);
  }
};

/** A copy of the nodes in which every id that is taken (or repeated) is replaced by a new one. */
function withFreshIds(nodes: readonly CollectionNode[], used: Set<string>): CollectionNode[] {
  return nodes.map((n) => {
    let id = n.id;
    if (!id || used.has(id)) {
      do id = shortId(n.kind === 'folder' ? 'fld-' : 'req-');
      while (used.has(id));
    }
    used.add(id);
    return n.kind === 'folder' ? { ...n, id, items: withFreshIds(n.items, used) } : { ...n, id };
  });
}

function findFolder(nodes: readonly CollectionNode[], id: string): CollectionFolder | undefined {
  for (const n of nodes) {
    if (n.kind !== 'folder') continue;
    if (n.id === id) return n;
    const inner = findFolder(n.items, id);
    if (inner) return inner;
  }
  return undefined;
}

/** The target must exist before anything is imported: a clear refusal, nothing half done. */
export function checkInto(store: WorkspaceStore, into: ImportInto): { collection: Collection; label: string } {
  let collection: Collection;
  try {
    collection = store.getCollection(into.collectionId);
  } catch {
    throw new ApsError('ValidationError', `No collection "${String(into.collectionId).slice(0, 80)}" to import into`);
  }
  if (into.folderId) {
    const f = findFolder(collection.items, into.folderId);
    if (!f) throw new ApsError('ValidationError', `No folder "${into.folderId.slice(0, 80)}" in collection "${collection.name}"`);
    return { collection, label: `${collection.name} / ${f.name}` };
  }
  return { collection, label: collection.name };
}

/** Add the writes' collections under the target. Returns how many requests and folders came in. */
export function commitInto(store: WorkspaceStore, into: ImportInto, writes: CommitWrite[], journal: JournalSink): { nodes: number; variables: number } {
  const { collection } = checkInto(store, into);
  const used = new Set<string>();
  walkIds(collection.items, used);
  let items = collection.items;
  let variables = collection.variables ?? [];
  let nodes = 0;
  let addedVars = 0;
  const add = (list: readonly CollectionNode[], more: CollectionNode[]): CollectionNode[] => [...list, ...more];
  for (const w of writes) {
    const raw = parseJsonSafe(w.data.toString('utf8'));
    if (!isRecord(raw) || !Array.isArray(raw.items)) throw new ApsError('ValidationError', `${w.incoming.name}: not a collection`);
    const fresh = withFreshIds(raw.items as CollectionNode[], used);
    nodes += fresh.length;
    if (into.folderId) {
      const place = (list: readonly CollectionNode[]): CollectionNode[] =>
        list.map((n) => (n.kind !== 'folder' ? n : n.id === into.folderId ? { ...n, items: add(n.items, fresh) } : { ...n, items: place(n.items) }));
      items = place(items);
    } else items = add(items, fresh);
    // the variables the incoming requests were written against, unless the target has one of that name
    const have = new Set(variables.map((v) => v.key));
    const more = (Array.isArray(raw.variables) ? raw.variables : []).filter((v): v is { key: string; value: string; enabled?: boolean } => isRecord(v) && typeof v.key === 'string' && typeof v.value === 'string' && !have.has(v.key));
    if (more.length) {
      variables = [...variables, ...more];
      addedVars += more.length;
    }
  }
  const file = store.collectionFileOf(collection.id);
  journal.before(file);
  store.saveCollection({ ...collection, items, variables });
  journal.after(file);
  return { nodes, variables: addedVars };
}
