import { call } from '../api';
import { toastError } from '../store';
import { openRef } from './open-ref';

/**
 * WF-08 "Run again", the one way: a whole run as it ran, or some of its results (a result's Run again), through
 * `runs.runAgain` (the backend knows what the run ran, and in which environment). The new run opens; production asks
 * like any run. Rerun last run (Ctrl+Shift+R, the palette) is `runAgain('last')`.
 */
export async function runAgain(runId: string, resultIds?: string[]): Promise<string | undefined> {
  try {
    const r = await call<{ runId: string }>('runs.runAgain', { runId, ...(resultIds?.length ? { resultIds } : {}) });
    void openRef({ kind: 'run', runId: r.runId });
    return r.runId;
  } catch (e) {
    toastError(e);
    return undefined;
  }
}
