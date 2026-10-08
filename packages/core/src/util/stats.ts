import type { LatencyStats } from '../model/types.js';

/**
 * Incremental latency aggregator. Stores samples in a growable Float64Array
 * (8 bytes/sample: one million samples ≈ 8 MB) so percentiles are exact.
 */
export class LatencyRecorder {
  private buf = new Float64Array(1024);
  private n = 0;
  private sum = 0;
  private minV = Infinity;
  private maxV = -Infinity;

  record(v: number): void {
    if (!Number.isFinite(v)) return;
    if (this.n === this.buf.length) {
      const next = new Float64Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.n++] = v;
    this.sum += v;
    if (v < this.minV) this.minV = v;
    if (v > this.maxV) this.maxV = v;
  }

  get count(): number {
    return this.n;
  }

  stats(): LatencyStats {
    if (!this.n) return { count: 0, min: 0, max: 0, mean: 0, p50: 0, p90: 0, p95: 0, p99: 0 };
    const sorted = this.buf.slice(0, this.n).sort();
    const pct = (p: number) => percentile(sorted, p / 100)!;
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
}

/** Nearest-rank percentile of sorted values (p in 0..1). */
export function percentile(sorted: ArrayLike<number>, p: number): number | undefined {
  if (!sorted.length) return undefined;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

export function round(v: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

export { formatBytes, formatDuration, formatMs } from '@testpion/shared';
