import type { LatencyStats } from '../model/types.js';

/** Log-bucket histogram: 64 buckets per octave, so a reported percentile is within 0.55 % of the true one. */
const BUCKETS_PER_OCTAVE = 64;
const MIN_TRACKED_MS = 0.001;
const MAX_BUCKET = Math.ceil(Math.log2(1e10) * BUCKETS_PER_OCTAVE);
const bucketOf = (v: number): number => (v <= MIN_TRACKED_MS ? 0 : Math.min(MAX_BUCKET, 1 + Math.floor(Math.log2(v / MIN_TRACKED_MS) * BUCKETS_PER_OCTAVE)));
const bucketMid = (b: number): number => (b === 0 ? 0 : MIN_TRACKED_MS * 2 ** ((b - 0.5) / BUCKETS_PER_OCTAVE));

export interface LatencyRecorderOptions {
  /**
   * Keep exact samples only up to this many; beyond it the recorder switches to a log-bucket histogram (percentiles within 0.55 %), drops the
   * samples and stays at constant memory and constant cost per snapshot. Default: exact for ever (reports); live load tests pass a limit.
   */
  exactUpTo?: number;
}

/**
 * Incremental latency aggregator. Stores samples in a growable Float64Array
 * (8 bytes/sample: one million samples ≈ 8 MB) so percentiles are exact, or - with `exactUpTo` - exact up to
 * that many samples and a log-bucket histogram after it (a live snapshot never sorts millions of samples).
 */
export class LatencyRecorder {
  private buf = new Float64Array(1024);
  private n = 0;
  private sum = 0;
  private minV = Infinity;
  private maxV = -Infinity;
  private readonly exactUpTo: number;
  private hist?: Uint32Array;
  /** Sorted copy of the exact samples, reused until the next record. */
  private sortedAt = -1;
  private sortedBuf?: Float64Array;

  constructor(opts: LatencyRecorderOptions = {}) {
    this.exactUpTo = opts.exactUpTo ?? Infinity;
  }

  record(v: number): void {
    if (!Number.isFinite(v)) return;
    if (this.hist) this.hist[bucketOf(v)]!++;
    else {
      if (this.n === this.buf.length) {
        const next = new Float64Array(this.buf.length * 2);
        next.set(this.buf);
        this.buf = next;
      }
      this.buf[this.n] = v;
      if (this.n + 1 > this.exactUpTo) this.toHistogram(v);
    }
    this.n++;
    this.sum += v;
    if (v < this.minV) this.minV = v;
    if (v > this.maxV) this.maxV = v;
  }

  /** Move the exact samples (the one just written at buf[n] included) into the histogram and free them. */
  private toHistogram(last: number): void {
    const h = new Uint32Array(MAX_BUCKET + 1);
    for (let i = 0; i < this.n; i++) h[bucketOf(this.buf[i]!)]!++;
    h[bucketOf(last)]!++;
    this.hist = h;
    this.buf = new Float64Array(0);
    this.sortedBuf = undefined;
  }

  get count(): number {
    return this.n;
  }

  /** True once the recorder holds a histogram instead of exact samples. */
  get approximate(): boolean {
    return !!this.hist;
  }

  stats(): LatencyStats {
    if (!this.n) return { count: 0, min: 0, max: 0, mean: 0, p50: 0, p90: 0, p95: 0, p99: 0 };
    const pct = this.hist ? (p: number) => this.histogramPercentile(p) : this.exactPercentile();
    return {
      count: this.n,
      min: round(this.minV),
      max: round(this.maxV),
      mean: round(this.sum / this.n),
      p50: round(pct(50)),
      p90: round(pct(90)),
      p95: round(pct(95)),
      p99: round(pct(99)),
    };
  }

  private exactPercentile(): (p: number) => number {
    if (this.sortedAt !== this.n || !this.sortedBuf) {
      this.sortedBuf = this.buf.slice(0, this.n).sort();
      this.sortedAt = this.n;
    }
    const sorted = this.sortedBuf;
    return (p) => percentile(sorted, p / 100)!;
  }

  private histogramPercentile(p: number): number {
    const target = Math.max(1, Math.ceil((p / 100) * this.n));
    const h = this.hist!;
    let seen = 0;
    for (let b = 0; b < h.length; b++) {
      seen += h[b]!;
      if (seen >= target) return Math.min(this.maxV, Math.max(this.minV, bucketMid(b)));
    }
    return this.maxV;
  }
}

/** Nearest-rank percentile of sorted values (p in 0..1). */
export function percentile(sorted: ArrayLike<number>, p: number): number | undefined {
  if (!sorted.length) return undefined;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/** The mean of the values (0 for none). */
export function mean(xs: readonly number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** The population standard deviation (0 for fewer than two values). */
export function stdev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

/** The median (the mean of the two middle values for an even count; NaN for none). */
export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function round(v: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

export { formatBytes, formatDuration, formatMs } from '@testpion/shared';
