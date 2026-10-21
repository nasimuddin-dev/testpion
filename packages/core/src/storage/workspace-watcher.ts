import { readdirSync, readFileSync, statSync, watch } from 'node:fs';
import { join, sep } from 'node:path';
import { watchKindOfPath, type WatchKind } from '@testpion/shared';
import { forgetOwnWrite, ownWrite } from './fsutil.js';
import { sha1Hex } from '../util/hash.js';

/**
 * Watch a workspace folder for changes made outside the app (GIT-103): `git pull`, a branch switch, another editor.
 * Results and this computer's state are ignored, so are the app's own changes: each is known by path and what it made
 * the file (fsutil `ownWrite`), never by the time, so an outside change right after a save is still reported. Changes
 * arrive in batches (a pull touches many files at once).
 */
/** The kind of file a change touched: the item-kind registry's watch kinds (`data.changed` `kinds`). */
export type WorkspaceChangeKind = WatchKind;

export interface WorkspaceChange {
  /** Path inside the workspace, with forward slashes. */
  path: string;
  kind: WorkspaceChangeKind;
}

const IGNORED_TOP = new Set(['runs', 'traces', 'payloads', 'reports', 'baselines', 'trash', '.local', '.git', 'node_modules']);
// debugger/*.har: capture sessions are git-ignored and written constantly while a capture runs (debugger/shared/ is tracked and still reported)
const IGNORED_FILE = /(^|\/)(database\.sqlite.*|metadata\.jsonl|\.template-offered\.json)$|^debugger\/[^/]+\.har$|\.tmp-\d+-[0-9a-f]+$|~$|\.swp$/;

/** What a changed file is (results, local state and temp files: nothing); the registry says which kind it belongs to. */
export function changeKind(path: string): WorkspaceChangeKind | undefined {
  const top = path.split('/')[0]!;
  if (IGNORED_TOP.has(top) || IGNORED_FILE.test(path)) return undefined;
  return watchKindOfPath(path, { raw: true });
}

/** A running watch: call it to stop; `adopt()` takes the folder as it is now as known (see below). */
export type WorkspaceWatch = (() => void) & {
  /**
   * The app had another program change the folder for it (git switch, pull, discard): take every file as it is now as
   * the known state, so those changes are not reported as outside ones. The caller refreshes everything itself.
   */
  adopt(): void;
};

/** The folder events the watcher listens to (node's recursive `fs.watch`; a test passes its own). */
export type WatchSource = (root: string, listener: (event: string, name: string | null) => void) => { close(): void };

const nodeWatch: WatchSource = (root, listener) => {
  const w = watch(root, { recursive: true, persistent: false }, (event, name) => listener(event, name === null ? null : String(name)));
  w.on('error', () => undefined);
  return w;
};

