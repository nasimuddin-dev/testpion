/**
 * `testpion test|run|run-collection … --triage` (AI-2 for CI): after a run with failures, the failures grouped by likely
 * cause and — with a model set up — explained with proposed, verified fixes, printed as a "Triage" section and kept as
 * triage.json / triage.md beside the results. The JUnit, HTML and Markdown reports get a "Triage (AI)" section only when
 * a model answered. It never changes the exit code, and a triage that fails is a warning: the run's result stands.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  aiRunDeps,
  appendTriageToReports,
  normalizeError,
  triageMarkdown,
  triageRun,
  WorkspaceManager,
  type ReportFormat,
  type RunSummary,
  type TriageResult,
  type WorkspaceStore,
} from '@testpion/core';
import { cliContext, dim, yellow } from './shared.js';
import { machine, noteWarning } from './output.js';

export async function triageAfterRun(a: {
  store: WorkspaceStore;
  summary: RunSummary;
  outDir: string;
  reports: Partial<Record<ReportFormat, string>>;
  quiet?: boolean;
}): Promise<TriageResult | undefined> {
  if (a.summary.failed + a.summary.errors === 0 || a.summary.cancelled) return undefined;
  const ctx = cliContext(a.store, a.summary.environment);
  try {
    const t = await triageRun(aiRunDeps({ ctx, settings: new WorkspaceManager().loadSettings(), store: a.store, surface: process.env.CI ? 'ci' : 'cli', env: process.env }), {
      runId: a.summary.runId,
    });
    const md = triageMarkdown(t);
    writeFileSync(join(a.outDir, 'triage.json'), JSON.stringify(t, null, 2));
    writeFileSync(join(a.outDir, 'triage.md'), md);
    // the reports' "Triage (AI)" section: only what a model said (the grouping alone is in triage.md)
    if (t.ai) appendTriageToReports(a.reports, t);
    if (!a.quiet && !machine()) console.log(`\n${md.trimEnd()}\n${dim(`triage: ${join(a.outDir, 'triage.md')}`)}`);
    return t;
  } catch (e) {
    const w = `The triage could not be made (the run's result stands): ${normalizeError(e).message}`;
    console.error(yellow(`warning: ${w}`));
    noteWarning(w);
    return undefined;
  } finally {
    await ctx.dispose();
  }
}
