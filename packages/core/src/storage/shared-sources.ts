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
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ApsError } from '../errors.js';
import type { Environment, Workspace } from '../model/types.js';
import { slugify } from '../util/ids.js';

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

/** The names, sizes and times of the environment files of these folders: the frozen list is read again when it changes. */
export function environmentFilesSignature(dirs: string[]): string {
  const sigOf = (dir: string) =>
    readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => ((s) => `${f}:${s?.size}:${s?.mtimeMs}`)(statSync(join(dir, f), { throwIfNoEntry: false })))
      .join('|');
  return dirs.map((d) => `${d}>${sigOf(d)}`).join('||');
}

const byOrder = (a: Environment, b: Environment) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER);

/**
 * The workspace's own environments, then those of the shared folders, in their own order, read-only (`shared`, the
 * folder's name). One with the id of one of the workspace's own stays the workspace's: the shared one is listed with why.
 */
export function withSharedEnvironments(own: Environment[], sources: Array<{ name: string; dir: string }>, read: (dir: string) => Environment[]): Environment[] {
  if (!sources.length) return own;
  const ids = new Set(own.map((e) => e.id));
  const shared = sources.flatMap((s) =>
    read(s.dir)
      .sort(byOrder)
      .map((e): Environment => {
        const { order: _order, ...rest } = e;
        void _order;
        const clash = ids.has(e.id) ? `The shared environment "${e.name}" from ${s.name} has the same id as one of this workspace's: this workspace's is used` : undefined;
        ids.add(e.id);
        return { ...rest, shared: s.name, readOnly: true, ...(clash ? { problem: clash, variables: [] } : {}) };
      }),
  );
  return [...own, ...shared];
}

type EnvStore = { root: string; workspace: Pick<Workspace, 'shared'>; path(...p: string[]): string; listEnvironments(): Environment[] };

/** Saving or deleting an environment a shared folder gives (and the workspace has none of its own by that id) is refused. */
export function refuseSharedEnvironment(store: EnvStore, id: string, what: 'change' | 'delete'): void {
  if (existsSync(store.path('environments', `${slugify(id)}.json`))) return;
  const s = store.listEnvironments().find((e) => e.shared && e.id === id && !e.problem);
  if (s) throw new ApsError('ValidationError', `"${s.name}" is shared from ${s.shared}: ${what} it there`, { suggestions: [`Open the workspace in ${s.shared} to change it, or copy it into this workspace (Duplicate) to change a copy.`] });
}

/**
 * The file of a shared environment (by id, name or "Group ▸ name"), relative to the workspace:
 * ../platform-shared/environments/x.json. The files are read, never the list (callers that index refs count on it).
 */
export function sharedEnvironmentFile(store: EnvStore, idOrName: string): string | undefined {
  const [group, name] = idOrName.includes(' ▸ ') ? idOrName.split(' ▸ ', 2).map((x) => x.trim()) : [undefined, idOrName];
  for (const s of sharedDirs(store.workspace, store.root, 'environments'))
    for (const f of readdirSync(s.dir).filter((x) => x.endsWith('.json'))) {
      try {
        const e = JSON.parse(readFileSync(join(s.dir, f), 'utf8')) as Environment;
        if (e.id === idOrName || (e.name === name && (group === undefined || (e.group?.trim() ?? '').toLowerCase() === group!.toLowerCase())))
          return relative(store.root, join(s.dir, f)).split(sep).join('/');
      } catch {
        /* not an environment */
      }
    }
  return undefined;
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
