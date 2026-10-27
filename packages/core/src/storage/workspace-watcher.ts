import { readdirSync, readFileSync, statSync, watch } from 'node:fs';
import { join, sep } from 'node:path';
import { watchKindOfPath, type WatchKind } from '@testpion/shared';
import { forgetOwnWrite, ownWrite, ownWriteStat } from './fsutil.js';
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

/** The open walks the folder in slices of this many milliseconds; a burst of events is reported at the latest this long after its first. */
const SLICE_MS = 8;
const MAX_WAIT_MS = 5000;
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
export type WatchSource = (root: string, listener: (event: string, name: string | null) => void, onError?: (e: Error) => void) => { close(): void };

const nodeWatch: WatchSource = (root, listener, onError) => {
  const w = watch(root, { recursive: true, persistent: false }, (event, name) => listener(event, name === null ? null : String(name)));
  w.on('error', (e) => onError?.(e));
  return w;
};

/** Start watching; `onChange` gets each batch once things are quiet for `debounceMs`. */
/** Waits before the watch is started again after it failed (the folder was unmounted, a limit was reached). */
const RETRY_WATCH_MS = [1000, 5000, 30_000];

/**
 * Start watching; `onChange` gets each batch once things are quiet for `debounceMs`. `onProblem` hears why the watch could not start or
 * stopped (once per failure; the code, e.g. ENOSPC when the inotify limit is reached), and the watch is started again after 1, 5 and then
 * every 30 seconds: outside changes are not silently missed.
 */
