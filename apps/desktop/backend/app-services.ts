/**
 * What one process shares between sessions (cloud stage 1). A `Backend` is a Session: one user's workspace, settings,
 * secrets, cookies, runs and connections. Whatever is process-wide by design lives here, so a server that hosts many
 * sessions knows exactly what they share: the registry of live sessions and, from the script-runner work on, the
 * pool of script workers. The list of everything else that is still module-level state (and why each is safe) is
 * planning/cloud-globals.md, kept honest by tests/unit/two-sessions.test.ts.
 */
import { WorkerScriptRunner, type ScriptRunner } from '@testpion/core';
import type { Backend } from './backend.js';

/** Script workers: TESTPION_SCRIPT_WORKERS=1 (or a pool size), =0 for none; otherwise what the host asks for (BackendHost.scriptWorkers). */
export function scriptWorkersWanted(hostChoice: boolean | number | undefined, env: NodeJS.ProcessEnv = process.env): number {
  const e = env.TESTPION_SCRIPT_WORKERS;
  const v = e !== undefined && e !== '' ? (e === '0' || e === 'false' ? 0 : /^\d+$/.test(e) ? Number(e) : 1) : hostChoice === true ? 1 : typeof hostChoice === 'number' ? hostChoice : 0;
  return v;
}

export class AppServices {
  /** The live sessions of this process (a Backend registers itself and leaves on `dispose`). */
  readonly sessions = new Set<Backend>();
  readonly startedAt = Date.now();

  private pool?: WorkerScriptRunner;
  /** Why the worker pool could not start (the sessions then run scripts in their own thread); undefined when it did or was not asked for. */
  scriptWorkersProblem?: string;

  /** The script runner the sessions of this process share: one worker pool (scripts of every user use the cores), or none (the engine in the calling thread). */
  scriptRunner(want: number): ScriptRunner | undefined {
    if (want <= 0) return undefined;
    if (!this.pool && !this.scriptWorkersProblem)
      try {
        this.pool = new WorkerScriptRunner(want > 1 ? { size: want } : {});
      } catch (e) {
        this.scriptWorkersProblem = (e as Error).message;
      }
    return this.pool;
  }

  async dispose(): Promise<void> {
    await this.pool?.dispose();
    this.pool = undefined;
  }

  register(s: Backend): void {
    this.sessions.add(s);
  }

  release(s: Backend): void {
    this.sessions.delete(s);
  }
}

let shared: AppServices | undefined;

/** The services of this process: the desktop app and the CLI have one session, a server hosts many. */
export function appServices(): AppServices {
  return (shared ??= new AppServices());
}

/** The Session of the architecture notes is the Backend object: one per user and workspace. */
export type Session = Backend;
