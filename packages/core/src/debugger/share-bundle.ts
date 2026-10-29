import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { ApsError } from '../errors.js';
import { redactOutputText } from '../output/policy.js';
import { atomicWrite } from '../storage/fsutil.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import type { Redactor } from '../util/redact.js';
import { beginJournal } from '../git/journal.js';
import { CAPTURE_SESSIONS_DIR, captureSessionFileName } from './capture-history.js';
import { createShareBundle, SHARE_BUNDLE_EXTENSION } from './bundle.js';
import { exchangesFromHar } from './har.js';
import type { DebuggerRule, DebuggerRulesFile } from './rules.js';
import type { ShareResult } from './share-session.js';

/**
 * Share session as a bundle (FG-24, extending git share-session): the same masked copy, written as one `.tpbundle` to
 * `debugger/shared/` with the workspace's enabled rules, environment facts and a note, so the person who pulls it opens it in
 * TestPion and sees what the sender saw.
 */
export async function shareSessionBundle(store: WorkspaceStore, name: string, o: { redactor: Redactor; notes?: string; rules?: boolean; dryRun?: boolean }): Promise<ShareResult> {
  const file = captureSessionFileName(String(name ?? '').trim());
  if (file === '.har' || file.includes('/') || file.includes('\\')) throw new ApsError('ValidationError', 'A session needs a name (no folders)');
  const source = store.safePath(file, store.path(CAPTURE_SESSIONS_DIR));
  if (!existsSync(source)) throw new ApsError('ValidationError', `There is no saved session "${basename(file, '.har')}"`, { suggestions: ['Save the session in the Debugger first (Save session), then share it.'] });
  const text = readFileSync(source, 'utf8');
  let har: unknown;
  try {
    har = JSON.parse(redactOutputText(text, 'har', o.redactor));
  } catch {
    throw new ApsError('ValidationError', `${file} is not a HAR file`);
  }
  const exchanges = exchangesFromHar(har);
  let rules: DebuggerRule[] = [];
  if (o.rules !== false) {
    try {
      const raw = JSON.parse(readFileSync(store.path(CAPTURE_SESSIONS_DIR, 'rules.json'), 'utf8')) as DebuggerRulesFile;
      rules = (raw.profiles?.[raw.active] ?? []).filter((r) => r.enabled);
    } catch {
      /* no rules file: none travel */
    }
  }
  const base = basename(file, '.har');
  const { bytes, manifest } = await createShareBundle({ name: base, exchanges, rules, notes: o.notes, redactor: o.redactor });
  const rel = `${CAPTURE_SESSIONS_DIR}/shared/${base}${SHARE_BUNDLE_EXTENSION}`;
  const target = store.safePath(`${base}${SHARE_BUNDLE_EXTENSION}`, store.path(CAPTURE_SESSIONS_DIR, 'shared'));
  const result: ShareResult = { name: base, from: `${CAPTURE_SESSIONS_DIR}/${file}`, to: rel, bytes: bytes.length, entries: manifest.exchanges, masked: true, replaced: existsSync(target), applied: false };
  if (o.dryRun) return result;
  const undo = beginJournal(store.root, 'share-session', `Share session ${base} as a bundle`, [rel]);
  mkdirSync(store.path(CAPTURE_SESSIONS_DIR, 'shared'), { recursive: true });
  atomicWrite(target, bytes);
  return { ...result, applied: true, undoId: undo.id };
}
