import { useCallback, useSyncExternalStore } from 'react';
import { afterScopeChange, beforeScopeChange, scopedKey } from './ws-scope';

/**
 * Which folders, collections and sections are open, for every tree and list (planning/menus-uniform.md §3): one store
 * per workspace, kept across restarts (`ws:<id>:aps.tree-state` in the window's storage), with one sub-record per tree
 * (`collections`, `explorer`, `list:<id>` …) so a change in one tree leaves the others' objects as they were. Expand all
 * and Collapse all of every container go through `setSubtree`, the one implementation.
 *
 * The stores of earlier versions (`aps.tree.open`, `aps.explorer.sections.v2`, `aps.folders.<id>`, kept for every
 * workspace at once) move into the first workspace that opens, once, the way sticky values did.
 */
export type TreeOpen = Readonly<Record<string, boolean>>;
type State = Record<string, TreeOpen>;

const KEY = 'aps.tree-state';
const EMPTY: TreeOpen = Object.freeze({});
let state: State | undefined;
let loadedFor: string | undefined;
const listeners = new Set<() => void>();

const storage = (): Storage | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

/** The stores of earlier versions, as sub-records of this one (read once, then removed). */
export function migrateOldTreeKeys(s: Storage): State {
  const out: Record<string, Record<string, boolean>> = {};
  const read = (k: string): Record<string, boolean> | undefined => {
    try {
      const v = s.getItem(k);
      const o = v === null ? undefined : (JSON.parse(v) as unknown);
      return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, boolean>) : undefined;
    } catch {
      return undefined;
    }
  };
  const tree = read('aps.tree.open');
  if (tree) out.collections = { ...tree };
  const sections = read('aps.explorer.sections.v2');
  if (sections) out.explorer = { ...sections };
  const lists: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (k?.startsWith('aps.folders.')) lists.push(k);
  }
  // a FolderList kept which folders were collapsed (true = closed): here every tree keeps what is open
  for (const k of lists) {
    const collapsed = read(k);
    if (collapsed) out[`list:${k.slice('aps.folders.'.length)}`] = Object.fromEntries(Object.entries(collapsed).map(([f, c]) => [f, !c]));
  }
  for (const k of ['aps.tree.open', 'aps.explorer.sections.v2', ...lists]) s.removeItem(k);
  return out;
}

function load(): State {
  const k = scopedKey(KEY);
  if (state && loadedFor === k) return state;
  loadedFor = k;
  state = {};
  const s = storage();
  if (!k || !s) return state;
  try {
    const raw = s.getItem(k);
    if (raw !== null) state = JSON.parse(raw) as State;
    else {
      const migrated = migrateOldTreeKeys(s);
      if (Object.keys(migrated).length) {
        state = migrated;
        s.setItem(k, JSON.stringify(state));
      }
    }
  } catch {
    state = {};
  }
  return state;
}

/** A write is pending (several changes in one task — Expand all over many collections — are written once). */
let pending = false;
function flush(): void {
  if (!pending) return;
  pending = false;
  const k = scopedKey(KEY);
  const s = storage();
  if (!k || !s || !state) return;
  try {
    s.setItem(k, JSON.stringify(state));
  } catch {
    /* storage unavailable: kept for this session */
  }
}
function save(): void {
  if (pending) return;
  pending = true;
  // after the current task: the state is serialised once, however many changes this task made (JSON.stringify of every
  // tree and a synchronous localStorage.setItem per change were the cost of Expand all); a workspace switch in between
  // writes it first (beforeScopeChange), so the old workspace's state never lands in the new one's store
  queueMicrotask(flush);
}

/**
 * The key of a node in a tree's record, from its parts (`treeKey('col-1', 'cat', 'rest')` = `col-1:cat:rest`): one
 * scheme for every tree (the record itself is the scope: `collections`, `explorer`, `list:<id>`, `tests`).
 */
export const treeKey = (...parts: Array<string | number>): string => parts.join(':');

const emit = () => listeners.forEach((l) => l());
beforeScopeChange(flush);
afterScopeChange(() => {
  state = undefined;
  emit();
});

/** One tree's open/closed record (the same object until it changes). */
export const treeOpenOf = (scope: string): TreeOpen => load()[scope] ?? EMPTY;

/** Change one tree's record (a toggle, a reveal, Expand all …): one write, one render. */
export function setTreeOpen(scope: string, change: (open: TreeOpen) => TreeOpen): void {
  const all = load();
  const before = all[scope] ?? EMPTY;
  const next = change(before);
  if (next === before) return;
  state = { ...all, [scope]: next };
  save();
  emit();
}

/** Open or close a container and everything inside it (`keys`: the container's own key and its descendants'). */
export function setSubtree(scope: string, keys: readonly string[], open: boolean): void {
  setTreeOpen(scope, (o) => (keys.every((k) => o[k] === open) ? o : { ...o, ...Object.fromEntries(keys.map((k) => [k, open])) }));
}

/** Whether a node is open (`def` when nothing was remembered for it). */
export const isTreeOpen = (scope: string, key: string, def = true): boolean => treeOpenOf(scope)[key] ?? def;

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** A tree's open/closed record and its setter, kept per workspace (React re-renders the tree when its record changes). */
export function useTreeOpen(scope: string): [TreeOpen, (change: TreeOpen | ((open: TreeOpen) => TreeOpen)) => void] {
  const open = useSyncExternalStore(subscribe, () => treeOpenOf(scope));
  const set = useCallback((change: TreeOpen | ((open: TreeOpen) => TreeOpen)) => setTreeOpen(scope, typeof change === 'function' ? change : () => change), [scope]);
  return [open, set];
}
