/**
 * MCP tool of the metric trend (the same engine function as `testpion rag trend`): the mean of every metric run by run for an
 * evaluation, the runs where the judge or a metric version changed (not comparable), and the metrics that moved. Reads stored runs only.
 */
import type { AppSettings } from '../../model/types.js';
import { ragTrend } from '../../runner/rag-trend.js';
import type { SecretStore } from '../../storage/secrets.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import { str, type Tool } from '../tool.js';

export function ragTrendTools({ store }: { store: WorkspaceStore; secrets: SecretStore; settings: AppSettings; checkEnvironment(name: unknown): string | undefined }): Tool[] {
  return [
    {
      name: 'rag_trend',
      doc: { when: 'Asking whether a RAG system is getting better or worse over time: metric means run by run, and which metric moved.', whenNot: 'Comparing exactly two runs sample by sample (rag_compare) or reading one run (rag_run results).', example: { evaluation: 'Clinic RAG', metrics: ['faithfulness'], runs: 10 } },
      description:
        'The trend of RAG metric means across the runs of a saved evaluation (and of its monitor): per run the mean, the 95% interval, the pass rate and the n/a count of each metric, the judge that scored it, and `judgeChanged` when the judge or a metric’s wording differs from the run before (a step there is not a regression of the system). `findings` lists the metrics whose newest mean moved more than its interval (or 0.05) against the median of the 3 runs before it. Reads stored runs; no model is called.',
      inputSchema: {
        type: 'object',
        properties: {
          evaluation: str('A saved evaluation (id or name)'),
          run_ids: { type: 'array', items: { type: 'string' }, description: 'Or these runs' },
          metrics: { type: 'array', items: { type: 'string' }, description: 'Only these metrics (ids, aliases, Ragas names)' },
          runs: { type: 'number', description: 'The most recent runs (default 30, at most 200)' },
          since: str('Only runs since this date (2026-10-01)'),
          min_delta: { type: 'number', description: 'The smallest move that counts without the interval deciding (default 0.05)' },
        },
      },
      run: (a) =>
        ragTrend(store, {
          evaluation: a.evaluation ? String(a.evaluation) : undefined,
          runIds: Array.isArray(a.run_ids) ? a.run_ids.map(String) : undefined,
          metrics: Array.isArray(a.metrics) ? a.metrics.map(String) : undefined,
          runs: typeof a.runs === 'number' ? a.runs : undefined,
          since: a.since ? String(a.since) : undefined,
          minDelta: typeof a.min_delta === 'number' ? a.min_delta : undefined,
        }),
    },
  ];
}
