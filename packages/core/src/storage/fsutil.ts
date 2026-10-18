import { closeSync, copyFileSync, cpSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { ApsError } from '../errors.js';

/**
 * End a write stream and wait until its file descriptor is closed. `end(cb)` only waits for 'finish'; the
 * fd is closed afterwards on the thread pool, and exiting the process in between aborts Node on Windows
 * ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)").
 */
export function endAndClose(stream: NodeJS.WritableStream & { closed?: boolean; once(ev: 'close' | 'error', fn: (...a: unknown[]) => void): unknown }): Promise<void> {
  return new Promise<void>((resolve) => {
    if (stream.closed) return resolve();
    stream.once('close', () => resolve());
    stream.once('error', () => resolve());
    stream.end();
  });
}

/**
 * The real path of each folder, looked up once and kept for a short while: a containment check (`relativeInside`) and
 * an own-write key (`ownKey`) both ask for the real path of a folder on the way to a file, and the same few hundred
 * folders come up over and over (a run's results, a flow's steps, every save). Only folders are kept, never files: a
 * file is the last name of most paths and costs one `lstat` to tell a link from a plain file; a kept entry expires so a
 * folder swapped for a junction after it was seen is noticed within seconds, not for the life of the process.
 */
const realDirs = new Map<string, { real: string; at: number }>();
const REAL_DIR_TTL_MS = 10_000;

/**
 * The real path of `p` when it exists, resolved through every link on the way (one that leads nowhere counts as
 * missing); undefined when it does not. The last name is told apart with `lstat`: a link is resolved in full, a plain
 * file is its folder's real path with its name, a folder is looked up and remembered.
 */
function realOf(p: string): string | undefined {
  const hit = realDirs.get(p);
  if (hit && Date.now() - hit.at < REAL_DIR_TTL_MS) return hit.real;
  let st: import('node:fs').Stats;
  try {
    st = lstatSync(p);
  } catch {
    return undefined;
  }
  try {
    if (st.isSymbolicLink()) return realpathSync(p);
    if (!st.isDirectory()) {
      const dir = dirname(p);
      if (dir === p) return p;
      const real = realOf(dir);
      return real === undefined ? undefined : join(real, basename(p));
    }
    const real = realpathSync(p);
    if (realDirs.size > 4096) realDirs.clear();
    realDirs.set(p, { real, at: Date.now() });
    return real;
  } catch {
    return undefined;
  }
}

/**
 * `p` (absolute, or from the current folder) with every link on the way resolved: the real path of its nearest folder
 * that exists, with the rest appended (a file about to be written is where its folder really is).
 */
export function realPathOf(p: string): string {
  let dir = resolve(p);
  const rest: string[] = [];
  for (;;) {
    const real = realOf(dir);
    if (real !== undefined) return join(real, ...rest.reverse());
    const up = dirname(dir);
    if (up === dir) return resolve(p); // nothing of it exists (another drive that is gone): as given
    rest.push(basename(dir));
    dir = up;
  }
}

const relativeWithin = (a: string, b: string, orSame: boolean | undefined) => {
  const rel = relative(a, b);
  if (rel === '') return orSame ? '' : undefined;
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? undefined : rel;
};

/**
 * `child` relative to `parent` when it is inside it (`''` when it is `parent` itself and `orSame`), else undefined.
 * The real paths decide (BOTH sides resolved): a workspace reached through a link (macOS /var → /private/var and /tmp
 * → /private/tmp, a junction, a linked home folder) is still itself, whichever way each path names it; and a path that
 * names the workspace but leads elsewhere through a link inside it (a junction under payloads/, a linked spec) is
 * outside, however it is spelled. The answer is named as the path names it when that is under `parent` too, else as
 * it really is. Windows paths ignore case (path.relative does). The one containment check for paths a write is guarded
 * by.
 */
export function relativeInside(parent: string, child: string, o: { orSame?: boolean } = {}): string | undefined {
  const really = relativeWithin(realPathOf(parent), realPathOf(child), o.orSame);
  if (really === undefined) return undefined;
  return relativeWithin(resolve(parent), resolve(child), o.orSame) ?? really;
}

export const isInside = (parent: string, child: string, o: { orSame?: boolean } = {}): boolean => relativeInside(parent, child, o) !== undefined;

/** Whether two paths name the same file or folder, as given or really (`relativeInside`): a folder and a link to it are one. */
export const samePath = (a: string, b: string): boolean => relativeInside(a, b, { orSame: true }) === '';

/**
 * The size of `file` when it is a plain file really inside `parent` (a recorded payload, a spooled body), else
 * undefined: a link is refused even when it points inside (what a read of a named file is guarded by, so a link put
 * under payloads/ never has the file it points to read out).
 */
export function plainFileInside(parent: string, file: string): number | undefined {
  let st: import('node:fs').Stats;
  try {
    st = lstatSync(file);
  } catch {
    return undefined;
  }
  if (!st.isFile() || !isInside(parent, file)) return undefined;
  return st.size;
}

/**
 * Whether a path names `target`: as written (`\` and `/` alike, case aside — how recorded result files were always
 * compared), or really (both resolved, as `relativeInside`): a run that resolved its files from the current folder (a
 * real path) and a workspace opened through a link name one file two ways. For the many results of a run: the real
 * path of `target` is looked up once, when the first name needs it, and the real path of each name once.
 */
export function pathMatcher(target: string): (p: string | undefined) => boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  const want = norm(target);
  const seen = new Map<string, boolean>();
  let realWant: string | undefined;
  return (p) => {
    if (!p) return false;
    if (norm(p) === want) return true;
    let same = seen.get(p);
    if (same === undefined) {
      realWant ??= realPathOf(target);
      seen.set(p, (same = relativeWithin(realWant, realPathOf(p), true) === ''));
    }
    return same;
  };
}

