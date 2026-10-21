import { Maximize2 } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import {
  flowGraph,
  flowGroups,
  frameBoxes,
  type FlowCheck,
  type FlowEdge,
  type FlowFrameDef,
  type FlowGroup,
  type FlowNote,
  type FlowStep,
} from '@testpion/shared';
import { Button, cx } from './ui';
import { clearTextFit } from '../lib/fit-text';
import {
  FlowMinimap,
  previewPlace,
  START_PORT_Y,
  START_W,
  StartNode,
  startHeight,
  StickyNote,
  SUGGESTION_GAP,
  SUGGESTION_H,
  SUGGESTION_W,
  SuggestionNode,
  UserFrame,
  type StartSpec,
} from './FlowCanvasParts';

/** The id a connection from the Start node comes from (not a step). */
export const FLOW_START = '__start';
import { FlowEdgeView, FlowNodeView, portY } from './FlowNode';
import { DropHintLayer, useFlowDrop, type FlowDropEvent } from './FlowDrop';
import { findMatches, FlowFindBar, FlowFrame, FlowProblems, FlowToolbarFrame, GRID, groupKey, placeDragged } from './FlowDiagramParts';
import { useCanvasView, viewTransform } from './use-canvas-view';

/** What is selected on an editable diagram: steps and notes (several with Shift or a Shift-drag box), or one edge. */
export interface FlowSelection {
  steps: string[];
  edge?: FlowEdge;
  notes?: string[];
}

/** The flow debugger's marks on a step: a breakpoint, a pinned response, the step a debugged run is paused before. */
export interface FlowMark {
  breakpoint?: boolean;
  pinned?: boolean;
  paused?: boolean;
}

/** What the designer can ask of its canvas (the toolbar and the command palette). */
export interface FlowDiagramApi {
  fit(): void;
  /** Open the search box (Ctrl+F). */
  find(): void;
  /** Pan and zoom so a step is in the middle of the view. */
  reveal(id: string): void;
  /** The middle of the view, in the diagram's units (where a new note goes). */
  centre(): [number, number];
  /** Give the canvas the keyboard focus (after an edit whose button or step went away). */
  focus(): void;
}

/**
 * A callback that keeps its identity across renders while calling the latest function (undefined stays undefined): the
 * memoised nodes then re-render only when their own props change, not on every hover, drag frame or zoom of the canvas.
 */
function useStable<A extends unknown[], R>(fn: ((...a: A) => R) | undefined): ((...a: A) => R) | undefined {
  const ref = useRef(fn);
  ref.current = fn;
  const stable = useMemo(() => (...a: A) => ref.current!(...a), []);
  return fn ? stable : undefined;
}

/** Below this zoom the steps are drawn compact (their details would be a few pixels high). */
const COMPACT_BELOW = 0.38;
const NO_NOTES: FlowNote[] = [];

