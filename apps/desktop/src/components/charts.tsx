import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Width of an element, kept current (charts draw at their real size: round markers, crisp text). */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** A chart's frame: small caps title, an aside (headline number) and a legend row under the plot. */
export function ChartCard({ title, aside, legend, children, className }: { title: string; aside?: ReactNode; legend?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={'rounded-xl border border-line bg-panel/40 p-3 min-w-0 ' + (className ?? '')}>
      <div className="flex items-baseline gap-2 mb-2">
        <h3 className="text-xs font-semibold text-muted uppercase tracking-wide">{title}</h3>
        {aside && <div className="ml-auto text-xs text-muted">{aside}</div>}
      </div>
      {children}
      {legend && <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-xs text-muted">{legend}</div>}
    </section>
  );
}

export function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="w-2.5 h-2.5 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  );
}

/** A hover card positioned at x inside a chart of the given width. */
export function ChartTip({ x, width, children, top = 0 }: { x: number; width: number; children: ReactNode; top?: number }) {
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-10 rounded-lg border border-line bg-popover px-2.5 py-1.5 text-xs shadow-lg whitespace-nowrap"
      style={{ top, left: Math.max(0, Math.min(x + 12, width - 200)) }}
    >
      {children}
    </div>
  );
}

/**
 * Keyboard access to a chart's items: focus it (Tab), then ←/→ (Home/End) move the highlighted item and its
 * tooltip, Enter picks it, Escape leaves. Returns props for the chart's wrapper.
 */
export function chartKeys(count: number, hover: number | undefined, setHover: (i?: number) => void, onPick?: (i: number) => void) {
  return {
    tabIndex: count ? 0 : -1,
    onFocus: () => hover === undefined && count && setHover(count - 1),
    onBlur: () => setHover(undefined),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (!count) return;
      const i = hover ?? count - 1;
      const next = e.key === 'ArrowLeft' ? Math.max(0, i - 1) : e.key === 'ArrowRight' ? Math.min(count - 1, i + 1) : e.key === 'Home' ? 0 : e.key === 'End' ? count - 1 : undefined;
      if (next !== undefined) {
        e.preventDefault();
        setHover(next);
      } else if (e.key === 'Enter' && onPick && hover !== undefined) onPick(hover);
      else if (e.key === 'Escape') setHover(undefined);
    },
    className: 'outline-none focus-visible:ring-2 focus-visible:ring-accent/50 rounded',
  };
}

/** A round number at or above v (1, 2, 5 × 10ⁿ) for an axis maximum. */
export const niceMax = (v: number) => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
};

