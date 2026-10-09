import { useEffect, useSyncExternalStore } from 'react';
import { call, on } from '../api';
import type { GitStatusInfo, SemanticChange } from '../views/GitView';

/**
 * The workspace's git state, shared by the status bar, the explorer's change marks and the Git view (GIT-204): read
 * once, refreshed when the workspace or git changes. Nothing is read when the workspace is not in git.
 */
interface GitState {
  status?: GitStatusInfo;
  /** Change by collection item id (the explorer marks those rows). */
  items: Map<string, SemanticChange['change']>;
  /** Collections with any change. */
  collections: Set<string>;
}

let state: GitState = { items: new Map(), collections: new Set() };
const listeners = new Set<() => void>();
let users = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let offs: Array<() => void> = [];

async function refresh() {
  try {
    // one round trip: the status and, when something changed, what it means
    const { changes, ...status } = await call<GitStatusInfo & { changes: SemanticChange[] }>('git.changes');
    const items = new Map<string, SemanticChange['change']>();
    const collections = new Set<string>();
    for (const c of changes) {
      if (c.itemId) items.set(c.itemId, c.change);
      if (c.collectionId) collections.add(c.collectionId);
    }
    state = { status, items, collections };
  } catch {
    state = { items: new Map(), collections: new Set() };
  }
  listeners.forEach((l) => l());
}

/** A git event (a commit, a pull, a branch switch …): read at once (the next task: a burst is one read). */
const now = () => {
  clearTimeout(timer);
  timer = setTimeout(() => void refresh(), 0);
};
/** A save or a change on disk: read once things settled (a run or an import saves many files in a row). */
const SETTLE_MS = 2000;
const later = () => {
  clearTimeout(timer);
  timer = setTimeout(() => void refresh(), SETTLE_MS);
};
/** `data.changed` events that write no workspace file: a run's results, a connection; they never change git's status. */
const NO_FILES = /^mcp\.(connect|disconnect)$/;
function onDataChanged(e?: { method?: string; kind?: string }) {
  if (e?.method === 'ws.open' || e?.method === 'git') return now();
  if (!e?.method && e?.kind === 'runs') return;
  if (e?.method && NO_FILES.test(e.method)) return;
  // not in git (and git can't be asked): a save changes nothing here; `git init` arrives as git.changed
  if (state.status && (!state.status.available || !state.status.repository)) return;
  later();
}

export function useGit(): GitState {
  useEffect(() => {
    if (users++ === 0) {
      void refresh();
      offs = [on('git.changed', now), on('git.remoteChanged', now), on('data.changed', onDataChanged), on('workspace.changedOnDisk', later)];
    }
    return () => {
      if (--users === 0) offs.forEach((o) => o());
    };
  }, []);
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => state,
  );
}
