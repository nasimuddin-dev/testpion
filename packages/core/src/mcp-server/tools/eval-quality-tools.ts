/**
 * MCP tools for checking an AI answer the easy way (the same engine functions as `testpion eval sample|estimate|check`):
 * `eval_sample` makes the sample evaluation and runs it on the offline demo model (no key, no network), `eval_estimate` says
 * what a saved evaluation would cost before it runs, `eval_try_check` tries one check on one case.
 */
import { ApsError } from '../../errors.js';
import { aiRunDeps } from '../../ai/tasks/run.js';
import { CASE_SOURCES, type CaseSource } from '../../ai/eval-cases.js';
import { generateEvalCases, type GenerateCasesOptions } from '../../runner/eval-cases-generate.js';
import { trustReviewer } from '../../runner/trust-reviewer.js';
import { findCollection } from '../../storage/env-edit.js';
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
        `Make the sample evaluation "${SAMPLE_NAME}" (10 support messages to sort into cancellation, refill, booking or other, checked with "the reply contains the expected answer") on the offline demo model, and run it. The demo model answers by rules, so the result says nothing about a real model (every answer says so). Returns the evaluation, the run (totals, per-case results) and a headline. An edited sample is put back as written: copy it to make your own. \`run: false\` only makes it.`,
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
        'What a saved prompt evaluation would cost before it runs: cases, calls (one per case, plus one per case for each check an AI reviewer grades), tokens, dollars from the price table (undefined when the model has no price), seconds, and `plan`: the spend cap that would stop the run ($1.00 for a paid model, none for the offline demo or a local model) and whether run_evaluation would ask first (over $0.50 or 100 calls). Nothing is sent.',
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
        'Try one check on one case of a saved evaluation: the case is sent to the evaluation’s model as in a run and the check is applied to the reply. Returns the reply, passed or failed, the check’s reason (an AI reviewer’s when it grades), the cost and the model. `dry_run` says what would be sent and what it costs, and sends nothing. A local model (the offline demo) is free; a paid model, and any check an AI reviewer grades, costs money and needs `confirm`: show the user the cost (dry_run) and ask first.',
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
    {
      name: 'eval_generate_cases',
      write: true,
      doc: {
        when: 'Writing test cases for a saved prompt evaluation from its prompt, an API definition (spec), a collection or folder, documents or real calls in History, when the person has too few cases.',
        whenNot: 'A bot with sources (rag_generate_testset makes its questions from documents) or changing existing cases (edit the evaluation).',
        example: { name: 'Intent classification', from: 'prompt', count: 10, dry_run: true },
      },
      description:
        'Write test cases for a saved prompt evaluation with TestPion’s configured model. `from`: prompt (the prompt under test), spec (an API definition under specs/: questions about its operations), collection (the saved requests of a collection, optionally one folder), documents (questions with expected answers from files or https pages, the RAG test-set generator) or history (real prompts sent to a model). Every case is verified (fills every prompt variable, is not a repeat, names an operation or request the source has, looks like a real call) and returned as ONE proposal; a case that failed a check is unticked. Nothing is added here: show the person the cases and badges, then add the ticked ones with ai_apply_proposal { id } (undo: ai_undo_proposal). The prompt and a few existing cases go to the model (redacted; the AI privacy level applies). `dry_run` sends nothing and returns what would be sent and the estimate.',
      inputSchema: {
        type: 'object',
        properties: {
          name: str('Saved evaluation name or id'),
          from: { type: 'string', enum: [...CASE_SOURCES], description: 'Where the cases come from (default prompt)' },
          count: { type: 'number', description: 'How many cases (1 to 30, default 10)' },
          spec: str('from spec: the API definition, e.g. specs/shop.yaml'),
          collection: str('from collection: the collection name or id'),
          folder: str('from collection: only this folder (its id)'),
          paths: { type: 'array', items: { type: 'string' }, description: 'from documents: files or folders of the workspace' },
          urls: { type: 'array', items: { type: 'string' }, description: 'from documents: public https pages' },
          history_limit: { type: 'number', description: 'from history: how many recent prompts to read (1 to 50)' },
          hint: str('What to focus on, e.g. "more about refunds"'),
          provider: str('Write them with this provider instead of the AI settings (the offline demo model is "demo")'),
          environment: str('Environment name'),
          dry_run: { type: 'boolean', description: 'Send nothing: return what would be sent and the estimate' },
        },
        required: ['name'],
      },
      run: async (a) => {
        const saved = findSavedEvaluation(store, String(a.name ?? ''));
        if (saved.type === 'rag') throw new ApsError('ValidationError', 'This is an evaluation of a bot with sources: use rag_generate_testset', { suggestions: [] });
        const source = (a.from ? String(a.from) : a.spec ? 'spec' : a.collection ? 'collection' : Array.isArray(a.paths) || Array.isArray(a.urls) ? 'documents' : 'prompt') as CaseSource;
        let collection: string | undefined;
        if (a.collection) {
          const c = findCollection(store, String(a.collection));
          if (!c) throw new ApsError('ValidationError', `No collection "${String(a.collection)}"`, { suggestions: [] });
          collection = c.id;
        }
        const opts: GenerateCasesOptions = {
          source,
          draft: saved,
          evaluation: saved.id,
          count: typeof a.count === 'number' ? a.count : undefined,
          spec: a.spec ? String(a.spec) : undefined,
          collection,
          folder: a.folder ? String(a.folder) : undefined,
          paths: Array.isArray(a.paths) ? a.paths.map(String) : undefined,
          urls: Array.isArray(a.urls) ? a.urls.map(String) : undefined,
          historyLimit: typeof a.history_limit === 'number' ? a.history_limit : undefined,
          hint: a.hint ? String(a.hint) : undefined,
          provider: a.provider ? String(a.provider) : undefined,
          dryRun: a.dry_run === true,
        };
        return withEngine({ store, secrets, settings }, { environment: checkEnvironment(a.environment), aiSurface: 'mcp' }, async (ctx) => {
          const r = await generateEvalCases(aiRunDeps({ ctx, settings, store, surface: 'mcp' }), store, opts);
          if (r.dryRun) return { dryRun: true, source, ...(r.preview ? { preview: r.preview } : {}), ...(r.estimate ? { estimate: r.estimate } : {}) };
          const p = r.proposal!;
          return {
            proposal: {
              id: p.id,
              title: p.title,
              summary: p.summary,
              notes: p.notes,
              items: p.items.map((i) => ({ id: i.id, case: (i.data as { record: Record<string, string> }).record, why: (i.data as { why?: string }).why, selected: i.selected, verification: i.verification.map((b) => ({ verifier: b.verifier, status: b.status, label: b.label })) })),
            },
            tally: r.tally,
            model: `${p.provider}/${p.model}`,
            usage: r.usage,
            costUsd: r.costUsd,
            next: `Show the person the cases and their badges; add the ticked ones to ${saved.name} with ai_apply_proposal { id: "${p.id}" } after they agree.`,
          };
        });
      },
    },
    {
      name: 'eval_trust_reviewer',
      write: true,
      doc: {
        when: 'Finding out whether an AI reviewer (a check graded by a second model) can be trusted: the person grades ten answers of a finished run and sees how often the reviewer agreed.',
        whenNot: 'Labelling a bot with sources’ samples one by one (rag_label, rag_calibrate).',
        example: { run: 'last' },
      },
      description:
        'Trust the AI reviewer. Without `grade`: returns up to 10 answers of a finished run to grade (input, answer, the reviewer’s rule; its own verdict is hidden), which ones the person graded already, and, once all are graded, how often the AI reviewer agreed (a sentence, the counts, Cohen’s kappa). With `grade: { result, verdict }`: records the person’s verdict (pass or fail; null clears it) on one answer first, then returns the same. Only record a verdict the PERSON gave: never grade for them, or the agreement says nothing.',
      inputSchema: {
        type: 'object',
        properties: {
          run: str('Run id, or "last" for the newest finished run'),
          check: str('The AI reviewer check to compare (default: the first one of the run)'),
          count: { type: 'number', description: 'How many answers to grade (3 to 50, default 10)' },
          grade: { type: 'object', description: '{ result: the result id, verdict: "pass" | "fail" | null }' },
        },
        required: ['run'],
      },
      run: async (a) => {
        const g = a.grade as { result?: unknown; verdict?: unknown } | undefined;
        if (g && (typeof g.result !== 'string' || !(g.verdict === 'pass' || g.verdict === 'fail' || g.verdict === null))) throw new ApsError('ValidationError', 'grade is { "result": "<result id>", "verdict": "pass" | "fail" | null }', { suggestions: [] });
        return trustReviewer(store, { run: String(a.run), metric: a.check ? String(a.check) : undefined, count: typeof a.count === 'number' ? a.count : undefined, ...(g ? { label: { result: g.result as string, verdict: g.verdict as 'pass' | 'fail' | null } } : {}) });
      },
    },
  ];
}
