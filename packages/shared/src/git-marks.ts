/**
 * Change marks (planning/git-everything.md §4c): which rows of the explorer show that git sees a change. One key
 * scheme, built here for both sides: the engine says, for each changed item, the keys it makes a mark on (its own and
 * its containers'), and a row of any list asks for its own key. A row's key is the key of its ItemRef; a folder and a
 * section header have keys of their own, so they show how many changes are inside.
 */
import { itemRefKey, type ItemRef } from './item-ref.js';
import { KIND_INFO, kindOfRef, type KindId } from './item-kinds.js';

/** The key of an item's own mark: its ref's key. A flow is a test file, a step or a line of it is the file. */
export function gitRefKey(ref: ItemRef): string {
  if (ref.kind === 'flow' || ref.kind === 'test') return itemRefKey({ kind: 'test', path: ref.path });
  if (ref.kind === 'saved' && ref.library === 'monitors') return itemRefKey({ kind: 'monitor', monitorId: ref.itemId });
  if (ref.kind === 'monitor') return itemRefKey({ kind: 'monitor', monitorId: ref.monitorId });
  if (ref.kind === 'request') return itemRefKey({ kind: 'request', collectionId: ref.collectionId, requestId: ref.requestId });
  if (ref.kind === 'collection') return itemRefKey({ kind: 'collection', collectionId: ref.collectionId });
  if (ref.kind === 'environment' && !ref.scope && ref.environmentId) return itemRefKey({ kind: 'environment', environmentId: ref.environmentId });
  return itemRefKey(ref);
}

/** The key of a folder of a kind's list (a library folder, a folder of test files, a collection's folder uses its ref). */
export const gitFolderKey = (kind: KindId, folder: string): string => `folder|${kind}|${folder}`;

/**
 * The built-in folder of every list of saved items: an item with no folder is shown in it (a view of the list, not
 * stored: the file keeps `folder` unset), and an item whose stored folder is literally this name is in it too.
 */
export const DEFAULT_FOLDER = 'General';

/** The key of a section header: every change of a kind. */
export const gitSectionKey = (kind: KindId): string => `section|${kind}`;

/** The registry kind of a ref (a library item by its library), the kind whose section it is listed in. */
export const gitKindOfRef = (ref: ItemRef): KindId | undefined => (ref.kind === 'saved' ? kindOfRef(ref)?.id : ref.kind === 'flow' ? 'test' : ref.kind in KIND_INFO ? (ref.kind as KindId) : undefined);

/** What the window knows of a mark: a change (an item) or a count of changes inside (a folder, a section). */
export interface GitMarkInfo {
  change: 'added' | 'removed' | 'changed' | 'renamed' | 'conflicted';
  /** For a container: how many changes are inside. */
  count?: number;
}

/** The slice of a semantic change the marks are made from. */
interface MarkedChange {
  change: GitMarkInfo['change'];
  ref?: ItemRef;
  /** The keys of the containers it is inside (folders, the collection, the section). */
  containers?: string[];
}

/** Every mark a list of changes makes, by key: an item's own change, and a container's count. */
export function gitMarksOf(changes: readonly MarkedChange[]): Map<string, GitMarkInfo> {
  const marks = new Map<string, GitMarkInfo>();
  for (const c of changes) {
    // a removed item has no row left: only its containers show it
    if (c.ref && c.change !== 'removed') {
      const key = gitRefKey(c.ref);
      const had = marks.get(key);
      // a file with several changes (a test file with steps, a collection with requests) is "changed" on its own row
      if (!had) marks.set(key, { change: c.change });
      else if (had.change !== c.change) marks.set(key, { ...had, change: 'changed' });
    }
    for (const k of c.containers ?? []) {
      const had = marks.get(k);
      marks.set(k, { change: had?.change ?? 'changed', count: (had?.count ?? 0) + 1 });
    }
  }
  return marks;
}
