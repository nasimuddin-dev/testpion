import { ApsError } from '../errors.js';

/** Counting semaphore used to bound concurrency. */
export class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;

  constructor(private limit: number) {
    if (limit < 1) this.limit = 1;
  }

  get inUse(): number {
    return this.active;
  }

  get waiting(): number {
    return this.queue.length;
  }

  setLimit(n: number): void {
    this.limit = Math.max(1, n);
    this.drain();
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
      return this.releaser();
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener('abort', onAbort);
        this.active++;
        resolve(this.releaser());
      };
      const onAbort = () => {
        const i = this.queue.indexOf(grant);
        if (i >= 0) this.queue.splice(i, 1);
        reject(new ApsError('CancelledError', 'Cancelled while waiting for a worker'));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(grant);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < this.limit && this.queue.length) this.queue.shift()!();
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ApsError('CancelledError', 'Cancelled'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new ApsError('CancelledError', 'Cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Token-bucket style limiter supporting requests/second, requests/minute and tokens/minute.
 * `acquire()` waits until a request may start; `consumeTokens()` records token usage after the fact.
 */
export class RateLimiter {
  private reqTimes: number[] = [];
  private tokenEvents: Array<{ t: number; n: number }> = [];

  constructor(private opts: { requestsPerSecond?: number; requestsPerMinute?: number; tokensPerMinute?: number } = {}) {}

  get enabled(): boolean {
    return !!(this.opts.requestsPerSecond || this.opts.requestsPerMinute || this.opts.tokensPerMinute);
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (!this.enabled) return;
    for (;;) {
      const now = Date.now();
      this.reqTimes = this.reqTimes.filter((t) => now - t < 60_000);
      this.tokenEvents = this.tokenEvents.filter((e) => now - e.t < 60_000);
      let wait = 0;
      const { requestsPerSecond: rps, requestsPerMinute: rpm, tokensPerMinute: tpm } = this.opts;
      if (rps) {
        const lastSecond = this.reqTimes.filter((t) => now - t < 1000);
        if (lastSecond.length >= rps) wait = Math.max(wait, 1000 - (now - lastSecond[lastSecond.length - rps]!));
      }
      if (rpm && this.reqTimes.length >= rpm) wait = Math.max(wait, 60_000 - (now - this.reqTimes[this.reqTimes.length - rpm]!));
      if (tpm) {
        const used = this.tokenEvents.reduce((s, e) => s + e.n, 0);
        if (used >= tpm && this.tokenEvents.length) wait = Math.max(wait, 60_000 - (now - this.tokenEvents[0]!.t));
      }
      if (wait <= 0) {
        this.reqTimes.push(now);
        return;
      }
      await sleep(Math.max(1, wait), signal);
    }
  }

  consumeTokens(n: number): void {
    if (this.opts.tokensPerMinute && n > 0) this.tokenEvents.push({ t: Date.now(), n });
  }
}

interface RetryOptions {
  retries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  /** Return false to stop retrying for a given error. */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

/** Retry with exponential backoff and full jitter. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const base = opts.baseDelayMs ?? 250;
  const max = opts.maxDelayMs ?? 10_000;
  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (err) {
      const kind = (err as { kind?: string })?.kind;
      if (kind === 'CancelledError' || attempt >= opts.retries || opts.shouldRetry?.(err, attempt) === false) throw err;
      const retryAfter = (err as { retryAfterMs?: number })?.retryAfterMs;
      const delay = retryAfter ?? Math.min(max, Math.random() * base * 2 ** attempt);
      opts.onRetry?.(err, attempt + 1, delay);
      await sleep(delay, opts.signal);
      attempt++;
    }
  }
}

/** Run `fn` with a timeout; aborts the derived signal when the timeout fires. */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number | undefined,
  parent?: AbortSignal,
  label = 'Operation',
): Promise<T> {
  const ctrl = new AbortController();
  const onParentAbort = () => ctrl.abort(parent?.reason);
  if (parent?.aborted) throw new ApsError('CancelledError', 'Cancelled');
  parent?.addEventListener('abort', onParentAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  try {
    if (!timeoutMs || timeoutMs <= 0) return await fn(ctrl.signal);
    return await Promise.race([
      fn(ctrl.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const err = new ApsError('TimeoutError', `${label} timed out after ${timeoutMs} ms`);
          ctrl.abort(err);
          reject(err);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    parent?.removeEventListener('abort', onParentAbort);
  }
}

/**
 * Process items from an async iterable with bounded concurrency and backpressure:
 * at most `concurrency` items are in flight and the source is not pulled faster than that.
 */
export async function forEachConcurrent<T>(
  source: AsyncIterable<T> | Iterable<T>,
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const sem = new Semaphore(concurrency);
  const inflight = new Set<Promise<void>>();
  let index = 0;
  let firstError: unknown;
  for await (const item of source as AsyncIterable<T>) {
    if (signal?.aborted || firstError) break;
    const release = await sem.acquire(signal).catch(() => undefined);
    if (!release) break;
    const i = index++;
    const p = fn(item, i)
      .catch((e) => {
        firstError ??= e;
      })
      .finally(() => {
        release();
        inflight.delete(p);
      });
    inflight.add(p);
  }
  await Promise.all(inflight);
  if (firstError) throw firstError;
}

/** Throttle a callback so high-frequency events are delivered in batches. */
export function batcher<T>(flush: (items: T[]) => void, intervalMs = 50): { push(item: T): void; flush(): void } {
  let buf: T[] = [];
  let timer: NodeJS.Timeout | undefined;
  const doFlush = () => {
    timer = undefined;
    if (!buf.length) return;
    const items = buf;
    buf = [];
    flush(items);
  };
  return {
    push(item: T) {
      buf.push(item);
      if (!timer) timer = setTimeout(doFlush, intervalMs);
    },
    flush() {
      if (timer) clearTimeout(timer);
      doFlush();
    },
  };
}
