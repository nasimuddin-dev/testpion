/**
 * What to do when the window's page dies (out of memory, a GPU crash, a kill): reload it once, and ask when it dies again soon after.
 * Pure, so the policy is tested without Electron; main.ts owns the window and the dialog.
 */
export interface CrashRecord {
  /** Times (ms since epoch) of the recent crashes, newest last. */
  times: number[];
}

/** A second crash within this long of the first means the reload does not help: ask the user instead of looping. */
export const CRASH_WINDOW_MS = 60_000;

export type CrashAction = 'reload' | 'ask';

/** Records a crash at `now` and says what to do: the first one in the window reloads, a repeat asks. */
export function onRendererCrash(record: CrashRecord, now: number, reason: string): CrashAction {
  if (reason === 'clean-exit') return 'ask'; // not a crash (the page closed itself); the caller does nothing with it
  record.times = record.times.filter((t) => now - t < CRASH_WINDOW_MS);
  record.times.push(now);
  return record.times.length <= 1 ? 'reload' : 'ask';
}

/** The app.log line for a crash. */
export function crashMessage(kind: 'renderer' | 'child', d: { reason: string; exitCode?: number; type?: string; name?: string }, memory?: Record<string, number>): string {
  const what = kind === 'renderer' ? "The window's page crashed" : `A ${d.type ?? 'child'} process${d.name ? ` (${d.name})` : ''} crashed`;
  return `${what}: ${d.reason}${d.exitCode !== undefined ? ` (exit ${d.exitCode})` : ''}${memory ? ` · main heap ${Math.round((memory.heapUsed ?? 0) / 1048576)} MB` : ''}`;
}
