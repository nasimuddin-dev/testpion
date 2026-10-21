/**
 * MCP tool of test-set generation (`rag_generate_testset`, the same engine function as `testpion rag generate-dataset`):
 * TestPion's configured model writes questions with reference answers from the person's documents, every sample is verified,
 * and the result is ONE proposal. It only proposes: the rows are added to a dataset by `ai_apply_proposal`, after the person
 * has seen them. Paths are workspace-relative; URLs are public https pages only.
 */
import { createEngineContext } from '../engine.js';
import { aiRunDeps } from '../ai/tasks/run.js';
import { estimateGeneration, generateTestset, type GenerateOptions } from '../eval/rag/testset/index.js';
import { TESTSET_TYPES } from '../eval/rag/testset/types.js';
import type { AppSettings } from '../model/types.js';
import type { SecretStore } from '../storage/secrets.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { str, type Tool } from './tool.js';

const strList = (description: string) => ({ type: 'array', items: { type: 'string' }, description });

export function ragTestsetTools({ store, secrets, settings }: { store: WorkspaceStore; secrets: SecretStore; settings: AppSettings; checkEnvironment(name: unknown): string | undefined }): Tool[] {
  return [
    {
      name: 'rag_generate_testset',
      write: true,
      doc: {
        when: 'Making test questions for a RAG system from its documents: single-hop, multi-hop, abstract, unanswerable and adversarial questions with reference answers and the chunk ids they come from.',
        whenNot: 'Turning real calls into a dataset (rag_capture_dataset) or converting another tool’s dataset (rag_import_dataset).',
        example: { paths: ['docs/handbook.md'], count: 10, types: ['single-hop', 'unanswerable'], name: 'handbook', dry_run: true },
      },
      description:
        'Generate a RAG test set from documents (markdown, text, HTML files or folders of the workspace, public https pages). The documents are chunked deterministically; TestPion’s configured model writes questions with reference answers and `reference_ids` (the chunk ids); every sample is verified (the reference must be supported by its chunks: lexical overlap and a judge’s entailment check; an unanswerable question must not be answerable from the corpus by a keyword retrieval; no duplicates) and returned as ONE proposal whose items are dataset rows with their badges. Passages of the documents are sent to the model (redacted; the AI privacy level must be Full). `dry_run` reads the documents and returns the estimate (model and judge calls, tokens, cost range, the caps it would break) and sends nothing. Show the person the rows and badges; once they agree add the ticked ones with ai_apply_proposal { id } (undo with ai_undo_proposal).',
      inputSchema: {
        type: 'object',
        properties: {
          paths: strList('Files or folders of the workspace (docs/handbook.md, docs/)'),
          urls: strList('Public https pages (at most 20; no redirects to other hosts; 2 MB each)'),
          count: { type: 'number', description: 'How many questions (1 to 60, default 10)' },
          types: { type: 'array', items: { type: 'string', enum: [...TESTSET_TYPES] }, description: 'Question types (default: all five)' },
          name: str('The dataset: datasets/<name>.jsonl (default: from the first document)'),
          seed: str('Which passages are asked about (the same seed and documents ask about the same ones)'),
          judge: str('The judge that checks references against their chunks, as provider/model (default: the AI settings’ large model)'),
          no_judge_check: { type: 'boolean', description: 'Skip the judge’s check (lexical, corpus and duplicate checks still run)' },
          environment: str('Environment name'),
          dry_run: { type: 'boolean', description: 'Send nothing: return the estimate' },
        },
      },
      run: async (a) => {
        const opts: GenerateOptions = {
          paths: Array.isArray(a.paths) ? a.paths.map(String) : undefined,
          urls: Array.isArray(a.urls) ? a.urls.map(String) : undefined,
          count: Number(a.count ?? 10),
          types: Array.isArray(a.types) ? (a.types.map(String) as never) : undefined,
          name: a.name ? String(a.name) : undefined,
          seed: a.seed ? String(a.seed) : undefined,
          judge: a.judge ? String(a.judge) : undefined,
          noJudge: a.no_judge_check === true,
        };
        const ctx = createEngineContext({ store, secrets, settings, environment: a.environment ? String(a.environment) : undefined, aiSurface: 'mcp' });
        try {
          if (a.dry_run === true) return { dryRun: true, estimate: await estimateGeneration(store, ctx.services.ragJudge!, opts) };
          const r = await generateTestset(aiRunDeps({ ctx, settings, store, surface: 'mcp' }), store, opts);
          const p = r.proposal;
          return {
            proposal: {
              id: p.id,
              title: p.title,
              summary: p.summary,
              notes: p.notes,
              items: p.items.map((i) => {
                const rec = (i.data as { record: { question: string; reference: string; reference_ids: string[]; answerable: boolean } }).record;
                return { id: i.id, type: (i.data as { type: string }).type, question: rec.question, reference: rec.reference, reference_ids: rec.reference_ids, answerable: rec.answerable, selected: i.selected, verification: i.verification.map((b) => ({ verifier: b.verifier, status: b.status, label: b.label })) };
              }),
            },
            tally: r.tally,
            corpus: r.corpus,
            model: `${p.provider}/${p.model}`,
            usage: r.usage,
            costUsd: r.costUsd,
            next: `Show the person the questions and their badges; add the ticked ones to ${(p.items[0]!.data as { dataset: string }).dataset} with ai_apply_proposal { id: "${p.id}" } after they agree.`,
          };
        } finally {
          await ctx.dispose();
        }
      },
    },
  ];
}
