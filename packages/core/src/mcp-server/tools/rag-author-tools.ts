/**
 * MCP tool of evaluation authoring (`rag_author_evaluation`, the same engine as `testpion rag author`): TestPion's configured
 * model drafts a complete RAG evaluation for a target, TestPion builds it from the plan and dry-runs it without sending
 * anything. It only proposes: the person agrees, then `ai_apply_proposal` saves it as a saved evaluation.
 */
import { createEngineContext } from '../../engine.js';
import { aiRunDeps } from '../../ai/tasks/run.js';
import { runAiTask } from '../../ai/tasks/run.js';
import type { AppSettings } from '../../model/types.js';
import type { SecretStore } from '../../storage/secrets.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import { str, type Tool } from '../tool.js';

export function ragAuthorTools({ store, secrets, settings }: { store: WorkspaceStore; secrets: SecretStore; settings: AppSettings; checkEnvironment(name: unknown): string | undefined }): Tool[] {
  return [
    {
      name: 'rag_author_evaluation',
      write: true,
      doc: { when: 'Setting up the evaluation of a RAG system: which metrics, which pass marks, which judge options and gates, for this target and dataset.', whenNot: 'Running an evaluation (rag_run) or listing the metrics (rag_metrics).', example: { target: 'clinic-rag', dataset: 'clinic-questions.jsonl', goal: 'answers come from the handbook and never invent a dose', dry_run: true } },
      description:
        'Have TestPion\'s configured model draft a complete RAG evaluation for a target: the dataset slice, the metrics from the catalogue with a pass mark and a reason each, the judge options (sampling, short-circuit, cost limits) and gates. TestPion builds the evaluation from the plan and drops what cannot run on the data (a metric that needs gold chunk ids when the dataset has none), then dry-runs it on a few samples: free metrics are computed for real, judged metrics build their prompts, count the model calls and estimate the cost, and NOTHING is sent to a judge. The target\'s request (URL, headers, credentials) is never sent to the model, only what its mapping reads. Returns a proposal id with the item and its badges; show them to the person and, once they agree, save it with ai_apply_proposal. `dry_run` returns what would be sent to the model, with the token and cost estimate, and calls no model.',
      inputSchema: {
        type: 'object',
        properties: {
          target: str('The RAG target (rag_list_targets)'),
          dataset: str('A dataset under datasets/ (list_datasets): its columns decide which metrics can run'),
          docs: { type: 'array', items: { type: 'string' }, description: 'Documents or folders of the workspace: their titles and headings are shown to the model, never their text' },
          spec: str('An API definition under specs/'),
          goal: str('What the person wants to find out'),
          name: str('The name of the evaluation'),
          judge: str('The judge of the judged metrics as provider/model'),
          environment: str('Environment name'),
          dry_run: { type: 'boolean', description: 'Send nothing: return what would be sent to the model, with the estimate' },
        },
        required: ['target'],
      },
      run: async (a) => {
        const ctx = createEngineContext({ store, secrets, settings, environment: a.environment ? String(a.environment) : undefined, aiSurface: 'mcp' });
        try {
          const r = await runAiTask(aiRunDeps({ ctx, settings, store, surface: 'mcp' }), {
            task: 'rag-author-evaluation',
            question: a.goal ? String(a.goal) : undefined,
            context: { target: a.target, dataset: a.dataset, docs: a.docs, spec: a.spec, goal: a.goal, name: a.name, judge: a.judge },
            dryRun: a.dry_run === true,
          });
          if (r.dryRun) return { dryRun: true, preview: r.preview };
          const p = r.proposal;
          return {
            model: `${r.provider}/${r.model}`,
            usage: r.usage,
            costUsd: r.costUsd,
            problems: r.problems,
            ...(p
              ? {
                  proposal: { id: p.id, title: p.title, summary: p.summary, assumptions: p.assumptions, notes: p.notes, items: p.items.map((i) => ({ id: i.id, kind: i.kind, title: i.title, selected: i.selected, verification: i.verification, after: i.after })) },
                  next: `Show the person the evaluation and its badges; save it with ai_apply_proposal { id: "${p.id}" } after they agree. Gates are not part of a saved evaluation: pass them as --min flags to rag_run's CLI equivalent (the summary lists them).`,
                }
              : {}),
          };
        } finally {
          await ctx.dispose();
        }
      },
    },
  ];
}
