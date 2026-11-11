import { useState } from 'react';
import { formatMs } from '../lib/format';
import { axisMs, ChartCard, ChartTip, niceMax, useWidth } from './charts';

export interface LoadPoint {
  t: number;
  rps: number;
  p95: number;
  errors: number;
  vus: number;
}

type Field = 'rps' | 'p95' | 'errors' | 'vus';
const FIELDS: Array<{ field: Field; label: string; color: string; format(v: number): string }> = [
  { field: 'rps', label: 'Requests / second', color: 'var(--accent)', format: (v) => String(Math.round(v)) },
  { field: 'p95', label: 'p95 latency', color: 'var(--judge)', format: (v) => formatMs(v) },
  { field: 'errors', label: 'Errors / second', color: 'var(--bad)', format: (v) => String(Math.round(v)) },
  { field: 'vus', label: 'Virtual users', color: 'var(--ok)', format: (v) => String(Math.round(v)) },
];

const H = 120;
const PAD = { l: 44, r: 8, t: 8, b: 18 };

/** One metric over the test's seconds; the crosshair (hover index) is shared by all four charts. */
function Series({ series, spec, hover, setHover }: { series: LoadPoint[]; spec: (typeof FIELDS)[number]; hover?: { i: number; field: Field }; setHover(h?: { i: number; field: Field }): void }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const vals = series.map((s) => s[spec.field]);
  const max = niceMax(Math.max(1, ...vals));
  const innerW = Math.max(0, width - PAD.l - PAD.r);
  const x = (i: number) => PAD.l + (series.length < 2 ? innerW / 2 : (i / (series.length - 1)) * innerW);
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  const line = series.map((s, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(s[spec.field]).toFixed(1)}`).join(' ');
  const area = series.length > 1 ? `${line} L${x(series.length - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z` : '';
  const last = vals[vals.length - 1] ?? 0;
  const onMove = (e: React.MouseEvent) => {
    if (series.length < 2 || !innerW) return;
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left - PAD.l;
    setHover({ i: Math.max(0, Math.min(series.length - 1, Math.round((px / innerW) * (series.length - 1)))), field: spec.field });
  };
  const i = hover?.i;
  const at = i !== undefined ? series[i] : undefined;
  return (
    <ChartCard
      title={spec.label}
      aside={
        <span>
          now <b className="text-fg tabular-nums">{spec.format(last)}</b> · max <b className="text-fg tabular-nums">{spec.format(Math.max(0, ...vals))}</b>
        </span>
      }
    >
      <div ref={ref} className="relative" onMouseMove={onMove} onMouseLeave={() => setHover(undefined)}>
        <svg width={width} height={H} role="img" aria-label={`${spec.label} over time`}>
          {[0, max / 2, max].map((t) => (
            <g key={t}>
              <line x1={PAD.l} x2={width - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
              <text x={PAD.l - 6} y={y(t) + 3} textAnchor="end" fontSize={10} fill="var(--muted)">
                {/* a half step (0.5 of at most 1) is said as it is, not rounded into a second "1" */}
                {t === 0 ? '0' : spec.field === 'p95' ? axisMs(t) : Number.isInteger(t) ? spec.format(t) : String(Math.round(t * 10) / 10)}
              </text>
            </g>
          ))}
          {area && <path d={area} fill={spec.color} opacity={0.12} />}
          {series.length > 1 && <path d={line} fill="none" stroke={spec.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
          {at && (
            <>
              <line x1={x(i!)} x2={x(i!)} y1={PAD.t} y2={H - PAD.b} stroke="var(--muted)" strokeWidth={1} />
              <circle cx={x(i!)} cy={y(at[spec.field])} r={4} fill={spec.color} stroke="var(--bg)" strokeWidth={2} />
            </>
          )}
          {series.length > 0 && (
            <>
              <text x={PAD.l} y={H - 4} fontSize={10} fill="var(--muted)">
                {series[0]!.t}s
              </text>
              <text x={width - PAD.r} y={H - 4} fontSize={10} fill="var(--muted)" textAnchor="end">
                {series[series.length - 1]!.t}s
              </text>
            </>
          )}
        </svg>
        {at && hover?.field === spec.field && (
          <ChartTip x={x(i!)} width={width}>
            <div className="font-medium text-fg">At {at.t}s</div>
            {FIELDS.map((f) => (
              <div key={f.field} className="flex items-center gap-1.5 text-muted">
                <span className="w-2 h-2 rounded-full" style={{ background: f.color }} />
                {f.label}: <span className="text-fg tabular-nums">{f.format(at[f.field])}</span>
              </div>
            ))}
          </ChartTip>
        )}
      </div>
    </ChartCard>
  );
}

/** Throughput, p95 latency, errors and virtual users over time, with one crosshair across all four. */
export function LoadTimeline({ series }: { series: LoadPoint[] }) {
  // the crosshair follows the mouse on every chart; the tooltip shows on the chart under it
  const [hover, setHover] = useState<{ i: number; field: Field }>();
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
      {FIELDS.map((f) => (
        <Series key={f.field} series={series} spec={f} hover={hover} setHover={setHover} />
      ))}
    </div>
  );
}

/** Colour of a status: 2xx/OK good, 3xx neutral, 4xx warning, 5xx and transport errors bad. */
const statusColor = (k: string) => (/^2/.test(k) || k === 'OK' ? 'var(--ok)' : /^3/.test(k) ? 'var(--accent)' : /^4/.test(k) ? 'var(--warn)' : 'var(--bad)');

/** Share of each status code as one proportional bar, then a labelled legend with counts and percentages. */
export function StatusCodes({ codes }: { codes: Record<string, number> }) {
  const rows = Object.entries(codes).sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((a, [, n]) => a + n, 0);
  const [hover, setHover] = useState<string>();
  if (!total) return null;
  const pct = (n: number) => `${Math.round((n / total) * 1000) / 10}%`;
  return (
    <ChartCard title="Status codes" aside={<span>{total.toLocaleString()} responses</span>}>
      <div className="flex h-4 gap-0.5" role="img" aria-label={rows.map(([k, n]) => `${k}: ${pct(n)}`).join(', ')} onMouseLeave={() => setHover(undefined)}>
        {rows.map(([k, n]) => (
          <span
            key={k}
            className="h-full rounded-sm transition-opacity"
            style={{ flex: n, minWidth: 3, background: statusColor(k), opacity: hover && hover !== k ? 0.45 : 1 }}
            title={`${k}: ${n.toLocaleString()} (${pct(n)})`}
            onMouseEnter={() => setHover(k)}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs">
        {rows.map(([k, n]) => (
          <span key={k} className={'inline-flex items-center gap-1.5 ' + (hover === k ? 'text-fg' : 'text-muted')} onMouseEnter={() => setHover(k)} onMouseLeave={() => setHover(undefined)}>
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: statusColor(k) }} />
            <span className="text-fg font-medium">{k}</span>
            <span className="tabular-nums">
              {n.toLocaleString()} · {pct(n)}
            </span>
          </span>
        ))}
      </div>
    </ChartCard>
  );
}