/** Start watching; `onChange` gets each batch once things are quiet for `debounceMs`. */
export function watchWorkspace(root: string, onChange: (changes: WorkspaceChange[]) => void, opts: { debounceMs?: number; watch?: WatchSource } = {}): WorkspaceWatch {
  const pending = new Map<string, WorkspaceChange>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: { close(): void } | undefined;
  /**
   * What each file was when last seen: its size and last write. Windows reports a file being read (its access time)
   * as a change, so an event only counts when the file itself is different (or appeared, or is gone).
   */
  const seen = new Map<string, string>();
  /**
   * What a file is: its size and last write (`stat:` — cheap, taken for every file at open), or its size and content
   * hash (`hash:` — taken the first time a file reports an event, and from then on: a rewrite with the same bytes, git
   * restoring a file, is no change either). Opening a big workspace reads no file at all.
   */
  const fingerprint = (path: string, mode: 'stat' | 'hash') => {
    try {
      const full = join(root, path);
      const st = statSync(full);
      if (st.isDirectory()) return 'dir';
      // whole milliseconds: a tool that sets the time back (an access-time touch) gives it to the millisecond
      if (mode === 'stat' || st.size > 8 * 1024 * 1024) return `stat:${st.size}:${Math.round(st.mtimeMs)}`;
      return `hash:${st.size}:${sha1Hex(readFileSync(full))}`;
    } catch {
      return 'gone';
    }
  };
  /** The file now, against what was seen: `same` when it only looks touched (an access time, a same-bytes rewrite). */
  const compare = (path: string): { now: string; same: boolean } => {
    const before = seen.get(path) ?? 'gone';
    if (before.startsWith('stat:')) {
      // only a size:mtime is known: unchanged when those are; else the content is hashed from now on
      const quick = fingerprint(path, 'stat');
      if (quick === before) return { now: before, same: true };
      const now = quick === 'gone' || quick === 'dir' ? quick : fingerprint(path, 'hash');
      return { now, same: now === before };
    }
    const now = fingerprint(path, 'hash');
    return { now, same: now === before };
  };
  const snapshot = (dir: string, depth = 0) => {
    if (depth > 8) return;
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const path = dir ? `${dir}/${e.name}` : e.name;
      if (!changeKind(path)) continue;
      if (e.isDirectory()) snapshot(path, depth + 1);
      else seen.set(path, fingerprint(path, 'stat'));
    }
  };
  snapshot('');
  const flush = () => {
    timer = undefined;
    if (!pending.size) return;
    const batch = [...pending.values()].filter((c) => {
      const { now, same } = compare(c.path);
      if (now === 'gone') seen.delete(c.path);
      else seen.set(c.path, now);
      // a folder event says nothing by itself: its files report their own changes
      return now !== 'dir' && !same;
    });
    pending.clear();
    if (batch.length) onChange(batch);
  };
  const onEvent = (name: string | null) => {
    if (!name) return;
    const path = String(name).split(sep).join('/');
    const kind = changeKind(path);
    if (!kind) return;
    const full = join(root, path);
    const own = ownWrite(full);
    if (own !== undefined) {
      // the app's own change when the file is exactly what it made it (or gone, when it removed it): that is the known
      // state now. Anything else is someone else's change after it (an editor, git), reported like any outside change.
      const f = fingerprint(path, own.startsWith('stat:') ? 'stat' : 'hash');
      if (f === own) {
        if (f === 'gone') seen.delete(path);
        else seen.set(path, f);
        return;
      }
      if (f !== 'dir') forgetOwnWrite(full);
    }
    // a just-written temp file renamed into place reports the final name too: one entry per path
    pending.set(path, { path, kind });
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, opts.debounceMs ?? 400);
  };
  try {
    watcher = (opts.watch ?? nodeWatch)(root, (_event, name) => onEvent(name));
  } catch {
    // a host without recursive watching: the app still works, it just won't notice outside changes
    return Object.assign(() => undefined, { adopt: () => undefined });
  }
  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    watcher?.close();
  };
  const adopt = () => {
    seen.clear();
    snapshot('');
  };
  return Object.assign(stop, { adopt });
}

/** A short description of a batch for the user: "2 collections and 1 environment changed on disk". */
export function describeChanges(changes: WorkspaceChange[]): string {
  const count = (k: WorkspaceChangeKind) => new Set(changes.filter((c) => c.kind === k).map((c) => c.path)).size;
  const parts: string[] = [];
  const add = (n: number, one: string, many: string) => n && parts.push(`${n} ${n === 1 ? one : many}`);
  add(count('collections'), 'collection', 'collections');
  add(count('environments'), 'environment', 'environments');
  add(count('tests'), 'test file', 'test files');
  add(count('library'), 'saved call list', 'saved call lists');
  add(count('mcp'), 'MCP server list', 'MCP server lists');
  add(count('specs'), 'API definition', 'API definitions');
  add(count('providers') + count('workspace') + count('other'), 'other file', 'other files');
  return parts.length ? `${parts.join(', ')} changed outside TestPion` : 'Files changed outside TestPion';
}
