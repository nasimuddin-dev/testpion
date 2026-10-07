import type { DebuggerExchange } from './proxy.js';

/**
 * The exchanges a Debugger session holds, with its two limits in one place: at most `maxExchanges` (the oldest go
 * first, dropped in blocks so a full session does not pay a memmove per request) and at most `maxBodyBytes` of bodies
 * in memory (the oldest exchanges lose their bodies first; their headers, sizes and timing stay). The proxy adds
 * what it captures, the app's handlers delete, clear and load sessions: both through this, so the limits hold for
 * an appended HAR as much as for live traffic.
 */
export class DebuggerSession {
  /** The exchanges, oldest first. The array is the same object for the session's lifetime: holders may keep it. */
  readonly items: DebuggerExchange[] = [];
  private readonly maxExchanges: number;
  private readonly maxBodyBytes: number;
  /** How many over the cap before the oldest go: one memmove per block, not per request (100 for the usual 5,000). */
  private readonly block: number;
  private readonly kept = new WeakMap<DebuggerExchange, number>();
  private keptBytes = 0;
  /** Where the next eviction looks: everything before it has no body any more. */
  private evictAt = 0;

  constructor(opts: { maxExchanges?: number; maxBodyBytes?: number } = {}) {
    this.maxExchanges = opts.maxExchanges ?? 5000;
    this.maxBodyBytes = opts.maxBodyBytes ?? 200 * 1024 * 1024;
    this.block = Math.max(1, Math.min(100, Math.floor(this.maxExchanges / 50)));
  }

  get length(): number {
    return this.items.length;
  }

  /** A captured or loaded exchange, newest. */
  add(e: DebuggerExchange): void {
    this.items.push(e);
    if (this.items.length > this.maxExchanges + this.block) this.dropOldest(this.items.length - this.maxExchanges);
    this.account(e);
  }

  /** Call after a body was attached (or replaced): charges it to the budget and lets the oldest bodies go if needed. */
  account(e: DebuggerExchange): void {
    const n = (e.requestBody?.length ?? 0) + (e.responseBody?.length ?? 0);
    this.keptBytes += n - (this.kept.get(e) ?? 0);
    this.kept.set(e, n);
    while (this.keptBytes > this.maxBodyBytes && this.evictAt < this.items.length) {
      const old = this.items[this.evictAt++]!;
      if (old === e || !this.kept.get(old)) continue;
      delete old.requestBody;
      delete old.responseBody;
      old.bodiesDropped = true;
      this.keptBytes -= this.kept.get(old)!;
      this.kept.set(old, 0);
    }
  }

  remove(ids: Iterable<string>): void {
    const set = new Set(ids);
    this.replace(this.items.filter((e) => !set.has(e.id)));
  }

  clear(): void {
    this.replace([]);
  }

  /** A loaded session takes the place of the current one, or joins it. */
  load(loaded: DebuggerExchange[], append = false): void {
    this.replace(append ? [...this.items, ...loaded] : loaded);
  }

  /** The same array, new contents; the budget recounted from what is kept. */
  private replace(next: DebuggerExchange[]): void {
    this.items.length = 0;
    this.keptBytes = 0;
    this.evictAt = 0;
    for (const e of next.slice(-this.maxExchanges)) {
      this.items.push(e);
      this.kept.set(e, 0);
      this.account(e);
    }
  }

  private dropOldest(n: number): void {
    for (const gone of this.items.splice(0, n)) this.keptBytes -= this.kept.get(gone) ?? 0;
    this.evictAt = Math.max(0, this.evictAt - n);
  }
}
