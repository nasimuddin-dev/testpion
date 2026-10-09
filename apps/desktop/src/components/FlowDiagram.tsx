import { Maximize2 } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flowGraph, type FlowStep } from '@testpion/shared';
import { Button, Callout, cx } from './ui';
import { TEST_KINDS } from './TreeParts';

/**
 * A flow as a read-only diagram: one node per step (name, type, method and URL, what it extracts, the latest result),
 * an arrow per `dependsOn`, laid out left to right by @testpion/shared's flowGraph. Drag the background to pan, the
 * wheel zooms, Fit shows everything. The one diagram of the app: a test file's Flow tab today, a suite or a
 * collection's folders later.
 */
export function FlowDiagram({
  steps,
  selected,
  onSelect,
  onOpenResult,
  className,
}: {
  steps: FlowStep[];
  /** The id of the step drawn as chosen. */
  selected?: string;
  /** A click on a node. */
  onSelect?(step: FlowStep): void;
  /** A click on a node's result (its status and duration); when given, nodes with a result show it as a button. */
  onOpenResult?(step: FlowStep): void;
  className?: string;
}) {
  const graph = useMemo(() => flowGraph(steps), [steps]);
  const box = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const arrow = useId();

  const fit = useCallback(() => {
    const el = box.current;
    if (!el || !graph.width) return;
    const pad = 32;
    const k = Math.min((el.clientWidth - pad * 2) / graph.width, (el.clientHeight - pad * 2) / graph.height, 1.4);
    const s = Math.max(k, 0.15);
    setView({ k: s, x: (el.clientWidth - graph.width * s) / 2, y: (el.clientHeight - graph.height * s) / 2 });
  }, [graph.width, graph.height]);
  // a new graph (another file, more steps) fits the pane; a run that only recolours the nodes keeps the view
  useLayoutEffect(fit, [fit]);
  // the wheel zooms around the pointer (a native listener: React's is passive and could not stop the page scrolling)
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      setView((v) => {
        const k = Math.min(4, Math.max(0.15, v.k * Math.exp(-e.deltaY * 0.0015)));
        return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  // drag the background to pan
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | undefined>(undefined);
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || (e.target as Element).closest('[data-flow-node]')) return;
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (d) setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
  };
  const onPointerUp = () => (drag.current = undefined);

  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  return (
    <div ref={box} className={cx('relative h-full w-full overflow-hidden bg-bg', className)} data-flow-diagram>
      <svg
        ref={svg}
        className={cx('h-full w-full select-none touch-none', drag.current ? 'cursor-grabbing' : 'cursor-grab')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        role="img"
        aria-label={`Flow of ${graph.nodes.length} steps`}
      >
        <defs>
          <marker id={arrow} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted" />
          </marker>
        </defs>
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {graph.edges.map((e) => {
            const a = byId.get(e.from)!;
            const b = byId.get(e.to)!;
            const x1 = a.x + a.w;
            const y1 = a.y + a.h / 2;
            const x2 = b.x;
            const y2 = b.y + b.h / 2;
            const dx = Math.max(24, (x2 - x1) / 2);
            return (
              <path
                key={`${e.from}>${e.to}`}
                data-flow-edge={`${e.from}>${e.to}`}
                d={`M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`}
                className={cx('fill-none', selected && (selected === e.from || selected === e.to) ? 'stroke-accent' : 'stroke-line-strong')}
                strokeWidth={1.5}
                markerEnd={`url(#${arrow})`}
              />
            );
          })}
          {graph.nodes.map((n) => (
            <FlowNodeView key={n.id} node={n} selected={selected === n.id} onSelect={onSelect} onOpenResult={onOpenResult} />
          ))}
        </g>
      </svg>
      <div className="absolute top-2 right-2 flex items-center gap-1">
        <Button size="sm" icon={<Maximize2 size={12} />} onClick={fit} title="Show the whole flow">
          Fit
        </Button>
      </div>
      {graph.problems.length > 0 && (
        <Callout tone="warn" className="absolute left-2 bottom-2 right-2 rounded-md px-3 py-2 text-xs grid gap-0.5" data-flow-problems>
          {graph.problems.map((p, i) => (
            <div key={i}>{p.message}</div>
          ))}
        </Callout>
      )}
    </div>
  );
}

const STATUS_STROKE: Record<string, string> = { passed: 'stroke-ok', failed: 'stroke-bad', error: 'stroke-bad', skipped: 'stroke-muted' };
const STATUS_FILL: Record<string, string> = { passed: 'fill-ok', failed: 'fill-bad', error: 'fill-bad', skipped: 'fill-muted' };
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function FlowNodeView({
  node: n,
  selected,
  onSelect,
  onOpenResult,
}: {
  node: ReturnType<typeof flowGraph>['nodes'][number];
  selected: boolean;
  onSelect?(s: FlowStep): void;
  onOpenResult?(s: FlowStep): void;
}) {
  const s = n.step;
  const kind = TEST_KINDS[s.type] ?? [s.type.toUpperCase().slice(0, 4), 'text-muted'];
  const where = s.method && s.url ? s.url : (s.url ?? '');
  const result = s.status ? `${s.status}${s.durationMs !== undefined ? ` · ${s.durationMs} ms` : ''}` : undefined;
  return (
    <g
      data-flow-node={s.id}
      data-status={s.status}
      transform={`translate(${n.x} ${n.y})`}
      className="cursor-pointer outline-none"
      role="button"
      tabIndex={0}
      aria-label={s.name}
      onClick={() => onSelect?.(s)}
      onKeyDown={(e) => e.key === 'Enter' && onSelect?.(s)}
    >
      <title>
        {[
          s.name,
          s.method && s.url ? `${s.method} ${s.url}` : s.type,
          s.extract?.length ? `extracts ${s.extract.join(', ')}` : '',
          s.dependsOn?.length ? `after ${s.dependsOn.join(', ')}` : '',
          result ?? '',
        ]
          .filter(Boolean)
          .join('\n')}
      </title>
      <rect
        width={n.w}
        height={n.h}
        rx={8}
        className={cx('fill-panel', s.status ? (STATUS_STROKE[s.status] ?? 'stroke-line-strong') : 'stroke-line-strong', selected && 'stroke-accent')}
        strokeWidth={selected ? 2 : 1.5}
        strokeDasharray={s.status === 'skipped' ? '4 3' : undefined}
      />
      {s.status && <circle cx={14} cy={17} r={4} className={STATUS_FILL[s.status] ?? 'fill-muted'} />}
      <text x={s.status ? 24 : 12} y={21} className="fill-fg text-[13px] font-medium">
        {cut(s.name, s.status ? 22 : 24)}
      </text>
      <text x={12} y={42} className="text-[11px] mono">
        <tspan className={kind[1]} fill="currentColor" fontWeight="bold">
          {kind[0]}
        </tspan>
        {s.method && (
          <tspan dx={8} className={s.type === 'http' ? `method-${s.method}` : 'fill-muted'} fill="currentColor">
            {s.method}
          </tspan>
        )}
        <tspan dx={6} className="fill-muted">
          {cut(where, s.method ? 20 : 26)}
        </tspan>
      </text>
      <text x={12} y={60} className="fill-muted text-[11px]">
        {s.extract?.length ? `→ ${cut(s.extract.join(', '), result ? 14 : 28)}` : s.dependsOn?.length ? `after ${cut(s.dependsOn.join(', '), result ? 12 : 26)}` : ''}
      </text>
      {result && (
        <text
          x={n.w - 10}
          y={60}
          textAnchor="end"
          data-flow-result
          className={cx('text-[11px] tabular-nums', s.status === 'passed' ? 'fill-ok' : s.status === 'skipped' ? 'fill-muted' : 'fill-bad', onOpenResult && 'underline cursor-pointer')}
          onClick={(e) => {
            if (!onOpenResult) return;
            e.stopPropagation();
            onOpenResult(s);
          }}
        >
          {result}
        </text>
      )}
    </g>
  );
}
