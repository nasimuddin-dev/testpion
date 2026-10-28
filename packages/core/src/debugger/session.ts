import type { DebuggerExchange } from './proxy.js';
import type { SessionSpool } from './session-spool.js';

/** A message of a gRPC call is an object already decoded: counted at a flat estimate rather than stringified again. */
const GRPC_MESSAGE_ESTIMATE = 512;
const STREAM_ITEM_OVERHEAD = 64;

/** What an exchange keeps in memory that the budget counts, in characters: its bodies, its WebSocket frames, SSE events and gRPC messages. */
function sizeOf(e: DebuggerExchange): number {
  let n = (e.requestBody?.length ?? 0) + (e.responseBody?.length ?? 0) + (e.requestBodyBase64?.length ?? 0) + (e.responseBodyBase64?.length ?? 0);
  if (e.frames) for (const f of e.frames) n += (f.text?.length ?? 0) + STREAM_ITEM_OVERHEAD;
  if (e.events) for (const ev of e.events) n += ev.data.length + STREAM_ITEM_OVERHEAD;
  if (e.grpc) n += (e.grpc.requests.length + e.grpc.responses.length) * GRPC_MESSAGE_ESTIMATE;
  return n;
}

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
  /** Large-session mode (FG-28): where exchanges go when they leave memory, instead of being forgotten. */
  private spool?: SessionSpool;

  constructor(opts: { maxExchanges?: number; maxBodyBytes?: number } = {}) {
    this.maxExchanges = opts.maxExchanges ?? 5000;
    this.maxBodyBytes = opts.maxBodyBytes ?? 200 * 1024 * 1024;
    this.block = Math.max(1, Math.min(100, Math.floor(this.maxExchanges / 50)));
  }

  /** Turn large-session mode on (give the spool) or off (undefined: what the spool holds is forgotten). */
  setSpool(spool: SessionSpool | undefined): void {
    if (this.spool && this.spool !== spool) this.spool.clear();
    this.spool = spool;
  }

  /** How many exchanges are on disk, beyond the ones in memory. */
  get spilled(): number {
    return this.spool?.count ?? 0;
  }

  /** The whole session, oldest first: what the spool holds, then the exchanges in memory. */
  async everything(): Promise<DebuggerExchange[]> {
    return this.spool?.count ? [...(await this.spool.all()), ...this.items] : this.items.slice();
  }

  get length(): number {
    return this.items.length;
  }

  /** How much of the body budget the kept bodies use (characters, as `maxBodyBytes` counts them). */
  get bodyBytes(): number {
    return this.keptBytes;
  }

  /** A captured or loaded exchange, newest. */
  add(e: DebuggerExchange): void {
    this.items.push(e);
    if (this.items.length > this.maxExchanges + this.block) this.dropOldest(this.items.length - this.maxExchanges);
    this.account(e);
  }

  /** Call after a body was attached (or replaced): charges it to the budget and lets the oldest bodies go if needed. */
  account(e: DebuggerExchange): void {
    const n = sizeOf(e);
    this.keptBytes += n - (this.kept.get(e) ?? 0);
    this.kept.set(e, n);
    while (this.keptBytes > this.maxBodyBytes && this.evictAt < this.items.length) {
      const old = this.items[this.evictAt++]!;
      if (old === e || !this.kept.get(old)) continue;
      delete old.requestBody;
      delete old.responseBody;
      delete old.requestBodyBase64;
      delete old.responseBodyBase64;
      // streams count too: 500 frames or events of 64 KB each per direction were outside the budget (about 32 MB per streaming exchange)
      delete old.frames;
      delete old.events;
      if (old.grpc) old.grpc = { ...old.grpc, requests: [], responses: [] };
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
    this.spool?.clear();
    this.replace([]);
  }

  /** A loaded session takes the place of the current one, or joins it. */
  load(loaded: DebuggerExchange[], append = false): void {
    if (!append) this.spool?.clear();
    const all = append ? [...this.items, ...loaded] : loaded;
    // large-session mode: what does not fit in memory goes to the spool, oldest first
    if (this.spool && all.length > this.maxExchanges) this.spool.append(all.slice(0, all.length - this.maxExchanges));
    this.replace(all);
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
    const left = this.items.splice(0, n);
    this.spool?.append(left);
    for (const gone of left) this.keptBytes -= this.kept.get(gone) ?? 0;
    this.evictAt = Math.max(0, this.evictAt - n);
  }
}
