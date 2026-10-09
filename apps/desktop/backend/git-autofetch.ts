/**
 * Background fetch for the open workspace: while it is in git with a remote, the backend fetches quietly every
 * `git.autoFetchMinutes` (default 5; 0 = off) and tells the views when the remote has new commits
 * (`git.remoteChanged` with ahead / behind), so the Git view can offer Pull & push before a push is refused. It lives in
 * the backend, not the window, so a cloud host runs the same timer. It never runs while a pull, push or sync runs, never
 * asks for a sign-in (a remote that needs one just fails, quietly logged), and never changes the working folder.
 */
import { gitFetch, gitRemoteUrl, gitStatus, repoRoot } from '@testpion/core';
import type { Backend } from './backend.js';

export const DEFAULT_AUTO_FETCH_MINUTES = 5;

export class GitAutoFetch {
  private timer?: ReturnType<typeof setInterval>;
  /** Pulls, pushes, syncs and fetches the user started: the background fetch waits for none of them, it skips. */
  private running = 0;
  private inflight?: Promise<unknown>;
  private lastFetch = Date.now();
  /** The last `behind` told to the views, by workspace folder. */
  private known = new Map<string, number>();

  constructor(private readonly be: Backend) {}

  /** Check every `tickMs` whether a fetch is due (the interval itself comes from the settings, read on every tick). */
  start(tickMs = 30_000): void {
    this.stop();
    this.timer = setInterval(() => void this.tick(), tickMs);
    (this.timer as { unref?(): void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  minutes(): number {
    const m = this.be.settings.git?.autoFetchMinutes;
    return m === undefined || m === null ? DEFAULT_AUTO_FETCH_MINUTES : Math.max(0, Number(m) || 0);
  }

  /** Run a git operation the user asked for (pull, push, sync, fetch): the background fetch stays out of its way. */
  async exclusive<T>(op: () => Promise<T>): Promise<T> {
    this.running++;
    try {
      // a background fetch already under way finishes first (two fetches at once fight over git's lock files)
      await this.inflight?.catch(() => undefined);
      return await op();
    } finally {
      this.running--;
      // the next background fetch reports from scratch (a pull just brought `behind` to 0)
      if (this.be.store) this.known.delete(this.be.store.root);
    }
  }

  private async tick(): Promise<void> {
    const m = this.minutes();
    if (!m || Date.now() - this.lastFetch < m * 60_000) return;
    await this.fetchNow();
  }

  /**
   * Fetch quietly now (also when the Git view opens). Skipped while the user's own git operation runs, when no
   * workspace is open, or when it is not in git with a remote.
   */
  async fetchNow(): Promise<{ fetched: boolean; ahead?: number; behind?: number; skipped?: string }> {
    if (this.running || this.inflight) return { fetched: false, skipped: 'busy' };
    const ws = this.be.store?.root;
    if (!ws) return { fetched: false, skipped: 'no workspace' };
    this.lastFetch = Date.now();
    const work = (async () => {
      if (!(await repoRoot(ws)) || !(await gitRemoteUrl(ws))) return { fetched: false, skipped: 'no remote' };
      await gitFetch(ws, { quiet: true });
      const st = await gitStatus(ws);
      // the workspace was switched meanwhile: nothing to tell
      if (this.be.store?.root !== ws) return { fetched: true, ahead: st.ahead, behind: st.behind };
      const before = this.known.get(ws);
      this.known.set(ws, st.behind);
      if (before !== st.behind && (before !== undefined || st.behind > 0)) this.be.host.emit('git.remoteChanged', { ahead: st.ahead, behind: st.behind, upstream: st.upstream });
      return { fetched: true, ahead: st.ahead, behind: st.behind };
    })();
    this.inflight = work;
    try {
      return await work;
    } catch (e) {
      // offline, signed out, the remote gone: not worth more than a line in the log
      this.be.logger.debug(`Background git fetch failed: ${(e as Error).message}`);
      return { fetched: false, skipped: 'failed' };
    } finally {
      this.inflight = undefined;
    }
  }
}
