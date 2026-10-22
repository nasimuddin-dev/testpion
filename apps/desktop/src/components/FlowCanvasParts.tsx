/**
 * The flow canvas's own parts (drawn by FlowDiagram, the one canvas): sticky notes, coloured frames around steps, the
 * minimap, the Start node (and the empty flow's suggestions), and where the hover card goes.
 */
import { plural } from '../lib/format';
import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Play, Plus, X } from 'lucide-react';
import type { FlowFrameBox, FlowFrameDef, FlowNote, FlowStep } from '@testpion/shared';
import { Markdown } from './Markdown';
import { fitText, type TextFont } from '../lib/fit-text';
import { Bar, cx, Menu, type MenuItem } from './ui';

/** A step's outline by the latest run's status. */
export const STATUS_STROKE: Record<string, string> = { passed: 'stroke-ok', failed: 'stroke-bad', error: 'stroke-bad', skipped: 'stroke-muted', running: 'stroke-accent' };

/** The theme's shade of a note's or frame's colour name (yellow, blue …; unknown names are yellow). */
export function flowColor(name: string | undefined): { stroke: string; fill: string; soft: string; paper: string; fold: string; tape: string } {
  const hue: Record<string, number> = { yellow: 100, blue: 250, green: 150, pink: 350, purple: 300, gray: 260 };
  const h = hue[name ?? 'yellow'] ?? 100;
  const c = name === 'gray' ? 0.01 : 0.14;
  return {
    stroke: `oklch(0.66 ${c} ${h})`,
    fill: `color-mix(in oklch, oklch(0.9 ${c * 0.8} ${h}) 42%, var(--panel))`,
    soft: `color-mix(in oklch, oklch(0.75 ${c} ${h}) 9%, transparent)`,
    // a sticky note's paper: the colour itself (mixed a little toward the theme, so text stays readable in dark mode)
    paper: `color-mix(in oklch, oklch(0.94 ${c * 0.85} ${h}) 90%, var(--panel))`,
    fold: `color-mix(in oklch, oklch(0.8 ${c} ${h}) 85%, var(--panel))`,
    tape: `color-mix(in oklch, oklch(0.97 0.01 ${h}) 55%, transparent)`,
  };
}

/** How much of a sticky note's bottom-right corner is folded over. */
const FOLD = 14;
/** Ink on a note's paper: the paper is light in both themes, so the text is dark in both. */
const NOTE_INK = 'oklch(0.27 0.03 265)';

/** Where the hover card goes: right of the step, or left of it when there is no room. */
export function previewPlace(view: { x: number; y: number; k: number }, n: { x: number; y: number; w: number }, width: number) {
  const right = view.x + (n.x + n.w) * view.k + 10;
  const left = right + 360 > width ? Math.max(4, view.x + n.x * view.k - 370) : right;
  return { left, top: Math.max(4, view.y + n.y * view.k) };
}

/**
 * A coloured frame with a title around steps (visual only: solid, unlike a parallel group's dashed frame); its title
 * drags its steps. Drawn in two parts: the body under the steps, the title over them (it can always be grabbed).
 */
export function UserFrame({ frame: f, editable, onMenu, part }: { frame: FlowFrameBox; editable?: boolean; onMenu?(frame: FlowFrameDef, at: { x: number; y: number }): void; part: 'body' | 'title' }) {
  const c = flowColor(f.color);
  const title = fitText(f.title, f.w - 24, F_FRAME_TITLE);
  const menu = onMenu
    ? (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        onMenu(f, { x: e.clientX, y: e.clientY });
      }
    : undefined;
  if (part === 'body')
    return (
      <g data-flow-frame-body={f.id} onContextMenu={menu}>
        <title>{`${f.title}: a frame around ${plural(f.steps.length, 'step')} (only drawn; it does not change how they run)${editable ? '. Drag its title to move them; right-click to rename, recolour or remove it' : ''}`}</title>
        <rect x={f.x} y={f.y} width={f.w} height={f.h} rx={14} style={{ fill: c.soft, stroke: c.stroke }} strokeWidth={1.5} />
      </g>
    );
  return (
    <g data-flow-frame={f.id} onContextMenu={menu}>
      <g data-flow-frame-handle={editable ? f.id : undefined} className={editable ? 'cursor-move' : undefined}>
        <rect x={f.x} y={f.y} width={f.w} height={FRAME_TITLE_H} rx={14} style={{ fill: c.stroke }} opacity={0.9} />
        <rect x={f.x} y={f.y + FRAME_TITLE_H - 8} width={f.w} height={8} style={{ fill: c.stroke }} opacity={0.9} />
        <text x={f.x + 12} y={f.y + 16} className="fill-bg text-xs font-semibold" data-flow-frame-title>
          {title}
        </text>
      </g>
    </g>
  );
}
const FRAME_TITLE_H = 22;
const F_FRAME_TITLE: TextFont = { size: 11.5, weight: 600 };

