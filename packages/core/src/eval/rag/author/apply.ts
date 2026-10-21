/**
 * Applying and undoing the `evaluation` item of an authored-evaluation proposal (called from ai/proposal-apply.ts): the
 * evaluation is saved into the workspace's saved evaluations (library `evaluations`); what was there before is kept for
 * undo. (Filled in by the evaluation-authoring work.)
 */
import { ApsError } from '../../../errors.js';
import type { ProposalItem, ProposalUndo } from '../../../ai/proposal.js';
import type { WorkspaceStore } from '../../../storage/workspace.js';

export function applyEvaluationItem(_store: WorkspaceStore, item: ProposalItem): ProposalUndo {
  throw new ApsError('ValidationError', `"${item.title}": authored evaluations are not applied yet`);
}

export function undoEvaluation(_store: WorkspaceStore, _u: NonNullable<ProposalUndo['evaluation']>): void {}