/** A duration for an axis tick: 250 ms, 1 s, 2.5 s (no trailing zeros). */
export const axisMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${Number((ms / 1000).toFixed(2))} s`);

/**
 * How long something took next to the others in a list, as a thin bar (log scale, so a few slow
 * items don't flatten the rest). Decorative: the number is always shown beside it.
 */
export function DurationBar({ ms, max, bad, className }: { ms: number; max: number; bad?: boolean; className?: string }) {
  const w = max > 0 ? Math.max(0.04, Math.log1p(Math.max(0, ms)) / Math.log1p(max)) : 0;
  return (
    <span aria-hidden className={'inline-block h-1 w-16 rounded-full bg-hover/70 overflow-hidden align-middle ' + (className ?? '')}>
      <span className="block h-full rounded-full" style={{ width: `${Math.min(1, w) * 100}%`, background: bad ? 'var(--bad)' : 'var(--accent)' }} />
    </span>
  );
}

/** Results of the latest runs as tiny blocks, oldest left (green passed, red failed or could not run). */
export function RecentRuns({ statuses, className }: { statuses: string[]; className?: string }) {
  if (!statuses.length) return null;
  const passed = statuses.filter((s) => s === 'passed').length;
  const label = statuses.length === 1 ? `The last run ${passed ? 'passed' : 'failed'}` : `${passed} of the last ${statuses.length} runs passed (oldest left)`;
  return (
    <span className={'inline-flex items-end gap-px h-3 shrink-0 ' + (className ?? '')} role="img" aria-label={label} title={label}>
      {statuses.map((s, i) => (
        <span key={i} className="w-[3px] h-full rounded-[1px]" style={{ background: s === 'passed' ? 'var(--ok)' : 'var(--bad)', opacity: 0.85 }} />
      ))}
    </span>
  );
}

/**
 * A metric across items (oldest left): one line, each point coloured by its item (e.g. passed / failed),
 * a crosshair and tooltip on hover, an optional dashed reference line (a median), labels under the ends.
 * One axis; the item under the mouse can be picked with a click.
 */
export function PointLine<T>({
  items,
  value,
  color,
  keyOf,
  axis,
  tip,
  ends,
  reference,
  label,
  height = 150,
  onPick,
}: {
  items: T[];
  value(d: T): number;
  color(d: T): string;
  keyOf(d: T): string;
  axis(v: number): string;
  tip(d: T): ReactNode;
  /** Text under the first and last point (e.g. "2h ago"). */
  ends?(d: T): string;
  reference?: number;
  label: string;
  height?: number;
  onPick?(d: T): void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number>();
  const H = height;
  const pad = { l: 48, r: 8, t: 8, b: ends ? 20 : 12 };
  const max = niceMax(Math.max(1, ...items.map(value)));
  const innerW = Math.max(0, width - pad.l - pad.r);
  const x = (i: number) => pad.l + (items.length < 2 ? innerW / 2 : (i / (items.length - 1)) * innerW);
  const y = (v: number) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  const path = items.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(value(d)).toFixed(1)}`).join(' ');
  const onMove = (e: React.MouseEvent) => {
    if (!items.length) return;
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
    let best = 0;
    for (let i = 1; i < items.length; i++) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    setHover(best);
  };
  return (
    <div
      ref={ref}
      {...chartKeys(items.length, hover, setHover, onPick && ((i) => onPick(items[i]!)))}
      className={'relative outline-none focus-visible:ring-2 focus-visible:ring-accent/50 rounded' + (onPick ? ' cursor-pointer' : '')}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(undefined)}
      onClick={() => hover !== undefined && items[hover] && onPick?.(items[hover]!)}
    >
      <svg width={width} height={H} role="img" aria-label={label}>
        {[0, max / 2, max].map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
            <text x={pad.l - 6} y={y(t) + 3} textAnchor="end" fontSize={10} fill="var(--muted)">
              {t === 0 ? '0' : axis(t)}
            </text>
          </g>
        ))}
        {reference !== undefined && items.length > 1 && <line x1={pad.l} x2={width - pad.r} y1={y(reference)} y2={y(reference)} stroke="var(--muted)" strokeDasharray="4 4" strokeWidth={1} />}
        {items.length > 1 && <path d={path} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
        {hover !== undefined && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} stroke="var(--muted)" strokeWidth={1} />}
        {items.map((d, i) => (
          <circle key={keyOf(d)} cx={x(i)} cy={y(value(d))} r={hover === i ? 5 : 4} fill={color(d)} stroke="var(--bg)" strokeWidth={2} />
        ))}
        {ends && items.length > 0 && (
          <>
            <text x={pad.l} y={H - 4} fontSize={10} fill="var(--muted)">
              {ends(items[0]!)}
            </text>
            <text x={width - pad.r} y={H - 4} fontSize={10} fill="var(--muted)" textAnchor="end">
              {ends(items[items.length - 1]!)}
            </text>
          </>
        )}
      </svg>
      {hover !== undefined && items[hover] && (
        <ChartTip x={x(hover)} width={width}>
          {tip(items[hover]!)}
        </ChartTip>
      )}
    </div>
  );
}

/**
 * Columns of passed (at the base) and failed (above, 2px apart) per item: days, latency ranges, runs.
 * Whole-number axis, the hovered column's tooltip, labels under the columns that `labelOf` names.
 */
export function StackedColumns<T>({
  items,
  ok,
  bad,
  keyOf,
  tip,
  label,
  labelOf,
  empty,
  emptyMark,
  height = 140,
  maxBar = 22,
}: {
  items: T[];
  ok(d: T): number;
  bad(d: T): number;
  keyOf(d: T): string;
  tip(d: T): ReactNode;
  label: string;
  /** Text under a column (undefined for none); `slot` is the column width in px. */
  labelOf?(d: T, i: number, n: number, slot: number): string | undefined;
  /** Shown in the middle when every column is empty. */
  empty?: string;
  /** Items drawn as a thin red mark even when empty (e.g. a run that could not start). */
  emptyMark?(d: T): boolean;
  height?: number;
  maxBar?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number>();
  const H = height;
  const pad = { l: 48, r: 6, t: 8, b: labelOf ? 20 : 8 };
  const max = Math.max(2, niceMax(Math.max(1, ...items.map((d) => ok(d) + bad(d)))));
  const innerW = Math.max(0, width - pad.l - pad.r);
  const slot = items.length ? innerW / items.length : 0;
  const bw = Math.max(2, Math.min(maxBar, slot * 0.72));
  const x = (i: number) => pad.l + slot * i + slot / 2;
  const base = H - pad.b;
  const h = (v: number) => (v / max) * (base - pad.t);
  const anything = items.some((d) => ok(d) + bad(d) > 0);
  return (
    <div ref={ref} {...chartKeys(items.length, hover, setHover)} className="relative outline-none focus-visible:ring-2 focus-visible:ring-accent/50 rounded" onMouseLeave={() => setHover(undefined)}>
      <svg width={width} height={H} role="img" aria-label={label}>
        {[0, Math.round(max / 2), max].map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={width - pad.r} y1={base - h(t)} y2={base - h(t)} stroke="var(--line)" strokeWidth={1} />
            <text x={pad.l - 6} y={base - h(t) + 3} textAnchor="end" fontSize={10} fill="var(--muted)">
              {t}
            </text>
          </g>
        ))}
        {items.map((d, i) => {
          const okH = h(ok(d));
          const badH = h(bad(d));
          const text = labelOf?.(d, i, items.length, slot);
          return (
            <g key={keyOf(d)} onMouseEnter={() => setHover(i)} opacity={hover === undefined || hover === i ? 1 : 0.5}>
              <rect x={pad.l + slot * i} y={pad.t} width={slot} height={base - pad.t} fill="transparent" />
              {okH > 0 && <rect x={x(i) - bw / 2} y={base - okH} width={bw} height={okH} rx={2} fill="var(--ok)" />}
              {badH > 0 && <rect x={x(i) - bw / 2} y={base - okH - badH - (okH > 0 ? 2 : 0)} width={bw} height={badH} rx={2} fill="var(--bad)" />}
              {!okH && !badH && emptyMark?.(d) && <rect x={x(i) - bw / 2} y={base - 2} width={bw} height={2} rx={1} fill="var(--bad)" />}
              {text !== undefined && (
                <text x={Math.min(Math.max(x(i), pad.l + 14), width - pad.r - 14)} y={H - 5} fontSize={10} fill="var(--muted)" textAnchor="middle">
                  {text}
                </text>
              )}
            </g>
          );
        })}
        {!anything && empty && (
          <text x={pad.l + innerW / 2} y={base / 2 + 4} textAnchor="middle" fontSize={11} fill="var(--muted)">
            {empty}
          </text>
        )}
      </svg>
      {hover !== undefined && items[hover] && (
        <ChartTip x={x(hover)} width={width}>
          {tip(items[hover]!)}
        </ChartTip>
      )}
    </div>
  );
}