export function watchWorkspace(root: string, onChange: (changes: WorkspaceChange[]) => void, opts: { debounceMs?: number; maxWaitMs?: number; watch?: WatchSource; onProblem?: (message: string, code?: string) => void } = {}): WorkspaceWatch {
  const pending = new Map<string, WorkspaceChange>();
  const debounce = opts.debounceMs ?? 400;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstEventAt = 0;
  let lastEventAt = 0;
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
  /**
   * The same walk at open, in slices of about 8 ms between event-loop turns: a 50,000-file workspace took 3 s of
   * stat calls to open, all of it blocking. The first slice runs now (a small workspace is known when this returns).
   * A file that reports an event before its turn is not in `seen`, so it counts as changed (the safe side), and the
   * walk never overwrites a file an event already touched.
   */
  let walk = 0;
  const snapshotSliced = () => {
    const mine = ++walk;
    const stack: Array<{ dir: string; depth: number; entries?: import('node:fs').Dirent[]; i: number }> = [{ dir: '', depth: 0, i: 0 }];
    const slice = () => {
      if (mine !== walk) return;
      const until = performance.now() + SLICE_MS;
      let n = 0;
      while (stack.length) {
        const f = stack[stack.length - 1]!;
        if (!f.entries) {
          if (f.depth > 8) {
            stack.pop();
            continue;
          }
          try {
            f.entries = readdirSync(join(root, f.dir), { withFileTypes: true });
          } catch {
            stack.pop();
            continue;
          }
        }
        if (f.i >= f.entries.length) {
          stack.pop();
          continue;
        }
        const e = f.entries[f.i++]!;
        const path = f.dir ? `${f.dir}/${e.name}` : e.name;
        if (!changeKind(path)) continue;
        if (e.isDirectory()) stack.push({ dir: path, depth: f.depth + 1, i: 0 });
        else if (!seen.has(path) && !pending.has(path)) seen.set(path, fingerprint(path, 'stat'));
        if (++n % 64 === 0 && performance.now() > until) break;
      }
      if (stack.length && mine === walk) setImmediate(slice).unref();
    };
    slice();
  };
  snapshotSliced();
  /**
   * The system could not say which files changed: its buffer of events overflowed (a checkout or a merge while the app's
   * thread was busy writes thousands of entries in .git), and the one event left names no file. Every file is looked at
   * again instead (a stat each; only those that differ are read), so a change in that burst is still reported.
   */
  let rescanAll = false;
  const queueEverything = () => {
    const walkAll = (dir: string, depth: number) => {
      if (depth > 8) return;
      let entries: import('node:fs').Dirent[] = [];
      try {
        entries = readdirSync(join(root, dir), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const path = dir ? `${dir}/${e.name}` : e.name;
        const kind = changeKind(path);
        if (!kind) continue;
        if (e.isDirectory()) walkAll(path, depth + 1);
        else if (!isKnownOwnWrite(path)) pending.set(path, { path, kind });
      }
    };
    walkAll('', 0);
    // and those that are gone
    for (const path of seen.keys()) if (!pending.has(path)) pending.set(path, { path, kind: changeKind(path)! });
  };
  const flush = () => {
    timer = undefined;
    firstEventAt = 0;
    if (rescanAll) {
      rescanAll = false;
      queueEverything();
    }
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
  const arm = () => {
    // one timer per burst (not a clearTimeout / setTimeout per event: a branch switch is tens of thousands), re-armed
    // while events keep coming, but never later than MAX_WAIT_MS after the first: a build that writes for minutes
    // is reported in batches instead of when it ends (and `pending` stays one entry per file)
    lastEventAt = Date.now();
    if (!firstEventAt) firstEventAt = lastEventAt;
    if (!timer) timer = setTimeout(check, debounce);
  };
  /** True when the path is exactly what the app itself wrote (the known state now): nothing to report. */
  const isKnownOwnWrite = (path: string): boolean => {
    const full = join(root, path);
    const own = ownWrite(full);
    if (own === undefined) return false;
    // the app's own change when the file is exactly what it made it (or gone, when it removed it): that is the known
    // state now. Anything else is someone else's change after it (an editor, git), reported like any outside change.
    // the size and time the file had right after the app wrote it: still those, and nothing needs reading or hashing
    const ownStat = own === 'gone' ? undefined : ownWriteStat(full);
    if (ownStat && fingerprint(path, 'stat') === ownStat) {
      seen.set(path, ownStat);
      return true;
    }
    const f = fingerprint(path, own.startsWith('stat:') ? 'stat' : 'hash');
    if (f === own) {
      if (f === 'gone') seen.delete(path);
      else seen.set(path, f);
      return true;
    }
    if (f !== 'dir') forgetOwnWrite(full);
    return false;
  };
  const onEvent = (name: string | null) => {
    if (!name) return void ((rescanAll = true), arm());
    const path = String(name).split(sep).join('/');
    const kind = changeKind(path);
    if (!kind) return;
    if (isKnownOwnWrite(path)) return;
    // a just-written temp file renamed into place reports the final name too: one entry per path
    pending.set(path, { path, kind });
    arm();
  };
  const check = () => {
    timer = undefined;
    const now = Date.now();
    const wait = Math.min(debounce - (now - lastEventAt), (opts.maxWaitMs ?? MAX_WAIT_MS) - (now - firstEventAt));
    if (wait > 0 && (pending.size || rescanAll)) timer = setTimeout(check, wait);
    else flush();
  };
  let stopped = false;
  let retries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const begin = (): boolean => {
    try {
      const mine = (opts.watch ?? nodeWatch)(
        root,
        (_event, name) => onEvent(name),
        (e) => {
          if (watcher !== mine) return; // an older watch that was already replaced
          failed(e);
        },
      );
      watcher = mine;
      return true;
    } catch (e) {
      failed(e as Error);
      return false;
    }
  };
  const failed = (e: Error) => {
    const code = (e as NodeJS.ErrnoException).code;
    try {
      watcher?.close();
    } catch {
      /* already closed */
    }
    watcher = undefined;
    if (stopped) return;
    const wait = RETRY_WATCH_MS[Math.min(retries++, RETRY_WATCH_MS.length - 1)]!;
    opts.onProblem?.(`Not watching ${root} for changes made outside TestPion (${code ?? e.message}); trying again in ${Math.round(wait / 1000)} s`, code);
    retryTimer = setTimeout(() => {
      if (stopped) return;
      if (begin()) {
        retries = 0;
        rescanAll = true; // what changed while the watch was down
        arm();
      }
    }, wait);
    retryTimer.unref?.();
  };
  begin();
  const stop = () => {
    stopped = true;
    clearTimeout(retryTimer);
    if (timer) clearTimeout(timer);
    timer = undefined;
    walk++;
    watcher?.close();
  };
  const adopt = () => {
    walk++;
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
