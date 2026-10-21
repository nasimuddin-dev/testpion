/**
 * MCP tool of reference drafting (`rag_draft_references`, the same engine as `testpion rag draft-references`): TestPion's
 * configured model writes reference answers for the records of a captured dataset that have none, from the passages each
 * record retrieved, and every draft is checked against them. It only proposes: the person reads the drafts, then
 * `ai_apply_proposal` replaces the records in the dataset.
 */
import { createEngineContext } from '../../engine.js';
import { aiRunDeps, runAiTask } from '../../ai/tasks/run.js';
import type { AppSettings } from '../../model/types.js';
import type { SecretStore } from '../../storage/secrets.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import { str, type Tool } from '../tool.js';

export function ragReferencesTools({ store, secrets, settings }: { store: WorkspaceStore; secrets: SecretStore; settings: AppSettings; checkEnvironment(name: unknown): string | undefined }): Tool[] {
  return [
    {
      name: 'rag_draft_references',
      write: true,
      doc: {
        when: 'A dataset made from real calls (rag_capture_dataset) has questions, answers and retrieved passages but no reference answers, and the person wants drafts to review.',
        whenNot: 'Making questions from documents (rag_generate_testset), or writing a reference yourself: a reference is what the person accepts, not what the system said.',
        example: { dataset: 'captured-2026-10-20.jsonl', limit: 8, dry_run: true },
      },
      description:
        'Have TestPion\'s configured model draft reference answers for the records of a dataset (datasets/<name>.jsonl) that have none. Each draft is written from the passages the record retrieved (`contexts`), NOT from the system\'s own answer, so a wrong answer is not copied; a record whose passages do not hold the answer is marked unanswerable. Every draft is checked against its passages (the share of its words in them, and a judge\'s claim-by-claim check when a judge is available) and returned as ONE proposal; accepting an item replaces the record of the same id and keeps the rest of it. Up to 12 records per call (`limit`, `ids`); run it again for the next ones. The questions and passages are sent to the model (redacted; the AI privacy level must be Full). `dry_run` returns what would be sent with the token and cost estimate and calls no model. Show the person the drafts and badges; once they agree add the ticked ones with ai_apply_proposal { id } (undo with ai_undo_proposal).',
      inputSchema: {
        type: 'object',
        properties: {
          dataset: str('The dataset: datasets/<name>.jsonl (rag_list_datasets / list_datasets)'),
          ids: { type: 'array', items: { type: 'string' }, description: 'Only these record ids' },
          limit: { type: 'number', description: 'How many records (1 to 12, default 8)' },
          judge: str('The judge that checks each draft against its passages, as provider/model (default: the AI settings\' large model)'),
          environment: str('Environment name'),
          dry_run: { type: 'boolean', description: 'Send nothing: return what would be sent to the model, with the estimate' },
        },
        required: ['dataset'],
      },
      run: async (a) => {
        const ctx = createEngineContext({ store, secrets, settings, environment: a.environment ? String(a.environment) : undefined, aiSurface: 'mcp' });
        try {
          const r = await runAiTask(aiRunDeps({ ctx, settings, store, surface: 'mcp' }), {
            task: 'rag-draft-references',
            context: { dataset: a.dataset, ids: a.ids, limit: a.limit, judge: a.judge },
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
                  proposal: {
                    id: p.id,
                    title: p.title,
                    summary: p.summary,
                    assumptions: p.assumptions,
                    notes: p.notes,
                    items: p.items.map((i) => {
                      const rec = (i.data as { record: { id?: string; question: string; reference: string; reference_ids: string[]; answerable: boolean } }).record;
                      return { id: i.id, record: rec.id, question: rec.question, reference: rec.reference, reference_ids: rec.reference_ids, answerable: rec.answerable, selected: i.selected, verification: i.verification.map((b) => ({ verifier: b.verifier, status: b.status, label: b.label })) };
                    }),
                  },
                  next: `Show the person the drafts and their badges; replace the records with ai_apply_proposal { id: "${p.id}" } after they agree.`,
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
