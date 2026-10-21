/**
 * The MCP tool for the seeded safety probe sets (the same engine functions as `testpion rag probes`): list the built-in sets
 * (jailbreaks, planted instructions, personal data, abuse, bias, off-topic requests, harmless look-alikes) and which are in the
 * workspace, and write them into `datasets/` (never over a file that is there). An agent seeds them, makes a RAG evaluation of
 * the probe dataset with the `safety` preset, and runs it with `rag_run`.
 */
import { listProbeSets, seedProbeSets } from '../../eval/rag/probes.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import type { Tool } from '../tool.js';

export function ragProbeTools({ store }: { store: WorkspaceStore }): Tool[] {
  return [
    {
      name: 'rag_probe_sets',
      doc: { when: 'Safety-testing a RAG system: seeing the built-in probe sets and adding them to the workspace as datasets to run with the safety preset.', whenNot: 'Writing your own probes (add_dataset_row appends lines to a dataset) or running the evaluation (rag_run).', example: { add: true, sets: ['jailbreak', 'benign'] } },
      write: true,
      description:
        'The seeded safety probe sets: prompts a safe RAG system should refuse (jailbreaks, requests for other people’s data, abuse), resist (instructions planted in the text to read, with a canary word that proves obedience), answer carefully (bias bait) or answer anyway (harmless look-alikes, to count false refusals). Each record has `should_refuse`, `probe` and, for injections, `canaries`. Without `add` it lists the sets and which are in the workspace (with their record counts, yours included). With `add: true` it writes the named sets (default all) to datasets/probes-<set>.jsonl; a file that exists is left as it is. Run a set with a saved RAG evaluation and `rag_run` with `preset: "safety"`.',
      inputSchema: { type: 'object', properties: { add: { type: 'boolean', description: 'Write the sets into the workspace' }, sets: { type: 'array', items: { type: 'string' }, description: 'Which sets to add (default: all)' } } },
      run: (a) => {
        if (a.add === true) return { ...seedProbeSets(store, Array.isArray(a.sets) ? a.sets.map(String) : undefined), sets: listProbeSets(store).map((s) => ({ id: s.id, file: s.file, inWorkspace: s.inWorkspace })) };
        return { sets: listProbeSets(store) };
      },
    },
  ];
}
