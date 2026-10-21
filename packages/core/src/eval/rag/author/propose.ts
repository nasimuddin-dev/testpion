/**
 * The proposal of an authored evaluation (registry `propose` and `describe`): one item, the saved evaluation with its
 * gates, built from the plan by `buildEvaluation`.
 */
import { ApsError } from '../../../errors.js';
import type { AiTaskInput, DraftItem } from '../../../ai/tasks/registry.js';
import type { ProposalItem } from '../../../ai/proposal.js';
import { buildEvaluation, type BuiltEvaluation } from './build.js';
import type { AuthorLocal, AuthorPlan } from './types.js';

/** What the review and the apply step read back from the item. */
export interface AuthoredData extends Omit<BuiltEvaluation, 'yaml'> {
  plan: AuthorPlan;
  /** The saved evaluation (with its dataset text) that Accept saves. */
  source: { target: string; dataset?: string };
}

export function proposeEvaluation(a: { value?: unknown }, input: AiTaskInput): DraftItem[] {
  const local = input.local as AuthorLocal | undefined;
  if (!local) throw new ApsError('ValidationError', 'An evaluation is authored for a RAG target: name one');
  const plan = (a.value ?? {}) as AuthorPlan;
  const built = buildEvaluation(plan, local, { supplied: local.inputs });
  const { yaml, ...rest } = built;
  const data: AuthoredData = { ...rest, plan, source: { target: local.target.name, ...(local.dataset ? { dataset: local.dataset.name } : {}) } };
  return [{ kind: 'evaluation', title: `Evaluation: ${built.evaluation.name}`, after: yaml, language: 'yaml', data }];
}

export function describeEvaluation(value: unknown, items: ProposalItem[]): { summary?: string; assumptions?: string[]; notes?: string[] } {
  const v = (value ?? {}) as AuthorPlan;
  const d = items[0]?.data as AuthoredData | undefined;
  const gates = d && Object.keys(d.gates).length ? `Gates: ${d.gateFlags.join(' ')} (a saved evaluation has no field for them: pass them to \`testpion rag run\`, a monitor or the CI dialog).` : '';
  const sample = d?.records ? `${d.records.used} of ${d.records.total} dataset records are in the evaluation.` : '';
  return {
    summary: [typeof v.summary === 'string' ? v.summary : '', sample, gates, d?.baseline === 'previous' ? 'Run it with a baseline: fail a run that is worse than the one before.' : ''].filter(Boolean).join(' ') || undefined,
    assumptions: [...(Array.isArray(v.assumptions) ? v.assumptions.map(String) : []), ...(Array.isArray(v.risks) ? v.risks.map((r) => `Cannot tell: ${String(r)}`) : [])],
    notes: d?.notes ?? [],
  };
}
