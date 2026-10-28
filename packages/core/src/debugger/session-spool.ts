import { appendFileSync, closeSync, createReadStream, existsSync, openSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { PRIVATE_FILE_MODE } from '../storage/fsutil.js';
import { exchangesFromHar, harEntry, strictHarRedactor, type HarRedactor } from './har.js';
import type { DebuggerExchange } from './proxy.js';

/**
 * Large-session mode (FG-28): a session keeps the newest 5,000 exchanges in memory; with a spool, the older ones are not
 * forgotten but written to a file as they leave memory (one HAR entry per line, masked like the AutoSave: credentials and tokens
 * by shape). Saving, exporting and sharing read the spool first, so they hold the whole session; the grid shows the newest 5,000.
 * The file lives in the app's data folder and goes when the session is cleared, the mode is turned off or the app quits.
 */
export class SessionSpool {
  private n = 0;
  private bytes = 0;
  private readonly redactor: HarRedactor;

  constructor(
    readonly file: string,
    redactor: HarRedactor,
    /** The most bytes kept on disk (default 1 GB); past it the exchanges that leave memory are forgotten, as before the mode existed. */
    private readonly limitBytes = 1024 ** 3,
  ) {
    this.redactor = strictHarRedactor(redactor);
    rmSync(file, { force: true });
  }

  /** How many exchanges are on disk. */
  get count(): number {
    return this.n;
  }

  get size(): number {
    return this.bytes;
  }

  /** Add exchanges that left memory (oldest first). */
  append(list: DebuggerExchange[]): void {
    if (!list.length || this.bytes >= this.limitBytes) return;
    // bodies already let go of for the memory budget are not on disk either: the entry says so by having none
    const text = `${list.map((e) => JSON.stringify(harEntry(e, this.redactor))).join('\n')}\n`;
    const fd = openSync(this.file, 'a', PRIVATE_FILE_MODE);
    try {
      appendFileSync(fd, text);
    } finally {
      closeSync(fd);
    }
    this.n += list.length;
    this.bytes += Buffer.byteLength(text);
  }

  /** Read the exchanges back, oldest first, a block at a time. */
  async *blocks(size = 500): AsyncGenerator<DebuggerExchange[]> {
    if (!this.n || !existsSync(this.file)) return;
    let batch: unknown[] = [];
    const rl = createInterface({ input: createReadStream(this.file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      try {
        batch.push(JSON.parse(line));
      } catch {
        continue; // a half-written last line (a crash): the rest is intact
      }
      if (batch.length >= size) {
        yield exchangesFromHar({ log: { entries: batch } });
        batch = [];
      }
    }
    if (batch.length) yield exchangesFromHar({ log: { entries: batch } });
  }

  /** Every spooled exchange. */
  async all(): Promise<DebuggerExchange[]> {
    const out: DebuggerExchange[] = [];
    for await (const b of this.blocks()) out.push(...b);
    return out;
  }

  clear(): void {
    rmSync(this.file, { force: true });
    this.n = 0;
    this.bytes = 0;
  }
}
