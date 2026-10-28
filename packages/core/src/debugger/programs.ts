import { execFileChecked } from '../net/process.js';
import { createOwnerBatcher, parseOwners, psOwnerCommand, windowsOwnerCommand, type OwnerAnswer } from './owner-lookup.js';

/** A program found behind a client port. */
export interface ProgramInfo {
  name: string;
  pid?: number;
  /** The account the program runs as (DOMAIN\\user on Windows). */
  user?: string;
}

const SPAWN = { timeout: 5000, windowsHide: true };

/**
 * Which program owns a TCP connection, by its local port. Programs come and go faster than a process listing takes,
 * so the lookups share snapshots: on Windows one `netstat` (every connection's owner) and one `tasklist` (every
 * process's name) run side by side, at most once per 500 ms, and answer every port asked for since the last one; a
 * port that snapshot does not know yet (the connection is newer) is asked once more in the next one. A flood of new
 * connections then costs two process listings a second, not two per connection. On other platforms `lsof` answers
 * per port.
 */
export function applicationOfPort(port: number): Promise<ProgramInfo | undefined> {
  if (process.platform !== 'win32') return lsofPort(port);
  // a snapshot taken a moment ago that knows the port answers at once
  const known = snapshot && Date.now() - snapshot.at < 250 ? programIn(snapshot, port) : undefined;
  if (known) return Promise.resolve(known);
  return new Promise((resolve) => {
    waiting.push({ port, resolve, tries: 0 });
    scheduleSnapshot();
  });
}

/** How often a snapshot is taken at most while ports wait for one. */
const SNAPSHOT_EVERY_MS = 500;
const waiting: Array<{ port: number; resolve(p: ProgramInfo | undefined): void; tries: number }> = [];
let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
let lastSnapshotStart = 0;

function programIn(s: WindowsSnapshot, port: number): ProgramInfo | undefined {
  const pid = s.owners.get(port);
  const name = pid ? s.names.get(pid) : undefined;
  return pid && name ? { name, pid } : undefined;
}

function scheduleSnapshot(): void {
  if (snapshotTimer || snapshotPending) return;
  snapshotTimer = setTimeout(answerWaiting, Math.max(0, lastSnapshotStart + SNAPSHOT_EVERY_MS - Date.now()));
  (snapshotTimer as { unref?(): void }).unref?.();
}

async function answerWaiting(): Promise<void> {
  snapshotTimer = undefined;
  lastSnapshotStart = Date.now();
  const batch = waiting.splice(0);
  const s = await windowsSnapshot(true);
  for (const w of batch) {
    const found = programIn(s, w.port);
    if (found || w.tries++ >= 1) w.resolve(found);
    else {
      // a connection of a process newer than the process listing: list them again
      if (s.owners.get(w.port)) processNames = undefined;
      waiting.push(w);
    }
  }
  if (waiting.length) scheduleSnapshot();
}

interface WindowsSnapshot {
  at: number;
  /** local port → owning PID (established connections first; PID 0, a closed connection, is nobody) */
  owners: Map<number, number>;
  /** PID → process name as Get-Process names it ("chrome", "node") */
  names: Map<number, string>;
}
let snapshot: WindowsSnapshot | undefined;
/** The latest process listing, reused for this long. */
const NAMES_FOR_MS = 5000;
let processNames: { at: number; names: Map<number, string> } | undefined;
let snapshotPending: Promise<WindowsSnapshot> | undefined;

function windowsSnapshot(fresh = false): Promise<WindowsSnapshot> {
  if (!fresh && snapshot && Date.now() - snapshot.at < 250) return Promise.resolve(snapshot);
  if (snapshotPending) return snapshotPending;
  snapshotPending = Promise.all([
    spawnText('netstat', ['-ano', '-p', 'tcp']).then((out) => {
      const owners = new Map<number, number>();
      for (const m of out.matchAll(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+(\S+)\s+(\d+)\s*$/gm)) {
        const local = Number(m[1]);
        const pid = Number(m[3]);
        if (pid > 0 && (m[2] === 'ESTABLISHED' || !owners.has(local))) owners.set(local, pid);
      }
      return owners;
    }),
    // the process names change far less often than the connections: a listing of a few seconds ago still answers
    // (a PID it does not know asks for a new one: see answerWaiting)
    processNames && Date.now() - processNames.at < NAMES_FOR_MS
      ? processNames.names
      : spawnText('tasklist', ['/FO', 'CSV', '/NH']).then((out) => {
          const names = new Map<number, string>();
          for (const m of out.matchAll(/^"([^"]+)","(\d+)"/gm)) names.set(Number(m[2]), m[1]!.replace(/\.exe$/i, ''));
          processNames = { at: Date.now(), names };
          return names;
        }),
  ])
    .then(([owners, names]) => (snapshot = { at: Date.now(), owners, names }))
    .finally(() => (snapshotPending = undefined));
  return snapshotPending;
}

function lsofPort(port: number): Promise<ProgramInfo | undefined> {
  return spawnText('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:ESTABLISHED', '-Fpc']).then((out) => {
    const name = /^c(.+)$/m.exec(out)?.[1]?.trim();
    const pid = Number(/^p(\d+)$/m.exec(out)?.[1]) || undefined;
    return name ? { name, pid } : undefined;
  });
}

/** One system query for the accounts of several processes (see owner-lookup.ts). */
async function queryOwners(pids: number[]): Promise<Map<number, OwnerAnswer>> {
  const [file, args] = process.platform === 'win32' ? windowsOwnerCommand(pids) : psOwnerCommand(pids);
  return parseOwners(await spawnText(file, args, 8000));
}

const ownerBatch = createOwnerBatcher({ query: queryOwners });

/**
 * The account a process runs as (DOMAIN\user on Windows, from CIM: Get-Process -IncludeUserName needs an elevated shell). The
 * processes asked about within a quarter of a second are looked up in one query, not one shell each.
 */
export function ownerOfProcess(pid: number): Promise<string | undefined> {
  return ownerBatch(Math.trunc(pid));
}

/** A command's stdout, or '' when it fails (a lookup that cannot be made answers "unknown"). */
function spawnText(file: string, args: string[], timeout = SPAWN.timeout): Promise<string> {
  return new Promise((resolve) => execFileChecked(`program ${file}`, file, args, { ...SPAWN, timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, out) => resolve(err ? '' : String(out))));
}
