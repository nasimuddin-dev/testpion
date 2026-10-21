import type { Collection } from '../model/types.js';
import type { WorkspaceStore } from '../storage/workspace.js';

/**
 * The store for an import run. Every input of an import asks for the collections of the workspace (their node ids and names,
 * so nothing clashes, and the one an update would change), and the store reads and parses every collection file for each
 * ask: 100 files into a workspace of 10,000 requests parsed the whole workspace 300 times. Here the listing is read once
 * and kept for the run; what the run saves itself is read in (just that one file) when it is saved, so the listing stays
 * what a fresh read would give. Everything that can change the collections (a delete, a reload) drops it.
 *
 * Only for runs that are synchronous from start to end (an import is): nothing else writes while it holds the listing.
 * The order of the listing is not kept (a saved collection goes where it was or last); callers ask for ids, names and
 * node ids, never for the order.
 */
const wrapped = new WeakSet<object>();

type Listed = Collection & { problem?: string };

export function withCollectionListing(store: WorkspaceStore): WorkspaceStore {
  if (wrapped.has(store)) return store;
  let listed: Listed[] | undefined;
  const afterSave = (id: string) => {
    if (!listed) return;
    try {
      const fresh = store.getCollection(id);
      const same = listed.filter((c) => c.id === id).length;
      // two files with one id (the listing renames the second): leave it to a fresh read
      if (same > 1) return void (listed = undefined);
      const at = listed.findIndex((c) => c.id === id);
      if (at >= 0) listed[at] = fresh;
      else listed.push(fresh);
    } catch {
      listed = undefined;
    }
  };
  const proxy: WorkspaceStore = new Proxy(store, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      switch (prop) {
        case 'listCollections':
          // a copy of the array (callers filter and sort theirs); the collections in it are read-only for them
          return () => (listed ??= target.listCollections()).slice();
        case 'saveCollection':
          return (c: Collection) => {
            const saved = target.saveCollection(c);
            afterSave(saved.id);
            return saved;
          };
        case 'deleteCollection':
        case 'reloadWorkspaceFile':
        case 'close':
          return (...args: unknown[]) => {
            listed = undefined;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        default:
          // a method of the real store keeps the real store as `this`
          return value.bind(target);
      }
    },
  });
  wrapped.add(proxy);
  return proxy;
}
