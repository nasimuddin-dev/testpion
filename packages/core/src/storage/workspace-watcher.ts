import { opendirSync, readFileSync, statSync, watch, type Dir, type Dirent } from 'node:fs';
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

/**
 * The next slice of a long job, after the event loop has had its turn. A timer, not `setImmediate().unref()`: while only unreferenced
 * immediates are waiting, Node's loop may sleep until something else wakes it, and a walk of 20,000 files then crawled at the pace of
 * unrelated events (a slice every ~200 ms in an idle process).
 */
const later = (fn: () => void) => setTimeout(fn, 0).unref();

/** The open walks the folder in slices of this many milliseconds; a burst of events is reported at the latest this long after its first. */
const SLICE_MS = 8;
const MAX_WAIT_MS = 5000;
/** A file's time can run ahead of the clock by a tick or two (up to ~16 ms on Windows): a write this close after `adopt()` still counts as the adopted one. */
const ADOPT_SLACK_MS = 250;
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
  /** Set when the watch is stopped: slices still queued do nothing. */
  let stopped = false;
  /**
   * The folder walked in slices of about SLICE_MS between event-loop turns (50,000 files took 3 s of stat calls, all of it
   * blocking). `file` gets each file the registry knows (a path `changeKind` ignores is skipped, with its folder); `done`
   * runs when the walk ends; `current` says whether a newer walk replaced this one. The first slice runs now (a small
   * workspace is finished when this returns).
   */
  const walkSliced = (current: () => boolean, file: (path: string, kind: WorkspaceChangeKind) => void, done?: () => void) => {
    // a folder is read entry by entry (`opendirSync`), not whole: one folder of 20,000 files would be one long call
    const stack: Array<{ dir: string; depth: number; handle?: Dir }> = [{ dir: '', depth: 0 }];
    const release = () => {
      for (const f of stack.splice(0)) {
        try {
          f.handle?.closeSync();
        } catch {
          /* already closed */
        }
      }
    };
    const slice = () => {
      if (stopped || !current()) return release();
      const until = performance.now() + SLICE_MS;
      let n = 0;
      while (stack.length) {
        const f = stack[stack.length - 1]!;
        if (!f.handle) {
          if (f.depth > 8) {
            stack.pop();
            continue;
          }
          try {
            f.handle = opendirSync(join(root, f.dir));
          } catch {
            stack.pop();
            continue;
          }
        }
        let e: Dirent | null = null;
        try {
          e = f.handle.readSync();
        } catch {
          /* the folder went away: it ends here */
        }
        if (!e) {
          try {
            f.handle.closeSync();
          } catch {
            /* already closed */
          }
          stack.pop();
          continue;
        }
        const path = f.dir ? `${f.dir}/${e.name}` : e.name;
        const kind = changeKind(path);
        if (!kind) continue;
        if (e.isDirectory()) stack.push({ dir: path, depth: f.depth + 1 });
        else file(path, kind);
        if (++n % 16 === 0 && performance.now() > until) break;
      }
      if (stack.length) later(slice);
      else done?.();
    };
    slice();
  };
  /**
   * Every file's size and time, at open and after `adopt()`. A file that reports an event before its turn is not in
   * `seen`, so it counts as changed (the safe side), and the walk never overwrites a file an event already touched.
   */
  let walk = 0;
  const snapshotSliced = (done?: () => void) => {
    const mine = ++walk;
    walkSliced(
      () => mine === walk,
      (path) => {
        if (!seen.has(path) && !pending.has(path)) seen.set(path, fingerprint(path, 'stat'));
      },
      done,
    );
  };
  snapshotSliced();
  /**
   * The system could not say which files changed: its buffer of events overflowed (a checkout or a merge while the app's
   * thread was busy writes thousands of entries in .git), and the one event left names no file. Every file is looked at
   * again instead (a stat each; only those that differ are read), so a change in that burst is still reported. The walk
   * is sliced like the first one, and `done` goes on when it has queued every file.
   */
  let rescanAll = false;
  let rescan = 0;
  const queueEverything = (done: () => void) => {
    const mine = ++rescan;
    const found = new Set<string>();
    walkSliced(
      () => mine === rescan,
      (path, kind) => {
        found.add(path);
        if (!isKnownOwnWrite(path)) pending.set(path, { path, kind });
      },
      () => {
        // and those that are gone (the files the walk found are queued or are the app's own writes, known now)
        for (const path of seen.keys()) if (!found.has(path) && !pending.has(path)) pending.set(path, { path, kind: changeKind(path)! });
        done();
      },
    );
  };
  /** True while a batch is being compared (in slices); events that come meanwhile wait in `pending` for the next one. */
  let flushing = false;
  /**
   * After `adopt()`, until the walk has taken every file: a file not walked yet that reports an event and was last written
   * before `adoptedAt` is the change the app adopted (git's), taken as it is; one written after it is an outside change.
   */
  let adopting = false;
  let adoptedAt = 0;
  const writtenBeforeAdopt = (path: string): boolean => {
    try {
      return statSync(join(root, path)).mtimeMs <= adoptedAt + ADOPT_SLACK_MS;
    } catch {
      return true; // gone: nothing to report either way
    }
  };
  const flush = () => {
    timer = undefined;
    firstEventAt = 0;
    if (flushing) return; // the running flush starts another when it ends, if more came
    flushing = true;
    const report = () => {
      const entries = [...pending.values()];
      pending.clear();
      const batch: WorkspaceChange[] = [];
      let at = 0;
      const slice = () => {
        if (stopped) return void (flushing = false);
        const until = performance.now() + SLICE_MS;
        while (at < entries.length) {
          const c = entries[at++]!;
          if (adopting && !seen.has(c.path) && writtenBeforeAdopt(c.path)) {
            const f = fingerprint(c.path, 'stat');
            if (f !== 'gone' && f !== 'dir') seen.set(c.path, f);
          } else {
            const { now, same } = compare(c.path);
            if (now === 'gone') seen.delete(c.path);
            else seen.set(c.path, now);
            // a folder event says nothing by itself: its files report their own changes
            if (now !== 'dir' && !same) batch.push(c);
          }
          // (a file is hashed when its size or time moved: check the clock often)
          if (at % 16 === 0 && performance.now() > until) break;
        }
        if (at < entries.length) return void later(slice);
        flushing = false;
        if (batch.length) onChange(batch);
        if ((pending.size || rescanAll) && !stopped) arm();
      };
      slice();
    };
    if (rescanAll) {
      rescanAll = false;
      queueEverything(report);
    } else report();
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
    rescan++;
    watcher?.close();
  };
  const adopt = () => {
    // events heard so far are about what the app adopts (git's changes): the walk takes the files as they are
    pending.clear();
    seen.clear();
    adopting = true;
    adoptedAt = Date.now();
    const mine = walk + 1;
    snapshotSliced(() => void (walk === mine && (adopting = false)));
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