/**
 * The app's own changes to files, by path (GIT-103): what this process last made each file (absolute path → its content
 * fingerprint `hash:<size>:<sha1>`, or `gone`). A folder watcher tells its own saves from changes made outside the app
 * (git pull, another editor) by comparing the file now with this, not by the time: other bytes are someone else's
 * change, however soon after a save they come. A removed folder is one entry (`gone`, `dir: true`) that covers what was
 * in it. Entries are kept for a minute (the watcher's events arrive within that); `OUTSIDE` marks a path whose last
 * change was someone else's, so an own entry of a folder above it no longer speaks for it.
 */
const recentWrites = new Map<string, { at: number; fingerprint: string; dir?: boolean }>();
const OWN_WRITE_TTL_MS = 60_000;
/** At most this many own writes are remembered (~200 B each): a write the watcher has not seen yet is only forgotten beyond it. */
const MAX_OWN_WRITES = 100_000;
const OUTSIDE = 'outside';
const ownWriteListeners = new Set<(path: string) => void>();

/**
 * The key of a path in the own-writes registry: its real path (its folder's, with its name), so a write and the
 * watcher's event agree however each names the workspace — through a link (macOS /tmp and /var, a junction) or really
 * (a path from the current folder, a real path made for a write). Each folder's real path is looked up once (`realOf`
 * remembers a few thousand): a write costs one map lookup, not a walk of every folder on its path.
 */
function ownKey(path: string): string {
  const abs = resolve(path);
  const dir = dirname(abs);
  if (dir === abs) return abs;
  const real = realOf(dir);
  // its folder is gone too (a removed folder's file), or is a file: the nearest folder that exists
  return real === undefined ? realPathOf(abs) : join(real, basename(abs));
}

/** The content fingerprint the watcher compares: `hash:<size>:<sha1>`. */
export function contentFingerprint(bytes: Buffer): string {
  return `hash:${bytes.length}:${createHash('sha1').update(bytes).digest('hex')}`;
}