/** A sticky note: Markdown in a coloured box; in the designer double-click edits it, drag moves it, the corner resizes it. */
export function StickyNote({
  note: n,
  editable,
  editing,
  onEdit,
  onText,
  onMenu,
  selected,
}: {
  note: FlowNote;
  editable?: boolean;
  selected?: boolean;
  editing: boolean;
  onEdit(on: boolean): void;
  onText(text: string): void;
  onMenu?(note: FlowNote, at: { x: number; y: number }): void;
}) {
  const c = flowColor(n.color);
  const [draft, setDraft] = useState(n.text);
  useEffect(() => {
    if (editing) setDraft(n.text);
  }, [editing, n.text]);
  return (
    <g
      data-flow-note={n.id}
      data-selected={selected || undefined}
      className={editable ? 'cursor-move' : undefined}
      onDoubleClick={(e) => {
        if (!editable) return;
        e.stopPropagation();
        onEdit(true);
      }}
      onContextMenu={
        onMenu
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              onMenu(n, { x: e.clientX, y: e.clientY });
            }
          : undefined
      }
    >
      {/* a square of paper: a strip of tape across the top, the bottom-right corner folded over, a soft shadow */}
      <path
        d={`M ${n.x} ${n.y + 2} Q ${n.x} ${n.y} ${n.x + 2} ${n.y} H ${n.x + n.w - 2} Q ${n.x + n.w} ${n.y} ${n.x + n.w} ${n.y + 2} V ${n.y + n.h - FOLD} L ${n.x + n.w - FOLD} ${n.y + n.h} H ${n.x + 2} Q ${n.x} ${n.y + n.h} ${n.x} ${n.y + n.h - 2} Z`}
        style={{ fill: c.paper, stroke: c.stroke }}
        strokeWidth={0.75}
        filter="drop-shadow(0 3px 5px rgb(0 0 0 / 0.22))"
        data-flow-note-paper
      />
      {selected && <rect x={n.x - 4} y={n.y - 4} width={n.w + 8} height={n.h + 8} rx={6} className="fill-none stroke-accent pointer-events-none" strokeWidth={2} data-flow-note-selected />}
      <path d={`M ${n.x + n.w} ${n.y + n.h - FOLD} L ${n.x + n.w - FOLD} ${n.y + n.h - FOLD} L ${n.x + n.w - FOLD} ${n.y + n.h} Z`} style={{ fill: c.fold, stroke: c.stroke }} strokeWidth={0.75} />
      <rect x={n.x + n.w / 2 - 28} y={n.y - 6} width={56} height={13} rx={2} style={{ fill: c.tape }} transform={`rotate(-3 ${n.x + n.w / 2} ${n.y})`} />
      <foreignObject x={n.x} y={n.y + 6} width={n.w} height={Math.max(0, n.h - 6 - FOLD / 2)}>
        {editing ? (
          <textarea
            autoFocus
            aria-label="Note text (Markdown)"
            className="w-full h-full resize-none bg-transparent outline-none p-2 text-xs mono cursor-text"
            style={{ color: NOTE_INK }}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              onEdit(false);
              onText(draft);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') onEdit(false);
              else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) (e.target as HTMLTextAreaElement).blur();
            }}
          />
        ) : (
          <div
            className="w-full h-full overflow-hidden p-2 text-xs select-none"
            style={{ color: NOTE_INK }}
            title={editable ? 'Double-click to edit (Markdown) · drag to move · right-click for colour and delete' : undefined}
          >
            {n.text.trim() ? <Markdown source={n.text} className="text-xs" /> : <span className="italic opacity-60">{editable ? 'Double-click to write a note' : ''}</span>}
          </div>
        )}
      </foreignObject>
      {editable && !editing && (
        <path
          data-flow-note-resize
          d={`M ${n.x + n.w - 12} ${n.y + n.h - 3} L ${n.x + n.w - 3} ${n.y + n.h - 12} M ${n.x + n.w - 7} ${n.y + n.h - 3} L ${n.x + n.w - 3} ${n.y + n.h - 7}`}
          style={{ stroke: c.stroke }}
          strokeWidth={1.5}
          className="cursor-nwse-resize"
        >
          <title>Drag to resize</title>
        </path>
      )}
      {editable && !editing && <rect data-flow-note-resize x={n.x + n.w - 14} y={n.y + n.h - 14} width={14} height={14} className="fill-transparent cursor-nwse-resize" />}
    </g>
  );
}

