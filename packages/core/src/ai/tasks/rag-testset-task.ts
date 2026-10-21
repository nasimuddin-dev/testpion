/**
 * The AI task `rag-generate-testset` (planning/rag-testing.md §4b): questions with reference answers and the chunks they
 * come from, proposed from the chunks of the user's documents, verified before anyone sees them. This file only defines the
 * task; the work is in eval/rag/testset/. It is a function (called by the registry) and imports functions only, so an import
 * cycle through the judge service and the task runner cannot reach a constant that is not yet defined.
 */
import type { AiTaskDef } from './registry.js';
import { describeTestset, prepareTestset, proposeTestset } from '../../eval/rag/testset/task.js';
import { TESTSET_INSTRUCTION, TESTSET_SCHEMA, TESTSET_VERSION } from '../../eval/rag/testset/prompts.js';

export function ragTestsetTask(): AiTaskDef {
  return {
    id: 'rag-generate-testset',
    version: TESTSET_VERSION,
    title: 'Generate a RAG test set',
    description:
      'From the chunks of your documents (a folder, files or https pages), questions with reference answers and the chunk ids they come from: single-hop, multi-hop, abstract, unanswerable and adversarial. Every sample is verified (the reference is supported by its chunks, an unanswerable question is not answerable from the corpus, no duplicates) and offered as a proposal; accepted rows are added to datasets/<name>.jsonl.',
    tier: 'large',
    instruction: TESTSET_INSTRUCTION,
    output: { kind: 'json', schema: { ...TESTSET_SCHEMA } },
    context: 'paths (workspace files or folders), urls (https pages), count (1 to 60), types, seed, name (datasets/<name>.jsonl), personas, styles, dedupe (lexical or embedding), embedder, batch',
    contextTokens: 16_000,
    sectionBudgets: { passages: 14_000 },
    maxTokens: 3500,
    temperature: 0.3,
    maxRepairs: 2,
    verifiers: ['testset-support', 'testset-answerable', 'testset-duplicate'],
    prepareContext: prepareTestset,
    propose: proposeTestset,
    describe: describeTestset,
  };
}
