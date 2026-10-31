/** RPC handlers: the report card of a run, why a case failed, a case against the run before, and compare mode (variants of an evaluation). */
import { ApsError, evalCaseDiff, evalReport, evalReviewQueue, evalTrajectory, evalWhy, diffPromptVersions, listPromptVersions, reviewToDataset, savePromptVersion, setEvaluationBaseline, usePromptVersion, evaluationVariants, variantsSummary, type SavedEvaluation } from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';
import { estimateDraft, startDraftRun } from './eval-quality.js';

export function evalReportHandlers(be: Backend): Handlers {
  return {
    /** The report card of a run (what `testpion eval summary` prints): headline, by check, failures, pass line, against the last run, trend. */
    'eval.summary': ({ run, against }: { run: string; against?: string }) => evalReport(be.ws, { run, against }),
    /** One case against the same case in the run before it: both answers and the difference (what `testpion eval diff` prints). */
    'eval.caseDiff': ({ run, case: kase, against }: { run: string; case: string; against?: string }) => evalCaseDiff(be.ws, { run, case: kase, against }),
    /** What an agent did in one case, step by step, with its tool checks pinned to the step that decided them (what `testpion eval trajectory` prints). */
    'eval.trajectory': ({ run, case: kase, against }: { run: string; case: string; against?: string }) => evalTrajectory(be.ws, { run, case: kase, against }),
    /** The review queue of a run: answers to grade good or bad, the checks' verdict withheld until graded (grades go through `runs.review`). */
    'eval.reviewQueue': ({ run, count }: { run: string; count?: number }) => evalReviewQueue(be.ws, { run, count }),
    /** Add the answers graded good to the evaluation's test cases as their expected answers. */
    'eval.reviewToDataset': async ({ run, resultIds }: { run: string; resultIds?: string[] }) => {
      const r = await reviewToDataset(be.ws, { run, resultIds });
      be.host.emit('data.changed', { method: 'eval.reviewToDataset', kinds: ['evaluations'], paths: ['library/evaluations.json'] });
      return r;
    },
    /** The prompt versions of a saved evaluation, each with the result of its latest run (what `testpion eval versions` prints). */
    'eval.versions': ({ evaluation }: { evaluation: string }) => listPromptVersions(be.ws, evaluation),
    /** What changed between a version and another (or the prompt in use), word by word (what `testpion eval version-diff` prints). */
    'eval.versionDiff': ({ evaluation, version, other }: { evaluation: string; version: string; other?: string }) => diffPromptVersions(be.ws, { evaluation, version, other }),
    /** Save the evaluation's prompt and system prompt now as a named version; with `prompt` (and `system`), a draft kept beside the others without changing the evaluation. */
    'eval.saveVersion': ({ evaluation, name, note, prompt, system }: { evaluation: string; name: string; note?: string; prompt?: string; system?: string }) => {
      const v = savePromptVersion(be.ws, { evaluation, name, note, prompt, system });
      be.host.emit('data.changed', { method: 'eval.saveVersion', kinds: ['evaluations'], paths: ['library/evaluations.json'] });
      return v;
    },
    /** Make a version the evaluation's prompt. One under the pass line, worse than the prompt in use, or never run asks first (`confirm`) and says the numbers. */
    'eval.useVersion': async ({ evaluation, version, confirm }: { evaluation: string; version: string; confirm?: boolean }) => {
      const r = await usePromptVersion(be.ws, { evaluation, version, confirm });
      be.host.emit('data.changed', { method: 'eval.useVersion', kinds: ['evaluations'], paths: ['library/evaluations.json'] });
      return r;
    },
    /** Mark a run as the baseline of its agent evaluation (the golden trajectory), or clear it: later runs say how their tools differ. */
    'eval.setBaseline': ({ run, clear, evaluation }: { run?: string; clear?: boolean; evaluation?: string }) => {
      const r = setEvaluationBaseline(be.ws, { run, clear, evaluation });
      be.host.emit('data.changed', { method: 'eval.setBaseline', kinds: ['evaluations'], paths: ['library/evaluations.json'] });
      return r;
    },
    /** Why one case failed: the AI reviewer's stored reason, and the context the `eval-why` task is given. */
    'eval.why': ({ run, case: kase }: { run: string; case: string }) => evalWhy(be.ws, { run, case: kase }),
    /**
     * Compare mode: the evaluation and each of its variants run on the same cases, a run each ("<name> · <variant>"). Asks once for
     * all of them when together they are over $0.50 (or 100 calls); each stops at its own spend cap. `dryRun` starts nothing and
     * says what they would cost (the line beside Run, and whether Run asks first).
     */
    'eval.runVariants': async ({ draft, environment, confirm, dryRun }: { draft: SavedEvaluation; environment?: string; confirm?: boolean; dryRun?: boolean }) => {
      if (draft.type === 'rag') throw new ApsError('ValidationError', 'Compare mode is for prompts and models: this evaluation is of a bot with sources', { suggestions: [] });
      const list = evaluationVariants(draft);
      if (list.length < 2) throw new ApsError('ValidationError', 'Add a variant to compare: another prompt version or another model', { suggestions: [] });
      const estimates = [];
      let cost = 0;
      let calls = 0;
      let seconds = 0;
      let priced = true;
      for (const v of list) {
        const est = await estimateDraft(be, v.draft, { environment });
        estimates.push({ letter: v.letter, label: v.label, cases: est.cases, calls: est.calls, costUsd: est.costUsd, seconds: est.seconds, summary: est.summary, free: est.free });
        cost += est.costUsd ?? 0;
        calls += est.calls;
        seconds += est.seconds;
        if (!est.priced) priced = false;
      }
      const total = { variants: list.length, cases: estimates[0]!.cases, calls, costUsd: cost, priced, seconds, free: estimates.every((e) => e.free), ask: cost > 0.5 || calls > 100 };
      if (dryRun) return { evaluation: draft.name, variants: estimates, total };
      if (total.ask && !confirm) throw new ApsError('ValidationError', `The ${list.length} variants make about ${calls} calls and cost about $${cost.toFixed(2)}. Confirm to run them.`, { suggestions: [] });
      const runs: Array<{ letter: string; label: string; runId: string }> = [];
      for (const v of list) {
        const r = await startDraftRun(be, v.draft, { environment, confirm: true });
        runs.push({ letter: v.letter, label: v.label, runId: (r as { runId: string }).runId });
      }
      return { evaluation: draft.name, runs };
    },
    /** The comparison of the variants' runs: the table's rows, the winner of each and the sentence (what `testpion eval variants` prints). */
    'eval.variantsSummary': ({ draft, runs }: { draft: SavedEvaluation; runs?: string[] }) => variantsSummary(be.ws, { evaluation: draft, runs }),
  };
}