/**
 * A labelled horizontal bar: segments (e.g. passed / failed / skipped, or one magnitude) side by side,
 * scaled to `of` (the largest row) so rows compare; the label left, a number right.
 */
export function BarRow({ label, segments, of, right, title, labelClass = 'w-20', rightClass = 'w-16' }: { label: ReactNode; segments: Array<{ value: number; color: string }>; of: number; right: ReactNode; title?: string; labelClass?: string; rightClass?: string }) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  return (
    <div className="flex items-center gap-2 text-xs" title={title}>
      <span className={'shrink-0 truncate text-muted ' + labelClass}>{label}</span>
      <span className="flex-1 h-3 rounded bg-hover/60 overflow-hidden">
        <span className="flex h-full gap-0.5" style={{ width: `${of > 0 ? (total / of) * 100 : 0}%` }}>
          {segments
            .filter((s) => s.value > 0)
            .map((s, i) => (
              <span key={i} className="h-full rounded-sm" style={{ flex: s.value, background: s.color }} />
            ))}
        </span>
      </span>
      <span className={'text-right tabular-nums text-fg shrink-0 ' + rightClass}>{right}</span>
    </div>
  );
}

/** A headline number: label, value (green / red when it says something good / bad) and a line of context. */
export function StatTile({ label, value, sub, tone }: { label: string; value: string; sub?: ReactNode; tone?: 'ok' | 'bad' }) {
  return (
    <div className="rounded-xl border border-line bg-panel/40 px-4 py-3 min-w-0">
      <div className="text-xs text-muted">{label}</div>
      <div className={'text-2xl font-semibold tabular-nums mt-0.5 ' + (tone === 'ok' ? 'text-ok' : tone === 'bad' ? 'text-bad' : '')}>{value}</div>
      {sub && <div className="text-xs text-muted mt-0.5 truncate">{sub}</div>}
    </div>
  );
}

/** When the messages of a stream arrived (ms from the start), as a tiny column sparkline, with the mean gap in its tooltip. */
export function ArrivalSpark({ times, buckets = 30 }: { times: number[]; buckets?: number }) {
  if (times.length < 2) return null;
  const end = Math.max(1, ...times);
  const counts = Array.from({ length: buckets }, () => 0);
  for (const t of times) counts[Math.min(buckets - 1, Math.floor((t / end) * buckets))]!++;
  const max = Math.max(1, ...counts);
  const sorted = [...times].sort((a, b) => a - b);
  const gap = (sorted[sorted.length - 1]! - sorted[0]!) / (sorted.length - 1);
  const label = `${times.length} messages over ${(end / 1000).toFixed(2)} s, ${gap < 1 ? 'arriving together' : `one every ${Math.round(gap)} ms on average`}`;
  return (
    <span className="inline-flex items-end gap-px h-4 w-[90px] shrink-0" role="img" aria-label={label} title={label}>
      {counts.map((c, i) => (
        <span key={i} className="flex-1 rounded-[1px] bg-accent" style={{ height: `${c ? Math.max(12, (c / max) * 100) : 0}%`, opacity: 0.85 }} />
      ))}
    </span>
  );
}
