import { Maximize2 } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { flowGraph, type FlowEdge, type FlowStep } from '@testpion/shared';
import { Button, Callout, cx } from './ui';
import { TEST_KINDS } from './TreeParts';

/** What is selected on an editable diagram: steps (several with Shift), or one edge. */
export interface FlowSelection {
  steps: string[];
  edge?: FlowEdge;
}

/**
 * A flow as a diagram: one node per step (name, type, method and URL, what it extracts, the latest result), an arrow
 * per `dependsOn` labelled with the variables that flow along it, laid out left to right by @testpion/shared's
 * flowGraph (or where the file's `layout:` puts each step). Drag the background to pan, the wheel zooms, Fit shows
 * everything. The one diagram of the app: read-only in a test file's Flow tab for a suite, and with `editable` the
 * canvas of the flow designer (FlowDesigner): ports to connect steps, drag to move them, click / Shift+click to
 * select steps or an edge, Delete to remove what is selected.
 */
export function FlowDiagram({
  steps,
  selected,
  onSelect,
  onOpenResult,
  className,
  editable,
  selection,
  onSelectionChange,
  onConnect,
  onMove,
  onDelete,
  onCanvasClick,
  onOpen,
  toolbar,
  fitKey,
}: {
  steps: FlowStep[];
  /** The id of the step drawn as chosen. */
  selected?: string;
  /** A click on a node. */
  onSelect?(step: FlowStep): void;
  /** A click on a node's result (its status and duration); when given, nodes with a result show it as a button. */
  onOpenResult?(step: FlowStep): void;
  className?: string;
  /** The designer's canvas: ports, dragging, selection of steps and edges. */
  editable?: boolean;
  selection?: FlowSelection;
  onSelectionChange?(s: FlowSelection): void;
  /** A drag from a step's output port to another step: `to` should wait for `from`. */
  onConnect?(from: string, to: string): void;
  /** Steps dragged to a new place (top-left corners, in the diagram's units). */
  onMove?(positions: Record<string, [number, number]>): void;
  /** Delete (or Backspace) with something selected. */
  onDelete?(): void;
  /** A click on the empty canvas, where (in the diagram's units): a new step can go there. */
  onCanvasClick?(at: [number, number]): void;
  /** A double-click on a node. */
  onOpen?(step: FlowStep): void;
  /** Buttons above the canvas, before Fit. */
  toolbar?: ReactNode;
  /** With it, the view fits again only when it (or the number of steps) changes: a designer that moves steps keeps its view. Without it, when the graph's size does. */
  fitKey?: string;
}) {
  const graph = useMemo(() => flowGraph(steps), [steps]);
  const box = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  // until the pane's size is known, the graph at its own size from the top left corner
  const [view, setView] = useState({ x: 32, y: 32, k: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const arrow = useId();
  // the pane's size, from a ResizeObserver: reading clientWidth right after mounting hundreds of nodes forced a layout
  const size = useRef<{ w: number; h: number }>(undefined);
  /** The current graph has been fitted to a known size. */
  const fitted = useRef(false);

  const fit = useCallback(() => {
    const s = size.current;
    if (!s || !graph.width) return;
    const pad = 32;
    const k = Math.min((s.w - pad * 2) / graph.width, (s.h - pad * 2) / graph.height, 1.4);
    const z = Math.max(k, 0.15);
    setView({ k: z, x: (s.w - graph.width * z) / 2, y: (s.h - graph.height * z) / 2 });
    fitted.current = true;
  }, [graph.width, graph.height]);
  const fitNow = useRef(fit);
  fitNow.current = fit;
  // a new graph (another file, more steps) fits the pane; a run that only recolours the nodes keeps the view
  // (in the designer, steps placed by hand keep the view too: it fits again for another file, or when steps are added or removed)
  const placed = steps.some((s) => s.position);
  const fitTrigger = fitKey === undefined ? fit : placed ? `${fitKey}|${graph.nodes.length}` : `${fitKey}|${graph.width}x${graph.height}`;
  useLayoutEffect(() => {
    fitted.current = false;
    fitNow.current();
  }, [fitTrigger]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width: w, height: h } = entry!.contentRect;
      if (!w || !h) return; // hidden: fit once it is shown
      size.current = { w, h };
      if (!fitted.current) fitNow.current();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
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

  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const chosen = useMemo(() => new Set(selection ? selection.steps : selected ? [selected] : []), [selection, selected]);
  const edgeKey = (e: FlowEdge) => `${e.from}>${e.to}`;
  const chosenEdge = selection?.edge ? edgeKey(selection.edge) : undefined;
  /** A pointer position in the diagram's units. */
  const toGraph = (clientX: number, clientY: number): [number, number] => {
    const r = svg.current!.getBoundingClientRect();
    const v = viewRef.current;
    return [(clientX - r.left - v.x) / v.k, (clientY - r.top - v.y) / v.k];
  };
  const capture = (e: React.PointerEvent<SVGSVGElement>) => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // a synthetic pointer (tests) has no capture; the events still arrive on the svg
    }
  };

  // drag the background to pan; in the designer, drag a node to move it (the selected ones with it), a port to connect
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved?: boolean } | undefined>(undefined);
  const nodeDrag = useRef<{ ids: string[]; x: number; y: number; moved: boolean } | undefined>(undefined);
  const [offset, setOffset] = useState<{ ids: Set<string>; dx: number; dy: number }>();
  const [link, setLink] = useState<{ from: string; x: number; y: number }>();
  const linkRef = useRef(link);
  linkRef.current = link;
  /** A click that ended a drag is not a click on the node. */
  const dragged = useRef(false);

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const t = e.target as Element;
    const node = t.closest('[data-flow-node]')?.getAttribute('data-flow-node') ?? undefined;
    if (editable) {
      box.current?.focus({ preventScroll: true });
      const port = t.closest('[data-flow-port="out"]');
      if (port && node) {
        const [x, y] = toGraph(e.clientX, e.clientY);
        setLink({ from: node, x, y });
        capture(e);
        return;
      }
      if (node) {
        nodeDrag.current = { ids: chosen.has(node) ? [...chosen] : [node], x: e.clientX, y: e.clientY, moved: false };
        capture(e);
        return;
      }
    }
    if (node || t.closest('[data-flow-edge-hit]')) return;
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    capture(e);
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (linkRef.current) {
      const [x, y] = toGraph(e.clientX, e.clientY);
      setLink({ ...linkRef.current, x, y });
      return;
    }
    const n = nodeDrag.current;
    if (n) {
      const k = viewRef.current.k;
      const dx = (e.clientX - n.x) / k;
      const dy = (e.clientY - n.y) / k;
      if (!n.moved && Math.hypot(e.clientX - n.x, e.clientY - n.y) < 4) return;
      n.moved = true;
      setOffset({ ids: new Set(n.ids), dx, dy });
      return;
    }
    const d = drag.current;
    if (d) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) >= 4) d.moved = true;
      setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
    }
  };
  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const l = linkRef.current;
    if (l) {
      setLink(undefined);
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-flow-node]')?.getAttribute('data-flow-node');
      if (target && target !== l.from) onConnect?.(l.from, target);
      return;
    }
    const n = nodeDrag.current;
    if (n) {
      nodeDrag.current = undefined;
      if (n.moved && offset) {
        // the click that ends the drag (if the browser sends one) is not a click on the node
        dragged.current = true;
        setTimeout(() => (dragged.current = false), 0);
        const out: Record<string, [number, number]> = {};
        for (const id of n.ids) {
          const at = byId.get(id);
          if (at) out[id] = [Math.max(0, Math.round(at.x + offset.dx)), Math.max(0, Math.round(at.y + offset.dy))];
        }
        onMove?.(out);
        // the node stays where it was dropped until the new layout arrives (or the move failed)
        setTimeout(() => setOffset(undefined), 3000);
      }
      return;
    }
    const d = drag.current;
    drag.current = undefined;
    if (editable && d && !d.moved && e.type === 'pointerup') {
      onSelectionChange?.({ steps: [] });
      onCanvasClick?.(toGraph(e.clientX, e.clientY));
    }
  };
  // the steps' places stay with the dropped offset until the new steps (with their new positions) come in
  useEffect(() => setOffset(undefined), [steps]);

  const clickNode = (s: FlowStep, e: React.MouseEvent) => {
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    if (editable) {
      const next = e.shiftKey ? (chosen.has(s.id) ? [...chosen].filter((x) => x !== s.id) : [...chosen, s.id]) : [s.id];
      onSelectionChange?.({ steps: next });
    }
    onSelect?.(s);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!editable || (e.key !== 'Delete' && e.key !== 'Backspace')) return;
    if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return;
    if (!chosen.size && !selection?.edge) return;
    e.preventDefault();
    onDelete?.();
  };

  const at = (id: string) => {
    const n = byId.get(id)!;
    return offset?.ids.has(id) ? { ...n, x: n.x + offset.dx, y: n.y + offset.dy } : n;
  };
  const canvas = (
    <div ref={box} className={cx('relative h-full w-full overflow-hidden bg-bg outline-none', !toolbar && className, !!toolbar && 'flex-1 min-h-0')} data-flow-diagram data-flow-editable={editable || undefined} tabIndex={editable ? -1 : undefined} onKeyDown={onKeyDown}>
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
            const a = at(e.from);
            const b = at(e.to);
            const x1 = a.x + a.w;
            const y1 = a.y + a.h / 2;
            const x2 = b.x;
            const y2 = b.y + b.h / 2;
            const dx = Math.max(24, Math.abs(x2 - x1) / 2);
            const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
            const key = edgeKey(e);
            const on = chosenEdge === key;
            const label = e.vars?.length ? e.vars.map((v) => `{{${v}}}`).join(' ') : '';
            return (
              <g key={key}>
                <path
                  data-flow-edge={key}
                  d={d}
                  className={cx('fill-none', on || (chosen.size && (chosen.has(e.from) || chosen.has(e.to))) ? 'stroke-accent' : 'stroke-line-strong')}
                  strokeWidth={on ? 2.5 : 1.5}
                  markerEnd={`url(#${arrow})`}
                />
                {editable && (
                  <path
                    data-flow-edge-hit={key}
                    d={d}
                    className="fill-none stroke-transparent cursor-pointer"
                    strokeWidth={12}
                    onClick={() => onSelectionChange?.({ steps: [], edge: { from: e.from, to: e.to } })}
                  >
                    <title>{`${e.to} waits for ${e.from}${label ? ` (${label})` : ''}: click to select, Delete removes it`}</title>
                  </path>
                )}
                {label && (
                  <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 6} textAnchor="middle" className="fill-accent stroke-bg text-[10px] mono pointer-events-none" strokeWidth={3} paintOrder="stroke" data-flow-edge-vars={key}>
                    {label.length > 32 ? `${label.slice(0, 31)}…` : label}
                  </text>
                )}
              </g>
            );
          })}
          {graph.nodes.map((n) => (
            <FlowNodeView
              key={n.id}
              node={offset?.ids.has(n.id) ? at(n.id) : n}
              selected={chosen.has(n.id)}
              editable={editable}
              onClick={clickNode}
              onOpen={onOpen}
              onSelect={onSelect}
              onOpenResult={onOpenResult}
            />
          ))}
          {link &&
            (() => {
              const a = byId.get(link.from)!;
              return <path d={`M ${a.x + a.w} ${a.y + a.h / 2} L ${link.x} ${link.y}`} className="fill-none stroke-accent pointer-events-none" strokeWidth={1.5} strokeDasharray="5 4" data-flow-link />;
            })()}
        </g>
      </svg>
      {!toolbar && (
        <div className="absolute top-2 right-2 flex items-center gap-1">
          <Button size="sm" icon={<Maximize2 size={12} />} onClick={fit} title="Show the whole flow">
            Fit
          </Button>
        </div>
      )}
      {graph.problems.length > 0 && (
        <Callout tone="warn" className="absolute left-2 bottom-2 right-2 rounded-md px-3 py-2 text-xs grid gap-0.5" data-flow-problems>
          {graph.problems.map((p, i) => (
            <div key={i}>{p.message}</div>
          ))}
        </Callout>
      )}
    </div>
  );
  if (!toolbar) return canvas;
  return (
    <div className={cx('h-full w-full flex flex-col min-h-0', className)}>
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-line flex-wrap shrink-0" data-flow-toolbar>
        {toolbar}
        <span className="flex-1" />
        <Button size="sm" icon={<Maximize2 size={12} />} onClick={fit} title="Show the whole flow">
          Fit
        </Button>
      </div>
      {canvas}
    </div>
  );
}

