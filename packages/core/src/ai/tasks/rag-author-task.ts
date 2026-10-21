/**
 * The AI task `rag-author-evaluation` (ai-features.md AI-11, rag-testing.md): given a RAG target (and optionally a dataset,
 * documents, an API definition and a goal) it proposes a complete evaluation, dry-run on a few samples before it is offered.
 * This file only defines the task; the work is in eval/rag/author/ and runner/rag-author-context.ts. A function (called by
 * the registry) that imports functions and leaf modules only, so an import cycle through the judge service and the task
 * runner cannot reach a constant that is not yet defined.
 */
import type { AiTaskDef } from './registry.js';
import { describeEvaluation, proposeEvaluation } from '../../eval/rag/author/propose.js';
import { AUTHOR_INSTRUCTION, AUTHOR_PLAN_SCHEMA } from '../../eval/rag/author/types.js';
import { prepareAuthorContext } from '../../runner/rag-author-context.js';
// registers the verifier `rag-eval-dry-run`
import '../../eval/rag/author/verify.js';

export function ragAuthorTask(): AiTaskDef {
  return {
    id: 'rag-author-evaluation',
    version: 1,
    title: 'Draft a RAG evaluation',
    description:
      'For a RAG target (and optionally a dataset, documents, an API definition and a goal), a complete evaluation: the dataset slice, the metrics from the catalogue with pass marks and why, the judge options and the gates. TestPion builds the evaluation from the plan, drops what cannot run on the data, and dry-runs it on a few samples (free metrics for real, judged metrics as counted prompts that are not sent) before offering it as a proposal.',
    tier: 'large',
    instruction: AUTHOR_INSTRUCTION,
    output: { kind: 'json', schema: { ...AUTHOR_PLAN_SCHEMA } },
    context: 'target (a RAG target name), dataset (a file under datasets/), docs (workspace files or folders), spec (a file under specs/), goal (what to find out), judge (provider/model), name',
    contextTokens: 14_000,
    maxTokens: 2500,
    temperature: 0.2,
    maxRepairs: 2,
    verifiers: ['rag-eval-dry-run'],
    prepareContext: (store, context) => prepareAuthorContext(store, context),
    propose: proposeEvaluation,
    describe: describeEvaluation,
  };
}
