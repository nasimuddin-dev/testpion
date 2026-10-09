/**
 * The explorer's per-collection health and Home's "needs attention" list, remembered between calls. Both read the
 * whole request history (and, for attention, every collection, the monitors and the runs); the window asks again
 * after every request it sends and every run, so the answers are kept and only redone when what they read changed:
 *
 * - health: one grouped query over the history, redone when the history changed;
 * - attention: redone when the history, the latest run, the monitors' results, the collections (any `data.changed`)
 *   or the day changed.
 */
import { lastMonitorResult, listMonitors, workspaceAttention, type AttentionItem, type WorkspaceStore } from '@testpion/core';

export interface CollectionHealth {
  sent: number;
  failing: number;
}

interface HistoryMark {
  total: number;
  latestId?: string;
  latestTs?: string;
}

/** The newest history entry and how many there are: one indexed query. */
function historyMark(ws: WorkspaceStore): HistoryMark {
  const page = ws.meta.listHistory({ limit: 1, brief: true });
  const latest = page.items[0];
  return { total: page.total ?? page.items.length, latestId: latest?.id, latestTs: latest?.timestamp };
}

const health = new WeakMap<WorkspaceStore, { mark: HistoryMark; value: Record<string, CollectionHealth> }>();

/** Per collection: requests sent from the app and how many of them fail now (one grouped query, kept until the history changes). */
export function collectionsHealth(ws: WorkspaceStore): Record<string, CollectionHealth> {
  const mark = historyMark(ws);
  const known = health.get(ws);
  if (known && known.mark.latestId === mark.latestId && known.mark.total === mark.total) return known.value;
  const value = ws.meta.historyByCollection();
  health.set(ws, { mark, value });
  return value;
}

const attention = new WeakMap<WorkspaceStore, { key: string; value: Promise<AttentionItem[]> }>();

/**
 * What needs attention, remembered by what it reads. `dataEpoch` counts the backend's `data.changed` events (a
 * collection saved, imported, deleted, changed on disk …).
 */
export function cachedAttention(ws: WorkspaceStore, dataEpoch: number): Promise<AttentionItem[]> {
  const mark = historyMark(ws);
  const latestRun = ws.meta.listRuns({ limit: 1 }).items[0];
  const monitors = listMonitors(ws)
    .filter((m) => m.enabled)
    .map((m) => {
      const r = lastMonitorResult(ws, m.id);
      return `${m.id}:${m.name}:${r?.runId ?? ''}:${r?.status ?? ''}`;
    })
    .join('|');
  const day = new Date().toISOString().slice(0, 10);
  const key = JSON.stringify([mark.total, mark.latestId, latestRun?.id, monitors, dataEpoch, day]);
  const known = attention.get(ws);
  if (known?.key === key) return known.value;
  const value = workspaceAttention(ws);
  attention.set(ws, { key, value });
  // a failure is not remembered: the next ask tries again
  value.catch(() => attention.get(ws)?.value === value && attention.delete(ws));
  return value;
}
