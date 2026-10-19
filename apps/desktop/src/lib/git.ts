import { useEffect, useSyncExternalStore } from 'react';
import { gitMarksOf, type GitMarkInfo } from '@testpion/shared';
import { call, on } from '../api';
import type { GitStatusInfo, SemanticChange } from '../views/GitView';

/**
 * The workspace's git state, shared by the status bar, the change marks of every list and the Git view (GIT-204): read
 * once, refreshed when the workspace or git changes. Nothing is read when the workspace is not in git.
 */
interface GitState {
  status?: GitStatusInfo;
  /** Every change mark by key (@testpion/shared git-marks): an item's own change, a folder's or a section's count. */
  marks: Map<string, GitMarkInfo>;
  /** What changed, item by item (the Git view lists these). */
  changes: SemanticChange[];
}

let state: GitState = { marks: new Map(), changes: [] };
const listeners = new Set<() => void>();
let users = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let offs: Array<() => void> = [];

async function refresh() {
  try {
    // one round trip: the status and, when something changed, what it means
    const { changes, ...status } = await call<GitStatusInfo & { changes: SemanticChange[] }>('git.changes');
    state = { status, marks: gitMarksOf(changes), changes };
  } catch {
    state = { marks: new Map(), changes: [] };
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

const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));

/** The mark one key has right now (an item's own change, a folder's or section's count); undefined: unchanged, or not in git. */
export function useGitMarkInfo(key: string): GitMarkInfo | undefined {
  return useSyncExternalStore(subscribe, () => state.marks.get(key));
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
  return useSyncExternalStore(subscribe, () => state);
}
