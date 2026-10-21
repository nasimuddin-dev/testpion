/**
 * The AI task `rag-generate-testset` (planning/rag-testing.md §4b): questions with reference answers and the chunks they
 * come from, proposed from the chunks of the user's documents, verified before anyone sees them. This file only defines the
 * task; the work is in eval/rag/testset/. It is a function (called by the registry) and imports functions only, so an import
 * cycle through the judge service and the task runner cannot reach a constant that is not yet defined.
 */
import type { AiTaskDef } from './registry.js';

export function ragTestsetTask(): AiTaskDef {
  return {
    id: 'rag-generate-testset',
    version: 1,
    title: 'Generate a RAG test set',
    description: 'Placeholder until the test-set work fills it.',
    tier: 'large',
    instruction: 'Placeholder.',
    output: { kind: 'json', schema: { type: 'object' } },
    context: 'see eval/rag/testset',
  };
}
