/** The Debugger's statistics and its deep search, off the main handler file: one pass over the session, and a search that only reads what changed. */
import type { DebuggerExchange } from '@testpion/core';

const statusClass = (e: DebuggerExchange) => (e.error ? 'error' : !e.status ? 'pending' : e.status < 300 ? '2xx' : e.status < 400 ? '3xx' : e.status < 500 ? '4xx' : '5xx');

interface Tally {
  count: number;
  bytes: number;
  ms: number;
}

/** The `k` entries with the largest `value`, largest first; of equal values the earlier stays first (as a stable sort would leave them). */
class TopK<T> {
  private readonly items: Array<{ x: T; v: number }> = [];
  constructor(private readonly k: number) {}
  add(x: T, v: number): void {
    const t = this.items;
    if (t.length === this.k && v <= t[this.k - 1]!.v) return;
    let i = t.length;
    while (i > 0 && t[i - 1]!.v < v) i--;
    t.splice(i, 0, { x, v });
    if (t.length > this.k) t.pop();
  }
  get list(): T[] {
    return this.items.map((t) => t.x);
  }
}

/** When each exchange started, parsed once (an ISO date costs about a microsecond to parse: 5 ms for a session of 5,000, on every sync). */
const started = new WeakMap<DebuggerExchange, number>();
function startMs(e: DebuggerExchange): number {
  let t = started.get(e);
  if (t === undefined) started.set(e, (t = Date.parse(e.startedAt)));
  return t;
}

const tallies = <K extends string>(m: Map<K, Tally>) => [...m.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.bytes - a.bytes).slice(0, 20);

/** Statistics of a session: by host, content type and program, the largest and the slowest, the timeline and the status mix; one pass over the exchanges. */
export function sessionStats(exchanges: DebuggerExchange[], redactUrl: (url: string) => string) {
  const hosts = new Map<string, Tally>();
  const types = new Map<string, Tally>();
  const apps = new Map<string, Tally>();
  const add = (m: Map<string, Tally>, k: string | undefined, e: DebuggerExchange) => {
    if (!k) return;
    let v = m.get(k);
    if (!v) m.set(k, (v = { count: 0, bytes: 0, ms: 0 }));
    v.count++;
    v.bytes += e.responseBodyBytes;
    v.ms += e.durationMs ?? 0;
  };
  const largest = new TopK<DebuggerExchange>(10);
  const slowest = new TopK<DebuggerExchange>(10);
  const statuses: Record<string, number> = {};
  const startedAt = new Float64Array(exchanges.length);
  let bytes = 0;
  let errors = 0;
  let first = Infinity;
  let last = -Infinity;
  let n = 0;
  for (const e of exchanges) {
    bytes += e.responseBodyBytes;
    const failed = !!e.error || (e.status ?? 0) >= 400;
    if (failed) errors++;
    const sc = statusClass(e);
    statuses[sc] = (statuses[sc] ?? 0) + 1;
    add(hosts, e.host, e);
    add(types, e.contentType?.split(';')[0]?.trim(), e);
    add(apps, e.application, e);
    if (e.durationMs !== undefined) {
      largest.add(e, e.responseBodyBytes);
      slowest.add(e, e.durationMs);
    }
    const t = startMs(e);
    startedAt[n++] = t;
    if (!Number.isNaN(t)) {
      if (t < first) first = t;
      if (t > last) last = t;
    }
  }
  if (first === Infinity) first = last = 0;
  const span = Math.max(1000, last - first);
  const buckets = Math.min(60, Math.max(10, Math.ceil(span / 1000)));
  const slice = span / buckets;
  const timeline = Array.from({ length: buckets }, (_, i) => ({ t: new Date(first + i * slice).toISOString(), count: 0, errors: 0 }));
  let i = 0;
  for (const e of exchanges) {
    const t = startedAt[i++]!;
    if (Number.isNaN(t)) continue;
    const b = timeline[Math.min(buckets - 1, Math.floor((t - first) / slice))]!;
    b.count++;
    if (e.error || (e.status ?? 0) >= 400) b.errors++;
  }
  return {
    total: exchanges.length,
    bytes,
    errors,
    firstAt: first ? new Date(first).toISOString() : undefined,
    lastAt: last ? new Date(last).toISOString() : undefined,
    timeline,
    statuses,
    hosts: tallies(hosts),
    contentTypes: tallies(types),
    applications: tallies(apps),
    largest: largest.list.map((e) => ({ id: e.id, method: e.method, url: redactUrl(e.url), bytes: e.responseBodyBytes })),
    slowest: slowest.list.map((e) => ({ id: e.id, method: e.method, url: redactUrl(e.url), ms: e.durationMs })),
  };
}

export type SessionStats = ReturnType<typeof sessionStats>;

/** The statistics of a session, kept until something in it changes (the window asks again on every sync). */
const statsCache = new WeakMap<DebuggerExchange[], { key: string; stats: SessionStats }>();
export function cachedSessionStats(exchanges: DebuggerExchange[], key: string, redactUrl: (url: string) => string): SessionStats {
  const hit = statsCache.get(exchanges);
  if (hit && hit.key === key) return hit.stats;
  const stats = sessionStats(exchanges, redactUrl);
  statsCache.set(exchanges, { key, stats });
  return stats;
}

/**
 * Deep search (headers and bodies): what each exchange answered for the last needle, kept with the revision it was read at
 * (and whether its bodies had been let go). The next search of the same needle reads only the exchanges that were added or
 * changed since, so a capture running with "In bodies" on does not scan 200 MB of bodies every two seconds.
 */
export class DeepSearchCache {
  private needle = '';
  private seen = new WeakMap<DebuggerExchange, { rev: number; dropped: boolean; hit: boolean }>();
  /** Reads done by the last search (for the tests). */
  reads = 0;

  /** Whether `e` matches in its headers or bodies; `rev` is its revision in the list, `scan` the actual (slow) test. */
  hit(needle: string, e: DebuggerExchange, rev: number, scan: (e: DebuggerExchange) => boolean): boolean {
    if (needle !== this.needle) {
      this.needle = needle;
      this.seen = new WeakMap();
    }
    const dropped = !!e.bodiesDropped;
    const c = this.seen.get(e);
    if (c && c.rev === rev && c.dropped === dropped) return c.hit;
    this.reads++;
    const hit = scan(e);
    this.seen.set(e, { rev, dropped, hit });
    return hit;
  }
}

/** Run `step` over `items`, giving the event loop a turn whenever `sliceMs` have passed (a search over the bodies of a long session). */
export async function inSlices<T>(items: T[], step: (x: T) => void, sliceMs = 12): Promise<void> {
  let t0 = performance.now();
  for (const x of items) {
    step(x);
    if (performance.now() - t0 > sliceMs) {
      await new Promise<void>((r) => setImmediate(r));
      t0 = performance.now();
    }
  }
}
