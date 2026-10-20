/**
 * The limits of a RAG target: at most n calls in flight whatever the run's concurrency, a rate, retries of server-side
 * failures only, and one limiter per request (shared by every test of the run).
 */
import { describe, expect, it } from 'vitest';
import { ApsError, limiterOf, limitsProblems, targetProblems } from '../../packages/core/src/index.js';

const target = (limits: Record<string, number>, url = 'http://x/a') => ({ step: { type: 'http', url }, limits });

describe('limiterOf', () => {
  it('a target without limits has no limiter', () => {
    expect(limiterOf({ step: { url: 'u' } })).toBeUndefined();
    expect(limiterOf({ step: { url: 'u' }, limits: { timeoutMs: 1000 } })).toBeUndefined();
  });

  it('the same request shares one limiter, another request does not', () => {
    expect(limiterOf(target({ concurrency: 1 }))).toBe(limiterOf(target({ concurrency: 1 })));
    expect(limiterOf(target({ concurrency: 1 }))).not.toBe(limiterOf(target({ concurrency: 1 }, 'http://x/b')));
  });

  it('at most `concurrency` calls are in flight, however many are started', async () => {
    const lim = limiterOf(target({ concurrency: 2 }, 'http://x/conc'))!;
    let now = 0;
    let max = 0;
    const call = async () => {
      now++;
      max = Math.max(max, now);
      await new Promise((r) => setTimeout(r, 15));
      now--;
      return 'ok';
    };
    expect(await Promise.all(Array.from({ length: 8 }, () => lim.run(call)))).toEqual(Array(8).fill('ok'));
    expect(max).toBe(2);
  });

  it('retries a failure of the server’s side, but not a wrong mapping or a refused request', async () => {
    const lim = limiterOf(target({ retries: 2 }, 'http://x/retry'))!;
    let n = 0;
    const flaky = async () => {
      if (++n < 3) throw new ApsError('ServerError', 'HTTP 503');
      return 'ok';
    };
    expect(await lim.run(flaky)).toBe('ok');
    expect(n).toBe(3);
    let m = 0;
    await expect(
      lim.run(async () => {
        m++;
        throw new ApsError('ConfigurationError', 'the mapping found no answer');
      }),
    ).rejects.toThrow(/no answer/);
    expect(m).toBe(1);
    // retries run out
    let k = 0;
    await expect(
      lim.run(async () => {
        k++;
        throw new ApsError('NetworkError', 'ECONNRESET');
      }),
    ).rejects.toThrow(/ECONNRESET/);
    expect(k).toBe(3);
  });

  it('requestsPerMinute makes a call wait for the window (a fast burst is held back)', async () => {
    const lim = limiterOf(target({ requestsPerMinute: 2 }, 'http://x/rate'))!;
    const t0 = Date.now();
    await lim.run(async () => 1);
    await lim.run(async () => 2);
    expect(Date.now() - t0).toBeLessThan(500);
    // the third would have to wait for the minute to roll over: cancelled here instead of waiting a minute
    const ctl = new AbortController();
    const third = lim.run(async () => 3, ctl.signal);
    setTimeout(() => ctl.abort(), 50);
    await expect(third).rejects.toThrow(/Cancelled/);
  });
});

describe('limits in the target’s checks', () => {
  it('names the limit that is wrong', () => {
    expect(limitsProblems({ concurrency: 0 })).toEqual(['limits.concurrency must be a number of 1 or more.']);
    expect(limitsProblems({ retries: -1 })).toEqual(['limits.retries must be a number (0 or more).']);
    expect(limitsProblems({ requestsPerMinute: 30, retries: 0, timeoutMs: 5000 })).toEqual([]);
    expect(targetProblems({ protocol: 'http', step: { type: 'http', url: 'u' }, mapping: { answer: '$.a' }, limits: { concurrency: -2 } })[0]).toMatch(/limits.concurrency/);
  });
});