function recordOwn(path: string, fingerprint: string, dir?: boolean): void {
  const abs = resolve(path);
  const key = ownKey(abs);
  recentWrites.delete(key); // newest last: pruning goes oldest first
  recentWrites.set(key, { at: Date.now(), fingerprint, ...(dir ? { dir } : {}) });
  // only what has expired goes (oldest first, stopping at the first one still fresh: O(1) a write): a write the
  // watcher has not seen yet is never forgotten — an import of thousands of files would otherwise come back as
  // "changed outside TestPion". MAX_OWN_WRITES bounds the memory of a flood that never pauses.
  if (recentWrites.size > 1000) {
    const now = Date.now();
    for (const [k, w] of recentWrites) {
      if (now - w.at < OWN_WRITE_TTL_MS && recentWrites.size <= MAX_OWN_WRITES) break;
      recentWrites.delete(k);
    }
  }
  for (const l of ownWriteListeners) {
    try {
      l(abs);
    } catch {
      /* a listener's failure never fails the write */
    }
  }
}

/**
 * Be told of every change this process makes to a file through these helpers (absolute path): the backend turns the
 * ones inside the open workspace into the same `data.changed` the watcher sends for outside changes. Returns `off`.
 */
export function onOwnWrite(listener: (path: string) => void): () => void {
  ownWriteListeners.add(listener);
  return () => void ownWriteListeners.delete(listener);
}

export function writtenByUs(path: string, withinMs = OWN_WRITE_TTL_MS): boolean {
  const f = ownWrite(path, withinMs);
  return f !== undefined;
}

/**
 * What this process last made `path` (within `withinMs`): `hash:<size>:<sha1>`, or `gone` when it removed the file or a
 * folder it was in. The watcher compares it with the file now: the same state is its own change; anything else is an
 * outside change (another editor, git), even right after a save.
 */
export function ownWrite(path: string, withinMs = OWN_WRITE_TTL_MS): string | undefined {
  const abs = ownKey(path);
  const now = Date.now();
  const w = recentWrites.get(abs);
  if (w) return w.fingerprint !== OUTSIDE && now - w.at < withinMs ? w.fingerprint : undefined;
  // a folder this process removed (or moved away) takes what was in it along
  for (let dir = dirname(abs), i = 0; i < 16 && dir !== dirname(dir); dir = dirname(dir), i++) {
    const d = recentWrites.get(dir);
    if (d) return d.dir && d.fingerprint === 'gone' && now - d.at < withinMs ? 'gone' : undefined;
  }
  return undefined;
}

/** The file at `path` was last changed by someone else (the watcher saw other bytes than this process wrote). */
export function forgetOwnWrite(path: string): void {
  const abs = ownKey(path);
  if (recentWrites.has(abs)) recentWrites.set(abs, { at: Date.now(), fingerprint: OUTSIDE });
  else if (ownWrite(abs) !== undefined) recentWrites.set(abs, { at: Date.now(), fingerprint: OUTSIDE }); // under a removed folder
}

/**
 * Record a change this process made without the helpers below (another library wrote the file, an async write and
 * rename): `path` as it is on disk now — a file's content, a folder's files (each), or gone.
 */
export function noteOwnChange(path: string): void {
  let st: import('node:fs').Stats | undefined;
  try {
    st = statSync(path);
  } catch {
    st = undefined;
  }
  if (!st) return recordOwn(path, 'gone', true);
  if (st.isDirectory()) {
    const walk = (dir: string, depth: number) => {
      if (depth > 8) return;
      let names: import('node:fs').Dirent[] = [];
      try {
        names = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of names) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.isFile()) noteOwnChange(p);
      }
    };
    return walk(path, 0);
  }
  try {
    recordOwn(path, st.size > 8 * 1024 * 1024 ? `stat:${st.size}:${Math.round(st.mtimeMs)}` : contentFingerprint(readFileSync(path)));
  } catch {
    recordOwn(path, 'gone', true);
  }
  forgetText(path);
}

