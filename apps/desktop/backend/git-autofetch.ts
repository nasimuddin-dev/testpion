/**
 * Background fetch for the open workspace: while it is in git with a remote, the backend fetches quietly every
 * `git.autoFetchMinutes` (default 5; 0 = off) and tells the views when the remote has new commits
 * (`git.remoteChanged` with ahead / behind), so the Git view can offer Pull & push before a push is refused; with `git.autoPull` it also
 * pulls a plain fast-forward by itself when the workspace has no change of the person's (`git.autoPulled`). It lives in
 * the backend, not the window, so a cloud host runs the same timer. It never runs while a pull, push or sync runs, never
 * asks for a sign-in (a remote that needs one just fails, quietly logged), and never changes the working folder.
 */
import { join } from 'node:path';
import { atomicWrite, gitFetch, gitPullFastForward, gitRemoteUrl, gitStatus, readJson, realPathOf, repoRoot } from '@testpion/core';
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
    // only a remote the person works with: a freshly cloned third-party repository is not pinged every few minutes
    if (!this.optedIn()) return;
    await this.fetchNow();
  }

  /** Workspaces (real paths) whose remote the person has pushed to from this computer, or turned the background fetch on for. */
  private file = () => join(this.be.host.appDir, 'git-autofetch.json');
  private key = (root: string) => (process.platform === 'win32' || process.platform === 'darwin' ? realPathOf(root).toLowerCase() : realPathOf(root));
  private list(): string[] {
    try {
      const v = readJson<{ workspaces?: string[] }>(this.file(), {}).workspaces;
      return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }
  optedIn(root = this.be.store?.root): boolean {
    return !!root && this.list().includes(this.key(root));
  }
  /** The person pushed (or asked): this workspace's remote is theirs, so it is fetched in the background from now on. */
  optIn(root = this.be.store?.root, on = true): void {
    if (!root) return;
    const k = this.key(root);
    const cur = this.list();
    if (cur.includes(k) === on) return;
    atomicWrite(this.file(), JSON.stringify({ workspaces: on ? [...cur, k] : cur.filter((x) => x !== k) }, null, 2));
  }

  autoPullOn(): boolean {
    return this.be.settings.git?.autoPull === true;
  }

  /**
   * Pull by itself when the person asked for it (Settings ▸ Git) and it is safe: the remote has commits, the workspace has no
   * change of the person's (not even a new file), nothing of theirs is unpushed, no merge is under way, and nothing else runs.
   * It is `git pull --ff-only`: it never merges, stashes or rewrites. Tells the views what came in (`git.autoPulled`: who and what).
   */
  private async autoPull(ws: string, st: Awaited<ReturnType<typeof gitStatus>>): Promise<boolean> {
    if (!this.autoPullOn() || this.running || st.behind <= 0 || st.ahead > 0 || st.files.length || st.conflicted || !st.upstream) return false;
    if (this.be.store?.root !== ws) return false;
    this.running++;
    try {
      const r = await gitPullFastForward(ws);
      if (!r.pulled) return false;
      // the files were written for the app: reload them and tell the views, as after a pull the person asked for
      this.be.adoptDiskState();
      this.be.ws.reloadWorkspaceFile();
      this.be.host.emit('data.changed', { method: 'git' });
      this.be.host.emit('git.changed', {});
      this.be.host.emit('git.autoPulled', { count: r.pulled, branch: st.branch, commits: r.commits.slice(0, 5), authors: [...new Set(r.commits.map((c) => c.author))] });
      this.be.logger.info(`Pulled ${r.pulled} commit(s) from ${st.upstream} by itself`);
      return true;
    } catch (e) {
      // it could not fast-forward (the histories diverged meanwhile) or the sign-in is needed: nothing changed, the strip offers Pull
      this.be.logger.debug(`Pull by itself skipped: ${(e as Error).message}`);
      return false;
    } finally {
      this.running--;
    }
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
      let st = await gitStatus(ws);
      // "pull my team's commits by itself": only a plain fast-forward of a workspace with nothing of the person's in it
      const pulled = await this.autoPull(ws, st);
      if (pulled) st = await gitStatus(ws);
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
