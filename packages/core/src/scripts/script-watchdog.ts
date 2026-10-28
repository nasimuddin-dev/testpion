/**
 * The engine-time budget of one worker job (script-runner-workers.ts). The watchdog ends a worker that has been busy with the
 * engine for longer than the job's limit plus a slack. Time the host spends answering `tp.sendRequest` is not the engine's, so the
 * clock stops while a request is out and restarts when the reply is posted; each answered request starts one more pass of the
 * script (the engine replays it, each pass with its own limit), so it adds one limit to the budget. What is left is always the
 * REMAINING budget, never the whole limit again: a script that sends requests in a loop cannot postpone the watchdog forever.
 */
export class WatchBudget {
  private budget: number;
  private spent = 0;
  private since: number | undefined;

  constructor(
    private readonly limitMs: number,
    slackMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.budget = limitMs + slackMs;
  }

  /** The engine works from now on; returns how long it may still work (0 or less: already over). */
  start(): number {
    this.since = this.now();
    return this.budget - this.spent;
  }

  /** The engine stopped (it asked the host for something). */
  pause(): void {
    if (this.since !== undefined) this.spent += this.now() - this.since;
    this.since = undefined;
  }

  /** The host answered a request: the script runs one more pass. */
  grantPass(): void {
    this.budget += this.limitMs;
  }

  get remainingMs(): number {
    return this.budget - this.spent - (this.since === undefined ? 0 : this.now() - this.since);
  }
}
