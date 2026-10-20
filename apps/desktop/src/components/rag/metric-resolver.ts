import { normalizeMetricName } from '@testpion/shared';
import type { metricCatalogueRows } from '@testpion/core';

export type MetricRow = ReturnType<typeof metricCatalogueRows>[number] & { missing?: string[] };
export interface MetricCatalogue {
  groups: Array<{ id: string; label: string }>;
  metrics: MetricRow[];
  presets: Array<{ id: string; name: string; description: string; checks: Array<Record<string, unknown> & { type: string }> }>;
}

/** The metric an evaluator stands for: its id, an alias or a Ragas name (the engine's normalisation), `recall@5`; undefined for any other check. */
export function metricResolver(rows: MetricRow[]) {
  const index = new Map<string, MetricRow>();
  const put = (n: string, r: MetricRow) => index.has(normalizeMetricName(n)) || index.set(normalizeMetricName(n), r);
  for (const r of rows) {
    put(r.id, r);
    r.aliases.forEach((a) => put(a, r));
  }
  for (const r of rows) (r.ragas?.names ?? []).forEach((a) => put(a, r));
  return (type: string): MetricRow | undefined => {
    const t = type.replace(/^ragas:/i, '');
    const at = /^(.+)@\d+$/.exec(t);
    const key = normalizeMetricName(at ? `${at[1]}@k` : t);
    return index.get(key) ?? index.get(key.replace(/-score$/, ''));
  };
}

/** Whether an evaluator spends something (asks a judge or an embedding model): a metric of another kind than "no model", or a legacy one given a judge. */
export function spendsOnJudge(row: MetricRow | undefined, check: Record<string, unknown>): boolean {
  if (!row || row.kind === 'deterministic') return false;
  if (row.judge === 'optional') return !!check.judge;
  if (row.kind === 'embedding') return check.method === 'embedding';
  return true;
}
