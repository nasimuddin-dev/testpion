import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { WorkspaceStore } from './workspace.js';
import { expireTrash } from './trash.js';
import { pruneRuns, retentionOf } from './storage-usage.js';
import { RUNNING_FILE, pidAlive, removeStaleMarker, runInProgress } from './run-marker.js';

/**
 * What a crash, a cancelled run or a failed rename leaves behind, removed (planning/review-2026-10-22-robustness.md R-2, R-4, C-3):
 * `*.tmp-<pid>-<hex>` files of a write that never finished, response bodies no history row points at, run folders that never got
 * their summary (and no history row), and the inline dataset files of runs. Everything younger than a grace period stays (a write or
 * a run in progress), so it is safe to run while the app is in use. Nothing here touches a file the workspace's data points at.
 */
export interface SweepResult {
  tmp: number;
  payloads: number;
  runs: number;
  inline: number;
  trash: number;
  /** Runs deleted by the retention setting (newest N, none older than D days). */
  pruned: number;
  /** Things the sweep could not do or chose not to (retention skipped because the baselines could not be listed, a run that would not delete). */
  warnings?: string[];
}

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const TMP = /\.tmp-(\d+)-[0-9a-f]+$/;
/** Folders whose files are written atomically by the workspace (a leftover temp file sits next to its target). */
export const TMP_FOLDERS = ['collections', 'environments', 'library', 'tests', 'datasets', 'specs', 'mocks', 'flows', '.local', ''];
/** What else lives in runs/ besides run folders: the load history, scale test results, monitor results, certificate checks. Never an orphan. */
export const NOT_RUNS: ReadonlySet<string> = new Set(['load', 'scale', 'monitors', 'certificates.json']);
export const alive = pidAlive;

export const ageOf = (path: string, now: number): number => {
  try {
    return now - statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

export function rm(path: string): boolean {
  try {
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch {
    return false; // in use: the next sweep
  }
}

function sweepTmp(root: string, now: number): number {
  let n = 0;
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 4 && !e.name.startsWith('.git') && e.name !== 'node_modules') walk(path, depth + 1);
        continue;
      }
      const m = TMP.exec(e.name);
      if (!m) continue;
      // the writer is gone (its process ended), or the file is a day old whoever wrote it
      if ((!alive(Number(m[1])) && ageOf(path, now) > 60_000) || ageOf(path, now) > DAY) if (rm(path)) n++;
    }
  };
  for (const f of TMP_FOLDERS) {
    const dir = f ? join(root, f) : root;
    if (!existsSync(dir)) continue;
    // the workspace root itself only one level (its own files), the data folders deeper
    walk(dir, f ? 0 : 4);
  }
  return n;
}

/** `keepRuns`: runs in progress (a run paused at a breakpoint writes nothing for a long time). */
export function sweepWorkspace(store: WorkspaceStore, o: { now?: number; keepRuns?: Iterable<string>; retention?: { keepRuns?: number; keepDays?: number } } = {}): SweepResult {
  const now = o.now ?? Date.now();
  const keep = new Set(o.keepRuns ?? []);
  const out: SweepResult = { tmp: 0, payloads: 0, runs: 0, inline: 0, trash: 0, pruned: 0 };
  const root = store.root;
  out.tmp = sweepTmp(root, now);
  out.trash = expireTrash(store, now);
  out.pruned = pruneRuns(store, retentionOf(o.retention), { now, keep }).deleted;

  const refs = store.meta.referencedFiles();
  // response bodies that no history row points at (a send that failed after its body arrived, a deleted row whose file was in use)
  const payloads = join(root, 'payloads');
  if (existsSync(payloads)) {
    const used = new Set([...refs.payloads].map((p) => resolve(root, p)));
    for (const f of readdirSync(payloads)) {
      const path = resolve(payloads, f);
      if (!used.has(path) && ageOf(path, now) > DAY && rm(path)) out.payloads++;
    }
  }

  const runs = join(root, 'runs');
  if (existsSync(runs)) {
    for (const f of readdirSync(runs)) {
      const path = join(runs, f);
      if (f === '.inline') {
        // the inline dataset of a run is read while it runs: an hour is far beyond that
        for (const g of readdirSync(path)) if (ageOf(join(path, g), now) > HOUR && rm(join(path, g))) out.inline++;
        continue;
      }
      if (NOT_RUNS.has(f) || f.startsWith('.') || refs.runIds.has(f) || keep.has(f)) continue;
      // another process's run (the CLI, a second window) marks its folder while it works
      if (runInProgress(path, now)) continue;
      // no history row and no summary: a run that was cut short (the app quit, the folder was made and the run never started)
      if (!existsSync(join(path, 'summary.json')) && newestAge(path, now) > HOUR) {
        if (rm(path)) out.runs++;
      } else removeStaleMarker(path);
    }
  }
  return out;
}

/** How long ago anything in a folder (one level) was written: a run still writing results is not an orphan. */
export function newestAge(dir: string, now: number): number {
  let age = ageOf(dir, now);
  try {
    for (const f of readdirSync(dir)) if (f !== RUNNING_FILE) age = Math.min(age, ageOf(join(dir, f), now)); // the marker has its own rule (run-marker.ts)
  } catch {
    /* gone */
  }
  return age;
}
