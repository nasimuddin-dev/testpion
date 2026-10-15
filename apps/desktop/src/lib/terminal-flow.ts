/**
 * The window's side of the Terminal's flow control (the backend's is in backend/terminal.ts): how much of a terminal's
 * output xterm has parsed, told to the backend as an absolute count. An ack that is lost, late or repeated changes
 * nothing the next one doesn't put right, and output parsed after a replay (terminal.replay, or a reload's restore)
 * counts only within that replay's epoch. No DOM here: the unit tests drive it with a fake xterm.
 */

/** An ack at least every 64 KB parsed (well under the backend's resume mark) … */
export const ACK_EVERY = 64 * 1024;
/** … and one soon after the output stops, so the backend's count is exact whenever it waits for the window. */
export const ACK_IDLE_MS = 50;
/** A failed ack is sent again after this long. */
export const ACK_RETRY_MS = 250;

export class AckCounter {
  /** Characters parsed, counted like the backend's `sent` (from the start, or from the replay the window drew). */
  parsed = 0;
  epoch = 0;
  private acked = 0;
  private timer?: ReturnType<typeof setTimeout>;

  /** `send` tells the backend (terminal.ack); when it fails, the count is sent again a moment later. */
  constructor(private send: (parsed: number, epoch: number) => Promise<unknown>) {}

  /** Count from `parsed` in `epoch`: the window now shows the output the backend kept (a restore, a replay). */
  reset(parsed: number, epoch: number): void {
    this.stop();
    this.parsed = this.acked = parsed;
    this.epoch = epoch;
  }

  /** xterm parsed `chars` characters that were written in `epoch`. */
  parsedChunk(chars: number, epoch: number): void {
    if (epoch !== this.epoch || this.stopped) return; // written before a replay: what it counted is gone
    this.parsed += chars;
    if (this.parsed - this.acked >= ACK_EVERY) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), ACK_IDLE_MS);
  }

  /**
   * Tell the backend now: when there is anything new, or always with `force` (the backend detached the terminal and
   * waits for the window to say it draws again). An ack that fails is sent again, so none is ever lost for good.
   */
  flush(force = false): void {
    this.stop();
    if (this.parsed === this.acked && !force) return;
    const { parsed, epoch } = this;
    this.acked = parsed;
    this.send(parsed, epoch).catch(() => {
      if (this.stopped || epoch !== this.epoch) return;
      this.acked = -1; // not heard: the next flush sends the count again
      this.timer ??= setTimeout(() => this.flush(), ACK_RETRY_MS);
    });
  }

  private stopped = false;

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** The terminal is closed: no more acks, no retries. */
  dispose(): void {
    this.stopped = true;
    this.stop();
  }
}
