import { datasetRecords } from '@testpion/shared';
import { ApsError } from '../errors.js';
import type { CheckConfig, CheckResult, TestResult } from '../model/types.js';
import { evaluationTests, type SavedEvaluation } from '../runner/saved-evaluations.js';
import type { ExecServices } from '../runner/execute.js';
import { runTests } from '../runner/runner.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { estimateEvaluation, isReviewerCheck, type EvalEstimate } from './llm-estimate.js';

/**
 * Try one check on one case (AU-11): the case goes to the model as in a run, and the check is applied to the reply, so a
 * person sees "the reply was ..., the check passed because ..." before saving anything. `evaluation.tryCheck` (the app),
 * `testpion eval check` and the `eval_try_check` tool all call this. A check of fixed rules costs nothing on the offline
 * demo model; a call to a paid model, and any check an AI reviewer grades, spend money: `dryRun` shows that first.
 */
export interface TryCheckInput {
  /** The evaluation as edited (its prompt, model and cases); only the check given is applied. */
  draft: SavedEvaluation;
  check: CheckConfig;
  /** Which case, counting from 1 (default 1). */
  caseNumber?: number;
  /** Say what would be sent and what it costs; send nothing. */
  dryRun?: boolean;
}

export interface TryCheckResult {
  caseNumber: number;
  cases: number;
  /** The case: its columns and values. */
  input: Record<string, unknown>;
  dryRun: boolean;
  /** What trying costs: calls and dollars (the same numbers as the estimate beside Run, for this one case). */
  estimate: Pick<EvalEstimate, 'calls' | 'costUsd' | 'priced' | 'free' | 'offline' | 'reviewerChecks' | 'summary'>;
  /** Not on a dry run. */
  reply?: string;
  passed?: boolean;
  score?: number;
  /** The check's own words for why it passed or failed (an AI reviewer's reason). */
  reason?: string;
  costUsd?: number;
  model?: string;
  error?: string;
}

export async function tryEvalCheck(i: TryCheckInput, o: { services: ExecServices; store?: WorkspaceStore; signal?: AbortSignal }): Promise<TryCheckResult> {
  const rows = datasetRecords(i.draft.dataset ?? '', i.draft.datasetFormat ?? 'jsonl');
  if (!rows.length) throw new ApsError('ValidationError', 'There are no test cases to try the check on. Add a case first.', { suggestions: [] });
  const n = Math.floor(i.caseNumber ?? 1);
  if (!(n >= 1 && n <= rows.length)) throw new ApsError('ValidationError', `There is no case ${i.caseNumber}: this evaluation has ${rows.length} case${rows.length === 1 ? '' : 's'}.`, { suggestions: [] });
  const row = rows[n - 1]!;
  const one: SavedEvaluation = { ...i.draft, dataset: JSON.stringify(row), datasetFormat: 'jsonl', evaluators: [i.check], limit: undefined };
  const est = estimateEvaluation(o.services, one);
  const estimate = { calls: est.calls, costUsd: est.costUsd, priced: est.priced, free: est.free, offline: est.offline, reviewerChecks: isReviewerCheck(i.check.type) ? 1 : 0, summary: est.summary };
  const base = { caseNumber: n, cases: rows.length, input: row, estimate };
  if (i.dryRun) return { ...base, dryRun: true };
  let got: TestResult | undefined;
  await runTests({
    name: 'Try a check',
    tests: evaluationTests(one, { store: o.store }),
    concurrency: 1,
    retries: 0,
    services: o.services,
    traceMode: 'none',
    signal: o.signal,
    onEvent: (e) => {
      if (e.type === 'test-end') got = e.result;
    },
  });
  if (!got) throw new ApsError('ConfigurationError', 'The case did not run.', { suggestions: [] });
  const c: CheckResult | undefined = got.checks[0];
  return {
    ...base,
    dryRun: false,
    reply: got.output ?? '',
    ...(c ? { passed: c.passed, ...(c.score !== undefined ? { score: c.score } : {}), reason: c.message } : {}),
    ...(got.error ? { error: got.error.message } : {}),
    ...(got.costUsd !== undefined ? { costUsd: got.costUsd } : {}),
    model: got.model,
  };
}
