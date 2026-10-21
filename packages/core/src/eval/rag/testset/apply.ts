/**
 * Applying and undoing the `dataset-row` items of a test-set proposal (called from ai/proposal-apply.ts): each accepted
 * row is appended to datasets/<name>.jsonl; the file's text before is kept for undo. (Filled in by the test-set work.)
 */
import { ApsError } from '../../../errors.js';
import type { ProposalItem, ProposalUndo } from '../../../ai/proposal.js';
import type { WorkspaceStore } from '../../../storage/workspace.js';

export function applyDatasetRowItem(_store: WorkspaceStore, item: ProposalItem): ProposalUndo {
  throw new ApsError('ValidationError', `"${item.title}": test-set rows are not applied yet`);
}

export function undoDatasetRows(_store: WorkspaceStore, _u: NonNullable<ProposalUndo['dataset']>): void {}
