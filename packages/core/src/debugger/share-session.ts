import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ApsError } from '../errors.js';
import { redactOutputText } from '../output/policy.js';
import { atomicWrite } from '../storage/fsutil.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import type { Redactor } from '../util/redact.js';
import { beginJournal } from '../git/journal.js';
import { CAPTURE_SESSIONS_DIR, captureSessionFileName } from './capture-history.js';

/**
 * Share session (release C of planning/git-everything.md §4f): a Debugger capture session is git-ignored (`debugger/*.har`:
 * traffic is large, personal and changes with every capture). A team that wants one in the repository (a bug report, a
 * reference recording) shares it on purpose: a copy goes to `debugger/shared/<name>.har`, which git tracks, after a second
 * masking pass with the redaction every export uses (`redactOutputText`: secret values the workspace knows, sensitive
 * header and field names, credentials by their shape). The original stays where it was, unmasked beyond what capture masked.
 */
export const SHARED_SESSIONS_DIR = `${CAPTURE_SESSIONS_DIR}/shared`;

export interface SharedSession {
  name: string;
  /** Workspace path of the shared copy. */
  file: string;
  bytes: number;
}

export interface ShareResult {
  name: string;
  /** The session it was copied from. */
  from: string;
  /** The tracked copy. */
  to: string;
  bytes: number;
  entries: number;
  /** The masking pass changed the text (it found something the capture had not masked). */
  masked: boolean;
  /** A shared copy of this name existed and is replaced. */
  replaced: boolean;
  applied: boolean;
  undoId?: string;
}

const sessionName = (name: string): string => {
  const file = captureSessionFileName(String(name ?? '').trim());
  if (file === '.har' || file.includes('/') || file.includes('\\')) throw new ApsError('ValidationError', 'A session needs a name (no folders)');
  return file;
};

/** Sessions shared so far (the tracked copies). */
export function listSharedSessions(store: WorkspaceStore): SharedSession[] {
  const dir = store.path(CAPTURE_SESSIONS_DIR, 'shared');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.har'))
    .sort()
    .map((f) => ({ name: basename(f, '.har'), file: `${SHARED_SESSIONS_DIR}/${f}`, bytes: statSync(join(dir, f)).size }));
}

/** Copy a saved session, masked, to the tracked folder. `dryRun` reports what would be written without writing. */
export function shareSession(store: WorkspaceStore, name: string, o: { redactor: Redactor; dryRun?: boolean }): ShareResult {
  const file = sessionName(name);
  const source = store.safePath(file, store.path(CAPTURE_SESSIONS_DIR));
  if (!existsSync(source)) throw new ApsError('ValidationError', `There is no saved session "${basename(file, '.har')}"`, { suggestions: ['Save the session in the Debugger first (Save session), then share it.'] });
  const text = readFileSync(source, 'utf8');
  let entries = 0;
  try {
    entries = (JSON.parse(text) as { log?: { entries?: unknown[] } }).log?.entries?.length ?? 0;
  } catch {
    throw new ApsError('ValidationError', `${file} is not a HAR file`);
  }
  const masked = redactOutputText(text, 'har', o.redactor);
  const out = masked.endsWith('\n') ? masked : `${masked}\n`;
  const to = `${SHARED_SESSIONS_DIR}/${file}`;
  const target = store.safePath(file, store.path(CAPTURE_SESSIONS_DIR, 'shared'));
  const result: ShareResult = {
    name: basename(file, '.har'),
    from: `${CAPTURE_SESSIONS_DIR}/${file}`,
    to,
    bytes: Buffer.byteLength(out),
    entries,
    masked: masked !== text,
    replaced: existsSync(target),
    applied: false,
  };
  if (o.dryRun) return result;
  const undo = beginJournal(store.root, 'share-session', `Share session ${result.name}`, [to]);
  mkdirSync(store.path(CAPTURE_SESSIONS_DIR, 'shared'), { recursive: true });
  atomicWrite(target, out);
  return { ...result, applied: true, undoId: undo.id };
}

/** Stop sharing: the tracked copy is deleted (the commit that removes it is the user's); the saved session stays. */
export function unshareSession(store: WorkspaceStore, name: string): { name: string; removed: boolean; undoId?: string } {
  const file = sessionName(name);
  const target = store.safePath(file, store.path(CAPTURE_SESSIONS_DIR, 'shared'));
  if (!existsSync(target)) return { name: basename(file, '.har'), removed: false };
  const rel = `${SHARED_SESSIONS_DIR}/${file}`;
  const undo = beginJournal(store.root, 'unshare-session', `Stop sharing session ${basename(file, '.har')}`, [rel]);
  rmSync(target);
  return { name: basename(file, '.har'), removed: true, undoId: undo.id };
}
