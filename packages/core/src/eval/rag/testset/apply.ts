/**
 * Applying and undoing the `dataset-row` items of a test-set proposal (called from ai/proposal-apply.ts): each accepted row is
 * appended to datasets/<name>.jsonl (created when it is not there). The text of the file before is kept for undo, so undoing
 * the items newest first ends at the file as it was (or removes it when the proposal created it). A row whose id is already in
 * the file is not added twice, so applying again is safe. The row is the item's text: a person may have edited it in the review.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { ApsError } from '../../../errors.js';
import type { ProposalItem, ProposalUndo } from '../../../ai/proposal.js';
import { atomicWrite, removeOwned } from '../../../storage/fsutil.js';
import type { WorkspaceStore } from '../../../storage/workspace.js';

const DATASET_PATH = /^datasets\/[A-Za-z0-9][\w.-]{0,100}\.jsonl$/;

function fileOf(store: WorkspaceStore, rel: string): string {
  const clean = rel.replace(/\\/g, '/');
  // one file directly in datasets/: no folders, no `..`, only .jsonl
  if (!DATASET_PATH.test(clean) || clean.includes('..')) throw new ApsError('ValidationError', `"${rel}" is not a dataset file (datasets/<name>.jsonl)`);
  return store.safePath(clean);
}

const idsOf = (text: string): Set<string> => {
  const ids = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const id = (JSON.parse(line) as { id?: unknown }).id;
      if (typeof id === 'string') ids.add(id);
    } catch {
      /* a line that is not JSON is left as it is */
    }
  }
  return ids;
}

export function applyDatasetRowItem(store: WorkspaceStore, item: ProposalItem): ProposalUndo {
  const d = item.data as { dataset?: string; record?: Record<string, unknown> } | undefined;
  if (!d?.dataset) throw new ApsError('ValidationError', `"${item.title}" names no dataset file`);
  const rel = d.dataset.replace(/\\/g, '/');
  const file = fileOf(store, rel);
  let row: Record<string, unknown> = d.record ?? {};
  try {
    const edited = JSON.parse(item.after) as Record<string, unknown>;
    if (edited && typeof edited === 'object' && typeof edited.question === 'string') row = edited;
  } catch {
    /* the original record stands */
  }
  if (typeof row.question !== 'string' || !row.question.trim()) throw new ApsError('ValidationError', `"${item.title}" has no question`);
  // what the verifiers said stays with the row, so a later reader knows how far to trust it
  const meta = (row.metadata && typeof row.metadata === 'object' ? row.metadata : {}) as Record<string, unknown>;
  const verification = item.verification.map((b) => ({ verifier: b.verifier, status: b.status }));
  row = { ...row, metadata: { ...meta, ...(verification.length ? { verification } : {}) } };
  const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
  const undo: ProposalUndo = { item: item.id, dataset: { path: rel, before } };
  if (typeof row.id === 'string' && before !== null && idsOf(before).has(row.id)) return undo;
  mkdirSync(store.path('datasets'), { recursive: true });
  const head = before === null || before === '' ? '' : before.endsWith('\n') ? before : `${before}\n`;
  atomicWrite(file, `${head}${JSON.stringify(row)}\n`);
  return undo;
}

export function undoDatasetRows(store: WorkspaceStore, u: NonNullable<ProposalUndo['dataset']>): void {
  const file = fileOf(store, u.path);
  if (u.before === null) {
    if (existsSync(file)) removeOwned(file);
  } else atomicWrite(file, u.before);
}
