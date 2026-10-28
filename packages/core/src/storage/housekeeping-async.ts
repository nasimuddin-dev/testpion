import { existsSync } from 'node:fs';
import { opendir, readdir, rm as rmP, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { WorkspaceStore } from './workspace.js';
import { expireTrash } from './trash.js';
import { retentionOf } from './storage-usage.js';
import { RUNNING_FILE, runInProgress, removeStaleMarker } from './run-marker.js';
import { DAY, HOUR, NOT_RUNS, TMP, TMP_FOLDERS, alive, type SweepResult } from './housekeeping.js';

/**
 * `sweepWorkspace` for the app: the same rules, but nothing holds the event loop. Every file system call is asynchronous (a folder
 * with 100,000 payloads is read entry by entry, not in one `readdirSync`), run folders are measured and removed through the thread
 * pool in small batches, and whatever has to run in this thread runs in slices of a few milliseconds with a yield between them, so
 * an RPC of the window is never late by more than a slice (the sweep used to freeze the window for seconds, five seconds after
 * every open; planning/review-2026-10-27-robustness.md 4.4).
 */
export interface AsyncSweepOptions {
  now?: number;
  keepRuns?: Iterable<string>;
  retention?: { keepRuns?: number; keepDays?: number };
  /** Longest stretch of work in this thread before the loop is given back (default 5 ms). */
  sliceMs?: number;
  /** Asked between slices: true stops the sweep (the workspace was closed). */
  stopped?: () => boolean;
}

const RUNS_PER_BATCH = 20;

export async function sweepWorkspaceAsync(store: WorkspaceStore, o: AsyncSweepOptions = {}): Promise<SweepResult> {
  const now = o.now ?? Date.now();
  const keep = new Set(o.keepRuns ?? []);
  const sliceMs = o.sliceMs ?? 5;
  const out: SweepResult = { tmp: 0, payloads: 0, runs: 0, inline: 0, trash: 0, pruned: 0, warnings: [] };
  const root = store.root;
  let sliceStart = performance.now();
  /** Gives the loop back when this slice has used its time. */
  const tick = async (): Promise<void> => {
    if (o.stopped?.()) throw new DOMException('The sweep was stopped', 'AbortError');
    if (performance.now() - sliceStart < sliceMs) return;
    await new Promise<void>((r) => setImmediate(r));
    sliceStart = performance.now();
  };
  const ageOf = async (path: string): Promise<number> => {
    try {
      return now - (await stat(path)).mtimeMs;
    } catch {
      return 0;
    }
  };
  /** Removals run a few at a time through the thread pool (a folder's removal is dozens of milliseconds on a machine with a virus scanner). */
  const doomed: Array<{ path: string; count: () => void }> = [];
  const flush = async (min = 16): Promise<void> => {
    while (doomed.length >= min && doomed.length > 0) {
      await Promise.all(doomed.splice(0, 16).map(async (d) => ((await rm(d.path)) ? d.count() : undefined)));
      await tick();
    }
  };
  const rm = async (path: string): Promise<boolean> => {
    try {
      await rmP(path, { recursive: true, force: true });
      return true;
    } catch {
      return false; // in use: the next sweep
    }
  };
  /** How long ago anything in a folder (one level) was written. */
  const newestAge = async (dir: string): Promise<number> => {
    let age = await ageOf(dir);
    try {
      for (const f of await readdir(dir)) {
        if (f !== RUNNING_FILE) age = Math.min(age, await ageOf(join(dir, f)));
        await tick();
      }
    } catch {
      /* gone */
    }
    return age;
  };

  try {
    // leftover temp files
    const walk = async (dir: string, depth: number): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        await tick();
        const path = join(dir, e.name);
        if (e.isDirectory()) {
          if (depth < 4 && !e.name.startsWith('.git') && e.name !== 'node_modules') await walk(path, depth + 1);
          continue;
        }
        const m = TMP.exec(e.name);
        if (!m) continue;
        const age = await ageOf(path);
        if (((!alive(Number(m[1])) && age > 60_000) || age > DAY) && (await rm(path))) out.tmp++;
      }
    };
    for (const f of TMP_FOLDERS) {
      const dir = f ? join(root, f) : root;
      if (existsSync(dir)) await walk(dir, f ? 0 : 4);
    }
    await tick();
    out.trash = expireTrash(store, now); // a handful of entries
    await tick();

    // runs beyond the retention, in batches through the thread pool; a run that will not delete leaves its row for the next sweep
    await pruneInBatches(store, retentionOf(o.retention), now, keep, out, tick);

    const refs = store.meta.referencedFiles();
    await tick();
    // response bodies that no history row points at (read entry by entry: a folder can hold 100,000)
    const payloads = join(root, 'payloads');
    if (existsSync(payloads)) {
      const used = new Set([...refs.payloads].map((p) => resolve(root, p)));
      const dir = await opendir(payloads);
      for await (const ent of dir) {
        await tick();
        const path = resolve(payloads, ent.name);
        if (!used.has(path) && (await ageOf(path)) > DAY) doomed.push({ path, count: () => out.payloads++ });
        await flush();
      }
      await flush(1);
    }

    const runs = join(root, 'runs');
    if (existsSync(runs)) {
      const dir = await opendir(runs);
      for await (const ent of dir) {
        await tick();
        const f = ent.name;
        const path = join(runs, f);
        if (f === '.inline') {
          for (const g of await readdir(path)) {
            await tick();
            if ((await ageOf(join(path, g))) > HOUR && (await rm(join(path, g)))) out.inline++;
          }
          continue;
        }
        if (NOT_RUNS.has(f) || f.startsWith('.') || refs.runIds.has(f) || keep.has(f)) continue;
        // another process's run marks its folder while it works (run-marker.ts)
        if (runInProgress(path, now)) continue;
        if (!existsSync(join(path, 'summary.json')) && (await newestAge(path)) > HOUR) doomed.push({ path, count: () => out.runs++ });
        else removeStaleMarker(path);
        await flush();
      }
      await flush(1);
    }
  } catch (e) {
    if ((e as Error).name !== 'AbortError') throw e;
  }
  return out;
}

