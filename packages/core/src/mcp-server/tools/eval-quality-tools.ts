/**
 * MCP tools for checking an AI answer the easy way (the same engine functions as `testpion eval sample|estimate|check`):
 * `eval_sample` makes the sample evaluation and runs it on the offline demo model (no key, no network), `eval_estimate` says
 * what a saved evaluation would cost before it runs, `eval_try_check` tries one check on one case.
 */
import { ApsError } from '../../errors.js';
import { ensureSample, SAMPLE_NAME } from '../../eval/sample.js';
import { estimateEvaluation, formatEstimateUsd, spendPlan } from '../../eval/llm-estimate.js';
import { tryEvalCheck } from '../../eval/try-check.js';
import { evaluationTests, findSavedEvaluation } from '../../runner/saved-evaluations.js';
import type { CheckConfig } from '../../model/types.js';
import type { AppSettings } from '../../model/types.js';
import type { SecretStore } from '../../storage/secrets.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import { str, type Tool } from '../tool.js';
import { withEngine } from './server-kit.js';
import type { ModuleToolDeps } from './deps.js';

export function evalQualityTools(d: { store: WorkspaceStore; secrets: SecretStore; settings: AppSettings; checkEnvironment: ModuleToolDeps['checkEnvironment']; recordedRun: ModuleToolDeps['recordedRun'] }): Tool[] {
  const { store, secrets, settings, checkEnvironment, recordedRun } = d;
  return [
    {
      name: 'eval_sample',
      doc: {
        when: 'Showing a person (or yourself) how AI evaluations work in one call: no model key and no network are needed.',
        whenNot: 'Evaluating the person’s own prompt (list_evaluations, then run_evaluation).',
        example: {},
      },
      write: true,
      description:
        `Make the sample evaluation "${SAMPLE_NAME}" (10 support messages to sort into cancellation, refill, booking or other, checked with "the reply contains the expected answer") on the offline demo model, and run it. The demo model answers by rules, so the result shows how a run looks and says nothing about a real model; every answer says so. Returns the evaluation, the run (totals, per-case results) and a one-sentence headline. An edited sample is put back as written: make your own with a copy. \`run: false\` only makes it.`,
      inputSchema: { type: 'object', properties: { run: { type: 'boolean', description: 'false: make the sample, do not run it (default true)' } } },
      run: async (a) => {
        const made = ensureSample(store);
        if (a.run === false) return { evaluation: made.evaluation.name, id: made.evaluation.id, created: made.created, providerAdded: made.providerAdded, cases: 10, model: 'Offline demo model' };
        const { summary, ...run } = await recordedRun(undefined, { name: made.evaluation.name, tests: evaluationTests(made.evaluation, { store }), concurrency: 4, retries: 0 });
        return {
          ...run,
          evaluation: made.evaluation.name,
          model: 'Offline demo model (answers come from rules, not from a real model)',
          headline: `${summary.passed} of ${summary.total} passed`,
          scores: summary.scores,
        };
      },
    },
    {
      name: 'eval_estimate',
      doc: {
        when: 'Telling the person what a prompt evaluation would cost, how many calls it makes and how long it takes, before running it (run_evaluation).',
        whenNot: 'An evaluation of a bot with sources (rag_estimate).',
        example: { name: 'Intent classification' },
      },
      description:
        'What a saved prompt evaluation would cost before it runs: cases, calls (one per case, plus one per case for each check an AI reviewer grades), tokens, dollars from the price table (undefined when the model has no price), seconds, and `plan`: the spend cap that would stop the run ($1.00 for a paid model, none for the offline demo model or a model on this computer) and whether run_evaluation would ask first (estimate over $0.50 or 100 calls). Nothing is sent.',
      inputSchema: {
        type: 'object',
        properties: { name: str('Saved evaluation name or id'), environment: str('Environment name'), limit: { type: 'number', description: 'Only the first n cases' }, max_cost_usd: { type: 'number', description: 'The cap to plan with (0 = none)' } },
        required: ['name'],
      },
      run: async (a) => {
        const saved = findSavedEvaluation(store, String(a.name ?? ''));
        if (saved.type === 'rag') throw new ApsError('ValidationError', 'This is an evaluation of a bot with sources: use rag_estimate', { suggestions: [] });
        const environment = checkEnvironment(a.environment);
        return withEngine({ store, secrets, settings }, { environment, aiSurface: 'mcp' }, (ctx) => {
          const est = estimateEvaluation(ctx.services, { ...saved, limit: typeof a.limit === 'number' ? a.limit : saved.limit });
          const plan = spendPlan(est, typeof a.max_cost_usd === 'number' ? a.max_cost_usd : saved.maxCostUsd);
          return { ...est, plan, ...(plan.capUsd !== undefined ? { capText: `stops at ${formatEstimateUsd(plan.capUsd)}` } : {}) };
        });
      },
    },
    {
      name: 'eval_try_check',
      doc: {
        when: 'Checking that a check does what the person means on one case, before saving it (what the reply was, passed or failed, and why).',
        whenNot: 'Running every case (run_evaluation).',
        example: { name: 'Intent classification', check: { type: 'contains', expected: '{{expected}}' }, case: 1, dry_run: true },
      },
      write: true,
      description:
        'Try one check on one case of a saved evaluation: the case is sent to the evaluation’s model as in a run and the check is applied to the reply. Returns the reply, passed or failed, the check’s reason (an AI reviewer’s reason when it grades), the cost and the model. `dry_run` says what would be sent and what it costs and sends nothing. A model that runs on this computer (the offline demo model) is free; a call to a paid model, and any check an AI reviewer grades, costs money, so they need `confirm: true`: show the user the cost (dry_run) and ask first.',
      inputSchema: {
        type: 'object',
        properties: {
          name: str('Saved evaluation name or id'),
          check: { type: 'object', description: 'The check: { type, expected?, path?, criteria?, threshold? } (the check types of the evaluation’s Checks tab)' },
          case: { type: 'number', description: 'Which case, counting from 1 (default 1)' },
          environment: str('Environment name'),
          dry_run: { type: 'boolean', description: 'Say what would be sent and what it costs; send nothing' },
          confirm: { type: 'boolean', description: 'Go ahead although this sends the case to a paid model' },
        },
        required: ['name', 'check'],
      },
      run: async (a) => {
        const saved = findSavedEvaluation(store, String(a.name ?? ''));
        if (saved.type === 'rag') throw new ApsError('ValidationError', 'This is an evaluation of a bot with sources: use rag_try_metric', { suggestions: [] });
        const check = a.check as CheckConfig | undefined;
        if (!check || typeof check !== 'object' || typeof check.type !== 'string') throw new ApsError('ValidationError', 'Give `check` as { "type": "contains", "expected": "…" }', { suggestions: [] });
        const environment = checkEnvironment(a.environment);
        return withEngine({ store, secrets, settings }, { environment, aiSurface: 'mcp' }, async (ctx) => {
          const input = { draft: saved, check, caseNumber: typeof a.case === 'number' ? a.case : 1 };
          const plan = await tryEvalCheck({ ...input, dryRun: true }, { services: ctx.services, store });
          if (a.dry_run === true) return plan;
          if (!plan.estimate.free && a.confirm !== true) throw new ApsError('ValidationError', `This sends case ${plan.caseNumber} to ${saved.provider}/${saved.model || 'its default model'} (${plan.estimate.summary}). Ask the user, then repeat the call with confirm: true.`, { suggestions: [] });
          return tryEvalCheck(input, { services: ctx.services, store });
        });
      },
    },
  ];
}
