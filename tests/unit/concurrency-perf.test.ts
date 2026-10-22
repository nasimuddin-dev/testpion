import { describe, expect, it } from 'vitest';
import { RateLimiter, Semaphore } from '../../packages/core/src/index.js';

const SLACK = Number(process.env.TESTPION_PERF_SLACK ?? 1);

// A-5: queue.shift() and indexOf+splice on cancel were O(n); the rate limiter filtered the whole last minute on every call
describe('Semaphore', () => {
  it('50,000 waiters are granted in order and 25,000 of them cancel quickly', async () => {
    const s = new Semaphore(1);
    const first = await s.acquire();
    const order: number[] = [];
    const ctrls = Array.from({ length: 50_000 }, () => new AbortController());
    const waiting = ctrls.map((c, i) =>
      s.acquire(c.signal).then(
        (release) => {
          order.push(i);
          release();
        },
        () => undefined,
      ),
    );
    expect(s.waiting).toBe(50_000);
    const t0 = performance.now();
    for (let i = 0; i < 50_000; i += 2) ctrls[i]!.abort();
    first();
    await Promise.all(waiting);
    const ms = performance.now() - t0;
    console.log(`50,000 waiters, 25,000 cancelled: ${ms.toFixed(0)} ms`);
    expect(order).toHaveLength(25_000);
    expect(order.slice(0, 3)).toEqual([1, 3, 5]);
    expect(ms).toBeLessThan(4000 * SLACK); // (5.7 s with the array queue)
  });
});

describe('RateLimiter', () => {
  it('200,000 acquires under a generous limit cost little each, and the limit still holds', async () => {
    const r = new RateLimiter({ requestsPerSecond: 1_000_000, requestsPerMinute: 10_000_000 });
    const t0 = performance.now();
    for (let i = 0; i < 200_000; i++) await r.acquire();
    const ms = performance.now() - t0;
    console.log(`200,000 acquires: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(3000 * SLACK);
    const tight = new RateLimiter({ requestsPerSecond: 3 });
    const t1 = performance.now();
    for (let i = 0; i < 4; i++) await tight.acquire();
    expect(performance.now() - t1).toBeGreaterThanOrEqual(900); // the fourth waits for the first second to pass
  });
});
