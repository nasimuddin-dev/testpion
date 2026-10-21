/**
 * RPC handlers of evaluation authoring: what an evaluation can be authored from (targets, datasets, API definitions) and
 * what a target and a dataset can support. The drafting itself is the AI task `rag-author-evaluation`, run through the
 * ordinary `ai.run` flow of the assistant panel (What will be sent, cost, proposal review), so nothing is duplicated here.
 */
import { authorInputs, listRagTargets, listSpecs, listWorkspaceDatasets } from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';

export function ragAuthorHandlers(be: Backend): Handlers {
  return {
    /** The things an evaluation can be authored from. */
    'rag.author.context': () => ({
      targets: listRagTargets(be.ws).map((t) => ({ id: t.id, name: t.name, protocol: t.protocol, problems: t.problems })),
      datasets: listWorkspaceDatasets(be.ws)
        .filter((d) => d.format === 'jsonl' || d.format === 'json' || d.format === 'csv')
        .map((d) => ({ path: d.path, name: d.path.replace(/^datasets\//, ''), format: d.format })),
      specs: listSpecs(be.ws),
    }),
    /** How many metrics could run on this target and dataset, and what is missing for the others (no model is asked). */
    'rag.author.inputs': ({ target, dataset }: { target: string; dataset?: string }) => authorInputs(be.ws, { target, dataset }),
  };
}
