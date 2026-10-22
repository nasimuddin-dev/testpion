import { AlertTriangle, ChevronDown, ChevronUp, CircleAlert, Maximize2, Minus, Plus, Search, X } from 'lucide-react';
import type { ReactNode, RefObject } from 'react';
import type { FlowCheck, FlowGroup, FlowNode } from '@testpion/shared';
import { Button, Callout, cx, IconButton } from './ui';
import { fitText, textWidth, type TextFont } from '../lib/fit-text';

/**
 * The pieces of the flow diagram (FlowDiagram.tsx) that need none of its state: a group's frame, the find box, the problems
 * strip, the zoom toolbar, and the two pure computations the canvas makes from its nodes (the find matches, where a dragged
 * step lands). FlowDiagram keeps the view, the pointer gestures and what is drawn.
 */

export const groupKey = (g: FlowGroup) => `${g.kind}:${g.name}`;
const F_LANE: TextFont = { size: 10, weight: 600 };
/** The overview's size (FlowMinimap): Fit keeps the flow out of its corner. */
export const MINIMAP_W = 180;
export const MINIMAP_H = 120;
/** The farthest out the view goes (Fit, the wheel, the zoom buttons): a long chain of steps still fits a narrow pane. */
export const MIN_ZOOM = 0.08;

/** A frame around a parallel group's steps, or the Finally lane; in the designer its label drags its steps. */
export function FlowFrame({ group: g, editable }: { group: FlowGroup; editable?: boolean }) {
  const fin = g.kind === 'finally';
  const label = fin ? 'Finally · runs last, whatever happened' : `parallel · ${g.name}`;
  // the pill as wide as its text, at most the frame's width; the text fitted inside it
  const text = fitText(label, Math.max(0, g.w - 16 - 14), F_LANE);
  const pill = Math.min(g.w - 16, textWidth(text, F_LANE) + 14);
  return (
    <g data-flow-group={groupKey(g)} data-flow-group-kind={g.kind}>
      <title>{fin ? 'Clean-up steps: they run after every other step of the flow, also after failures and a stop' : `Steps of the group "${g.name}" may run at the same time (what they wait for still applies)`}</title>
      <rect x={g.x} y={g.y} width={g.w} height={g.h} rx={12} className={cx(fin ? 'fill-warn/5 stroke-warn' : 'fill-accent/5 stroke-accent')} strokeWidth={1.25} strokeDasharray="6 4" />
      <g data-flow-group-handle={editable ? groupKey(g) : undefined} className={editable ? 'cursor-move' : undefined}>
        <rect x={g.x + 8} y={g.y + 3} width={Math.max(0, pill)} height={15} rx={7.5} className={fin ? 'fill-warn' : 'fill-accent'} />
        <text x={g.x + 15} y={g.y + 14} className="fill-bg text-[10px] font-semibold" data-flow-group-title>
          {text}
        </text>
      </g>
    </g>
  );
}

