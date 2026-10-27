/** Where the time of a collection's requests went, from the timing kept with each response sent in the app. */
import type { WorkspaceStore } from './workspace.js';

interface PhaseTotals {
  requests: number;
  newConnections: number;
  reused: number;
  dnsMs: number;
  tcpMs: number;
  tlsMs: number;
  ttfbMs: number;
  downloadMs: number;
}

/** Totals over the latest `limit` HTTP and GraphQL responses of the collection that have timing; undefined when there are none. */
export function collectionTiming(store: WorkspaceStore, collectionId: string, opts: { limit?: number } = {}): PhaseTotals | undefined {
  // the collection's own rows from the indexed column, only the timing of each (it used to read the latest 2,000 of every collection whole)
  const rows = store.meta.collectionTimings(collectionId, Math.min(Math.max(opts.limit ?? 2000, 1), 20_000));
  const t: PhaseTotals = { requests: 0, newConnections: 0, reused: 0, dnsMs: 0, tcpMs: 0, tlsMs: 0, ttfbMs: 0, downloadMs: 0 };
  for (const row of rows) {
    const m = row as { dnsMs?: number; tcpMs?: number; tlsMs?: number; ttfbMs?: number; downloadMs?: number; reusedConnection?: boolean };
    if (m.ttfbMs === undefined) continue;
    t.requests++;
    if (m.reusedConnection === true) t.reused++;
    else if (m.reusedConnection === false) t.newConnections++;
    t.dnsMs += m.dnsMs ?? 0;
    t.tcpMs += m.tcpMs ?? 0;
    t.tlsMs += m.tlsMs ?? 0;
    t.ttfbMs += m.ttfbMs;
    t.downloadMs += m.downloadMs ?? 0;
  }
  if (!t.requests) return undefined;
  for (const k of ['dnsMs', 'tcpMs', 'tlsMs', 'ttfbMs', 'downloadMs'] as const) t[k] = Math.round(t[k] * 10) / 10;
  return t;
}
