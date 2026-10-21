import { useEffect, useRef, useSyncExternalStore } from 'react';
import { gitMarksOf, type GitMarkInfo } from '@testpion/shared';
import { call, on } from '../api';
import type { GitStatusInfo, SemanticChange } from '../views/GitView';

/**
 * The workspace's git state, shared by the status bar, the change marks of every list and the Git view (GIT-204): read
 * once, refreshed when the workspace or git changes. Nothing is read when the workspace is not in git.
 *
 * It is read often (two seconds after every save), so a read that finds nothing new changes nothing: the state keeps its
 * identity, and no component renders. A component takes the one thing it shows (`useGitRepo`, `useGitBehind`, `useGitBar`,
 * `useGitMarkInfo`), never the whole state, so a changed file list does not render the explorer.
 */
interface GitState {
  status?: GitStatusInfo;
  /** Every change mark by key (@testpion/shared git-marks): an item's own change, a folder's or a section's count. */
  marks: Map<string, GitMarkInfo>;
  /** What changed, item by item (the Git view lists these). */
  changes: SemanticChange[];
}

let state: GitState = { marks: new Map(), changes: [] };
/** What the state was made from (the answer as text): a read with the same answer is dropped. */
let signature = '';
const listeners = new Set<() => void>();
let users = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
/** When the pending read was asked for to run: 0 at once (a git event), else the settle wait; meaningless while no timer is pending. */
let readsAt = 0;
let offs: Array<() => void> = [];

/** The marks of a new read, with the very same object for a mark that did not change (a component of an unchanged mark does not render). */
function reuseMarks(next: Map<string, GitMarkInfo>, old: Map<string, GitMarkInfo>): Map<string, GitMarkInfo> {
  let same = next.size === old.size;
  for (const [k, v] of next) {
    const was = old.get(k);
    if (was && was.change === v.change && was.count === v.count) next.set(k, was);
    else same = false;
  }
  return same ? old : next;
}

async function readOnce() {
  let next: GitState;
  let sig: string;
  try {
    // one round trip: the status and, when something changed, what it means
    const { changes, ...status } = await call<GitStatusInfo & { changes: SemanticChange[] }>('git.changes');
    sig = JSON.stringify([status, changes]);
    if (sig === signature) return;
    next = { status, marks: reuseMarks(gitMarksOf(changes), state.marks), changes };
  } catch {
    sig = 'unreadable';
    if (sig === signature) return;
    next = { marks: new Map(), changes: [] };
  }
  signature = sig;
  state = next;
  listeners.forEach((l) => l());
}

/**
 * Read the state again. One read at a time: a request that comes while one is running makes one more run after it (never
 * several), and every caller gets the promise of the run that includes its request. Reads therefore never overtake each
 * other, and a slow one cannot overwrite a newer answer.
 */
let running: Promise<void> | undefined;
let rerun = false;
export function refreshGit(): Promise<void> {
  if (running) {
    rerun = true;
    return running;
  }
  running = (async () => {
    do {
      rerun = false;
      await readOnce();
    } while (rerun);
  })().finally(() => {
    running = undefined;
  });
  return running;
}

/** A git event (a commit, a pull, a branch switch …): read at once (the next task: a burst is one read). */
const now = () => {
  clearTimeout(timer);
  timer = setTimeout(() => ((timer = undefined), void refreshGit()), 0);
  readsAt = 0;
};
/** A save or a change on disk: read once things settled (a run or an import saves many files in a row). */
const SETTLE_MS = 2000;
const later = () => {
  // a read already asked for at once is not put off by a save that follows it (the watcher reports the app's own write a
  // moment after the git event: that used to replace the immediate read with one two seconds later, and again for each
  // report that came, so the Git view showed the state from before an Undo for as long as files kept being written)
  if (timer !== undefined && readsAt === 0) return;
  clearTimeout(timer);
  readsAt = SETTLE_MS;
  timer = setTimeout(() => ((timer = undefined), void refreshGit()), SETTLE_MS);
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

/** The current state without subscribing (menus are built while open, outside React's render). */
export const gitSnapshot = (): GitState => state;

/** Keeps the state read and fresh while a component that shows it is on screen. */
function useGitLive() {
  useEffect(() => startGitLive(), []);
}

/** Start keeping the state read (the first user starts the subscriptions); returns the stop (the last one ends them). Exported for the tests. */
export function startGitLive(): () => void {
  if (users++ === 0) {
    void refreshGit();
    offs = [on('git.changed', now), on('git.remoteChanged', now), on('data.changed', onDataChanged), on('workspace.changedOnDisk', later)];
  }
  return () => {
    if (--users === 0) offs.forEach((o) => o());
  };
}

/**
 * One value taken from the state. The component renders again only when that value changed (`equal`, by identity unless
 * said otherwise), however often git is read.
 */
function useGitValue<T>(select: (s: GitState) => T, equal: (a: T, b: T) => boolean = Object.is): T {
  useGitLive();
  const last = useRef<{ from: GitState; value: T } | undefined>(undefined);
  return useSyncExternalStore(subscribe, () => {
    const prev = last.current;
    if (prev && prev.from === state) return prev.value;
    const value = select(state);
    const kept = prev && equal(prev.value, value) ? prev.value : value;
    last.current = { from: state, value: kept };
    return kept;
  });
}

/** The status and what changed, item by item: what the Git view lists (the same read the marks and the status bar use: the view asks git for nothing itself). */
export const useGitFull = (): { status?: GitStatusInfo; changes: SemanticChange[] } =>
  useGitValue(
    (s) => ({ status: s.status, changes: s.changes }),
    (a, b) => a.status === b.status && a.changes === b.changes,
  );

/** Whether the workspace is a git repository (the explorer's History entries, the environments' history). */
export const useGitRepo = (): boolean => useGitValue((s) => !!s.status?.repository);

/** How many commits the remote has that this branch does not (the rail's badge). */
export const useGitBehind = (): number => useGitValue((s) => s.status?.behind ?? 0);

/** What the status bar shows of git: undefined when the workspace is not a repository. */
export interface GitBar {
  branch?: string;
  ahead: number;
  behind: number;
  conflicted: boolean;
  changedFiles: number;
}
export const useGitBar = (): GitBar | undefined =>
  useGitValue(
    (s) => (s.status?.repository ? { branch: s.status.branch, ahead: s.status.ahead, behind: s.status.behind, conflicted: !!s.status.conflicted, changedFiles: s.status.files.length } : undefined),
    (a, b) => a === b || (!!a && !!b && a.branch === b.branch && a.ahead === b.ahead && a.behind === b.behind && a.conflicted === b.conflicted && a.changedFiles === b.changedFiles),
  );

/** Test hook: the state as a fresh start (the store is module state). */
export function resetGitForTest() {
  state = { marks: new Map(), changes: [] };
  signature = '';
  clearTimeout(timer);
  timer = undefined;
  users = 0;
  offs.forEach((o) => o());
  offs = [];
  running = undefined;
  rerun = false;
}
