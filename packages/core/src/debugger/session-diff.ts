import type { DebuggerExchange } from './proxy.js';

/**
 * Compare two captures (FG-23): "what changed between the green run and the red one". Exchanges are matched by method and URL
 * (the nth request for a URL in one capture with the nth in the other); the result lists the requests only the second has
 * (added), only the first has (removed), and the matched ones whose status or timing changed.
 */
export interface DiffSide {
  id: string;
  status?: number;
  error?: string;
  ms?: number;
  bytes: number;
}

export interface DiffEntry {
  method: string;
  url: string;
  a?: DiffSide;
  b?: DiffSide;
  /** For a matched pair: what differs. */
  changes?: Array<'status' | 'timing' | 'size' | 'error'>;
}

export interface SessionDiff {
  added: DiffEntry[];
  removed: DiffEntry[];
  changed: DiffEntry[];
  /** Matched with nothing to report. */
  unchanged: number;
  totals: { a: number; b: number };
  options: Required<DiffOptions>;
}

export interface DiffOptions {
  /** Match without the query string (default: the whole URL). */
  ignoreQuery?: boolean;
  /** A timing counts as changed when it moved by at least this many milliseconds (default 200) and by this ratio (default 1.5). */
  timingMs?: number;
  timingRatio?: number;
  /** Also report a different response size as a change (default: only status, timing and error). */
  includeSize?: boolean;
  /** Tunnels (HTTPS that was not decrypted) take part (default: they do not). */
  includeTunnels?: boolean;
}

const side = (e: DebuggerExchange): DiffSide => ({ id: e.id, status: e.status, error: e.error, ms: e.durationMs, bytes: e.responseBodyBytes });

function keyOf(e: DebuggerExchange, ignoreQuery: boolean): string {
  let url = e.url;
  const hash = url.indexOf('#');
  if (hash >= 0) url = url.slice(0, hash);
  if (ignoreQuery) {
    const q = url.indexOf('?');
    if (q >= 0) url = url.slice(0, q);
  }
  return `${e.method.toUpperCase()} ${url}`;
}

export function diffSessions(a: DebuggerExchange[], b: DebuggerExchange[], opts: DiffOptions = {}): SessionDiff {
  const o: Required<DiffOptions> = { ignoreQuery: opts.ignoreQuery ?? false, timingMs: opts.timingMs ?? 200, timingRatio: opts.timingRatio ?? 1.5, includeSize: opts.includeSize ?? false, includeTunnels: opts.includeTunnels ?? false };
  const take = (list: DebuggerExchange[]) => (o.includeTunnels ? list : list.filter((e) => e.kind !== 'tunnel'));
  const left = take(a);
  const right = take(b);
  // the exchanges of the first capture by key, in order: the nth of one meets the nth of the other
  const waiting = new Map<string, DebuggerExchange[]>();
  for (const e of left) {
    const k = keyOf(e, o.ignoreQuery);
    const q = waiting.get(k);
    if (q) q.push(e);
    else waiting.set(k, [e]);
  }
  const taken = new Map<string, number>();
  const added: DiffEntry[] = [];
  const changed: DiffEntry[] = [];
  const matched = new Set<DebuggerExchange>();
  let unchanged = 0;
  for (const e of right) {
    const k = keyOf(e, o.ignoreQuery);
    const n = taken.get(k) ?? 0;
    const other = waiting.get(k)?.[n];
    if (!other) {
      added.push({ method: e.method, url: e.url, b: side(e) });
      continue;
    }
    taken.set(k, n + 1);
    matched.add(other);
    const changes: NonNullable<DiffEntry['changes']> = [];
    if ((other.status ?? 0) !== (e.status ?? 0)) changes.push('status');
    if (!!other.error !== !!e.error) changes.push('error');
    const x = other.durationMs;
    const y = e.durationMs;
    if (x !== undefined && y !== undefined && Math.abs(y - x) >= o.timingMs && (y >= x * o.timingRatio || y * o.timingRatio <= x)) changes.push('timing');
    if (o.includeSize && other.responseBodyBytes !== e.responseBodyBytes) changes.push('size');
    if (changes.length) changed.push({ method: e.method, url: e.url, a: side(other), b: side(e), changes });
    else unchanged++;
  }
  const removed = left.filter((e) => !matched.has(e)).map<DiffEntry>((e) => ({ method: e.method, url: e.url, a: side(e) }));
  return { added, removed, changed, unchanged, totals: { a: left.length, b: right.length }, options: o };
}

/** One line for the window and the tools. */
export function describeDiff(d: SessionDiff): string {
  return `${d.added.length} added, ${d.removed.length} removed, ${d.changed.length} changed, ${d.unchanged} the same (${d.totals.a} vs ${d.totals.b} requests)`;
}