/** Remove a file or folder as the app's own change (the watcher does not report it). */
export function removeOwned(path: string, opts: { recursive?: boolean } = {}): void {
  rmSync(path, { force: true, recursive: !!opts.recursive, ...(opts.recursive ? { maxRetries: 5, retryDelay: 100 } : {}) });
  recordOwn(path, 'gone', true);
  forgetText(path);
}

/** Rename (move) a file or folder as the app's own change: the old path is gone, the new one holds what moved. */
export function renameOwned(from: string, to: string): void {
  renameWithRetry(from, to);
  recordOwn(from, 'gone', true);
  forgetText(from);
  noteOwnChange(to);
}

/** Copy a file or folder as the app's own change. */
export function copyOwned(from: string, to: string, opts: { recursive?: boolean } = {}): void {
  mkdirSync(dirname(to), { recursive: true });
  if (opts.recursive) cpSync(from, to, { recursive: true });
  else copyFileSync(from, to);
  noteOwnChange(to);
}

/** Write a file in place (no temp file: an append-style rewrite, a small file) as the app's own change. */
export function writeOwned(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  writeFileSync(path, bytes);
  recordOwn(path, contentFingerprint(bytes));
  forgetText(path);
}

/** Atomic write: write a temp file, fsync, then rename over the target. A crash never leaves a half-written file. */

export function atomicWrite(path: string, data: string | Buffer): void {
  stageAtomicWrite(path, data).commit();
}

/**
 * An atomic write in two steps: the bytes are written to a temp file (and synced) now; `commit()` renames it over
 * `path`, `discard()` drops it. In between, something else can be made to appear with the file: whatever is done just
 * before `commit()` (synchronously) is seen by anyone who sees the file, and the slow part (the write) is done before it.
 */
export function stageAtomicWrite(path: string, data: string | Buffer): { commit(): void; discard(): void } {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  closeSync(fd);
  let done = false;
  return {
    commit() {
      if (done) return;
      done = true;
      try {
        renameWithRetry(tmp, path);
      } catch (e) {
        rmSync(tmp, { force: true });
        throw e;
      } finally {
        forgetText(path);
      }
      recordOwn(path, contentFingerprint(bytes));
    },
    discard() {
      if (done) return;
      done = true;
      rmSync(tmp, { force: true });
    },
  };
}

/**
 * Waits between rename attempts: Windows refuses a rename while another program (antivirus, an indexer, an editor) has
 * the file open. A scan of a just-written file can hold it for over a second (seen with several app instances writing
 * at once), so the waits grow to about 1.5 s in all; then the bytes are copied over the target instead of renamed.
 */
const RENAME_RETRY_MS = [50, 100, 200, 400, 700];
const sleepBuf = new Int32Array(new SharedArrayBuffer(4));

function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const wait = RENAME_RETRY_MS[attempt];
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw e;
      if (wait === undefined) {
        // still refused: a scanner keeps the new file (or the old one) open. Copy the bytes over instead (the target
        // is replaced in place, which only needs it writable), then drop the temp file when it can be dropped.
        copyFileSync(from, to);
        try {
          rmSync(from, { force: true });
        } catch {
          // left for the scanner to release; a .tmp- file is ignored by the watcher and the loaders
        }
        return;
      }
      Atomics.wait(sleepBuf, 0, 0, wait); // a synchronous pause: the callers write synchronously
    }
  }
}

/**
 * Plain write for derived files (traces, caches) that can be produced again: no fsync, no temp file and rename,
 * and each folder is created once per process. Several times cheaper than `atomicWrite` on Windows.
 */
const madeDirs = new Set<string>();
export function writeDerived(path: string, data: string | Buffer): void {
  const dir = dirname(path);
  if (!madeDirs.has(dir)) {
    mkdirSync(dir, { recursive: true });
    if (madeDirs.size > 1000) madeDirs.clear();
    madeDirs.add(dir);
  }
  try {
    writeFileSync(path, data);
  } catch (e) {
    // the folder went away (deleted while the app runs): make it again once
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, data);
  }
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  recordOwn(path, contentFingerprint(bytes));
  forgetText(path);
}

