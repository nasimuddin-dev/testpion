import { percentile } from '../util/stats.js';

/** Response-time summary of a request's recent responses (history), shared by the app chart, the CLI and MCP. */
export interface ResponseTimeStats {
  /** responses with a duration */
  count: number;
  /** responses with no status or a status of 400 or more */
  failed: number;
  minMs?: number;
  meanMs?: number;
  p50Ms?: number;
  p95Ms?: number;
  maxMs?: number;
}

/** A response failed when it has no numeric status (network error, timeout) or a status of 400 or more. */
export const responseFailed = (status: unknown): boolean => typeof status !== 'number' || status >= 400;

export function responseTimeStats(entries: Array<{ durationMs?: number; status?: unknown }>): ResponseTimeStats {
  const timed = entries.filter((e) => typeof e.durationMs === 'number' && Number.isFinite(e.durationMs));
  const ms = timed.map((e) => e.durationMs!).sort((a, b) => a - b);
  const stats: ResponseTimeStats = { count: ms.length, failed: timed.filter((e) => responseFailed(e.status)).length };
  if (!ms.length) return stats;
  return {
    ...stats,
    minMs: ms[0],
    meanMs: Math.round(ms.reduce((a, b) => a + b, 0) / ms.length),
    p50Ms: percentile(ms, 0.5),
    p95Ms: percentile(ms, 0.95),
    maxMs: ms[ms.length - 1],
  };
}
