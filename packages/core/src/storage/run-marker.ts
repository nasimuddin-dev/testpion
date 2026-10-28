import { readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A run folder's "this run is going on" marker. The process that runs writes `.running` (its pid) into the run's folder and touches
 * it every 30 s while it works; the housekeeping sweep of ANOTHER process (the app opening a workspace the CLI is running in) leaves
 * a folder alone while the pid in the marker is alive or its heartbeat is younger than two minutes, however long the run has
 * been silent (a run paused at a breakpoint writes nothing for an hour).
 */
export const RUNNING_FILE = '.running';
export const HEARTBEAT_MS = 30_000;
export const HEARTBEAT_STALE_MS = 120_000;

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // it exists, it is another user's
  }
}

/** Marks `dir` as a run in progress; the returned function removes the marker (call it when the run has ended, in a `finally`). */
export function startRunMarker(dir: string): () => void {
  const file = join(dir, RUNNING_FILE);
  try {
    writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  } catch {
    return () => undefined; // a folder that cannot be written is the run's own problem to report; the marker is a courtesy
  }
  const beat = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(file, now, now);
    } catch {
      /* the folder is gone or busy: the next beat */
    }
  }, HEARTBEAT_MS);
  beat.unref();
  return () => {
    clearInterval(beat);
    try {
      rmSync(file, { force: true });
    } catch {
      /* left: the sweep removes a stale marker */
    }
  };
}

/** Is a run going on in this folder (a live pid in its marker, or a heartbeat younger than two minutes)? */
export function runInProgress(dir: string, now: number = Date.now(), isAlive: (pid: number) => boolean = pidAlive): boolean {
  const file = join(dir, RUNNING_FILE);
  let mtime: number;
  try {
    mtime = statSync(file).mtimeMs;
  } catch {
    return false;
  }
  if (now - mtime < HEARTBEAT_STALE_MS) return true;
  try {
    const pid = (JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown }).pid;
    return typeof pid === 'number' && pid > 0 && isAlive(pid);
  } catch {
    return false;
  }
}

/** A marker left by a run that died: removed with its folder, or alone when the folder is kept. */
export function removeStaleMarker(dir: string): void {
  try {
    rmSync(join(dir, RUNNING_FILE), { force: true });
  } catch {
    /* next sweep */
  }
}
