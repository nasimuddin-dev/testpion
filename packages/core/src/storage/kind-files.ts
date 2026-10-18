/**
 * What the node menus do to files the user keeps in the workspace (API definitions, datasets): rename one in its folder,
 * keep its virtual folder (library/spec-folders.json, library/dataset-folders.json: the files never move, so `spec:` and
 * `dataset:` paths in tests, bundles and git stay stable), and the folder that holds one (Reveal file). Every name is
 * checked lexically, the same on every OS: never by what `node:path` thinks is absolute on the machine it runs on.
 */
import { dirname, posix } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { ApsError } from '../errors.js';
import type { WorkspaceStore } from './workspace.js';
import { renameOwned } from './fsutil.js';

/** Names Windows reserves for devices (with any extension). */
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\.|$)/i;

/** A file name someone typed (a rename): one name, no folders, one that every OS can hold; or why not. */
export function checkFileName(asked: string): string {
  const name = String(asked ?? '').trim();
  const bad = (why: string) => new ApsError('ValidationError', `Not a usable file name: ${JSON.stringify(asked)} (${why})`, { suggestions: ['Give a plain file name, e.g. orders-v2.yaml.'] });
  if (!name) throw bad('empty');
  if (name.length > 100) throw bad('longer than 100 characters');
  if (/[\u0000-\u001f\u007f]/.test(name)) throw bad('it holds a control character');
  if (/[\\/]/.test(name)) throw bad('a name, not a path: no / or \\');
  if (/[<>:"|?*]/.test(name)) throw bad('Windows cannot hold < > : " | ? *');
  if (name === '.' || name === '..' || /[. ]$/.test(name)) throw bad('it ends in a dot or a space');
  if (RESERVED.test(name)) throw bad('Windows reserves that name');
  return name;
}

/** A workspace path of a kind's folder (`specs/x.yaml` under `specs/`), lexically: `/` only, no `..`, no empty names. */
export function checkKindPath(rel: string, root: string): string {
  const p = String(rel ?? '').trim();
  const names = p.split('/');
  if (names[0] !== root || names.length < 2 || names.some((n) => !n || n === '.' || n === '..') || p.includes('\\') || /^[a-z]:/i.test(p))
    throw new ApsError('ValidationError', `Not a file in ${root}/: ${JSON.stringify(rel)}`, { suggestions: [] });
  return p;
}

/** The library holding a kind's virtual folders: `{ folders, items: [{ id: <path>, folder }] }`. */
type FolderLibrary = 'spec-folders' | 'dataset-folders' | 'mcp-folders';

/** An item renamed: its folder goes with it (the folder library names items by their path). */
export function moveFolderEntry(store: WorkspaceStore, library: FolderLibrary, from: string, to: string): void {
  const lib = store.getLibrary(library);
  if (!lib.items.some((i) => i.id === from)) return;
  store.saveLibrary(library, { folders: lib.folders, items: lib.items.map((i) => (i.id === from ? { ...i, id: to, name: to } : i)) });
}

/** An item duplicated: the copy is in the same folder. */
export function copyFolderEntry(store: WorkspaceStore, library: FolderLibrary, from: string, to: string): void {
  const lib = store.getLibrary(library);
  const it = lib.items.find((i) => i.id === from);
  if (!it || lib.items.some((i) => i.id === to)) return;
  store.saveLibrary(library, { folders: lib.folders, items: [...lib.items, { ...it, id: to, name: to }] });
}

/**
 * Rename an API definition in its folder (`specs/a.yaml` → `specs/b.yaml`; the extension is kept when the new name has
 * none); its virtual folder goes with it. Never overwrites: a taken name is refused.
 */
export function renameSpecFile(store: WorkspaceStore, rel: string, to: string): string {
  const from = checkKindPath(rel, 'specs');
  const name = checkFileName(to);
  const ext = posix.extname(from);
  const dest = `${posix.dirname(from)}/${posix.extname(name) ? name : name + ext}`;
  if (dest === from) return from;
  const src = store.safePath(from);
  if (!existsSync(src)) throw new ApsError('ConfigurationError', `No API definition ${from}`, { suggestions: [] });
  const target = store.safePath(dest);
  if (!store.isInside(target, 'specs')) throw new ApsError('ValidationError', `Not a file in specs/: ${dest}`, { suggestions: [] });
  if (existsSync(target)) throw new ApsError('ValidationError', `${dest} exists already`, { suggestions: ['Choose another name.'] });
  renameOwned(src, target);
  moveFolderEntry(store, 'spec-folders', from, dest);
  return dest;
}

/** The folder in the workspace that holds a file (Reveal file opens it in the file manager; a file itself is never opened). */
export function folderOfWorkspaceFile(store: WorkspaceStore, rel: string): string {
  const p = String(rel ?? '').trim();
  if (!p || p.includes('\\') || p.split('/').some((n) => !n || n === '..') || /^[a-z]:/i.test(p) || p.startsWith('/'))
    throw new ApsError('ValidationError', `Not a file in the workspace: ${JSON.stringify(rel)}`, { suggestions: [] });
  const dir = dirname(store.safePath(p));
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new ApsError('ConfigurationError', `No folder for ${p}`, { suggestions: [] });
  return dir;
}
