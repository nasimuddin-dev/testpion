import type { TestResult } from '../model/types.js';

/** Upper bounds (ms) of the latency histogram's buckets; the last bucket is open-ended. */
const LATENCY_BUCKETS = [50, 100, 250, 500, 1000, 2500, 5000] as const;

interface LatencyBucket {
  /** Lower bound in ms (inclusive). */
  fromMs: number;
  /** Upper bound in ms (exclusive); absent for the last, open-ended bucket. */
  toMs?: number;
  passed: number;
  /** Failed or errored. */
  failed: number;
}

export interface RunBreakdown {
  /** How many results had a latency (or duration). */
  timed: number;
  histogram: LatencyBucket[];
  /** Slowest results, slowest first. */
  slowest: Array<{ id: string; name: string; type: string; status: string; latencyMs: number }>;
  /** Results per test type (http, graphql, grpc, mcp, llm, …). */
  byType: Record<string, { passed: number; failed: number; skipped: number }>;
  /** Checks that failed most often, by name. */
  failingChecks: Array<{ name: string; count: number }>;
  /** Tests that passed only after a retry (flaky), most attempts first. */
  flaky: Array<{ id: string; name: string; attempts: number }>;
  /** Scored checks by evaluator (check type): how many scores fell in 0–0.2, 0.2–0.4, … 0.8–1, and their mean. */
  scores: Array<{ name: string; buckets: number[]; mean: number; count: number }>;
  /**
   * Where the time of HTTP and GraphQL requests went: total ms per phase over all of them (DNS, TCP and TLS only
   * count on new connections), and how many requests opened a new connection or reused one.
   */
  phases?: { requests: number; newConnections: number; reused: number; dnsMs: number; tcpMs: number; tlsMs: number; ttfbMs: number; downloadMs: number };
}

const PHASE_KEYS = ['dnsMs', 'tcpMs', 'tlsMs', 'ttfbMs', 'downloadMs'] as const;

/**
 * Summary of a run's results for charts: a latency histogram (passed and failed per bucket),
 * the slowest results, results per type and the checks that failed most. Feed results one at a
 * time (they are streamed from results.jsonl), then call `result()`.
 */
export function runBreakdown() {
  const histogram: LatencyBucket[] = [0, ...LATENCY_BUCKETS].map((fromMs, i) => ({ fromMs, toMs: LATENCY_BUCKETS[i], passed: 0, failed: 0 }));
  let slowest: RunBreakdown['slowest'] = [];
  const byType: RunBreakdown['byType'] = {};
  const checks = new Map<string, number>();
  const scores = new Map<string, { buckets: number[]; sum: number; count: number }>();
  const flaky: RunBreakdown['flaky'] = [];
  const phases = { requests: 0, newConnections: 0, reused: 0, dnsMs: 0, tcpMs: 0, tlsMs: 0, ttfbMs: 0, downloadMs: 0 };
  let timed = 0;
  return {
    add(r: TestResult) {
      const bad = r.status === 'failed' || r.status === 'error';
      if (r.status === 'passed' && (r.attempts ?? 1) > 1 && flaky.length < 200) flaky.push({ id: r.id, name: r.name, attempts: r.attempts });
      const t = (byType[r.type] ??= { passed: 0, failed: 0, skipped: 0 });
      if (bad) t.failed++;
      else if (r.status === 'skipped') t.skipped++;
      else t.passed++;
      for (const c of r.checks ?? []) {
        if (!c.passed) checks.set(c.name, (checks.get(c.name) ?? 0) + 1);
        if (typeof c.score === 'number' && Number.isFinite(c.score)) {
          const sc = Math.min(1, Math.max(0, c.score));
          // per evaluator (check type: similarity, groundedness, llm-judge …), not per check
          const key = c.type || c.name;
          const e = scores.get(key) ?? scores.set(key, { buckets: [0, 0, 0, 0, 0], sum: 0, count: 0 }).get(key)!;
          e.buckets[Math.min(4, Math.floor(sc * 5))]!++;
          e.sum += sc;
          e.count++;
        }
      }
      if (r.status === 'skipped') return;
      const timing = (r.metadata as { timing?: Partial<Record<(typeof PHASE_KEYS)[number], number>> & { reusedConnection?: boolean } } | undefined)?.timing;
      if (timing && timing.ttfbMs !== undefined) {
        phases.requests++;
        if (timing.reusedConnection === true) phases.reused++;
        else if (timing.reusedConnection === false) phases.newConnections++;
        for (const k of PHASE_KEYS) phases[k] += timing[k] ?? 0;
      }
      const ms = r.latencyMs ?? r.durationMs;
      if (typeof ms !== 'number' || !(ms >= 0)) return;
      timed++;
      let i = LATENCY_BUCKETS.findIndex((b) => ms < b);
      if (i < 0) i = LATENCY_BUCKETS.length;
      if (bad) histogram[i]!.failed++;
      else histogram[i]!.passed++;
      if (slowest.length < 5 || ms > slowest[slowest.length - 1]!.latencyMs) {
        slowest.push({ id: r.id, name: r.name, type: r.type, status: r.status, latencyMs: Math.round(ms) });
        slowest.sort((a, b) => b.latencyMs - a.latencyMs);
        slowest = slowest.slice(0, 5);
      }
    },
    result(): RunBreakdown {
      // trailing empty buckets are dropped so the chart is not mostly blank; leading ones stay (they show "nothing was that fast")
      let last = histogram.length - 1;
      while (last > 0 && histogram[last]!.passed + histogram[last]!.failed === 0) last--;
      const failingChecks = [...checks].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 5);
      const scored = [...scores].map(([name, e]) => ({ name, buckets: e.buckets, mean: Math.round((e.sum / e.count) * 1000) / 1000, count: e.count })).slice(0, 12);
      for (const k of PHASE_KEYS) phases[k] = Math.round(phases[k] * 10) / 10;
      return { timed, histogram: histogram.slice(0, last + 1), slowest, byType, failingChecks, flaky: flaky.sort((a, b) => b.attempts - a.attempts).slice(0, 20), scores: scored, ...(phases.requests ? { phases } : {}) };
    },
  };
}
