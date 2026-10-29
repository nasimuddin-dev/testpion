/**
 * "Why did this fail?" (AU-15): one failed case of an evaluation run, answered in plain words. When an AI reviewer graded the
 * case its own reason is the answer (nothing is sent anywhere). Otherwise the AI task `eval-why` explains it from the case the
 * run stored (the prompt, the reply, the answer that was expected, what each check said). The app (`eval.why` + the AI action),
 * `testpion eval why` and the `eval_explain_failure` MCP tool share the context built here.
 */
import { ApsError } from '../errors.js';
import { resolveRunRef } from '../runner/eval-matrix-runs.js';
import { readRunSummary } from '../runner/run-records.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { evalCaseKey, failureOf, findEvalResult, type EvalReportFailure } from './report.js';

export const EVAL_WHY_INSTRUCTION = [
  'You explain, to a developer who is not a machine-learning specialist, why one test case of an AI evaluation failed.',
  'The context holds `prompt` (what the model was asked, with the case filled in), `reply` (what it answered), `expected` (the answer that was expected, when there is one), `failedChecks` (each failed check with its name, type and message, and the reason an AI reviewer gave when one graded it), `passedChecks` and `model`.',
  'Say in plain words: (1) what went wrong, in one sentence, comparing the reply with what was expected or asked; (2) the likely cause in the prompt, the case or the check: the prompt is ambiguous or leaves the format open, the case is borderline, the expected answer is too strict (a different wording that is also right), or the model really answered wrongly; name which one and quote the shortest words that show it; (3) the first thing to change, one concrete step (a line to add to the prompt, a check to loosen or tighten, a case to fix), and how to see whether it worked.',
  'Be concise: three short paragraphs at most. Judge only from the context; do not guess at anything it does not show. If the check looks wrong rather than the reply, say so.',
].join('\n');

type Store = Pick<WorkspaceStore, 'root' | 'runDir' | 'meta'>;

export interface EvalWhy {
  run: { id: string; name: string };
  resultId: string;
  key: string;
  name: string;
  status: string;
  failure: EvalReportFailure;
  /** The AI reviewer's own reason, when it graded this case: show it, no model call is needed. */
  stored?: { source: 'AI reviewer'; reason: string };
  /** What the `eval-why` task is given (the task redacts it and fits it to a budget before anything is sent). */
  context: Record<string, unknown>;
}

const cut = (s: string | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n)} …` : s);

/** The case, its stored reason and the context for the task. A case that passed is refused: there is nothing to explain. */
export async function evalWhy(store: Store, o: { run: string; case: string }): Promise<EvalWhy> {
  const ref = resolveRunRef(store, o.run);
  const summary = readRunSummary(store, ref.runId);
  if (!summary) throw new ApsError('ConfigurationError', `Run ${ref.runId} has not finished`);
  const r = await findEvalResult(store, ref.runId, o.case);
  if (r.status === 'passed' || r.status === 'skipped') throw new ApsError('ValidationError', `Case ${evalCaseKey(r.id)} ${r.status === 'passed' ? 'passed' : 'did not run'}: there is nothing to explain`, { suggestions: ['Pick a failed case (`testpion eval summary` lists them).'] });
  const failure = failureOf(r);
  const reasons = failure.failedChecks.filter((c) => c.aiReviewer && c.reason).map((c) => c.reason!);
  return {
    run: { id: ref.runId, name: summary.name },
    resultId: r.id,
    key: failure.key,
    name: r.name,
    status: r.status,
    failure,
    ...(reasons.length ? { stored: { source: 'AI reviewer' as const, reason: reasons.join(' ') } } : {}),
    context: {
      case: failure.key,
      prompt: cut(r.input, 3000),
      reply: cut(r.output, 3000),
      ...(failure.expected !== undefined ? { expected: cut(failure.expected, 1000) } : {}),
      failedChecks: failure.failedChecks.map((c) => ({ name: c.name, type: c.type, message: cut(c.message, 400), ...(c.reason ? { reviewerReason: cut(c.reason, 600) } : {}) })),
      passedChecks: r.checks.filter((c) => c.passed).map((c) => c.name || c.type),
      ...(r.error ? { error: cut(r.error.message, 400) } : {}),
      ...(r.model ? { model: r.model } : {}),
    },
  };
}
