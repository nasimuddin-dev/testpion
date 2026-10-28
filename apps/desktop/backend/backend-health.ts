import { EncryptedFileSecretStore, normalizeError, sweepWorkspaceAsync, type WorkspaceStore } from '@testpion/core';
import type { Backend } from './backend.js';

/**
 * How the backend keeps going when the disk, the database or a run misbehaves (planning/review-2026-10-22-robustness.md): bookkeeping that
 * never turns a success into an error, a workspace switch that waits for its runs, problems the window is told about, the slowest calls,
 * and a bounded shutdown. Functions of the backend, in a module of their own so backend.ts stays small.
 */

/** Waits for the promises, but never longer than `ms`; failures are ignored (this is shutdown). */
export async function settleWithin(promises: Array<Promise<unknown> | undefined | void>, ms: number): Promise<void> {
  const live = promises.filter((p): p is Promise<unknown> => !!p);
  if (!live.length) return;
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<void>((res) => (timer = setTimeout(res, ms)));
  timer?.unref();
  await Promise.race([Promise.allSettled(live), limit]);
  clearTimeout(timer);
}

/**
 * Closes a workspace store that is being replaced. A run still writing to it is stopped first and the store stays open until the run has
 * written its results and history row (bounded), so a workspace switch never closes the database under a run.
 */
export function closeStoreAfterRuns(be: Backend, old: WorkspaceStore | undefined, waitMs = 5000): Promise<void> {
  if (!old) return Promise.resolve();
  const mine = [...be.runs.values()].filter((r) => r.store === old);
  if (mine.length === 0) {
    old.close();
    return Promise.resolve();
  }
  for (const r of mine) r.ctrl.abort();
  be.logger.info(`${mine.length} run${mine.length === 1 ? ' was' : 's were'} stopped by the workspace switch`);
  return settleWithin(
    mine.map((r) => r.finished),
    waitMs,
  ).then(() => {
    try {
      old.close();
    } catch {
      /* already closed */
    }
  });
}

/** Keeps a problem for the diagnostics (the last 50). */
export function noteProblem(be: Backend, message: string): void {
  be.problems.push(`${new Date().toISOString().slice(0, 19)} ${message}`);
  if (be.problems.length > 50) be.problems.shift();
}

/** The history database was damaged, locked or newer than this version reads: log it and tell the window (again a little later, in case it was not listening yet). */
export function reportMetaProblem(be: Backend, store: WorkspaceStore): void {
  const p = store.meta.problem;
  if (!p) return;
  be.logger.error(p.message, { code: p.code, backup: p.backup });
  noteProblem(be, p.message);
  const say = () => {
    if (be.store === store) be.host.emit('workspace.problem', { kind: 'history', code: p.code, message: p.message, backup: p.backup });
  };
  say();
  const t = setTimeout(say, 4000);
  t.unref();
  be.deferred.push(t);
}

/**
 * Best-effort bookkeeping around work that already succeeded (a history row, a trace, a certificate after a response that arrived): a
 * failure of the disk is logged and shown once a minute per cause, never turns the success into an error or loses the answer.
 */
export function recordBestEffort(be: Backend, what: string, fn: () => void): { ok: true } | { ok: false; code: string; message: string } {
  try {
    fn();
    return { ok: true };
  } catch (e) {
    const err = normalizeError(e);
    const code = String((e as { code?: string })?.code ?? err.kind);
    const now = Date.now();
    if (now - (be.problemsSaid.get(code) ?? 0) > 60_000) {
      be.problemsSaid.set(code, now);
      be.logger.error(`Could not save the ${what}: ${err.message}`, { code });
      noteProblem(be, `Could not save the ${what}: ${err.message}`);
      be.host.emit('workspace.problem', { kind: 'storage', code, message: `Could not save the ${what}: ${err.message}.`, hint: err.suggestions[0] });
    }
    return { ok: false, code, message: err.message };
  }
}

/** The last workspace could not be opened at the start: remembered (`ws.startupProblem`) and told to the window, which may not be listening yet. */
export function reportStartupProblem(be: Backend, path: string | undefined, e: unknown): void {
  const err = normalizeError(e);
  const message = `Could not open ${path ?? 'the workspace'}: ${err.message}`;
  be.startupProblem = { path, message };
  noteProblem(be, message);
  const say = () => {
    if (!be.store) be.host.emit('workspace.problem', { kind: 'open', code: err.kind, message: `${message}.`, hint: 'Open another workspace, or fix the file named above.' });
  };
  for (const ms of [0, 4000]) {
    const t = setTimeout(say, ms);
    t.unref();
    be.deferred.push(t);
  }
}

/** The encrypted secret store, with its problems (a damaged file, values of another user) told to the window. */
export function encryptedSecrets(be: Backend, file: string, cipher: ConstructorParameters<typeof EncryptedFileSecretStore>[1]): EncryptedFileSecretStore {
  const enc = new EncryptedFileSecretStore(file, cipher);
  enc.onProblem = (m) => reportSecretsProblem(be, m);
  if (enc.problem) setImmediate(() => reportSecretsProblem(be, enc.problem!));
  return enc;
}

/** Secrets read as empty (a damaged secrets.json, values encrypted for another user): logged, kept for the diagnostics, told to the window (again later: it may not be listening yet). */
export function reportSecretsProblem(be: Backend, message: string): void {
  be.logger.error(message);
  noteProblem(be, message);
  for (const ms of [0, 4000]) {
    const t = setTimeout(() => be.host.emit('workspace.problem', { kind: 'secrets', code: 'secrets', message }), ms);
    t.unref();
    be.deferred.push(t);
  }
}

/** Keeps the 100 slowest calls of the session (no I/O). */
export function noteSlowCall(be: Backend, method: string, ms: number): void {
  if (ms < 50 || (be.slowRpcs.length >= 100 && ms <= be.slowRpcs[be.slowRpcs.length - 1]!.ms)) return;
  be.slowRpcs.push({ method, ms, at: new Date().toISOString() });
  be.slowRpcs.sort((a, b) => b.ms - a.ms);
  if (be.slowRpcs.length > 100) be.slowRpcs.length = 100;
}

/** Leftovers of crashes and cut-short runs are removed shortly after a workspace opens (never on the way in: opening stays fast). */
export function scheduleSweep(be: Backend, store: WorkspaceStore, afterMs = 5000): void {
  const t = setTimeout(() => {
    if (be.store !== store) return;
    // asynchronous and in slices of a few milliseconds: the window's calls are served between them (housekeeping-async.ts)
    sweepWorkspaceAsync(store, { keepRuns: be.runs.keys(), retention: be.settings.retention, stopped: () => be.store !== store }).then(
      ({ warnings, ...r }) => {
        for (const w of warnings ?? []) be.logger.warn(w);
        // the first sweep after an update may delete runs beyond the retention: said as a warning, not as routine housekeeping
        if (r.pruned) be.logger.warn(`The retention setting removed ${r.pruned} old run(s)`, { ...r });
        else if (r.tmp + r.payloads + r.runs + r.inline + r.trash) be.logger.info('Removed leftovers from earlier sessions', { ...r });
      },
      (e: unknown) => be.logger.warn(`Clean-up of leftovers failed: ${(e as Error).message}`),
    );
  }, afterMs);
  t.unref();
  be.deferred.push(t);
}
