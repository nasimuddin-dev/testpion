/**
 * The AI task `rag-draft-references` (planning/rag-testing.md §4b, B-33b): reference answers for the records of a captured
 * dataset that have none, drafted from the passages each record retrieved and checked against them before anyone sees them.
 * This file only defines the task; the work is in eval/rag/capture/references.ts. A function (called by the registry) that
 * imports functions and leaf modules only, so an import cycle through the judge service and the task runner cannot reach a
 * constant that is not yet defined.
 */
import type { AiTaskDef } from './registry.js';
import { describeReferences, prepareReferences, proposeReferences } from '../../eval/rag/capture/references.js';
import { REFERENCES_INSTRUCTION, REFERENCES_SCHEMA, REFERENCES_VERSION } from '../../eval/rag/capture/references-prompts.js';

export function ragReferencesTask(): AiTaskDef {
  return {
    id: 'rag-draft-references',
    version: REFERENCES_VERSION,
    title: 'Draft reference answers',
    description:
      'For the records of a captured dataset that have no reference answer, a reference written from the passages each record retrieved (the system’s own answer is not sent, so a wrong one is not copied). A record whose passages do not hold the answer is marked unanswerable. Every draft is checked against its passages (words and a judge) and offered for review; accepted drafts replace the record of the same id in datasets/<name>.jsonl.',
    tier: 'large',
    instruction: REFERENCES_INSTRUCTION,
    output: { kind: 'json', schema: { ...REFERENCES_SCHEMA } },
    context: 'dataset (datasets/<name>.jsonl), ids (only these records), limit (1 to 12), judge (provider/model of the support check)',
    contextTokens: 16_000,
    sectionBudgets: { records: 14_000 },
    maxTokens: 3000,
    temperature: 0.2,
    maxRepairs: 2,
    verifiers: ['testset-support'],
    prepareContext: prepareReferences,
    propose: proposeReferences,
    describe: describeReferences,
  };
}
