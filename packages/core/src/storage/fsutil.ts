import { closeSync, copyFileSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
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

/** Atomic write: write a temp file, fsync, then rename over the target. A crash never leaves a half-written file. */
/**
 * Files this process wrote, and when (absolute path → ms): a folder watcher tells its own saves from changes made
 * outside the app (git pull, another editor) with `writtenByUs`.
 */
const recentWrites = new Map<string, number>();
export function writtenByUs(path: string, withinMs = 2000): boolean {
  const at = recentWrites.get(resolve(path));
  return at !== undefined && Date.now() - at < withinMs;
}

export function atomicWrite(path: string, data: string | Buffer): void {
  recentWrites.set(resolve(path), Date.now());
  if (recentWrites.size > 2000) for (const [k, t] of recentWrites) if (Date.now() - t > 10_000) recentWrites.delete(k);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameWithRetry(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  } finally {
    forgetText(path);
  }
}

/** Waits between rename attempts: Windows refuses a rename while another program (antivirus, an indexer, an editor) has the file open. */
const RENAME_RETRY_MS = [50, 100, 200];
const sleepBuf = new Int32Array(new SharedArrayBuffer(4));

function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const wait = RENAME_RETRY_MS[attempt];
      if (wait === undefined || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
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
  recentWrites.set(resolve(path), Date.now());
  if (recentWrites.size > 2000) for (const [k, t] of recentWrites) if (Date.now() - t > 10_000) recentWrites.delete(k);
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
