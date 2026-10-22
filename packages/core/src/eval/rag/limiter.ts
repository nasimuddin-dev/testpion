/**
 * The limits of a RAG target (`limits: { concurrency, requestsPerMinute, timeoutMs, retries }`): an evaluation of 2,000
 * questions must not overload the system it tests. One limiter per target request (keyed by the request itself), shared by
 * every test of the run, so the limit holds however many tests run at once. The judge has its own, independent limits.
 */
import { createHash } from 'node:crypto';
import type { RagLimits, RagTarget } from '@testpion/shared';
import { ApsError } from '../../errors.js';
import { Semaphore } from '../../util/concurrency.js';

const RETRYABLE: ReadonlySet<string> = new Set(['ProtocolError', 'NetworkError', 'TimeoutError', 'ServerError', 'RateLimitError']);

class TargetLimiter {
  private sem?: Semaphore;
  private readonly starts: number[] = [];
  constructor(readonly limits: RagLimits) {
    if (limits.concurrency) this.sem = new Semaphore(limits.concurrency);
  }

  /** Waits until another request may start (a sliding minute). */
  private async rate(signal?: AbortSignal): Promise<void> {
    const per = this.limits.requestsPerMinute;
    if (!per) return;
    for (;;) {
      const now = Date.now();
      while (this.starts.length && now - this.starts[0]! >= 60_000) this.starts.shift();
      if (this.starts.length < per) {
        this.starts.push(now);
        return;
      }
      const wait = 60_000 - (now - this.starts[0]!);
      await new Promise<void>((res, rej) => {
        const t = setTimeout(res, Math.min(wait, 1000));
        signal?.addEventListener('abort', () => (clearTimeout(t), rej(new ApsError('CancelledError', 'Cancelled while waiting for the rate limit'))), { once: true });
      });
    }
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.sem?.acquire(signal);
    try {
      const tries = 1 + Math.max(0, Math.min(5, this.limits.retries ?? 0));
      let last: unknown;
      for (let i = 0; i < tries; i++) {
        await this.rate(signal);
        try {
          return await fn();
        } catch (e) {
          last = e;
          // only a failed call is tried again: a wrong mapping or a refused request would fail the same way
          if (!(e instanceof ApsError) || !RETRYABLE.has(e.kind) || signal?.aborted) throw e;
          await new Promise((r) => setTimeout(r, Math.min(2000, 200 * 2 ** i)));
        }
      }
      throw last;
    } finally {
      release?.();
    }
  }
}

const limiters = new Map<string, TargetLimiter>(); // bounded: cleared above 200 targets

/** The limiter of a target, or undefined when it has no limits. */
export function limiterOf(target: Pick<RagTarget, 'step' | 'limits'>): TargetLimiter | undefined {
  const l = target.limits;
  if (!l || !(l.concurrency || l.requestsPerMinute || l.retries)) return undefined;
  const key = createHash('sha1').update(JSON.stringify([target.step, l])).digest('hex');
  let lim = limiters.get(key);
  if (!lim) {
    if (limiters.size > 200) limiters.clear();
    lim = new TargetLimiter(l);
    limiters.set(key, lim);
  }
  return lim;
}

/** Problems with a target's limits (a negative number, a string). */
export function limitsProblems(l: RagLimits | undefined): string[] {
  if (!l) return [];
  const out: string[] = [];
  for (const k of ['concurrency', 'requestsPerMinute', 'timeoutMs', 'retries'] as const) {
    const v = l[k];
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < (k === 'retries' ? 0 : 1))) out.push(`limits.${k} must be a number${k === 'retries' ? ' (0 or more)' : ' of 1 or more'}.`);
  }
  return out;
}
