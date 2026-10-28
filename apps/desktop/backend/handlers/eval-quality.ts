/** RPC handlers: checking an AI answer the easy way: the sample, what a run costs before it starts and the spend cap, one check tried on one case. */
import {
  ApsError,
  capRunOptions,
  ensureSample,
  estimateEvaluation,
  evaluationTests,
  assertEvaluationRunnable,
  runTests,
  spendPlan,
  tryEvalCheck,
  type CheckConfig,
  type SavedEvaluation,
} from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';

/** The estimate of a prompt evaluation and what may be spent on it: the numbers beside Run, the same as `testpion eval estimate`. */
export async function estimateDraft(be: Backend, draft: SavedEvaluation, o: { environment?: string; limit?: number; maxCostUsd?: number } = {}) {
  const ctx = be.context({ environment: o.environment });
  try {
    const est = estimateEvaluation(ctx.services, { ...draft, limit: o.limit ?? draft.limit });
    return { ...est, plan: spendPlan(est, o.maxCostUsd ?? draft.maxCostUsd) };
  } finally {
    await ctx.dispose();
  }
}

/**
 * Run an evaluation as edited in the app (saved or not): the same conversion as `testpion eval run`. A RAG evaluation's target and
 * judge are checked first. A prompt evaluation that is estimated over $0.50 (or 100 calls) is refused until the person confirmed
 * (`confirm`), and a paid model stops at its spend cap (default $1.00) with the reason sent as `eval.capped`.
 */
export async function startDraftRun(be: Backend, draft: SavedEvaluation, o: { environment?: string; confirm?: boolean }) {
  if (draft.type === 'rag') {
    const ctx = be.context({ environment: o.environment });
    try {
      assertEvaluationRunnable(be.ws, ctx.services.ragJudge!, draft);
    } finally {
      await ctx.dispose();
    }
    return be.startRun(draft.name || 'Evaluation', evaluationTests(draft, { store: be.ws }), { environment: o.environment, concurrency: draft.concurrency, retries: draft.retries, traceMode: 'all' });
  }
  const est = await estimateDraft(be, draft, { environment: o.environment });
  if (est.plan.ask && !o.confirm) throw new ApsError('ValidationError', `${est.summary}. ${est.plan.reason ?? ''} Confirm to run it.`.replace(/\s+/g, ' '), { suggestions: [] });
  const cases = est.cases;
  return be.startRun(draft.name || 'Evaluation', evaluationTests(draft, { store: be.ws }), { environment: o.environment, concurrency: draft.concurrency, retries: draft.retries, traceMode: 'all' }, async (opts) => {
    const capped = capRunOptions(opts, est.plan.capUsd);
    const summary = await runTests(capped.options);
    if (capped.guard.stopped) {
      // stopped at the cap: not a cancelled run; the app says how far it got
      summary.cancelled = false;
      be.host.emit('eval.capped', { runId: opts.runId, name: draft.name, spentUsd: capped.guard.spentUsd, capUsd: capped.guard.capUsd, done: summary.total, total: cases, message: capped.guard.message(cases) });
    }
    return summary;
  });
}

export function evalQualityHandlers(be: Backend): Handlers {
  return {
    /**
     * The sample (AU-4): the offline demo model and the evaluation "Sample: support intents" are made (or put back as written) and
     * the evaluation starts at once. Answers `{ runId, evaluation, name, offline: true }`; nothing leaves the computer.
     */
    'ai.sample': async ({ run }: { run?: boolean } = {}) => {
      const made = ensureSample(be.ws);
      be.host.emit('data.changed', { method: 'sample' });
      if (run === false) return { evaluation: made.evaluation.id, name: made.evaluation.name, offline: true, created: made.created };
      const r = await startDraftRun(be, made.evaluation, {});
      return { ...r, evaluation: made.evaluation.id, name: made.evaluation.name, offline: true, created: made.created };
    },
    /** What an evaluation as edited would cost (AU-5): cases, calls, tokens, dollars, seconds, and the spend cap with whether a run asks first (AU-18). */
    'eval.estimate': ({ draft, environment, limit }: { draft: SavedEvaluation; environment?: string; limit?: number }) => estimateDraft(be, draft, { environment, limit }),
    /** Try one check on one case (AU-11): the reply, passed or failed and why, the cost. `dryRun` says what it would cost and sends nothing. */
    'eval.tryCheck': async ({ draft, check, caseNumber, dryRun, environment }: { draft: SavedEvaluation; check: CheckConfig; caseNumber?: number; dryRun?: boolean; environment?: string }) => {
      const ctx = be.context({ environment });
      try {
        return await tryEvalCheck({ draft, check, caseNumber, dryRun }, { services: ctx.services, store: be.ws });
      } finally {
        await ctx.dispose();
      }
    },
  };
}
