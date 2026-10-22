import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkspaceStore } from './workspace.js';

export interface StorageUsage {
  /** What each kept-data folder (and the database) holds. */
  parts: Array<{ name: string; label: string; bytes: number; files: number }>;
  totalBytes: number;
  runs: number;
  history: number;
  traces: number;
  /** Start of the oldest kept run. */
  oldestRun?: string;
}

const PARTS: Array<[string, string]> = [
  ['runs', 'Runs (results and reports)'],
  ['traces', 'Traces'],
  ['payloads', 'Response bodies'],
  ['reports', 'Exported reports'],
  ['trash', 'Recently deleted'],
];

function sizeOf(path: string): { bytes: number; files: number } {
  if (!existsSync(path)) return { bytes: 0, files: 0 };
  const st = statSync(path);
  if (!st.isDirectory()) return { bytes: st.size, files: 1 };
  let bytes = 0;
  let files = 0;
  for (const e of readdirSync(path, { withFileTypes: true })) {
    const s = sizeOf(join(path, e.name));
    bytes += s.bytes;
    files += s.files;
  }
  return { bytes, files };
}

/** The same, without blocking: a folder's entries are looked at a few dozen at a time, so the event loop runs in between. */
async function sizeOfAsync(path: string): Promise<{ bytes: number; files: number }> {
  let st;
  try {
    st = await stat(path);
  } catch {
    return { bytes: 0, files: 0 };
  }
  if (!st.isDirectory()) return { bytes: st.size, files: 1 };
  let bytes = 0;
  let files = 0;
  const entries = await readdir(path).catch(() => [] as string[]);
  for (let i = 0; i < entries.length; i += 64)
    for (const s of await Promise.all(entries.slice(i, i + 64).map((e) => sizeOfAsync(join(path, e))))) {
      bytes += s.bytes;
      files += s.files;
    }
  return { bytes, files };
}

const DB_FILES = ['database.sqlite', 'database.sqlite-wal', 'database.sqlite-shm', 'metadata.jsonl'];
const sum = (all: Array<{ bytes: number; files: number }>) => all.reduce((a, b) => ({ bytes: a.bytes + b.bytes, files: a.files + b.files }), { bytes: 0, files: 0 });

/** How much the workspace keeps besides its definitions: runs, traces, response bodies, the history database. */
export function workspaceStorage(store: Pick<WorkspaceStore, 'path' | 'meta' | 'root'>): StorageUsage {
  const parts = PARTS.map(([name, label]) => ({ name, label, ...sizeOf(store.path(name)) }));
  return usageOf(store, parts, sum(DB_FILES.map((f) => sizeOf(join(store.root, f)))));
}

/**
 * `workspaceStorage` for the app's backend, which serves the window from the same thread: the folders (up to tens of
 * thousands of run and trace files) are walked without holding it up.
 */
export async function workspaceStorageAsync(store: Pick<WorkspaceStore, 'path' | 'meta' | 'root'>): Promise<StorageUsage> {
  const parts = await Promise.all(PARTS.map(async ([name, label]) => ({ name, label, ...(await sizeOfAsync(store.path(name))) })));
  return usageOf(store, parts, sum(await Promise.all(DB_FILES.map((f) => sizeOfAsync(join(store.root, f))))));
}

function usageOf(store: Pick<WorkspaceStore, 'meta'>, parts: StorageUsage['parts'], db: { bytes: number; files: number }): StorageUsage {
  // the history / runs / traces index (SQLite, with its write-ahead log)
  parts.push({ name: 'database', label: 'History and index', ...db });
  const runs = store.meta.listRuns({ limit: 1 });
  const oldest = runs.total ? store.meta.listRuns({ limit: 1, offset: runs.total - 1 }).items[0]?.startedAt : undefined;
  return {
    parts,
    totalBytes: parts.reduce((a, p) => a + p.bytes, 0),
    runs: runs.total,
    history: store.meta.listHistory({ limit: 1 }).total,
    traces: store.meta.listTraces({ limit: 1 }).total,
    oldestRun: oldest,
  };
}

/** Delete the runs (results, reports, index rows) that started before `before` (ISO time). Baselines are kept. */
export function deleteRunsBefore(store: Pick<WorkspaceStore, 'meta' | 'runDir'>, before: string): { deleted: number; bytes: number } {
  let deleted = 0;
  let bytes = 0;
  const all = store.meta.listRuns({ limit: 100_000 }).items.filter((r) => r.startedAt < before);
  for (const r of all) {
    const dir = store.runDir(r.id);
    bytes += sizeOf(dir).bytes;
    rmSync(dir, { recursive: true, force: true });
    store.meta.deleteRun(r.id);
    deleted++;
  }
  return { deleted, bytes };
}
