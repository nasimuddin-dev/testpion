import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pidAlive } from './run-marker.js';

/**
 * An advisory lock on a workspace folder, kept in the app's private data folder (`<appDir>/locks/<hash of the real path>.json`),
 * never in the workspace itself (a workspace is a git repository). A TestPion that has a workspace open holds it: the file names
 * its process and is touched every 15 s. Another TestPion (a second profile, the CLI, an MCP server) that finds a live holder
 * knows that two writers are about to share the folder, which the file formats cannot fully protect against (the compaction of
 * the JSONL files on close, the folder watcher's own-write bookkeeping). The lock advises; it never blocks a reader, and a
 * holder that died (pid gone, or no heartbeat for a minute) is taken over silently.
 */
export const LOCK_BEAT_MS = 15_000;
export const LOCK_STALE_MS = 60_000;

export interface LockHolder {
  pid: number;
  /** What holds it: the window ('app'), a command line ('cli'), an agent ('mcp'). */
  by: string;
  since: string;
  /** The workspace folder, as the holder saw it. */
  workspace: string;
}

const held = new Set<() => void>(); // bounded: the locks this process holds, each leaves on release; the exit hook releases the rest
let exitHooked = false; // bounded: a flag

export interface WorkspaceLock {
  /** Someone else holds the workspace (undefined: this process does). */
  heldBy?: LockHolder;
  release(): void;
}

const realOf = (p: string): string => {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
};

export function lockFileOf(appDir: string, workspace: string): string {
  const key = realOf(workspace);
  return join(appDir, 'locks', createHash('sha1').update(process.platform === 'win32' ? key.toLowerCase() : key).digest('hex').slice(0, 24) + '.json');
}

/** Who holds the workspace now (another live process), if anyone. This process does not count. */
export function lockHolder(appDir: string, workspace: string, now: number = Date.now(), isAlive: (pid: number) => boolean = pidAlive): LockHolder | undefined {
  const file = lockFileOf(appDir, workspace);
  try {
    const age = now - statSync(file).mtimeMs;
    const h = JSON.parse(readFileSync(file, 'utf8')) as Partial<LockHolder>;
    if (typeof h.pid !== 'number' || h.pid === process.pid) return undefined;
    if (age > LOCK_STALE_MS || !isAlive(h.pid)) return undefined;
    return { pid: h.pid, by: String(h.by ?? 'app'), since: String(h.since ?? ''), workspace: String(h.workspace ?? workspace) };
  } catch {
    return undefined; // no file, or one that cannot be read: nobody holds it
  }
}

/** Takes the lock (or reports the holder, and takes nothing). `release` removes it if it is still this process's. */
export function acquireWorkspaceLock(appDir: string, workspace: string, by: string, o: { now?: number; isAlive?: (pid: number) => boolean } = {}): WorkspaceLock {
  const heldBy = lockHolder(appDir, workspace, o.now, o.isAlive);
  if (heldBy) return { heldBy, release: () => undefined };
  const file = lockFileOf(appDir, workspace);
  const body = JSON.stringify({ pid: process.pid, by, since: new Date().toISOString(), workspace: realOf(workspace) });
  try {
    mkdirSync(join(appDir, 'locks'), { recursive: true });
    writeFileSync(file, body);
  } catch {
    return { release: () => undefined }; // an advisory lock that cannot be written advises nothing
  }
  const beat = setInterval(() => {
    try {
      const t = new Date();
      utimesSync(file, t, t);
    } catch {
      /* gone or busy: the next beat */
    }
  }, LOCK_BEAT_MS);
  beat.unref();
  if (!exitHooked) {
    exitHooked = true;
    process.on('exit', () => {
      for (const r of [...held]) r();
    });
  }
  const release = () => {
    held.delete(release);
    clearInterval(beat);
    try {
      if ((JSON.parse(readFileSync(file, 'utf8')) as { pid?: number }).pid === process.pid) rmSync(file, { force: true });
    } catch {
      /* gone already */
    }
  };
  held.add(release);
  return { release };
}

/** The sentence a person reads when `holder` has the workspace open. */
export function lockMessage(h: LockHolder): string {
  const who = h.by === 'app' ? 'Another TestPion window' : h.by === 'cli' ? 'Another testpion command' : 'Another TestPion process';
  return `${who} (process ${h.pid}, since ${h.since.slice(0, 16).replace('T', ' ')}) has this workspace open. Changing it from two places at once can lose edits. Close it first, or continue anyway.`;
}
