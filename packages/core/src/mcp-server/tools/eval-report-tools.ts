/**
 * MCP tools for reading an evaluation run (the same functions as `testpion eval summary|why|diff|variants`): `eval_summary` is
 * the report card as numbers and words, `eval_explain_failure` says why one case failed, `eval_case_diff` how a case's answer
 * changed since the run before, `eval_variants` compares an evaluation's variants (prompt versions and models).
 */
import { aiRunDeps, runAiTask } from '../../ai/tasks/run.js';
import { evalCaseDiff, evalReport } from '../../eval/report.js';
import { variantsSummary } from '../../eval/variants.js';
import { evalWhy } from '../../eval/why.js';
import { findSavedEvaluation } from '../../runner/saved-evaluations.js';
import type { AppSettings } from '../../model/types.js';
import type { SecretStore } from '../../storage/secrets.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import { str, type Tool } from '../tool.js';
import { spent } from './ai-propose.js';
import { withEngine } from './server-kit.js';

export function evalReportTools(d: { store: WorkspaceStore; secrets: SecretStore; settings: AppSettings }): Tool[] {
  const { store, secrets, settings } = d;
  return [
    {
      name: 'eval_summary',
      doc: {
        when: 'Telling the person how an evaluation run went in a line, which checks failed, which cases failed first, and how it compares with the run before it.',
        whenNot: 'The full per-case list (run_results) or runs side by side (eval_matrix).',
        example: { run: 'last' },
      },
      description:
        'The report card of an evaluation run, the same words the app shows: `headline` ("17 of 20 passed"), cost, average and slowest time, `byCheck` (cases passed per check), `failures` (failed cases with the prompt, reply, expected answer, failed checks and an AI reviewer’s reason when it graded), the pass line if the evaluation has one, `vsLast` (against the run before: passed more or fewer, cases better or worse), `trend` (pass rates of the last runs) and `text` (all as a few sentences). A run on the offline demo model says so.',
      inputSchema: {
        type: 'object',
        properties: { run: str('Run id, "last" (the newest evaluation run) or an evaluation name (its newest run)'), against: str('Compare with this run instead of the one before it') },
        required: ['run'],
      },
      run: (a) => evalReport(store, { run: String(a.run ?? ''), against: a.against ? String(a.against) : undefined }),
    },
    {
      name: 'eval_explain_failure',
      doc: {
        when: 'Telling the person why one case of an evaluation failed: what the reply was, what was expected and the likely cause in the prompt, the case or the check.',
        whenNot: 'A failed HTTP test (ai_run_task with explain-test-failure) or a sample of a bot with sources (ai_run_task with rag-explain-sample).',
        example: { run: 'last', case: 'case-7', dry_run: true },
      },
      description:
        'Why one failed case of an evaluation run failed. When an AI reviewer graded the case, its own reason is returned (`source: "AI reviewer"`) and no model is called. Otherwise TestPion’s AI task `eval-why` explains it with the user’s configured model, from the prompt, reply, expected answer and what each check said (redacted, fitted to a budget). `dry_run` shows what would be sent and the estimate, and sends nothing. Counted in the AI usage, within the user’s caps.',
      inputSchema: {
        type: 'object',
        properties: {
          run: str('Run id, "last" or an evaluation name'),
          case: str('The case: its result id, its key (the id without the evaluation’s name, e.g. case-7) or its name'),
          environment: str('Environment whose variable names the task may use'),
          privacy: { type: 'string', enum: ['full', 'metadata', 'names'], description: 'full (redacted, default), metadata (shapes and names), names' },
          dry_run: { type: 'boolean', description: 'Send nothing: return what would be sent and the estimate' },
          stored_only: { type: 'boolean', description: 'Only the AI reviewer’s stored reason: never call a model' },
        },
        required: ['run', 'case'],
      },
      run: async (a) => {
        const why = await evalWhy(store, { run: String(a.run ?? ''), case: String(a.case ?? '') });
        const base = { run: why.run, case: why.key, name: why.name, failedChecks: why.failure.failedChecks.map((c) => ({ name: c.name, message: c.message })), expected: why.failure.expected, reply: why.failure.got };
        if (why.stored) return { ...base, source: why.stored.source, answer: why.stored.reason, calledModel: false };
        if (a.stored_only === true) return { ...base, calledModel: false, note: 'No AI reviewer graded this case, so there is no stored reason. Leave out stored_only to ask the AI task.' };
        return withEngine({ store, secrets, settings }, { environment: a.environment ? String(a.environment) : undefined, aiSurface: 'mcp' }, async (ctx) => {
          const r = await runAiTask(aiRunDeps({ ctx, settings, store, surface: 'mcp' }), { task: 'eval-why', context: why.context, privacy: a.privacy ? String(a.privacy) : undefined, dryRun: a.dry_run === true });
          const { preview, proposal: _proposal, ...rest } = r;
          return {
            ...base,
            ...rest,
            ...spent(r),
            source: 'AI task eval-why',
            calledModel: !r.dryRun,
            ...(r.dryRun ? { preview } : { sent: { privacy: preview.privacy, contextTokens: preview.context.tokens, masked: preview.redactionCount, local: preview.local } }),
            answer: r.text,
          };
        });
      },
    },
    {
      name: 'eval_case_diff',
      doc: {
        when: 'Telling the person how the answer of one case changed since the last run of the same evaluation, and whether the case flipped.',
        whenNot: 'Which cases changed overall (eval_compare, or eval_matrix with filter changed).',
        example: { run: 'last', case: 'case-7' },
      },
      description:
        'One case’s answer in a run against the same case in the run before it (or in `against`): both answers, whether they are identical, whether the case got better, worse or kept its result, and the diff (changed fields of a JSON answer, or a line diff of text).',
      inputSchema: {
        type: 'object',
        properties: { run: str('Run id, "last" or an evaluation name'), case: str('The case: its result id, its key or its name'), against: str('The run to compare with (default: the run before it)') },
        required: ['run', 'case'],
      },
      run: (a) => evalCaseDiff(store, { run: String(a.run ?? ''), case: String(a.case ?? ''), against: a.against ? String(a.against) : undefined }),
    },
    {
      name: 'eval_variants',
      doc: {
        when: 'Telling the person which version of a prompt or which model is better, cheaper and faster, after run_evaluation with variants: true.',
        whenNot: 'Comparing a run with a baseline (eval_compare).',
        example: { name: 'Intent classification' },
      },
      description:
        'The comparison of a saved evaluation’s variants (its prompt versions and models, set in the app’s Compare mode): the latest finished run of each, with passed, cost and average time per variant, the winner of each row, cases worse or better against the first variant, and a one-sentence `conclusion`. It never names one variant best overall. Run the variants first with run_evaluation `variants: true`.',
      inputSchema: {
        type: 'object',
        properties: { name: str('Saved evaluation name or id'), runs: { type: 'array', items: { type: 'string' }, description: 'The runs to compare, in variant order (default: the latest run of each variant)' } },
        required: ['name'],
      },
      run: (a) => variantsSummary(store, { evaluation: findSavedEvaluation(store, String(a.name ?? '')), runs: Array.isArray(a.runs) ? a.runs.map(String) : undefined }),
    },
  ];
}
