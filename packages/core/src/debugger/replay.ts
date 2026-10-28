/**
 * Replay many (FG-2): send a captured request again N times, some at once, in order, and sum up what came back. The engine
 * only schedules and counts; the sending is the caller's (the app's send path, so every answer lands in History).
 * Starting is in order (request 1 starts before request 2); with concurrency above 1, answers may finish out of order but
 * the results are kept by position. A cap of 200 sends and a question for hosts that are not on this computer protect real servers.
 */
import type { DebuggerExchange } from './proxy.js';

export const REPLAY_MAX = 200;
export const REPLAY_MAX_CONCURRENCY = 20;
export const REPLAY_MAX_DELAY_MS = 60_000;

export interface ReplayOptions {
  /** How many sends in all (1 to 200). */
  count: number;
  /** How many at once (1 to 20). */
  concurrency: number;
  /** Wait this long between the start of one send and the next in a lane. */
  delayMs: number;
  /** Stop starting new sends after the first failure (an error, or a status of 400 and up). */
  stopOnFailure: boolean;
}

/** What one send did: its place in the order, the status or the error, and the time. */
export interface ReplayResult {
  index: number;
  status?: number;
  error?: string;
  ms: number;
  /** The History entry the send left (open it as a request). */
  historyId?: string;
}

export interface ReplaySummary {
  planned: number;
  sent: number;
  failed: number;
  /** Not started because of stop on failure. */
  skipped: number;
  statuses: Record<string, number>;
  minMs?: number;
  p50Ms?: number;
  maxMs?: number;
  stoppedAt?: number;
  results: ReplayResult[];
}

/** Options with every number clamped to what is allowed (the caller says what it asked for; this says what runs). */
export function cleanReplayOptions(o: Partial<ReplayOptions>): ReplayOptions {
  const int = (v: unknown, min: number, max: number, fallback: number) => {
    const n = Math.trunc(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const count = int(o.count, 1, REPLAY_MAX, 1);
  return { count, concurrency: Math.min(count, int(o.concurrency, 1, REPLAY_MAX_CONCURRENCY, 1)), delayMs: int(o.delayMs, 0, REPLAY_MAX_DELAY_MS, 0), stopOnFailure: o.stopOnFailure === true };
}

const failed = (r: Pick<ReplayResult, 'status' | 'error'>) => !!r.error || (r.status ?? 0) >= 400;

export function summarizeReplay(planned: number, results: Array<ReplayResult | undefined>): ReplaySummary {
  const done = results.filter((r): r is ReplayResult => !!r);
  const statuses: Record<string, number> = {};
  for (const r of done) {
    const k = r.error ? 'error' : String(r.status ?? '?');
    statuses[k] = (statuses[k] ?? 0) + 1;
  }
  const times = done.map((r) => r.ms).sort((a, b) => a - b);
  const stopped = results.findIndex((r) => r === undefined);
  return {
    planned,
    sent: done.length,
    failed: done.filter(failed).length,
    skipped: planned - done.length,
    statuses,
    ...(times.length ? { minMs: times[0], p50Ms: times[Math.floor((times.length - 1) / 2)], maxMs: times[times.length - 1] } : {}),
    ...(stopped >= 0 ? { stoppedAt: stopped } : {}),
    results: done.sort((a, b) => a.index - b.index),
  };
}

/** Run `send(index)` for index 0..count-1 with the options. `send` never throws: a failure is a result with an `error`. */
export async function replayMany(opts: ReplayOptions, send: (index: number) => Promise<Omit<ReplayResult, 'index'>>, signal?: AbortSignal): Promise<ReplaySummary> {
  const results: Array<ReplayResult | undefined> = new Array(opts.count).fill(undefined);
  let next = 0;
  let halt = false;
  const lane = async () => {
    let first = true;
    for (;;) {
      if (halt || signal?.aborted || next >= opts.count) return;
      const index = next++;
      if (!first && opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (halt || signal?.aborted) return;
      first = false;
      let r: Omit<ReplayResult, 'index'>;
      try {
        r = await send(index);
      } catch (e) {
        r = { error: (e as Error).message, ms: 0 };
      }
      results[index] = { index, ...r };
      if (opts.stopOnFailure && failed(r)) halt = true;
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency }, lane));
  return summarizeReplay(opts.count, results);
}

export { isReplayLocalHost } from '@testpion/shared';

/** The request of a captured exchange as the app's send path takes it (the proxy's own headers left off). */
export function requestOfExchange(e: Pick<DebuggerExchange, 'method' | 'url' | 'requestHeaders' | 'requestBody'>): {
  method: string;
  url: string;
  headers: Array<{ key: string; value: string; enabled: boolean }>;
  body?: { type: 'json' | 'xml' | 'text'; content: string };
} {
  const headers = Object.entries(e.requestHeaders)
    .filter(([k]) => !/^(host|content-length|connection|proxy-.*|accept-encoding)$/i.test(k))
    .map(([key, value]) => ({ key, value, enabled: true }));
  const ct = e.requestHeaders['content-type'] ?? '';
  return { method: e.method, url: e.url, headers, ...(e.requestBody ? { body: { type: /json/i.test(ct) ? ('json' as const) : /xml/i.test(ct) ? ('xml' as const) : ('text' as const), content: e.requestBody } } : {}) };
}
