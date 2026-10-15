/** The requests of a monitor across its latest runs: which are slow or failing. */
import { join } from 'node:path';
import type { WorkspaceStore } from '../storage/workspace.js';
import { listMonitors, monitorResults } from './monitors.js';
import { resultSourceRefs } from './result-source.js';
import type { ItemRef } from '@testpion/shared';
import type { RunOrigin } from '../model/types.js';
import { readResultsFile } from './runner.js';

export interface MonitorRequestStat {
  name: string;
  runs: number;
  failed: number;
  medianMs?: number;
  p95Ms?: number;
  /** The latest failure's first failed check or error. */
  lastFailure?: string;
  /** Where it comes from: the saved request (a collection monitor) or the test file at its step (WF-08). */
  ref?: ItemRef;
}

/** Per request (test name), slowest median first, over the monitor's latest `runs` runs that have results. */
export async function monitorRequestStats(store: WorkspaceStore, monitorId: string, opts: { runs?: number } = {}): Promise<MonitorRequestStat[]> {
  const results = monitorResults(store, monitorId, Math.min(Math.max(opts.runs ?? 20, 1), 200)).filter((r) => r.total > 0);
  const by = new Map<string, { runs: number; failed: number; ms: number[]; lastFailure?: string; ref?: ItemRef }>();
  const m = listMonitors(store).find((x) => x.id === monitorId);
  const origin: RunOrigin | undefined = m?.collectionId ? { kind: 'collection', collectionId: m.collectionId } : undefined;
  // newest first, so the first failure seen is the latest
  for (const run of results) {
    for await (const t of await readResultsFile(join(store.runDir(run.runId), 'results.jsonl'))) {
      if (t.status === 'skipped') continue;
      let s = by.get(t.name);
      if (!s) by.set(t.name, (s = { runs: 0, failed: 0, ms: [], ref: resultSourceRefs(store, t, origin)[0] }));
      s.runs++;
      const ms = t.latencyMs ?? t.durationMs;
      if (typeof ms === 'number') s.ms.push(ms);
      if (t.status === 'failed' || t.status === 'error') {
        s.failed++;
        s.lastFailure ??= t.error?.message ?? t.checks?.find((c) => !c.passed)?.name;
      }
    }
  }
  const pct = (sorted: number[], p: number) => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!) : undefined);
  return [...by.entries()]
    .map(([name, s]) => {
      const sorted = s.ms.sort((a, b) => a - b);
      return { name, runs: s.runs, failed: s.failed, medianMs: pct(sorted, 0.5), p95Ms: pct(sorted, 0.95), lastFailure: s.lastFailure, ...(s.ref ? { ref: s.ref } : {}) };
    })
    .sort((a, b) => (b.medianMs ?? 0) - (a.medianMs ?? 0) || a.name.localeCompare(b.name));
}
