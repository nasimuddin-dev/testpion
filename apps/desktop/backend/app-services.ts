/**
 * What one process shares between sessions (cloud stage 1). A `Backend` is a Session: one user's workspace, settings,
 * secrets, cookies, runs and connections. Whatever is process-wide by design lives here, so a server that hosts many
 * sessions knows exactly what they share: the registry of live sessions and, from the script-runner work on, the
 * pool of script workers. The list of everything else that is still module-level state (and why each is safe) is
 * planning/cloud-globals.md, kept honest by tests/unit/two-sessions.test.ts.
 */
import type { Backend } from './backend.js';

export class AppServices {
  /** The live sessions of this process (a Backend registers itself and leaves on `dispose`). */
  readonly sessions = new Set<Backend>();
  readonly startedAt = Date.now();

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