const STATUS_STROKE: Record<string, string> = { passed: 'stroke-ok', failed: 'stroke-bad', error: 'stroke-bad', skipped: 'stroke-muted', running: 'stroke-accent' };
const STATUS_FILL: Record<string, string> = { passed: 'fill-ok', failed: 'fill-bad', error: 'fill-bad', skipped: 'fill-muted', running: 'fill-accent' };
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function FlowNodeView({
  node: n,
  selected,
  editable,
  onClick,
  onOpen,
  onSelect,
  onOpenResult,
}: {
  node: ReturnType<typeof flowGraph>['nodes'][number];
  selected: boolean;
  editable?: boolean;
  onClick(s: FlowStep, e: React.MouseEvent): void;
  onOpen?(s: FlowStep): void;
  onSelect?(s: FlowStep): void;
  onOpenResult?(s: FlowStep): void;
}) {
  const s = n.step;
  const kind = TEST_KINDS[s.type] ?? [s.type.toUpperCase().slice(0, 4), 'text-muted'];
  const where = s.method && s.url ? s.url : s.type === 'delay' && s.ms !== undefined ? `wait ${s.ms} ms` : (s.url ?? '');
  const result = s.status && s.status !== 'running' ? `${s.status}${s.durationMs !== undefined ? ` · ${s.durationMs} ms` : ''}` : s.status === 'running' ? 'running…' : undefined;
  const missing = s.unresolved?.length ? s.unresolved : undefined;
  return (
    <g
      data-flow-node={s.id}
      data-status={s.status}
      data-selected={selected || undefined}
      transform={`translate(${n.x} ${n.y})`}
      className={cx('outline-none', editable ? 'cursor-move' : 'cursor-pointer')}
      role="button"
      tabIndex={0}
      aria-label={s.name}
      aria-pressed={editable ? selected : undefined}
      onClick={(e) => onClick(s, e)}
      onDoubleClick={() => onOpen?.(s)}
      onKeyDown={(e) => e.key === 'Enter' && (editable ? onOpen?.(s) : onSelect?.(s))}
    >
      <title>
        {[
          s.name,
          s.method && s.url ? `${s.method} ${s.url}` : s.type === 'delay' && s.ms !== undefined ? `waits ${s.ms} ms` : s.type,
          s.extract?.length ? `extracts ${s.extract.join(', ')}` : '',
          s.dependsOn?.length ? `after ${s.dependsOn.join(', ')}` : '',
          missing ? `reads ${missing.map((v) => `{{${v}}}`).join(', ')}, which no earlier step extracts and the environment does not define` : '',
          result ?? '',
          editable ? 'Drag to move · drag the right dot onto another step to connect · double-click opens it in the editor' : '',
        ]
          .filter(Boolean)
          .join('\n')}
      </title>
      <rect
        width={n.w}
        height={n.h}
        rx={8}
        className={cx('fill-panel', s.status ? (STATUS_STROKE[s.status] ?? 'stroke-line-strong') : 'stroke-line-strong', selected && 'stroke-accent')}
        strokeWidth={selected ? 2.5 : 1.5}
        strokeDasharray={s.status === 'skipped' ? '4 3' : undefined}
      />
      {s.status && <circle cx={14} cy={17} r={4} className={STATUS_FILL[s.status] ?? 'fill-muted'} />}
      <text x={s.status ? 24 : 12} y={21} className="fill-fg text-[13px] font-medium">
        {cut(s.name, (s.status ? 22 : 24) - (missing ? 3 : 0))}
      </text>
      {missing && (
        <g transform={`translate(${n.w - 16} 15)`} data-flow-unresolved={missing.join(',')}>
          <circle r={7} className="fill-warn" />
          <text y={3.5} textAnchor="middle" className="fill-bg text-[10px] font-bold">
            !
          </text>
        </g>
      )}
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
          className={cx('text-[11px] tabular-nums', s.status === 'passed' ? 'fill-ok' : s.status === 'skipped' || s.status === 'running' ? 'fill-muted' : 'fill-bad', onOpenResult && s.status !== 'running' && 'underline cursor-pointer')}
          onClick={(e) => {
            if (!onOpenResult || s.status === 'running') return;
            e.stopPropagation();
            onOpenResult(s);
          }}
        >
          {result}
        </text>
      )}
      {editable && (
        <>
          <circle data-flow-port="in" cx={0} cy={n.h / 2} r={5} className="fill-panel stroke-line-strong" strokeWidth={1.5}>
            <title>Input: drop a connection here</title>
          </circle>
          <circle data-flow-port="out" cx={n.w} cy={n.h / 2} r={6} className="fill-accent stroke-panel cursor-crosshair" strokeWidth={1.5}>
            <title>Drag onto another step: it then waits for this one</title>
          </circle>
        </>
      )}
    </g>
  );
}