/** Ctrl+F: the ids of the steps whose name, URL, variable, type … hold every word of the query (in the order of the nodes). */
export function findMatches(nodes: FlowNode[], q: string): string[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return nodes
    .filter((n) => {
      const s = n.step;
      const hay = [s.name, s.id, s.type, s.method, s.url, s.message, s.if, s.flow, ...(s.uses ?? []).map((v) => `{{${v}}} ${v}`), ...(s.extract ?? []), ...(s.set ?? [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .map((n) => n.id);
}

/** The find box in the canvas's corner (Ctrl+F): type to search, Enter to the next match, Shift+Enter to the previous, Esc to close. */
export function FlowFindBar({
  query,
  inputRef,
  matches,
  current,
  onQuery,
  onJump,
  onClose,
}: {
  query: string;
  inputRef: RefObject<HTMLInputElement | null>;
  matches: string[];
  current: string | undefined;
  onQuery(q: string): void;
  onJump(dir: 1 | -1): void;
  onClose(): void;
}) {
  return (
    <div className="absolute top-2 left-2 flex items-center gap-1 rounded-md border border-line bg-popover shadow-lg px-1.5 py-1 text-xs" data-flow-find>
      <Search size={13} className="text-muted shrink-0" />
      <input
        ref={inputRef}
        aria-label="Find steps"
        className="bg-transparent outline-none w-48"
        placeholder="Find a step: name, URL, variable, type"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onJump(e.shiftKey ? -1 : 1);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      />
      <span className="text-muted tabular-nums whitespace-nowrap" data-flow-find-count>
        {query.trim() ? `${current ? matches.indexOf(current) + 1 : 0} of ${matches.length}` : ''}
      </span>
      <IconButton label="Previous match (Shift+Enter)" className="h-6 w-6" onClick={() => onJump(-1)} disabled={!matches.length} reason="No step matches">
        <ChevronUp size={13} />
      </IconButton>
      <IconButton label="Next match (Enter)" className="h-6 w-6" onClick={() => onJump(1)} disabled={!matches.length} reason="No step matches">
        <ChevronDown size={13} />
      </IconButton>
      <IconButton label="Close (Esc)" className="h-6 w-6" onClick={onClose}>
        <X size={13} />
      </IconButton>
    </div>
  );
}

/**
 * The checks as you edit (a strip under the canvas; a click selects the step), or, without checks, the layout's own
 * problems in a callout. Nothing when there is nothing to say.
 */
export function FlowProblems({ checks, problems, onPick }: { checks?: FlowCheck[]; problems: Array<{ message: string }>; onPick(step: string): void }) {
  return checks
    ? checks.length + problems.length > 0 && (
        <div className="absolute left-2 bottom-2 right-2 max-h-28 overflow-auto rounded-md border border-warn/40 bg-popover/95 shadow text-xs py-1" data-flow-checks role="list" aria-label="Problems">
          {problems.map((p, i) => (
            <div key={`p${i}`} className="flex items-center gap-2 px-2 py-0.5 text-warn">
              <AlertTriangle size={12} className="shrink-0" />
              <span>{p.message}</span>
            </div>
          ))}
          {checks.map((c, i) => (
            <button key={i} role="listitem" className="w-full flex items-center gap-2 px-2 py-0.5 text-left hover:bg-hover" data-flow-check={c.step} data-flow-check-kind={c.kind} title="Select the step" onClick={() => onPick(c.step)}>
              {c.severity === 'error' ? <CircleAlert size={12} className="shrink-0 text-bad" /> : <AlertTriangle size={12} className="shrink-0 text-warn" />}
              <span className="truncate">{c.message}</span>
            </button>
          ))}
        </div>
      )
    : problems.length > 0 && (
        <Callout tone="warn" className="absolute left-2 bottom-2 right-2 rounded-md px-3 py-2 text-xs grid gap-0.5" data-flow-problems>
          {problems.map((p, i) => (
            <div key={i}>{p.message}</div>
          ))}
        </Callout>
      );
}

/** The canvas under the designer's toolbar: its buttons on the left, the view's own (Deploy, zoom, Fit) whole on the right. */
export function FlowToolbarFrame({
  className,
  toolbar,
  toolbarRight,
  zoom,
  onZoom,
  onFit,
  children,
}: {
  className?: string;
  toolbar: ReactNode;
  toolbarRight?: ReactNode;
  /** The current zoom (1 = 100%). */
  zoom: number;
  onZoom(k: number): void;
  onFit(): void;
  children: ReactNode;
}) {
  return (
    <div className={cx('h-full w-full flex flex-col min-h-0', className)}>
      <div className="@container flex items-center gap-1 px-2 py-1.5 border-b border-line flex-nowrap overflow-hidden whitespace-nowrap shrink-0" data-flow-toolbar>
        {/* the designer's buttons take the room there is (they fold into their ⋯ menu); the view's own stay whole on the right */}
        <div className="flex-1 min-w-0 flex items-center gap-1 overflow-hidden">{toolbar}</div>
        <div className="flex items-center gap-1 shrink-0">
          {toolbarRight}
          <span className="hidden @[760px]:inline-flex">
            <IconButton label="Zoom out" className="h-7 w-7" onClick={() => onZoom(zoom / 1.25)} data-flow-zoom="out">
              <Minus size={13} />
            </IconButton>
          </span>
          <button type="button" className="hidden @[480px]:block h-7 min-w-11 px-1 rounded text-xs tabular-nums text-muted hover:bg-hover hover:text-fg" onClick={() => onZoom(1)} title="Zoom: click for 100%" aria-label="Zoom to 100%" data-flow-zoom-level>
            {Math.round(zoom * 100)}%
          </button>
          <span className="hidden @[760px]:inline-flex">
            <IconButton label="Zoom in" className="h-7 w-7" onClick={() => onZoom(zoom * 1.25)} data-flow-zoom="in">
              <Plus size={13} />
            </IconButton>
          </span>
          <Button size="sm" icon={<Maximize2 size={12} />} onClick={onFit} title="Show the whole flow" aria-label="Fit">
            <span className="hidden @[760px]:inline">Fit</span>
          </Button>
        </div>
      </div>
      {children}
    </div>
  );
}

/** Snap-to-grid step, and how close (in screen pixels) a dragged step must come to line up with another. */
export const GRID = 16;
const GUIDE_TOLERANCE = 6;

export interface PlacedDrag {
  dx: number;
  dy: number;
  lines: Array<{ x1: number; y1: number; x2: number; y2: number }>;
}

/**
 * Where the dragged steps go: lined up with another step when one is within a few pixels (a guide shows it), else on the grid
 * when snapping. `n` is the drag (its steps, the lead one, and whether it moves a frame's steps as one), `raw` how far the
 * pointer moved in the diagram's units, `k` the zoom.
 */
export function placeDragged(nodes: FlowNode[], byId: Map<string, FlowNode>, n: { ids: string[]; lead: string; frame?: boolean }, raw: { dx: number; dy: number }, k: number, snapTo: (v: number) => number): PlacedDrag {
  const lead = byId.get(n.lead);
  if (!lead) return { dx: raw.dx, dy: raw.dy, lines: [] };
  const tol = GUIDE_TOLERANCE / k;
  const px = lead.x + raw.dx;
  const py = lead.y + raw.dy;
  // a frame's or a group's steps move as one: lining their first step up with some other step means nothing
  const others = n.frame ? [] : nodes.filter((o) => !n.ids.includes(o.id));
  const anchors = (p: number, size: number) => [p, p + size / 2, p + size];
  let bx: { d: number; at: number; o: (typeof others)[number] } | undefined;
  let by: typeof bx;
  for (const o of others) {
    const mine = anchors(px, lead.w);
    const theirs = anchors(o.x, o.w);
    for (let i = 0; i < 3; i++) {
      const d = theirs[i]! - mine[i]!;
      if (Math.abs(d) < tol && (!bx || Math.abs(d) < Math.abs(bx.d))) bx = { d, at: theirs[i]!, o };
    }
    const mineY = anchors(py, lead.h);
    const theirsY = anchors(o.y, o.h);
    for (let i = 0; i < 3; i++) {
      const d = theirsY[i]! - mineY[i]!;
      if (Math.abs(d) < tol && (!by || Math.abs(d) < Math.abs(by.d))) by = { d, at: theirsY[i]!, o };
    }
  }
  const x = bx ? px + bx.d : snapTo(px);
  const y = by ? py + by.d : snapTo(py);
  const lines: PlacedDrag['lines'] = [];
  if (bx) lines.push({ x1: bx.at, y1: Math.min(y, bx.o.y) - 12, x2: bx.at, y2: Math.max(y + lead.h, bx.o.y + bx.o.h) + 12 });
  if (by) lines.push({ x1: Math.min(x, by.o.x) - 12, y1: by.at, x2: Math.max(x + lead.w, by.o.x + by.o.w) + 12, y2: by.at });
  return { dx: x - lead.x, dy: y - lead.y, lines };
}
