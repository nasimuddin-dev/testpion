import { existsSync } from 'node:fs';
import { basename, relative, sep } from 'node:path';
import { LAUNCHER_EXTENSIONS, fileExtension } from '@testpion/shared';
import { ApsError } from '../../errors.js';
import type { WorkspaceStore } from '../../storage/workspace.js';

/**
 * Where an MCP tool may write a file it was asked to produce (`save_output` with `save_to`, `export_bundle` with `out`).
 * The bytes can be controlled by someone else (a response body, a bundle's title), and the workspace is often the
 * repository root, so a deny-list of folders is not enough: `.husky/pre-commit`, `.vscode/tasks.json`, `Makefile`,
 * `package.json` or `metrics/x.yaml` would all be code that runs later. An allow-list instead: a new file under
 * `exports/` or `.local/exports/` (the folder the app and git already treat as output), never in a folder whose name
 * starts with a dot below that, never a program or launcher file, never over a file that is there.
 */
export const EXPORT_FOLDERS = ['exports', '.local/exports'] as const;

/** The absolute path of a new file under `exports/` or `.local/exports/`, or why `requested` is not allowed. */
export function exportTarget(store: WorkspaceStore, requested: string, opts: { what: string; arg: string }): string {
  const target = store.safePath(requested);
  const rel = relative(store.root, target).split(sep);
  const first = (rel[0] ?? '').toLowerCase();
  const inLocal = first === '.local' && (rel[1] ?? '').toLowerCase() === 'exports';
  const body = inLocal ? rel.slice(2) : first === 'exports' ? rel.slice(1) : undefined;
  const deny = (why: string) =>
    new ApsError('ValidationError', `${opts.arg} ${JSON.stringify(requested)} is not allowed: ${why}`, { suggestions: [`${opts.what} are written as new files under ${EXPORT_FOLDERS.join(' or ')} (e.g. exports/<name>).`] });
  if (!body || !body.length) throw deny(`${opts.what} only go under ${EXPORT_FOLDERS.join(' or ')}`);
  // a hidden folder or file, or a name Windows rewrites (trailing dot or space, a stream), is not a plain output file
  if (body.some((s) => !s || s.startsWith('.') || /[. ]$/.test(s) || s.includes(':'))) throw deny('hidden names, names ending in a dot or space and ":" are not used for output files');
  const ext = fileExtension(basename(target));
  if (LAUNCHER_EXTENSIONS.has(ext)) throw deny(`a ${ext} file is a program`);
  if (existsSync(target)) throw new ApsError('ValidationError', `${requested} already exists: ${opts.what} never replace a file`, { suggestions: ['Choose another name.'] });
  return target;
}
