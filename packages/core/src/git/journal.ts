import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApsError } from '../errors.js';
import { atomicWrite } from '../storage/fsutil.js';
import { workspaceFile } from './item-address.js';

/**
 * The undo of the git operations that write workspace files (restore a version, discard an item): before a file is
 * written, its bytes are copied to `.local/git-undo/<id>/` (git ignores `.local/`), so the app's Undo toast, the CLI's
 * `testpion git undo` and an agent's `git_undo` put the file back exactly, even when the change was never committed.
 * The newest 30 operations are kept.
 */
export interface JournalFile {
  file: string;
  /** The file existed before the operation (its bytes are in the backup). */
  existed: boolean;
}
export interface JournalEntry {
  id: string;
  op: string;
  /** In words: "Restore MCP server Weather from 3fa2c1d". */
  title: string;
  at: string;
  files: JournalFile[];
}

const KEEP = 30;
const dirOf = (ws: string) => join(ws, '.local', 'git-undo');

/** Copy the files' current bytes aside; call before writing them. */
export function beginJournal(ws: string, op: string, title: string, files: string[]): JournalEntry {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const dir = join(dirOf(ws), id);
  mkdirSync(dir, { recursive: true });
  const entry: JournalEntry = { id, op, title, at: new Date().toISOString(), files: [] };
  files.forEach((file, i) => {
    const abs = workspaceFile(ws, file);
    const existed = existsSync(abs);
    if (existed) copyFileSync(abs, join(dir, String(i)));
    entry.files.push({ file, existed });
  });
  writeFileSync(join(dir, 'entry.json'), JSON.stringify(entry, null, 2));
  prune(ws);
  return entry;
}

function prune(ws: string) {
  const ids = readdirSync(dirOf(ws)).sort();
  for (const old of ids.slice(0, Math.max(0, ids.length - KEEP))) rmSync(join(dirOf(ws), old), { recursive: true, force: true });
}

/** The undoable operations, newest first. */
export function listJournal(ws: string): JournalEntry[] {
  if (!existsSync(dirOf(ws))) return [];
  return readdirSync(dirOf(ws))
    .sort()
    .reverse()
    .flatMap((id) => {
      try {
        return [JSON.parse(readFileSync(join(dirOf(ws), id, 'entry.json'), 'utf8')) as JournalEntry];
      } catch {
        return [];
      }
    });
}

/** Put the files of an operation (default: the newest) back as they were, and forget it. */
export function undoJournal(ws: string, id?: string): JournalEntry {
  const entry = id ? listJournal(ws).find((e) => e.id === id) : listJournal(ws)[0];
  if (!entry) throw new ApsError('ValidationError', id ? `No undoable operation ${id}` : 'Nothing to undo', { suggestions: ['Only restores and discards of the last 30 operations can be undone.'] });
  const dir = join(dirOf(ws), entry.id);
  entry.files.forEach((f, i) => {
    const abs = workspaceFile(ws, f.file);
    if (f.existed) atomicWrite(abs, readFileSync(join(dir, String(i))));
    else rmSync(abs, { force: true });
  });
  rmSync(dir, { recursive: true, force: true });
  return entry;
}
