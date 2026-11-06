/**
 * Shared pieces across workspaces (planning/multi-team.md, item 4): a team with a repository of its own still uses the
 * environments of another folder (a sibling checkout, a git submodule) without copying them. workspace.json names the
 * folder and what is read from it:
 *
 *   "shared": [{ "path": "../platform-shared", "kinds": ["environments"] }]
 *
 * What comes from there is listed after the workspace's own, with `shared` (the folder's name) and `readOnly`: it is
 * changed where it lives, never here. Its secret values are this workspace's (by the environment's id, on this computer).
 */
import { existsSync, statSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { ApsError } from '../errors.js';
import type { Workspace } from '../model/types.js';

/** What a workspace may read from another folder. Collections and tests stay the workspace's own: they are what a team owns. */
export const SHAREABLE_KINDS = ['environments'] as const;
export type ShareableKind = (typeof SHAREABLE_KINDS)[number];

export interface SharedSource {
  /** As written in workspace.json (relative to the workspace). */
  path: string;
  kinds: ShareableKind[];
}

/** The folders a kind is read from besides the workspace's own: `name` is the shared folder's name, shown with what it gives. */
export function sharedDirs(ws: Pick<Workspace, 'shared'>, root: string, kind: ShareableKind): Array<{ name: string; dir: string }> {
  const out: Array<{ name: string; dir: string }> = [];
  for (const s of ws.shared ?? []) {
    if (!s || typeof s.path !== 'string' || !Array.isArray(s.kinds) || !s.kinds.includes(kind)) continue;
    const base = resolve(root, s.path);
    if (base === resolve(root)) continue; // the workspace itself
    const dir = resolve(base, kind);
    if (existsSync(dir) && statSync(dir).isDirectory()) out.push({ name: basename(base), dir });
  }
  return out;
}

/** A source to add, checked: a folder (relative to the workspace, as git keeps it on every computer) that holds the kinds named. */
export function checkedSource(root: string, path: string, kinds: string[]): SharedSource {
  const p = path.trim().replace(/\\/g, '/');
  if (!p) throw new ApsError('ValidationError', 'Name the folder to share from, relative to the workspace (e.g. ../platform-shared)');
  if (isAbsolute(p)) throw new ApsError('ValidationError', `"${p}" is an absolute path: name it relative to the workspace (../platform-shared), so it is the same on every computer`);
  const bad = kinds.filter((k) => !(SHAREABLE_KINDS as readonly string[]).includes(k));
  if (bad.length || !kinds.length) throw new ApsError('ValidationError', `What can be shared: ${SHAREABLE_KINDS.join(', ')}${bad.length ? ` (not ${bad.join(', ')})` : ''}`);
  const base = resolve(root, p);
  if (base === resolve(root)) throw new ApsError('ValidationError', 'A workspace cannot share from itself');
  const missing = kinds.filter((k) => !existsSync(resolve(base, k)));
  if (missing.length) throw new ApsError('ValidationError', `${base} has no ${missing.join(' or ')} folder`, { suggestions: ['Name the folder of another workspace (a sibling checkout or a git submodule).'] });
  return { path: p, kinds: kinds as ShareableKind[] };
}
