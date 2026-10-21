/**
 * Applying and undoing the `evaluation` item of an authored-evaluation proposal (called from ai/proposal-apply.ts): the
 * evaluation is saved into the workspace's saved evaluations (library `evaluations`) as a new item, never over one that is
 * there (a name that is taken gets "(2)"); what an update replaced is kept for undo. The dataset travels inside the
 * evaluation (a saved evaluation holds its dataset text), so no file is written under datasets/.
 */
import { ApsError } from '../../../errors.js';
import type { ProposalItem, ProposalUndo } from '../../../ai/proposal.js';
import { shortId } from '../../../util/ids.js';
import type { WorkspaceStore } from '../../../storage/workspace.js';
import type { SavedEvaluation } from '../../../runner/saved-evaluations.js';
import { resolveMetric } from '../metric-registry.js';
import { freeName } from './build.js';

/** The library of saved evaluations (runner/saved-evaluations.ts EVALUATIONS_LIBRARY; eval/rag takes types only from the runner). */
const LIBRARY = 'evaluations';

export function applyEvaluationItem(store: WorkspaceStore, item: ProposalItem): ProposalUndo {
  const d = item.data as { evaluation?: SavedEvaluation; updates?: string } | undefined;
  const ev = d?.evaluation;
  if (!ev || ev.type !== 'rag' || !Array.isArray(ev.evaluators)) throw new ApsError('ValidationError', `"${item.title}" holds no RAG evaluation`);
  const bad = ev.evaluators.filter((e) => !resolveMetric(e.type)).map((e) => e.type);
  if (bad.length) throw new ApsError('ValidationError', `"${item.title}": ${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} not metric${bad.length === 1 ? '' : 's'} of the catalogue`);
  const lib = store.getLibrary<SavedEvaluation>(LIBRARY);
  const was = d?.updates ? lib.items.find((i) => i.id === d.updates) : undefined;
  if (d?.updates && !was) throw new ApsError('ConfigurationError', `The evaluation this one updates (${d.updates}) is no longer there`);
  const id = was?.id ?? shortId('lib-');
  const name = was ? ev.name : freeName(ev.name, lib.items.map((i) => i.name));
  const next = { id, name, data: { ...ev, name }, updatedAt: new Date().toISOString(), ...(was?.folder ? { folder: was.folder } : {}) };
  store.saveLibrary(LIBRARY, { folders: lib.folders, items: was ? lib.items.map((i) => (i.id === id ? next : i)) : [...lib.items, next] });
  return { item: item.id, evaluation: { id, before: was ?? null } };
}

export function undoEvaluation(store: WorkspaceStore, u: NonNullable<ProposalUndo['evaluation']>): void {
  const lib = store.getLibrary<SavedEvaluation>(LIBRARY);
  const items = u.before === null ? lib.items.filter((i) => i.id !== u.id) : lib.items.map((i) => (i.id === u.id ? (u.before as (typeof lib.items)[number]) : i));
  store.saveLibrary(LIBRARY, { folders: lib.folders, items });
}