/** The overview in the corner: the whole flow small, the part on screen as a rectangle; click or drag in it to move the view there. */
export function FlowMinimap({
  bounds: b,
  nodes,
  frames,
  notes,
  view,
  size,
  onCentre,
}: {
  bounds: { x0: number; y0: number; x1: number; y1: number };
  nodes: Array<{ id: string; x: number; y: number; w: number; h: number; step: FlowStep }>;
  frames: FlowFrameBox[];
  notes: FlowNote[];
  view: { x: number; y: number; k: number };
  size: { w: number; h: number };
  onCentre(x: number, y: number): void;
}) {
  const W = 180;
  const H = 120;
  const pad = 40;
  const x0 = b.x0 - pad;
  const y0 = b.y0 - pad;
  const s = Math.min(W / (b.x1 - b.x0 + pad * 2), H / (b.y1 - b.y0 + pad * 2));
  // the part on screen, kept inside the overview (when everything is on screen it outlines the whole overview)
  const sx = -view.x / view.k;
  const sy = -view.y / view.k;
  const ex = x0 + W / s;
  const ey = y0 + H / s;
  const vx = Math.min(Math.max(sx, x0), ex - 4 / s);
  const vy = Math.min(Math.max(sy, y0), ey - 4 / s);
  const vp = { x: vx, y: vy, w: Math.max(4 / s, Math.min(sx + size.w / view.k, ex) - vx), h: Math.max(4 / s, Math.min(sy + size.h / view.k, ey) - vy) };
  const ref = useRef<SVGSVGElement>(null);
  const dragging = useRef(false);
  const move = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    onCentre((e.clientX - r.left) / s + x0, (e.clientY - r.top) / s + y0);
  };
  return (
    <svg
      ref={ref}
      width={W}
      height={H}
      className="absolute top-2 right-2 rounded-md border border-line bg-panel/90 shadow cursor-pointer touch-none"
      data-flow-minimap
      aria-label="Overview of the flow: click or drag to move the view"
      onPointerDown={(e) => {
        e.stopPropagation();
        dragging.current = true;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // a synthetic pointer (tests)
        }
        move(e);
      }}
      onPointerMove={(e) => dragging.current && move(e)}
      onPointerUp={() => (dragging.current = false)}
      onPointerCancel={() => (dragging.current = false)}
    >
      <g transform={`scale(${s}) translate(${-x0} ${-y0})`}>
        <MinimapShapes frames={frames} notes={notes} nodes={nodes} s={s} />
        <rect data-flow-minimap-viewport x={vp.x} y={vp.y} width={vp.w} height={vp.h} className="fill-accent/10 stroke-accent" strokeWidth={1.5 / s} />
      </g>
    </svg>
  );
}

