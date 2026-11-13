import { LIBRARY_LABEL, type ItemRef, type RefResolution } from '@testpion/shared';
import type { WorkspaceStore } from '../storage/workspace.js';
import { restoreFromTrash, trashLibraryItem } from '../storage/trash.js';
import { libraryIndex, missing, ok } from './ref-index.js';
import type { ItemKindDef, KindDefs } from './types.js';

type SavedRef = Extract<ItemRef, { kind: 'saved' }>;

/**
 * An item of a library (library/<library>.json): gRPC calls, connections, prompts, load tests, evaluations, and a
 * library this version doesn't know (another version's, a hand-made file) — those resolve too, as a "saved item".
 */
export function resolveSaved(store: WorkspaceStore, r: SavedRef): RefResolution {
  const it = libraryIndex(store, r.library)?.byId.get(r.itemId);
  const what = LIBRARY_LABEL[r.library] ?? 'saved item';
  return it
    ? ok(r, it.name, what)
    : missing(r, `That ${what.toLowerCase()} is no longer saved in this workspace (deleted, or in another workspace).`, { label: 'Search the workspace', view: 'search' });
}

type LibraryTrashKind = Parameters<typeof trashLibraryItem>[1];
/** Delete to Recently deleted and back: the item with its place in the list. */
const trashOps = (kind: LibraryTrashKind): NonNullable<ItemKindDef['ops']> => ({ remove: (store, id) => trashLibraryItem(store, kind, id), restore: (store, trashId) => restoreFromTrash(store, trashId) });
const saved = (kind: LibraryTrashKind): Omit<ItemKindDef, 'info'> => ({ resolve: (store, ref) => resolveSaved(store, ref as SavedRef), ops: trashOps(kind) });

export const libraryKinds: KindDefs = {
  'grpc-call': saved('grpc-call'),
  'ws-connection': saved('ws-connection'),
  prompt: saved('prompt'),
  'load-test': saved('load-test'),
  evaluation: saved('evaluation'),
  'rag-target': saved('rag-target'),
  monitor: {
    // (a tenant's id, <monitor>@<tenant>, deletes the definition it comes from: there is no monitor of its own to delete)
    ops: { ...trashOps('monitor'), remove: (store, id) => trashLibraryItem(store, 'monitor', id.includes('@') ? id.slice(0, id.indexOf('@')) : id) },
    resolve: (store, ref) => {
      // a monitor ref, or a library item of `monitors` (toItemRef turns those into monitor refs)
      const r = ref as Extract<ItemRef, { kind: 'monitor' }>;
      const it = libraryIndex(store, 'monitors')?.byId.get(r.monitorId);
      return it ? ok(r, it.name, 'Monitor') : missing(r, 'That monitor no longer exists (deleted, or in another workspace).', { label: 'Open monitors', view: 'monitors' });
    },
  },
};
