import { join } from 'node:path';
import type { ItemRef } from '@testpion/shared';
import { ApsError } from '../errors.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { moveToTrash, restoreFromTrash } from '../storage/trash.js';
import { collectionIndex, missing, ok } from './ref-index.js';
import type { KindDefs } from './types.js';

/** A request or a folder: by id in its collection's index (a request never resolves as a folder, nor the other way). */
function resolveNode(store: WorkspaceStore, r: Extract<ItemRef, { kind: 'request' | 'folder' }>) {
  const c = collectionIndex(store, r.collectionId);
  if (!c) return missing(r, 'Its collection is no longer in this workspace (deleted, or in another workspace).', { label: 'Search the workspace', view: 'search' });
  const id = r.kind === 'request' ? r.requestId : r.folderId;
  const n = c.byId.get(id);
  const want = r.kind === 'request' ? n && n.kind !== 'folder' : n?.kind === 'folder';
  if (!n || !want)
    return missing(r, `It is no longer in the collection "${c.name}" (deleted or moved to another collection).`, {
      label: `Open ${c.name}`,
      ref: { kind: 'collection', collectionId: r.collectionId },
    });
  const label = [c.name, ...n.path, n.name].join(' / ');
  return r.kind === 'request' ? ok({ ...r, ...(n.protocol ? { protocol: n.protocol } : {}) }, n.name, label) : ok(r, n.name, label);
}

/** A collection, or its mock server: there when the collection is. */
function resolveCollection(store: WorkspaceStore, r: Extract<ItemRef, { kind: 'collection' | 'mock' }>) {
  const c = collectionIndex(store, r.collectionId);
  return c ? ok(r, c.name) : missing(r, 'That collection is no longer in this workspace (deleted, or in another workspace).', { label: 'Open Collections', view: 'collections' });
}

export const collectionKinds: KindDefs = {
  collection: {
    resolve: (store, ref) => resolveCollection(store, ref as Extract<ItemRef, { kind: 'collection' }>),
    ops: {
      remove: (store, id) => {
        const trashId = moveToTrash(store, 'collection', join(store.root, store.collectionFileOf(id)));
        if (!trashId) throw new ApsError('ConfigurationError', `No collection ${id}`, { suggestions: [] });
        return trashId;
      },
      restore: (store, trashId) => restoreFromTrash(store, trashId),
    },
  },
  folder: { resolve: (store, ref) => resolveNode(store, ref as Extract<ItemRef, { kind: 'folder' }>) },
  request: { resolve: (store, ref) => resolveNode(store, ref as Extract<ItemRef, { kind: 'request' }>) },
  mock: { resolve: (store, ref) => resolveCollection(store, ref as Extract<ItemRef, { kind: 'mock' }>) },
};
