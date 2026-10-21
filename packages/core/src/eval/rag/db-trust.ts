/**
 * Which network databases a workspace may reach with its SQL metrics, on THIS computer (review 2, findings 1 and 10).
 *
 * A workspace comes from git, an import or a teammate, so a file in it must not be able to name `DATABASE_URL` (or any other
 * environment variable) as its database and mark itself read-only: the person decides, per computer and per workspace, which
 * target a PostgreSQL or MySQL connection may reach. The decision names the TARGET (the variable and the host and database it
 * points to, never a password), so a changed variable or URL asks again. It lives in the app's data folder, next to
 * settings.json: never in the workspace, never in a repository, and no MCP tool can write it (an agent cannot allow itself).
 * A SQLite file needs no decision: it must lie inside the workspace.
 */
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { atomicWrite, readJson } from '../../storage/fsutil.js';
import { defaultAppDir } from '../../storage/workspace.js';
import type { SqlSource, ResolvedSource } from '../../runner/sql-exec.js';

export interface TrustedDatabase {
  /** The workspace folder the decision is for. */
  workspace: string;
  /** What was allowed: `$NAME -> host/db` for a connection read from the environment, `url -> host/db` for one written in a file. */
  target: string;
  /** When the person allowed it. */
  at: string;
}

const file = () => join(defaultAppDir(), 'trusted-databases.json');
const workspaceKey = (root: string) => (process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root));

let cache: { path: string; mtime: number; size: number; list: TrustedDatabase[] } | undefined;

function load(): TrustedDatabase[] {
  const path = file();
  if (!existsSync(path)) return [];
  try {
    const st = statSync(path);
    if (cache && cache.path === path && cache.mtime === st.mtimeMs && cache.size === st.size) return cache.list;
    const raw = readJson<{ databases?: TrustedDatabase[] }>(path, {});
    const list = Array.isArray(raw.databases) ? raw.databases.filter((d) => d && typeof d.workspace === 'string' && typeof d.target === 'string') : [];
    cache = { path, mtime: st.mtimeMs, size: st.size, list };
    return list;
  } catch {
    return [];
  }
}

/** What the person is asked to allow: the variable (or "url") and the host and database it reaches. No password. */
export function databaseTarget(db: SqlSource, resolved: Pick<ResolvedSource, 'label'>): string {
  return `${db.connectionEnv && !db.url ? `$${db.connectionEnv}` : 'url'} -> ${resolved.label}`;
}

/** Whether a PostgreSQL or MySQL connection named by the workspace was allowed on this computer. */
export function isDatabaseTrusted(workspaceRoot: string, target: string): boolean {
  const w = workspaceKey(workspaceRoot);
  return load().some((d) => d.workspace === w && d.target === target);
}

/** Remember that the person allowed this target for the workspace on this computer. */
export function trustDatabase(workspaceRoot: string, target: string): void {
  if (isDatabaseTrusted(workspaceRoot, target)) return;
  const list = [...load(), { workspace: workspaceKey(workspaceRoot), target, at: new Date().toISOString() }];
  const path = file();
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, JSON.stringify({ databases: list }, null, 2) + '\n');
  cache = undefined;
}

/** Take an allowed target back (all of the workspace's when `target` is not given). */
export function forgetDatabase(workspaceRoot: string, target?: string): number {
  const w = workspaceKey(workspaceRoot);
  const all = load();
  const kept = all.filter((d) => !(d.workspace === w && (target === undefined || d.target === target)));
  if (kept.length !== all.length) {
    atomicWrite(file(), JSON.stringify({ databases: kept }, null, 2) + '\n');
    cache = undefined;
  }
  return all.length - kept.length;
}

/** The targets allowed for a workspace. */
export function trustedDatabases(workspaceRoot: string): TrustedDatabase[] {
  const w = workspaceKey(workspaceRoot);
  return load().filter((d) => d.workspace === w);
}
