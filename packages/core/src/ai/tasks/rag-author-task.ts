/**
 * The AI task `rag-author-evaluation` (ai-features.md AI-11, rag-testing.md): given a RAG target (and optionally documents, a
 * dataset, an API definition) it proposes a complete evaluation, dry-run on a few samples before it is offered. This file only
 * defines the task; the work is in eval/rag/author/. A function (called by the registry) that imports functions only, so an
 * import cycle through the judge service and the task runner cannot reach a constant that is not yet defined.
 */
import type { AiTaskDef } from './registry.js';

export function ragAuthorTask(): AiTaskDef {
  return {
    id: 'rag-author-evaluation',
    version: 1,
    title: 'Draft a RAG evaluation',
    description: 'Placeholder until the authoring work fills it.',
    tier: 'large',
    instruction: 'Placeholder.',
    output: { kind: 'json', schema: { type: 'object' } },
    context: 'see eval/rag/author',
  };
}