/** The retention (storage-usage.ts `pruneRuns`) without holding the thread, and without its two failure modes: an undeletable run no longer stops the pass, and a baseline list that cannot be read stops the pruning instead of pinning nothing. */
async function pruneInBatches(store: WorkspaceStore, plan: ReturnType<typeof retentionOf>, now: number, keep: Set<string>, out: SweepResult, tick: () => Promise<void>): Promise<void> {
  let pinned: string[];
  try {
    pinned = store.listBaselines().map((b) => b.runId);
  } catch (e) {
    // no baselines/ folder is "no baselines"; any other failure may hide a pinned run
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      out.warnings?.push(`Retention skipped: the saved baselines could not be listed (${(e as Error).message}), and the runs they point at must stay.`);
      return;
    }
    pinned = [];
  }
  for (const id of pinned) keep.add(id);
  const cutoff = plan.keepDays > 0 ? new Date(now - plan.keepDays * 86_400_000).toISOString() : undefined;
  const all = store.meta.listRuns({ limit: 100_000 }).items; // newest first
  const doomed = all.filter((r, i) => !keep.has(r.id) && ((plan.keepRuns > 0 && i >= plan.keepRuns) || (cutoff !== undefined && r.startedAt < cutoff)));
  let failed = 0;
  for (let i = 0; i < doomed.length; i += RUNS_PER_BATCH) {
    await tick();
    const batch = doomed.slice(i, i + RUNS_PER_BATCH);
    const removed: string[] = [];
    await Promise.all(
      batch.map(async (r) => {
        try {
          await rmP(store.runDir(r.id), { recursive: true, force: true });
          removed.push(r.id);
        } catch {
          failed++;
        }
      }),
    );
    if (removed.length) store.meta.deleteRuns(removed);
    out.pruned += removed.length;
  }
  if (failed) out.warnings?.push(`${failed} run folder(s) could not be deleted by the retention (in use); the next sweep tries again.`);
}
