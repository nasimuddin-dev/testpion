/**
 * The explorer's per-collection health and Home's "needs attention" list, remembered between calls. Both read the
 * whole request history (and, for attention, every collection, the monitors and the runs); the window asks again
 * after every request it sends and every run, so the answers are kept and only redone when what they read changed:
 *
 * - health: one grouped query over the history, redone when the history changed;
 * - attention: redone when the history, the latest run, the files it reads (collections, environments, the library
 *   with the monitors, the monitors' results, the certificates) or the day changed. The key is the files' names, sizes
 *   and times: a `data.changed` that wrote nothing of these (a run's results, a connection) is a hit, and finding that
 *   out parses no file.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { workspaceAttention, type AttentionItem, type WorkspaceStore } from '@testpion/core';

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

/** The files of a folder as a signature (name, size, time): one readdir and a stat each, no parsing; '' when there is no such folder. */
export function filesSignature(dir: string): string {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return '';
  }
  const parts: string[] = [];
  for (const name of names) {
    const st = statSync(join(dir, name), { throwIfNoEntry: false });
    if (st?.isFile()) parts.push(`${name}:${st.size}:${st.mtimeMs}`);
  }
  return parts.join(',');
}

const attention = new WeakMap<WorkspaceStore, { key: string; value: Promise<AttentionItem[]> }>();

/** What needs attention, remembered by what it reads (see the top of the file). */
export function cachedAttention(ws: WorkspaceStore): Promise<AttentionItem[]> {
  const mark = historyMark(ws);
  const latestRun = ws.meta.listRuns({ limit: 1 }).items[0];
  const files = [ws.path('collections'), ws.path('environments'), ws.path('library'), ws.path('runs', 'monitors')].map(filesSignature);
  const certificates = statSync(ws.path('runs', 'certificates.json'), { throwIfNoEntry: false });
  const day = new Date().toISOString().slice(0, 10);
  const key = JSON.stringify([mark.total, mark.latestId, latestRun?.id, files, certificates ? `${certificates.size}:${certificates.mtimeMs}` : '', day]);
  const known = attention.get(ws);
  if (known?.key === key) return known.value;
  const value = workspaceAttention(ws);
  attention.set(ws, { key, value });
  // a failure is not remembered: the next ask tries again
  value.catch(() => attention.get(ws)?.value === value && attention.delete(ws));
  return value;
}
