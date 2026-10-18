import { outputFileName } from '@testpion/shared';
import { saveOutput, type OutputSpec } from './output-core';

/**
 * What a run's down arrow saves (the run panel, the collection runner, evaluations) and what a runs list's "Export
 * report…" saves: the same spec, so a run's report is saved one way wherever it is asked for. The backend builds every
 * format from the run's files.
 */
export function runOutputSpec(run: { id: string; name?: string; startedAt?: string; outcome?: string }, empty?: string): OutputSpec {
  const source = { kind: 'run' as const, runId: run.id };
  return {
    id: 'run.results',
    what: 'run results',
    name: outputFileName({ name: `run-${run.name ?? run.id}`, status: run.outcome, when: run.startedAt ? new Date(run.startedAt) : undefined, ext: '' }),
    formats: [
      { format: 'html', label: 'HTML report', source, default: true },
      { format: 'json', label: 'JSON results', source },
      { format: 'junit', label: 'JUnit XML (CI)', source },
      { format: 'md', label: 'Markdown summary', source },
      { format: 'csv', label: 'Results (CSV)', source },
      { format: 'zip', label: 'All reports (ZIP)', source },
    ],
    empty,
  };
}

/** Save a run's HTML report through the Save as dialog (a runs list's "Export report…", the palette's Export Results). */
export function saveRunReport(run: { id: string; name?: string; startedAt?: string; outcome?: string }): Promise<void> {
  const spec = runOutputSpec(run);
  return saveOutput(spec, spec.formats[0]!);
}
