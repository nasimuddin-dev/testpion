import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { formatMs, timeAgo } from '../lib/format';

interface Point {
  id: string;
  timestamp: string;
  status?: number | string;
  durationMs?: number;
}

const failed = (s: Point['status']) => typeof s !== 'number' || s >= 400;
const H = 64;
const PAD = { l: 34, r: 8, t: 8, b: 6 };

/**
 * Response time of a saved request over its recent responses (oldest → newest), with failed responses
 * marked. One series: the title names it, no legend. Hover a point for its time, status and date.
 */
export function LatencyTrend({ entries, onPick }: { entries: Point[]; onPick?(id: string): void }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(280);
  const [hover, setHover] = useState<number>();
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const pts = useMemo(() => [...entries].filter((e) => typeof e.durationMs === 'number').reverse(), [entries]);
  const stats = useMemo(() => {
    const ms = pts.map((p) => p.durationMs!).sort((a, b) => a - b);
    // nearest-rank, as responseTimeStats in core (CLI `testpion history stats`, MCP response_time_stats)
    const q = (f: number) => ms[Math.min(ms.length - 1, Math.max(0, Math.ceil(f * ms.length) - 1))];
    return { p50: q(0.5), p95: q(0.95), max: ms[ms.length - 1], fails: pts.filter((p) => failed(p.status)).length };
  }, [pts]);
  if (pts.length < 2) return null;

  const max = Math.max(...pts.map((p) => p.durationMs!)) || 1;
  const x = (i: number) => PAD.l + (i / (pts.length - 1)) * (w - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.durationMs!).toFixed(1)}`).join(' ');
  const h = hover !== undefined ? pts[hover] : undefined;

  return (
    <div className="px-2 pt-2 pb-1 border-b border-line shrink-0">
      <div className="flex items-baseline gap-2 text-xs whitespace-nowrap">
        <span className="font-medium text-fg">Response time</span>
        {stats.fails > 0 && <span className="ml-auto text-bad">{stats.fails} failed</span>}
      </div>
      <div className="text-xs text-muted tabular-nums whitespace-nowrap">
        median {formatMs(stats.p50)} · p95 {formatMs(stats.p95)} · slowest {formatMs(stats.max)}
      </div>
      <div ref={box} className="relative" onMouseLeave={() => setHover(undefined)}>
        <svg width={w} height={H} role="img" aria-label={`Response time of the last ${pts.length} responses: median ${formatMs(stats.p50)}, slowest ${formatMs(stats.max)}`}>
          {/* recessive axis: the max and the baseline */}
          <line x1={PAD.l} x2={w - PAD.r} y1={y(0)} y2={y(0)} stroke="var(--line)" />
          <line x1={PAD.l} x2={w - PAD.r} y1={y(max)} y2={y(max)} stroke="var(--line)" strokeDasharray="2 3" />
          <text x={PAD.l - 4} y={y(max) + 3} textAnchor="end" fontSize="9" fill="var(--muted)">
            {formatMs(max)}
          </text>
          <text x={PAD.l - 4} y={y(0)} textAnchor="end" fontSize="9" fill="var(--muted)">
            0
          </text>
          <path d={path} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {pts.map((p, i) => (
            <g key={p.id}>
              {/* failed responses: a red marker with a surface ring; the tooltip says why */}
              {(failed(p.status) || hover === i) && (
                <circle cx={x(i)} cy={y(p.durationMs!)} r={4} fill={failed(p.status) ? 'var(--bad)' : 'var(--accent)'} stroke="var(--bg)" strokeWidth={2} />
              )}
              {/* hit target larger than the mark */}
              <rect
                x={x(i) - Math.max(4, (w - PAD.l - PAD.r) / pts.length / 2)}
                y={0}
                width={Math.max(8, (w - PAD.l - PAD.r) / pts.length)}
                height={H}
                fill="transparent"
                className={onPick ? 'cursor-pointer' : undefined}
                onMouseEnter={() => setHover(i)}
                onClick={() => onPick?.(p.id)}
              />
            </g>
          ))}
          {h && <line x1={x(hover!)} x2={x(hover!)} y1={PAD.t} y2={y(0)} stroke="var(--line-strong)" strokeDasharray="2 2" pointerEvents="none" />}
        </svg>
        {h && (
          <div
            className="absolute z-10 pointer-events-none rounded-md border border-line bg-popover shadow-md px-2 py-1 text-xs whitespace-nowrap"
            // below the chart, so it never covers the header or the line being read
            style={{ top: H + 2, left: Math.min(Math.max(x(hover!) - 60, 0), w - 130) }}
          >
            <div className="tabular-nums text-fg font-medium">{formatMs(h.durationMs)}</div>
            <div className={failed(h.status) ? 'text-bad' : 'text-muted'}>
              {failed(h.status) ? `Failed · ${h.status ?? 'no status'}` : `Status ${h.status}`} · {timeAgo(h.timestamp)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
