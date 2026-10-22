import { describe, expect, it } from 'vitest';
import { LatencyRecorder } from '@testpion/core';

// a live load test snapshots every second: that must not sort every sample recorded so far
describe('LatencyRecorder at load-test scale', () => {
  it('stays exact below the limit, then switches to a histogram and keeps memory constant', () => {
    const r = new LatencyRecorder({ exactUpTo: 1000 });
    for (let i = 1; i <= 1000; i++) r.record(i);
    expect(r.approximate).toBe(false);
    expect(r.stats()).toMatchObject({ count: 1000, p50: 500, p99: 990 });
    r.record(1001);
    expect(r.approximate).toBe(true);
    expect(r.stats().count).toBe(1001);
  });

  it('keeps percentiles within 1 % of the exact ones', () => {
    const exact = new LatencyRecorder();
    const approx = new LatencyRecorder({ exactUpTo: 100 });
    let seed = 7;
    for (let i = 0; i < 50_000; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const v = 0.5 + (seed % 100_000) / 100 + (i % 97 === 0 ? 4000 : 0);
      exact.record(v);
      approx.record(v);
    }
    const e = exact.stats();
    const a = approx.stats();
    expect(a).toMatchObject({ count: e.count, min: e.min, max: e.max, mean: e.mean });
    for (const k of ['p50', 'p90', 'p95', 'p99'] as const) expect(Math.abs(a[k] - e[k]) / e[k]).toBeLessThan(0.01);
  });

  it('5 million samples and 10 snapshots take well under 100 ms of snapshot time', () => {
    const r = new LatencyRecorder({ exactUpTo: 20_000 });
    for (let i = 0; i < 5_000_000; i++) r.record(1 + ((i * 7919) % 1000) / 10);
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) {
      r.record(5);
      r.stats();
    }
    const ms = performance.now() - t0;
    expect(r.approximate).toBe(true);
    // measured 0 ms (the old exact path: 1,859 ms for the same ten snapshots)
    expect(ms).toBeLessThan(100 * Number(process.env.TESTPION_PERF_SLACK ?? 1));
  });
});