/** The overview's shapes: memoised, so panning and zooming the canvas redraws only the viewport rectangle. */
const MinimapShapes = memo(function MinimapShapes({
  frames,
  notes,
  nodes,
  s,
}: {
  frames: FlowFrameBox[];
  notes: FlowNote[];
  nodes: Array<{ id: string; x: number; y: number; w: number; h: number; step: FlowStep }>;
  s: number;
}) {
  return (
    <>
      {frames.map((f) => (
        <rect key={f.id} x={f.x} y={f.y} width={f.w} height={f.h} rx={10} style={{ fill: flowColor(f.color).soft, stroke: flowColor(f.color).stroke }} strokeWidth={2 / s} />
      ))}
      {notes.map((n) => (
        <rect key={n.id} x={n.x} y={n.y} width={n.w} height={n.h} style={{ fill: flowColor(n.color).fill }} />
      ))}
      {nodes.map((n) => (
        <rect
          key={n.id}
          x={n.x}
          y={n.y}
          width={n.w}
          height={n.h}
          rx={8}
          className={cx('fill-panel-2', n.step.status ? (STATUS_STROKE[n.step.status] ?? 'stroke-line-strong') : 'stroke-line-strong')}
          strokeWidth={3 / s}
        />
      ))}
    </>
  );
});

/** The Start node's place and size; its output port is on the right of its header. */
export const START_W = 250;
export const START_PORT_Y = 22;
// the header (44), the trigger row (32), the inputs' padding (8), each row (28 + a 4 gap), Add input (28) and 8 below
export const startHeight = (inputs: number) => 120 + inputs * 32;

/** One input of the flow on the Start node: a name, the value a run starts with, what it is. */
export interface StartInput {
  name: string;
  default?: unknown;
  description?: string;
}

/** What the designer gives the Start node: how the flow is triggered (and the menu to change it) and its inputs. */
export interface StartSpec {
  trigger: string;
  triggerItems: MenuItem[];
  inputs: StartInput[];
  onInputs?(inputs: StartInput[]): void;
  /** An empty flow's first choices, drawn as buttons hanging off the Start node's output. */
  suggestions?: Array<{ id: string; label: string; icon: ReactNode; tone: string; onClick(): void; title?: string }>;
}

const asText = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v));

/**
 * The Start of a flow (not a step: it is drawn from the file's header): how the flow runs (Manual, Schedule, Webhook,
 * MCP tool, CI) and its inputs (the values a run starts with). Steps that wait for nothing hang off its output.
 */
