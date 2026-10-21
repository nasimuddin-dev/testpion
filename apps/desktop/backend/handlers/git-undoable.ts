/**
 * Undo for the two whole-file writes of the Changes panel and the conflict dialog (discard, resolve). They use the
 * journal that item restores and item discards already use (core: git/journal.ts): the files' bytes are copied aside
 * before they are rewritten, so the app's Undo toast puts them back. A resolved file also loses its "both sides
 * changed it" entries in the index when it is marked done; those are saved beside the copy and put back by the undo,
 * so the file is a conflict again, not a plain modified file with conflict marks in it.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beginJournal, listJournal, runGit } from '@testpion/core';
import type { Backend } from '../backend.js';

/**
 * What every git handler group shares: the workspace folder, `rewritten` (after git or an item operation rewrote workspace
 * files: reload and tell the views, without the "changed outside TestPion" notice, since the user asked for it) and `changed`
 * (the answer of an operation that only changed git's state).
 */
export function gitHelpers(be: Backend) {
  const ws = () => be.ws.root;
  const rewritten = async <T>(op: () => Promise<T> | T): Promise<T> => {
    try {
      return await op();
    } finally {
      be.adoptDiskState(); // the files were written for the app: they are its own changes, not outside ones
      be.ws.reloadWorkspaceFile();
      be.host.emit('data.changed', { method: 'git' });
      be.host.emit('git.changed', {});
    }
  };
  const changed = <T>(r: T): T => (be.host.emit('git.changed', {}), r);
  return { ws, rewritten, changed };
}

const STAGES = 'index-stages';
const isFile = (ws: string, rel: string) => {
  try {
    return statSync(join(ws, rel)).isFile();
  } catch {
    return false;
  }
};

/** Copy the files aside (those that are files and exist); the entry's id is the Undo's. */
export function journalFiles(ws: string, op: string, title: string, paths: string[]): string | undefined {
  const files = paths.filter((p) => isFile(ws, p));
  return files.length ? beginJournal(ws, op, title, files).id : undefined;
}

/** Journal a file about to be resolved, with the conflict entries of the index (ours, theirs, the common ancestor). */
export async function journalResolve(ws: string, path: string): Promise<string | undefined> {
  const id = journalFiles(ws, 'resolve', `Resolve ${path}`, [path]);
  if (!id) return undefined;
  const entries = await runGit(ws, ['ls-files', '-u', '-z', '--full-name', '--', path]).catch(() => '');
  if (entries) writeFileSync(join(ws, '.local', 'git-undo', id, STAGES), entries);
  return id;
}

/** Read, before the undo forgets the entry, what the undo of a resolve must put back in the index. */
export function savedConflict(ws: string, id: string | undefined): string | undefined {
  const entry = id ? listJournal(ws).find((e) => e.id === id) : listJournal(ws)[0];
  const saved = entry && join(ws, '.local', 'git-undo', entry.id, STAGES);
  return entry?.op === 'resolve' && saved && existsSync(saved) ? readFileSync(saved, 'utf8') : undefined;
}

/** After the journal put the file back: it is a conflict again (the resolved entry is dropped, the three sides are put back). */
export async function restoreConflict(ws: string, entries: string): Promise<void> {
  const path = /\t([^\0]+)\0/.exec(entries)?.[1];
  if (!path) return;
  // a higher stage can only be placed after the path is removed: a mode 0 entry says so
  await runGit(ws, ['update-index', '-z', '--index-info'], { input: `0 ${'0'.repeat(40)}\t${path}\0${entries}` }).catch(() => undefined);
}
