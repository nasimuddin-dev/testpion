/**
 * Which `shared` entries of workspace.json (another workspace's folder read here: environments, API definitions) are read
 * on this computer. workspace.json comes with a pull: an entry a teammate added would make this app read a folder of
 * this computer it never chose (any other TestPion workspace beside this one) and show its files, send them to checks
 * and to an AI provider. So, as for a monitor's schedule and the Debugger's rules, an entry is read once the person
 * allowed it here: by adding it in this app, or with "Allow on this computer". A pulled change to an entry (another
 * folder, more kinds) waits again. The CLI reads every entry (a pipeline runs what the repository says). Kept in the
 * app's own folder, never in the workspace.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { WorkspaceStore } from '@testpion/core';
import type { Backend } from './backend.js';

type Entry = { path: string; kinds: string[] };
type TrustFile = Record<string, string[]>;

const fileOf = (be: Backend) => join(be.host.appDir, 'shared-trust.json');
/** One workspace, however its folder is spelled (Windows paths ignore case). */
const rootKey = (root: string) => (process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root));
/** One entry as allowed: its folder (as written, `\` as `/`) and its kinds, in one order. */
const entryKey = (e: Entry) => `${String(e.path).replace(/\\/g, '/').replace(/\/+$/, '')}|${[...(e.kinds ?? [])].sort().join(',')}`;

// read once per backend (the environment list asks on every call); only this app writes the file
const cache = new WeakMap<Backend, TrustFile>();

function read(be: Backend): TrustFile {
  const hit = cache.get(be);
  if (hit) return hit;
  let t: TrustFile = {};
  try {
    const v = JSON.parse(readFileSync(fileOf(be), 'utf8')) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) t = v as TrustFile;
  } catch {
    /* none yet */
  }
  cache.set(be, t);
  return t;
}

function write(be: Backend, t: TrustFile): void {
  cache.set(be, t);
  const f = fileOf(be);
  if (!existsSync(dirname(f))) mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(t, null, 2));
}

/** Whether this entry of this workspace is read on this computer. */
export function sharedAllowed(be: Backend, root: string, e: Entry): boolean {
  return (read(be)[rootKey(root)] ?? []).includes(entryKey(e));
}

/** Allow these entries here (added in this app, or "Allow on this computer"); entries no longer in workspace.json are forgotten. */
export function allowShared(be: Backend, store: Pick<WorkspaceStore, 'root' | 'workspace'>, entries: Entry[]): void {
  const t = read(be);
  const now = new Set((store.workspace.shared ?? []).map(entryKey));
  t[rootKey(store.root)] = [...new Set([...(t[rootKey(store.root)] ?? []).filter((k) => now.has(k)), ...entries.map(entryKey)])];
  write(be, t);
}

/** The entries of workspace.json that wait for "Allow on this computer". */
export function sharedWaiting(be: Backend, store: Pick<WorkspaceStore, 'root' | 'workspace'>): Entry[] {
  const allowed = new Set(read(be)[rootKey(store.root)] ?? []);
  return (store.workspace.shared ?? []).filter((e) => e && typeof e.path === 'string' && !allowed.has(entryKey(e)));
}

/** The opened store reads only the entries allowed here. */
export function trustShared(be: Backend, store: WorkspaceStore): void {
  store.sharedTrust = (e) => sharedAllowed(be, store.root, e);
}