export function StartNode({ x, y, spec, editable }: { x: number; y: number; spec: StartSpec; editable?: boolean }) {
  const [rows, setRows] = useState(spec.inputs.map((i) => ({ name: i.name, value: asText(i.default) })));
  // as tall as the rows being edited (a new row shows before it is saved)
  const h = startHeight(rows.length);
  const key = JSON.stringify(spec.inputs);
  const box = useRef<HTMLDivElement>(null);
  // the file's inputs again (after a save, an undo): not while a row is being typed in
  useEffect(() => {
    if (!box.current?.contains(document.activeElement)) setRows(spec.inputs.map((i) => ({ name: i.name, value: asText(i.default) })));
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = (next = rows) => {
    const clean = next.filter((r) => r.name.trim());
    const same = clean.length === spec.inputs.length && clean.every((r, i) => r.name === spec.inputs[i]!.name && r.value === asText(spec.inputs[i]!.default));
    if (!same) spec.onInputs?.(clean.map((r) => ({ name: r.name.trim(), default: r.value, description: spec.inputs.find((i) => i.name === r.name)?.description })));
  };
  return (
    <g data-flow-start transform={`translate(${x} ${y})`}>
      <rect width={START_W} height={h} rx={10} className="fill-panel stroke-accent" strokeWidth={1.5} />
      <foreignObject x={0} y={0} width={START_W} height={h}>
        <div className="h-full flex flex-col text-xs text-fg select-none" onPointerDown={(e) => e.stopPropagation()}>
          <Bar>
            <span className="grid place-items-center w-6 h-6 rounded-md bg-accent text-bg">
              <Play size={12} />
            </span>
            <span className="font-semibold text-sm">Start</span>
          </Bar>
          <div className="px-3 pt-2 flex items-center gap-2">
            <span className="text-muted">Trigger</span>
            {editable ? (
              <Menu
                align="start"
                width={250}
                items={spec.triggerItems}
                trigger={
                  <button
                    className="ml-auto flex items-center gap-1 rounded border border-line px-2 h-6 hover:bg-hover max-w-[160px]"
                    data-flow-trigger
                    title="Change trigger: how this flow is started"
                  >
                    <span className="truncate">{spec.trigger}</span>
                    <ChevronDown size={12} className="shrink-0" />
                  </button>
                }
              />
            ) : (
              <span className="ml-auto truncate">{spec.trigger}</span>
            )}
          </div>
          <div
            ref={box}
            className="px-3 pt-2 grid gap-1"
            data-flow-inputs
            // saved when the focus leaves the inputs (moving from a name to its value is still typing)
            onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && commit()}
          >
            {rows.map((r, i) => (
              <div key={i} className="flex items-center gap-1" data-flow-input={r.name}>
                <input
                  aria-label="Input name"
                  className="field h-7 text-xs w-[90px] mono"
                  value={r.name}
                  placeholder="name"
                  readOnly={!editable}
                  onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))}
                  onKeyDown={(e) => e.key === 'Enter' && commit()}
                />
                <input
                  aria-label={`Default of ${r.name || 'the input'}`}
                  className="field h-7 text-xs flex-1 min-w-0"
                  value={r.value}
                  placeholder="default value"
                  title={spec.inputs[i]?.description}
                  readOnly={!editable}
                  onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, value: e.target.value } : x)))}
                  onKeyDown={(e) => e.key === 'Enter' && commit()}
                />
                {editable && (
                  <button
                    aria-label={`Remove input ${r.name}`}
                    className="grid place-items-center w-6 h-6 rounded text-muted hover:text-bad hover:bg-hover"
                    onClick={() => {
                      const next = rows.filter((_, k) => k !== i);
                      setRows(next);
                      commit(next);
                    }}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            ))}
            {editable && (
              <button
                className="flex items-center gap-1 text-accent hover:underline h-7 w-fit"
                data-flow-add-input
                title="An input of the flow: a variable every step can use as {{name}}, with the value a run starts with"
                onClick={() => setRows([...rows, { name: '', value: '' }])}
              >
                <Plus size={12} /> Add input
              </button>
            )}
          </div>
        </div>
      </foreignObject>
      <circle data-flow-port="out" data-flow-start-port cx={START_W} cy={START_PORT_Y} r={6} className="fill-accent stroke-panel cursor-crosshair" strokeWidth={1.5}>
        <title>Click to add a block after the start; drag onto a step: it then waits for nothing</title>
      </circle>
    </g>
  );
}

export const SUGGESTION_W = 210;
export const SUGGESTION_H = 40;
export const SUGGESTION_GAP = 14;

/** An empty flow's first choice, drawn like a node: an icon, a label, a colour. */
export function SuggestionNode({ x, y, s }: { x: number; y: number; s: NonNullable<StartSpec['suggestions']>[number] }) {
  return (
    <foreignObject x={x} y={y} width={SUGGESTION_W} height={SUGGESTION_H} data-flow-suggestion={s.id}>
      <button
        className="w-full h-full flex items-center gap-2 px-3 rounded-lg border bg-panel hover:bg-hover text-sm text-fg text-left"
        style={{ borderColor: s.tone }}
        title={s.title}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={s.onClick}
      >
        <span className="grid place-items-center w-6 h-6 rounded-md shrink-0" style={{ background: s.tone, color: 'var(--bg)' }}>
          {s.icon}
        </span>
        <span className="truncate">{s.label}</span>
      </button>
    </foreignObject>
  );
}
