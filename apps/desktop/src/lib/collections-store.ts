import { useEffect } from 'react';
import { create } from 'zustand';
import { call, on } from '../api';
import type { Collection } from '../types';

/**
 * The workspace's collections (every request of every collection), fetched once for the whole app: the
 * Collections sidebar, the REST editor and the breadcrumbs share this list instead of each fetching it, and
 * it is fetched again once after a burst of changes (`data.changed`: a save, an import, a run), not once per
 * listener.
 */
const useStore = create<{ list: Collection[]; loaded: boolean }>(() => ({ list: [], loaded: false }));

let pending: Promise<Collection[]> | undefined;
/**
 * Fetches overlap (a full list asked for before a save can come back after the saved collection was read on its
 * own): each fetch has a number, and a full list does not overwrite a collection read by a later fetch.
 */
let gen = 0;
const readAt = new Map<string, number>();

/** Fetch the collections now (callers that just saved one can await the fresh list). */
export function refreshCollections(): Promise<Collection[]> {
  const g = ++gen;
  pending ??= call<Collection[]>('col.list')
    .then((fetched) => {
      const now = new Map(useStore.getState().list.map((c) => [c.id, c]));
      const list = fetched.map((c) => ((readAt.get(c.id) ?? 0) > g && now.has(c.id) ? now.get(c.id)! : c));
      useStore.setState({ list, loaded: true });
      return list;
    })
    .catch(() => useStore.getState().list)
    .finally(() => (pending = undefined));
  return pending;
}

/** Read only the collections that were saved and put them in the list (a save of one does not reload them all). */
async function refreshSome(ids: string[]): Promise<void> {
  const g = ++gen;
  const fresh = await Promise.all(ids.map((id) => call<Collection>('col.get', { id }).catch(() => undefined)));
  if (fresh.some((c) => !c)) return void refreshCollections();
  for (const c of fresh) if ((readAt.get(c!.id) ?? 0) < g) readAt.set(c!.id, g);
  const byId = new Map(fresh.map((c) => [c!.id, c!]));
  useStore.setState((st) => ({ list: st.list.map((c) => byId.get(c.id) ?? c) }));
}

/** After saving one collection: read it back (callers that go on with the fresh list await it). */
export const refreshCollection = (id: string) => refreshSome([id]);

let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  // the changes since the last refresh: the saved collections, or "everything" (an import, a delete, a move, git,
  // the disk). The first change refreshes at once (in the next task, so a burst in one task is one refresh); changes
  // that come while it runs are read in one more round after it, not one each.
  let saved = new Set<string>();
  let all = false;
  let running = false;
  const run = async () => {
    try {
      while (all || saved.size) {
        const ids = [...saved];
        const everything = all;
        saved = new Set();
        all = false;
        // a fetch already under way may have started before this change: read again after it
        await (everything ? (pending ? pending.then(() => refreshCollections()) : refreshCollections()) : refreshSome(ids));
      }
    } finally {
      running = false;
    }
  };
  on<{ method?: string; collectionId?: string }>('data.changed', (e) => {
    const known = e?.method === 'col.save' && e.collectionId && useStore.getState().list.some((c) => c.id === e.collectionId);
    if (known) saved.add(e.collectionId!);
    else all = true;
    if (running) return;
    running = true;
    setTimeout(() => void run(), 0);
  });
}

/** The collections, kept up to date (corrupted files included, with `problem` set). */
export function useCollections(): Collection[] {
  const list = useStore((s) => s.list);
  useEffect(() => {
    wire();
    if (!useStore.getState().loaded) void refreshCollections();
  }, []);
  return list;
}

/** The list as it is now, without subscribing (event handlers). */
export const currentCollections = () => useStore.getState().list;