/*
 * The text of JSON files already read, reused while a file's modification time and size are unchanged.
 * Workspace files (environments, collections, servers) are read again for every request sent and every
 * list shown; opening a file is the slow part (milliseconds each on Windows), checking it is not.
 * Only the text is kept: every read still parses, so callers get objects of their own to change.
 */
const textCache = new Map<string, { mtimeMs: number; size: number; text: string }>();
const TEXT_CACHE_MAX_BYTES = 64 * 1024 * 1024;
let textCacheBytes = 0;

function forgetText(path: string): void {
  const hit = textCache.get(path);
  if (!hit) return;
  textCache.delete(path);
  textCacheBytes -= hit.text.length;
}

function cachedText(path: string, mtimeMs: number, size: number): string {
  const hit = textCache.get(path);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.text;
  const text = readFileSync(path, 'utf8');
  forgetText(path);
  textCache.set(path, { mtimeMs, size, text });
  textCacheBytes += text.length;
  // oldest first (insertion order) until it fits again
  for (const [k, v] of textCache) {
    if (textCacheBytes <= TEXT_CACHE_MAX_BYTES || k === path) break;
    textCache.delete(k);
    textCacheBytes -= v.text.length;
  }
  return text;
}

export function writeJson(path: string, value: unknown): void {
  keepBrokenFile(path);
  atomicWrite(path, JSON.stringify(value, null, 2) + '\n');
}

/**
 * Saving over a file that is not valid JSON (a hand edit gone wrong, git conflict markers) first copies it to
 * `<file>.broken-<timestamp>`: the user chose to replace it, and what was in it can still be recovered.
 * A file whose text this process read and parsed (the cache) is known to be fine and costs only a stat.
 */
function keepBrokenFile(path: string): void {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat?.isFile()) return;
  const hit = textCache.get(path);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  if (!text.trim()) return;
  try {
    JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    try {
      copyFileSync(path, `${path}.broken-${Date.now()}`);
    } catch {
      /* best effort: the save goes ahead */
    }
  }
}

/** Why a JSON file's text does not parse, in words (git conflict markers are named as such). */
export function jsonProblem(text: string, error: unknown): string {
  if (/^(<{7}|={7}|>{7})( |$)/m.test(text)) return 'it has unresolved git merge conflict markers (<<<<<<< ======= >>>>>>>)';
  if (!text.trim()) return 'the file is empty';
  return `it is not valid JSON (${(error as Error).message})`;
}

/**
 * Read a JSON file. A file that does not parse is left exactly where it is (it may be mid-merge in git, or
 * being fixed by hand) and a ValidationError says why; nothing is renamed or rewritten by reading.
 */
export function readJson<T>(path: string, fallback?: T): T {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) {
    forgetText(path);
    if (fallback !== undefined) return fallback;
    throw new ApsError('ConfigurationError', `File not found: ${path}`);
  }
  const text = cachedText(path, stat.mtimeMs, stat.size);
  try {
    return JSON.parse(text.replace(/^﻿/, '')) as T;
  } catch (e) {
    forgetText(path);
    const why = jsonProblem(text, e);
    throw new ApsError('ValidationError', `${path} cannot be read: ${why}`, {
      why: `The file is broken: ${why}.`,
      suggestions: ['Fix the file by hand, or restore it from version control (git checkout -- <file>, or resolve the merge).', 'Saving over it in TestPion keeps a copy of it as <file>.broken-<time>.'],
      details: { path, problem: why },
    });
  }
}

/**
 * The text of a file for a cheap scan (no parsing): from readJson's cache when it is current, else read from disk.
 * It is not added to the cache, which holds only text that parsed (see keepBrokenFile).
 */
export function readTextCached(path: string): string | undefined {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat?.isFile()) return undefined;
  const hit = textCache.get(path);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.text;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}