/** How far (screen pixels) a press must move to become a drag; less, it is a click (or a double-click). */
const DRAG_THRESHOLD = 3;


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
  onCanvasClick,
  onOpen,
  toolbar,
  fitKey,
  marks,
  onNodeMenu,
  onGroupDrop,
  notes,
  frames,
  onNoteChange,
  onNoteMenu,
  onFrameMenu,
  onCanvasDoubleClick,
  checks,
  minimap,
  snap,
  renderPreview,
  apiRef,
  start,
  onPortClick,
  toolbarRight,
  onDropItems,
  onEdgeMenu,
  onCanvasMenu,
  onGroupMenu,
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
  /** A drag from a step's output port to another step: `to` should wait for `from` (from a condition's true or false port: on that branch). */
  onConnect?(from: string, to: string, when?: boolean): void;
  /** Steps dragged to a new place (top-left corners, in the diagram's units). */
  onMove?(positions: Record<string, [number, number]>): void;
  /** A click on the empty canvas, where (in the diagram's units): a new step can go there. */
  onCanvasClick?(at: [number, number]): void;
  /** A double-click on a node. */
  onOpen?(step: FlowStep): void;
  /** Buttons above the canvas, before Fit. */
  toolbar?: ReactNode;
  /** With it, the view fits again only when it (or the number of steps) changes: a designer that moves steps keeps its view. Without it, when the graph's size does. */
  fitKey?: string;
  /** Breakpoints, pins and the paused step, by step id (the flow debugger). */
  marks?: Record<string, FlowMark>;
  /** A right-click on a node, where (in the window): the designer opens the step's menu there. */
  onNodeMenu?(step: FlowStep, at: { x: number; y: number }): void;
  /** Steps dropped into a frame they were not in (and where all the dragged steps were dropped): the designer puts them in that parallel group (or the Finally lane). */
  onGroupDrop?(ids: string[], group: FlowGroup, positions: Record<string, [number, number]>): void;
  /** Sticky notes (Markdown) and coloured frames around steps: the file's layout.notes / layout.frames. */
  notes?: FlowNote[];
  frames?: FlowFrameDef[];
  /** A note moved, resized or edited (double-click edits its text). */
  onNoteChange?(id: string, set: Partial<Omit<FlowNote, 'id'>>): void;
  /** A right-click on a note or a frame's title, where (in the window). */
  onNoteMenu?(note: FlowNote, at: { x: number; y: number }): void;
  onFrameMenu?(frame: FlowFrameDef, at: { x: number; y: number }): void;
  /** A double-click on the empty canvas: where (in the diagram's units and in the window). */
  onCanvasDoubleClick?(at: [number, number], client: { x: number; y: number }): void;
  /** The checks as you edit: shown in a strip under the canvas (a click selects the step) and as marks on nodes and edges. */
  checks?: FlowCheck[];
  /** Show the overview in the corner (hidden for flows of 8 steps or fewer). */
  minimap?: boolean;
  /** Snap dragged steps and notes to a 16 px grid (lining up with another step wins). */
  snap?: boolean;
  /** What hovering a step for 400 ms shows (its last result). */
  renderPreview?(step: FlowStep): ReactNode;
  /** Filled with what the designer can ask of the canvas: fit, find, reveal a step. */
  apiRef?: MutableRefObject<FlowDiagramApi | undefined>;
  /** The Start node on the left (the flow's trigger and inputs); steps that wait for nothing hang off it. */
  start?: StartSpec;
  /** A click on an output port (or its +, or a connection dropped on the empty canvas): the designer opens the block picker there. */
  onPortClick?(from: string, when: boolean | undefined, at: { x: number; y: number }): void;
  /** Buttons at the right end of the toolbar, before Fit (Deploy). */
  toolbarRight?: ReactNode;
  /** Items or a palette block dropped on the canvas (FlowDrop): the designer adds them where they landed. */
  onDropItems?(d: FlowDropEvent): void;
  /** A right-click on an edge, on the empty canvas (where, in the diagram's units too) and on a parallel group's or the Finally lane's label. */
  onEdgeMenu?(edge: FlowEdge, at: { x: number; y: number }): void;
  onCanvasMenu?(at: [number, number], client: { x: number; y: number }): void;
  onGroupMenu?(group: FlowGroup, at: { x: number; y: number }): void;
}) {
  const graph = useMemo(() => flowGraph(steps), [steps]);
  // the web fonts loaded: every label is fitted again with their real widths (once)
  const [fonts, setFonts] = useState(0);
  useEffect(() => {
    let live = true;
    void document.fonts?.ready.then(() => {
      if (!live) return;
      clearTextFit();
      setFonts((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, []);
  const arrow = useId();

  const boxes = useMemo(() => frameBoxes(graph.nodes, frames), [graph.nodes, frames]);
  // the Start node: left of the steps, level with the ones that wait for nothing (an empty flow: with its suggestions)
  const hasStart = !!start;
  const startInputs = start?.inputs.length ?? 0;
  const startBox = useMemo(() => {
    if (!hasStart) return undefined;
    const h = startHeight(startInputs);
    if (!graph.nodes.length) return { x: 0, y: 0, w: START_W, h };
    const waiting = new Set(graph.edges.map((e) => e.to));
    const roots = graph.nodes.filter((n) => !waiting.has(n.id) && !n.step.finally);
    const level = roots.length ? roots : graph.nodes;
    const cy = level.reduce((sum, n) => sum + n.y + n.h / 2, 0) / level.length;
    return { x: Math.min(...graph.nodes.map((n) => n.x)) - START_W - 96, y: Math.round(cy - START_PORT_Y), w: START_W, h };
  }, [hasStart, startInputs, graph]);
  const rootIds = useMemo(() => {
    const waiting = new Set(graph.edges.map((e) => e.to));
    return graph.nodes.filter((n) => !waiting.has(n.id) && !n.step.finally && !n.step.dependsOn?.length).map((n) => n.id);
  }, [graph]);
  const suggestionBoxes = useMemo(() => {
    const list = !graph.nodes.length && startBox ? (start?.suggestions ?? []) : [];
    const total = list.length * SUGGESTION_H + (list.length - 1) * SUGGESTION_GAP;
    return list.map((s, i) => ({ s, x: START_W + 110, y: START_PORT_Y - total / 2 + i * (SUGGESTION_H + SUGGESTION_GAP), w: SUGGESTION_W, h: SUGGESTION_H }));
  }, [graph.nodes.length, startBox, start?.suggestions]);
  /** Everything drawn: the steps, their frames and the notes (a frame or a note may lie left of or above the steps), the Start node. */
  const bounds = useMemo(() => {
    const rects = [...graph.nodes, ...graph.groups, ...boxes, ...(notes ?? []), ...(startBox ? [startBox] : []), ...suggestionBoxes];
    if (!rects.length) return { x0: 0, y0: 0, x1: graph.width, y1: graph.height };
    return {
      x0: Math.min(0, ...rects.map((r) => r.x)),
      y0: Math.min(0, ...rects.map((r) => r.y)),
      x1: Math.max(graph.width, ...rects.map((r) => r.x + r.w)),
      y1: Math.max(graph.height, ...rects.map((r) => r.y + r.h)),
    };
  }, [graph, boxes, notes, startBox, suggestionBoxes]);
  // the view: pan, zoom, fit (use-canvas-view.ts); the flow fits again for another file, or when steps are added or removed
  const placed = steps.some((s) => s.position);
  const { box, svg, view, viewRef, size, setView, moveView, fit, zoomTo } = useCanvasView({
    bounds,
    minimap: !!minimap && graph.nodes.length > 8,
    fitSignature: fitKey === undefined ? undefined : placed ? `${fitKey}|${graph.nodes.length}` : `${fitKey}|${graph.width}x${graph.height}`,
  });

  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const chosen = useMemo(() => new Set(selection ? selection.steps : selected ? [selected] : []), [selection, selected]);
  const edgeKey = (e: FlowEdge) => `${e.from}>${e.to}`;
  const chosenEdge = selection?.edge ? edgeKey(selection.edge) : undefined;
  const chosenNotes = useMemo(() => new Set(selection?.notes ?? []), [selection?.notes]);
  /** A pointer position in the diagram's units. */
  const toGraph = (clientX: number, clientY: number): [number, number] => {
    const r = (box.current ?? svg.current!).getBoundingClientRect();
    const v = viewRef.current;
    return [(clientX - r.left - v.x) / v.k, (clientY - r.top - v.y) / v.k];
  };
  /**
   * A press on the canvas (a step, a note, a frame's title, a port, the background) becomes a drag only once the
   * pointer has moved DRAG_THRESHOLD pixels: only then is the pointer captured. A press that never moves stays a
   * click, and its pointerup, click and dblclick reach the element under it (a note's double-click edits it, a step's
   * opens it) — capturing at pointerdown would send them all to the svg instead.
   */
  const press = useRef<{ pointerId: number; x: number; y: number; captured: boolean } | undefined>(undefined);
  const capture = (e: React.PointerEvent<SVGSVGElement>) => {
    press.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, captured: false };
  };
  /** Past the threshold: the press is a drag, and the svg follows the pointer wherever it goes. */
  const dragging = (e: React.PointerEvent<SVGSVGElement>): boolean => {
    const p = press.current;
    if (!p) return false;
    if (!p.captured) {
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_THRESHOLD) return false;
      p.captured = true;
      try {
        svg.current?.setPointerCapture(p.pointerId);
      } catch {
        // a synthetic pointer (tests) has no capture; the events still arrive on the svg
      }
    }
    return true;
  };

  // drag the background to pan; in the designer, drag a node to move it (the selected ones with it), a port to connect
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved?: boolean; marquee?: boolean; shift?: boolean } | undefined>(undefined);
  /** The box a Shift-drag on the empty canvas draws (in the diagram's units): what it touches is selected. */
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number }>();
  /** Space held: a drag anywhere pans (as in every drawing app). */
  const space = useRef(false);
  const nodeDrag = useRef<{ ids: string[]; lead: string; x: number; y: number; moved: boolean; frame?: boolean } | undefined>(undefined);
  const [offset, setOffset] = useState<{ ids: Set<string>; dx: number; dy: number }>();
  const [guides, setGuides] = useState<Array<{ x1: number; y1: number; x2: number; y2: number }>>([]);
  const [link, setLink] = useState<{ from: string; x: number; y: number; when?: boolean; cx: number; cy: number }>();
  const linkRef = useRef(link);
  linkRef.current = link;
  /** A click that ended a drag is not a click on the node. */
  const dragged = useRef(false);
  // a note dragged (moved, or resized from its corner) and the note whose text is being edited
  const noteDrag = useRef<{ id: string; resize: boolean; x: number; y: number; moved: boolean } | undefined>(undefined);
  const [noteOffset, setNoteOffset] = useState<{ id: string; resize: boolean; dx: number; dy: number }>();
  const [editing, setEditing] = useState<string>();
  const snapTo = (v: number) => (snap ? Math.round(v / GRID) * GRID : v);

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    // the middle button (or Space with the left one) pans from anywhere
    const pan = e.button === 1 || (e.button === 0 && space.current);
    if (e.button !== 0 && !pan) return;
    const t = e.target as Element;
    // typing in a note (or the Start node's inputs): the text box keeps its own pointer; a port's + is a button
    if (!pan && t.closest('textarea, input, a, button, [data-flow-port-add], [data-flow-suggestion]')) return;
    // the canvas owns the press: no text of the page gets selected by a drag (or by a Ctrl+A after it), the middle button does not autoscroll
    e.preventDefault();
    setHover(undefined);
    // the pressed step takes the focus (Enter then opens it), else the canvas (the press's default focusing is prevented)
    if (editable) ((t.closest('[data-flow-node]') as SVGGElement | null) ?? box.current)?.focus({ preventScroll: true });
    if (pan) {
      drag.current = { x: e.clientX, y: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y };
      capture(e);
      return;
    }
    const node = t.closest('[data-flow-node]')?.getAttribute('data-flow-node') ?? undefined;
    if (editable) {
      const port = t.closest('[data-flow-port="out"]');
      const from = port?.hasAttribute('data-flow-start-port') ? FLOW_START : node;
      if (port && from) {
        const [x, y] = toGraph(e.clientX, e.clientY);
        const when = port.getAttribute('data-flow-when');
        const l = { from, x, y, cx: e.clientX, cy: e.clientY, ...(when ? { when: when === 'true' } : {}) };
        // the ref at once: a quick click (down and up before a render) still ends this connection
        linkRef.current = l;
        setLink(l);
        capture(e);
        return;
      }
      if (node) {
        nodeDrag.current = { ids: chosen.has(node) ? [...chosen] : [node], lead: node, x: e.clientX, y: e.clientY, moved: false };
        capture(e);
        return;
      }
      const note = t.closest('[data-flow-note]')?.getAttribute('data-flow-note');
      if (note && onNoteChange) {
        noteDrag.current = { id: note, resize: !!t.closest('[data-flow-note-resize]'), x: e.clientX, y: e.clientY, moved: false };
        capture(e);
        return;
      }
      const frame = t.closest('[data-flow-group-handle]')?.getAttribute('data-flow-group-handle');
      const g = frame ? graph.groups.find((x) => groupKey(x) === frame) : undefined;
      const userFrame = t.closest('[data-flow-frame-handle]')?.getAttribute('data-flow-frame-handle');
      const uf = userFrame ? boxes.find((x) => x.id === userFrame) : undefined;
      const ids = g?.ids ?? uf?.steps.filter((id) => byId.has(id));
      if (ids?.length) {
        nodeDrag.current = { ids, lead: ids[0]!, x: e.clientX, y: e.clientY, moved: false, frame: true };
        capture(e);
        return;
      }
    }
    if (node || t.closest('[data-flow-edge-hit]')) return;
    // the empty canvas: a drag pans; with Shift it draws a box that selects what it touches
    drag.current = { x: e.clientX, y: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y, marquee: !!editable && e.shiftKey, shift: e.shiftKey };
    capture(e);
  };
  const placeDrag = (n: NonNullable<typeof nodeDrag.current>, rawDx: number, rawDy: number) => placeDragged(graph.nodes, byId, n, { dx: rawDx, dy: rawDy }, viewRef.current.k, snapTo);
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    // nothing moves until the press is a drag (a click stays a click)
    if (!dragging(e)) return;
    if (linkRef.current) {
      const [x, y] = toGraph(e.clientX, e.clientY);
      setLink({ ...linkRef.current, x, y });
      return;
    }
    const n = nodeDrag.current;
    if (n) {
      const k = viewRef.current.k;
      n.moved = true;
      const p = placeDrag(n, (e.clientX - n.x) / k, (e.clientY - n.y) / k);
      setGuides(p.lines);
      setOffset({ ids: new Set(n.ids), dx: p.dx, dy: p.dy });
      return;
    }
    const nd = noteDrag.current;
    if (nd) {
      nd.moved = true;
      const k = viewRef.current.k;
      const note = notes?.find((x) => x.id === nd.id);
      let dx = (e.clientX - nd.x) / k;
      let dy = (e.clientY - nd.y) / k;
      if (note && snap) {
        dx = nd.resize ? snapTo(note.x + note.w + dx) - note.x - note.w : snapTo(note.x + dx) - note.x;
        dy = nd.resize ? snapTo(note.y + note.h + dy) - note.y - note.h : snapTo(note.y + dy) - note.y;
      }
      setNoteOffset({ id: nd.id, resize: nd.resize, dx, dy });
      return;
    }
    const d = drag.current;
    if (d) {
      d.moved = true;
      if (d.marquee) {
        const [x0, y0] = toGraph(d.x, d.y);
        const [x1, y1] = toGraph(e.clientX, e.clientY);
        setMarquee({ x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) });
        return;
      }
      moveView({ ...viewRef.current, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y });
    }
  };
  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    // the press is over (a captured pointer is released with it)
    const wasDrag = !!press.current?.captured;
    press.current = undefined;
    const l = linkRef.current;
    if (l) {
      linkRef.current = undefined;
      setLink(undefined);
      // a click on a port (or a connection dropped on the empty canvas) asks for a block to add there
      const clicked = !wasDrag;
      const target = clicked ? undefined : document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-flow-node]')?.getAttribute('data-flow-node');
      if (target && target !== l.from) onConnect?.(l.from, target, l.when);
      else if (!target && e.type === 'pointerup') onPortClick?.(l.from, l.when, { x: e.clientX, y: e.clientY });
      return;
    }
    const nd = noteDrag.current;
    if (nd) {
      noteDrag.current = undefined;
      const note = notes?.find((x) => x.id === nd.id);
      if (nd.moved && note && noteOffset) {
        onNoteChange?.(nd.id, nd.resize ? { w: Math.max(80, Math.round(note.w + noteOffset.dx)), h: Math.max(48, Math.round(note.h + noteOffset.dy)) } : { x: Math.round(note.x + noteOffset.dx), y: Math.round(note.y + noteOffset.dy) });
        setTimeout(() => setNoteOffset(undefined), 3000);
      } else {
        setNoteOffset(undefined);
        // a click on a note selects it (Shift adds it to the selection): Delete then removes it
        if (!nd.moved && e.type === 'pointerup' && !nd.resize) {
          const notesNow = selection?.notes ?? [];
          const next = e.shiftKey ? (notesNow.includes(nd.id) ? notesNow.filter((x) => x !== nd.id) : [...notesNow, nd.id]) : [nd.id];
          onSelectionChange?.({ steps: e.shiftKey ? [...chosen] : [], notes: next });
        }
      }
      return;
    }
    const n = nodeDrag.current;
    if (n) {
      nodeDrag.current = undefined;
      setGuides([]);
      if (n.moved && offset) {
        // the click that ends the drag (if the browser sends one) is not a click on the node
        dragged.current = true;
        setTimeout(() => (dragged.current = false), 0);
        const out: Record<string, [number, number]> = {};
        for (const id of n.ids) {
          const at = byId.get(id);
          if (at) out[id] = [Math.round(at.x + offset.dx), Math.round(at.y + offset.dy)];
        }
        // steps dropped into a frame they are not in join its group (a frame's own drag only moves it): one edit with the move
        let target: FlowGroup | undefined;
        if (!n.frame && onGroupDrop) {
          const dropped = n.ids.map((id) => byId.get(id)!).filter(Boolean);
          const centre = (id: string) => [out[id]![0] + byId.get(id)!.w / 2, out[id]![1] + byId.get(id)!.h / 2] as const;
          target = graph.groups.find((g) => {
            if (n.ids.every((id) => g.ids.includes(id))) return false;
            return dropped.some((d) => {
              const [cx, cy] = centre(d.id);
              return cx > g.x && cx < g.x + g.w && cy > g.y && cy < g.y + g.h;
            });
          });
        }
        if (target) onGroupDrop!(n.ids.filter((id) => !target.ids.includes(id)), target, out);
        else onMove?.(out);
        // a step dragged by itself is the selected one afterwards (as a click on it would make it)
        if (!n.frame && !chosen.has(n.lead)) onSelectionChange?.({ steps: [n.lead] });
        // the node stays where it was dropped until the new layout arrives (or the move failed)
        setTimeout(() => setOffset(undefined), 3000);
      }
      return;
    }
    const d = drag.current;
    drag.current = undefined;
    if (d?.marquee && d.moved) {
      // the box selects the steps and notes it touches (added to the selection: it was drawn with Shift)
      const m = marquee;
      setMarquee(undefined);
      if (m) {
        const hit = (r: { x: number; y: number; w: number; h: number }) => r.x < m.x1 && r.x + r.w > m.x0 && r.y < m.y1 && r.y + r.h > m.y0;
        const stepsHit = graph.nodes.filter(hit).map((n) => n.id);
        const notesHit = (notes ?? []).filter(hit).map((n) => n.id);
        onSelectionChange?.({ steps: [...new Set([...chosen, ...stepsHit])], notes: [...new Set([...(selection?.notes ?? []), ...notesHit])] });
      }
      return;
    }
    // the pan ends: what is on screen is drawn now
    if (d?.moved) setView(viewRef.current);
    if (editable && d && !d.moved && !d.shift && e.type === 'pointerup' && e.button === 0) {
      onSelectionChange?.({ steps: [] });
      onCanvasClick?.(toGraph(e.clientX, e.clientY));
    }
  };
  // the steps' places stay with the dropped offset until the new steps (with their new positions) come in
  useEffect(() => setOffset(undefined), [steps]);
  useEffect(() => setNoteOffset(undefined), [notes]);

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

  // hovering a step for 400 ms shows its last result (the designer's card)
  const [hover, setHover] = useState<string>();
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onHover = (id: string | undefined) => {
    clearTimeout(hoverTimer.current);
    if (!id) return setHover(undefined);
    if (!renderPreview || nodeDrag.current || linkRef.current || drag.current) return;
    hoverTimer.current = setTimeout(() => setHover(id), 400);
  };
  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  /** Pan (and zoom in, when far out) so a step is in the middle of the view. */
  const reveal = useCallback(
    (id: string) => {
      const n = byId.get(id);
      const s = size.current;
      if (!n || !s) return;
      setView((v) => {
        const k = Math.max(v.k, 0.8);
        return { k, x: s.w / 2 - (n.x + n.w / 2) * k, y: s.h / 2 - (n.y + n.h / 2) * k };
      });
    },
    [byId],
  );

  // Ctrl+F: find steps by name, URL, variable or type; Enter jumps to the next match and selects it
  const [find, setFind] = useState<{ q: string; i: number }>();
  const findInput = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => findMatches(graph.nodes, find?.q ?? ''), [find?.q, graph.nodes]);
  const openFind = useCallback(() => {
    setFind((f) => f ?? { q: '', i: -1 });
    setTimeout(() => (findInput.current?.focus(), findInput.current?.select()), 0);
  }, []);
  const jump = (dir: 1 | -1) => {
    if (!find || !matches.length) return;
    const i = (((find.i < 0 && dir === 1 ? -1 : find.i) + dir) % matches.length + matches.length) % matches.length;
    setFind({ ...find, i });
    const id = matches[i]!;
    reveal(id);
    if (editable) onSelectionChange?.({ steps: [id] });
  };
  const closeFind = () => {
    setFind(undefined);
    box.current?.focus({ preventScroll: true });
  };

  if (apiRef)
    apiRef.current = {
      fit,
      find: openFind,
      reveal,
      focus: () => box.current?.focus({ preventScroll: true }),
      centre: () => {
        const s = size.current ?? { w: 600, h: 400 };
        const v = viewRef.current;
        return [Math.round((s.w / 2 - v.x) / v.k - 110), Math.round((s.h / 2 - v.y) / v.k - 60)];
      },
    };

  // the canvas's own keys: Ctrl+F (find) and Space (held: a drag pans). Delete, Ctrl+A, Esc, undo and the others are the
  // designer's (FlowDesigner), handled wherever the focus is in it.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!editable) return;
    if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return;
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      e.stopPropagation();
      return openFind();
    }
    if (e.key === ' ') {
      e.preventDefault();
      space.current = true;
    }
  };
  const onKeyUp = (e: React.KeyboardEvent) => {
    if (e.key === ' ') space.current = false;
  };
  /** A right-click: an edge, a group's label or the empty canvas (steps, notes and frames have their own menus). */
  const onContextMenu = (e: React.MouseEvent) => {
    if (!editable) return;
    const t = e.target as Element;
    if (t.closest('textarea, input, [data-flow-node], [data-flow-note], [data-flow-frame], [data-flow-frame-body], [data-flow-minimap]')) return;
    const at = { x: e.clientX, y: e.clientY };
    const hit = t.closest('[data-flow-edge-hit]')?.getAttribute('data-flow-edge-hit');
    const edge = hit ? graph.edges.find((x) => edgeKey(x) === hit) : undefined;
    const handle = t.closest('[data-flow-group-handle]')?.getAttribute('data-flow-group-handle');
    const group = handle ? graph.groups.find((g) => groupKey(g) === handle) : undefined;
    const menu = edge ? onEdgeMenu : group ? onGroupMenu : t.closest('[data-flow-group]') ? undefined : onCanvasMenu;
    if (!menu) return;
    e.preventDefault();
    if (edge) {
      onSelectionChange?.({ steps: [], edge: { from: edge.from, to: edge.to } });
      onEdgeMenu?.(edge, at);
    } else if (group) onGroupMenu?.(group, at);
    else onCanvasMenu?.(toGraph(e.clientX, e.clientY), at);
  };

  const at = (id: string) => {
    const n = byId.get(id)!;
    return offset?.ids.has(id) ? { ...n, x: n.x + offset.dx, y: n.y + offset.dy } : n;
  };
  const noteAt = (n: FlowNote): FlowNote =>
    noteOffset?.id === n.id
      ? noteOffset.resize
        ? { ...n, w: Math.max(80, n.w + noteOffset.dx), h: Math.max(48, n.h + noteOffset.dy) }
        : { ...n, x: n.x + noteOffset.dx, y: n.y + noteOffset.dy }
      : n;
  const shownBoxes = offset ? frameBoxes(graph.nodes.map((n) => at(n.id)), frames) : boxes;
  // the checks: marks on their steps and edges, a strip under the canvas
  const checkOf = useMemo(() => {
    const m = new Map<string, 'error' | 'warning'>();
    for (const c of checks ?? []) if (c.kind !== 'unset-variable' && m.get(c.step) !== 'error') m.set(c.step, c.severity);
    return m;
  }, [checks]);
  const badEdges = useMemo(() => new Set((checks ?? []).flatMap((c) => (c.edge ? [`${c.edge.from}>${c.edge.to}`] : []))), [checks]);
  // the layout's own problems that the checks do not say (two steps with one id)
  const problems = checks ? graph.problems.filter((p) => /^Two steps/.test(p.message)) : graph.problems;
  const matched = new Set(matches);
  const current = find && find.i >= 0 ? matches[find.i] : undefined;
  const minimapShown = !!minimap && graph.nodes.length > 8 && !!size.current;
  // a big flow: only what is on screen (and a margin) is drawn, and zoomed far out the steps are drawn compact
  const compact = view.k < COMPACT_BELOW;
  // the compact name (22 units) would be under 4.5 px on screen: unreadable, so not drawn
  const tiny = view.k * 22 < 4.5;
  const sz = size.current;
  const margin = 240 / view.k;
  const vr = sz ? { x0: -view.x / view.k - margin, y0: -view.y / view.k - margin, x1: (sz.w - view.x) / view.k + margin, y1: (sz.h - view.y) / view.k + margin } : undefined;
  // the pane not measured yet (not shown: a tab kept in the background, or before its first layout): nothing is on
  // screen, so nothing is drawn; the first size fits the view and draws what it shows (a hidden 1,000-step flow
  // otherwise kept every node, ~10,000 elements, in the page)
  const inView = (r: { x: number; y: number; w: number; h: number }) => !!vr && r.x + r.w >= vr.x0 && r.x <= vr.x1 && r.y + r.h >= vr.y0 && r.y <= vr.y1;
  const hovered = hover ? byId.get(hover) : undefined;
  // a drag from elsewhere in the app (or the palette) over the canvas: where it would land, and the drop
  const drop = useFlowDrop({ enabled: !!editable, toGraph: (x, y) => (svg.current ? toGraph(x, y) : [0, 0]), onDrop: onDropItems });
  // the nodes' callbacks keep their identity: a node re-renders only when its own data changes
  const stable = {
    click: useStable(clickNode),
    open: useStable(onOpen),
    select: useStable(onSelect),
    openResult: useStable(onOpenResult),
    menu: useStable(onNodeMenu),
    hover: useStable(onHover),
    portAdd: useStable(onPortClick),
    selectEdge: useStable((e: FlowEdge) => onSelectionChange?.({ steps: [], edge: { from: e.from, to: e.to } })),
  };
  const canvas = (
    <div ref={box} className={cx('relative h-full w-full overflow-hidden bg-bg outline-none', !toolbar && className, !!toolbar && 'flex-1 min-h-0')} data-flow-diagram data-flow-editable={editable || undefined} tabIndex={editable ? -1 : undefined} onKeyDown={onKeyDown} onKeyUp={onKeyUp} onBlur={() => (space.current = false)} {...drop.handlers}>
      <svg
        ref={svg}
        className={cx('h-full w-full select-none touch-none', drag.current ? 'cursor-grabbing' : 'cursor-grab')}
        // text scales exactly with its box: no hinting to whole pixels (which drew it wider than the box when zoomed out)
        textRendering="geometricPrecision"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={onContextMenu}
        onDoubleClick={(e) => {
          const t = e.target as Element;
          if (!onCanvasDoubleClick || t.closest('[data-flow-node], [data-flow-note], [data-flow-frame], [data-flow-frame-body], [data-flow-group], [data-flow-edge-hit]')) return;
          onCanvasDoubleClick(toGraph(e.clientX, e.clientY), { x: e.clientX, y: e.clientY });
        }}
        role="img"
        aria-label={`Flow of ${graph.nodes.length} steps`}
      >
        <defs>
          <marker id={arrow} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted" />
          </marker>
        </defs>
        <g transform={viewTransform(view)}>
          {startBox && start && (
            <>
              {[...rootIds.map((id) => at(id)), ...suggestionBoxes.map((b) => ({ id: `suggestion:${b.s.id}`, ...b }))].map((b) => {
                const x1 = startBox.x + startBox.w;
                const y1 = startBox.y + START_PORT_Y;
                const y2 = b.y + b.h / 2;
                const dx = Math.max(24, Math.abs(b.x - x1) / 2);
                return <path key={b.id} d={`M ${x1} ${y1} C ${x1 + dx} ${y1}, ${b.x - dx} ${y2}, ${b.x} ${y2}`} className="fill-none stroke-line-strong pointer-events-none" strokeWidth={1.5} data-flow-start-edge={b.id} />;
              })}
              <StartNode x={startBox.x} y={startBox.y} spec={start} editable={editable} />
              {suggestionBoxes.map((b) => (
                <SuggestionNode key={b.s.id} x={b.x} y={b.y} s={b.s} />
              ))}
            </>
          )}
          {shownBoxes.map((f) => (
            <UserFrame key={f.id} frame={f} editable={editable} onMenu={onFrameMenu} part="body" />
          ))}
          {(offset ? flowGroups(graph.nodes.map((n) => at(n.id))) : graph.groups).map((g) => (
            <FlowFrame key={groupKey(g)} group={g} editable={editable} />
          ))}
          {graph.edges.map((e) => {
            const a = at(e.from);
            const b = at(e.to);
            // an edge is drawn when the box its two ends span is on screen
            if (!inView({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x) + a.w, h: Math.abs(b.y - a.y) + a.h })) return null;
            const key = edgeKey(e);
            return (
              <FlowEdgeView
                key={key}
                edge={e}
                from={a}
                to={b}
                selected={chosenEdge === key}
                near={!!chosen.size && (chosen.has(e.from) || chosen.has(e.to))}
                bad={badEdges.has(key)}
                editable={editable}
                compact={compact}
                arrow={arrow}
                onSelect={stable.selectEdge!}
              />
            );
          })}
          {graph.nodes.filter((n) => inView(n) || chosen.has(n.id) || offset?.ids.has(n.id)).map((n) => (
            <FlowNodeView
              compact={compact}
              tiny={tiny}
              key={n.id}
              node={offset?.ids.has(n.id) ? at(n.id) : n}
              selected={chosen.has(n.id)}
              editable={editable}
              onClick={stable.click!}
              onOpen={stable.open}
              onSelect={stable.select}
              onOpenResult={stable.openResult}
              mark={marks?.[n.id]}
              onMenu={stable.menu}
              match={current === n.id ? 'current' : matched.has(n.id) ? 'match' : undefined}
              problem={checkOf.get(n.id)}
              onHover={renderPreview ? stable.hover : undefined}
              onPortAdd={stable.portAdd}
              fonts={fonts}
            />
          ))}
          {/* a frame's title lies over the steps: it can always be grabbed, even with a step moved under it */}
          {shownBoxes.map((f) => (
            <UserFrame key={f.id} frame={f} editable={editable} onMenu={onFrameMenu} part="title" />
          ))}
          {/* notes lie on top, like paper stuck on the board: a note is never hidden by a step dragged under it */}
          {(notes ?? []).filter((n) => inView(noteAt(n))).map((n) => (
            <StickyNote
              key={n.id}
              note={noteAt(n)}
              editable={editable && !!onNoteChange}
              editing={editing === n.id}
              selected={chosenNotes.has(n.id)}
              onEdit={(on) => setEditing(on ? n.id : undefined)}
              onText={(text) => text !== n.text && onNoteChange?.(n.id, { text })}
              onMenu={onNoteMenu}
            />
          ))}
          {drop.hint && <DropHintLayer hint={drop.hint} box={(id) => (byId.has(id) ? at(id) : undefined)} name={(id) => byId.get(id)?.step.name ?? id} />}
          {marquee && <rect x={marquee.x0} y={marquee.y0} width={marquee.x1 - marquee.x0} height={marquee.y1 - marquee.y0} className="fill-accent/10 stroke-accent pointer-events-none" strokeWidth={1 / view.k} strokeDasharray={`${4 / view.k} ${3 / view.k}`} data-flow-marquee />}
          {guides.map((g, i) => (
            <line key={i} x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} className="stroke-accent pointer-events-none" strokeWidth={1} strokeDasharray="4 3" data-flow-guide />
          ))}
          {link &&
            (() => {
              const a = link.from === FLOW_START && startBox ? { ...startBox, h: START_PORT_Y * 2 } : byId.get(link.from)!;
              return <path d={`M ${a.x + a.w} ${a.y + (link.when === undefined ? a.h / 2 : portY(a.h, link.when))} L ${link.x} ${link.y}`} className="fill-none stroke-accent pointer-events-none" strokeWidth={1.5} strokeDasharray="5 4" data-flow-link />;
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
      {find && <FlowFindBar query={find.q} inputRef={findInput} matches={matches} current={current} onQuery={(q) => setFind({ q, i: -1 })} onJump={jump} onClose={closeFind} />}
      {minimapShown && (
        <FlowMinimap
          bounds={bounds}
          // the overview shows where the steps are, not where they are being dragged: it redraws on the drop, not every frame
          nodes={graph.nodes}
          frames={boxes}
          notes={noteOffset ? (notes ?? []).map(noteAt) : (notes ?? NO_NOTES)}
          view={view}
          size={size.current!}
          onCentre={(x, y) => setView((v) => ({ ...v, x: size.current!.w / 2 - x * v.k, y: size.current!.h / 2 - y * v.k }))}
        />
      )}
      {hovered && renderPreview && (
        <div
          className="absolute z-10 w-[360px] max-w-[80%] pointer-events-none rounded-lg border border-line bg-popover shadow-xl overflow-hidden"
          style={previewPlace(view, hovered, size.current?.w ?? 800)}
          data-flow-preview={hovered.id}
        >
          {renderPreview(hovered.step)}
        </div>
      )}
      <FlowProblems
        checks={checks}
        problems={problems}
        onPick={(step) => {
          reveal(step);
          if (editable) onSelectionChange?.({ steps: [step] });
          else if (byId.get(step)) onSelect?.(byId.get(step)!.step);
        }}
      />
    </div>
  );
  if (!toolbar) return canvas;
  return (
    <FlowToolbarFrame className={className} toolbar={toolbar} toolbarRight={toolbarRight} zoom={view.k} onZoom={zoomTo} onFit={fit}>
      {canvas}
    </FlowToolbarFrame>
  );
}
