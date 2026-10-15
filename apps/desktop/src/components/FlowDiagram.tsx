import { AlertTriangle, ChevronDown, ChevronUp, CircleAlert, Maximize2, Minus, Plus, Search, X } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
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
import { Button, Callout, cx, IconButton } from './ui';
import { clearTextFit, fitText, textWidth, type TextFont } from '../lib/fit-text';
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

interface View {
  x: number;
  y: number;
  k: number;
}
const viewTransform = (v: View) => `translate(${v.x} ${v.y}) scale(${v.k})`;
/** A wheel or pan gesture is over when nothing moved for this long: then the canvas renders for the new view. */
const SETTLE_MS = 140;

/** Below this zoom the steps are drawn compact (their details would be a few pixels high). */
const COMPACT_BELOW = 0.38;
const NO_NOTES: FlowNote[] = [];

/** How far (screen pixels) a press must move to become a drag; less, it is a click (or a double-click). */
const DRAG_THRESHOLD = 3;

/** Snap-to-grid step, and how close (in screen pixels) a dragged step must come to line up with another. */
const GRID = 16;
const GUIDE_TOLERANCE = 6;

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
  const box = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  // until the pane's size is known, the graph at its own size from the top left corner
  const [committed, setCommitted] = useState<View>({ x: 32, y: 32, k: 1 });
  /** The view as it is on screen now (ahead of `committed` while a wheel or pan gesture is in progress). */
  const viewRef = useRef(committed);
  const gesture = useRef<{ timer?: ReturnType<typeof setTimeout>; raf?: number; live?: boolean }>({});
  /** Set the view now (fit, reveal, the minimap, the end of a gesture): it replaces a gesture in progress. */
  const setView = useCallback((next: View | ((v: View) => View)) => {
    const g = gesture.current;
    clearTimeout(g.timer);
    if (g.raf) cancelAnimationFrame(g.raf);
    gesture.current = {};
    const v = typeof next === 'function' ? next(viewRef.current) : next;
    viewRef.current = v;
    setCommitted(v);
    // the same view again (a gesture that came back where it began): nothing renders, so drop the picture transform here
    if (v.x === committedRef.current.x && v.y === committedRef.current.y && v.k === committedRef.current.k && svg.current) {
      svg.current.style.transform = '';
      svg.current.style.willChange = '';
    }
  }, []);
  const committedRef = useRef(committed);
  committedRef.current = committed;
  /**
   * A wheel or pan step. The drawing is not touched: the whole canvas is moved as one composited picture (a CSS
   * transform from the committed view to the live one, on the GPU, once a frame), so neither React nor the browser's
   * painting of hundreds of steps runs per frame. Once the gesture settles the view is committed: the canvas renders
   * once for it (the steps on screen, compact or full, sharp at the new zoom) and the CSS transform is dropped.
   */
  const moveView = useCallback(
    (v: View) => {
      viewRef.current = v;
      const g = gesture.current;
      g.live = true;
      if (!g.raf)
        g.raf = requestAnimationFrame(() => {
          g.raf = undefined;
          const el = svg.current;
          if (!el) return;
          const c = committedRef.current;
          const l = viewRef.current;
          const k = l.k / c.k;
          el.style.transformOrigin = '0 0';
          el.style.willChange = 'transform';
          el.style.transform = `translate(${l.x - k * c.x}px, ${l.y - k * c.y}px) scale(${k})`;
        });
      clearTimeout(g.timer);
      g.timer = setTimeout(() => setView(viewRef.current), SETTLE_MS);
    },
    [setView],
  );
  // the committed view is drawn: the gesture's picture transform goes, in the same frame
  useLayoutEffect(() => {
    const el = svg.current;
    if (el && el.style.transform) {
      el.style.transform = '';
      el.style.willChange = '';
    }
  }, [committed]);
  useEffect(
    () => () => {
      clearTimeout(gesture.current.timer);
      if (gesture.current.raf) cancelAnimationFrame(gesture.current.raf);
    },
    [],
  );
  // what is drawn follows the committed view; during a gesture the picture is moved on top of it (moveView)
  const view = committed;
  const arrow = useId();
  // the pane's size, from a ResizeObserver: reading clientWidth right after mounting hundreds of nodes forced a layout
  const size = useRef<{ w: number; h: number }>(undefined);
  /** The current graph has been fitted to a known size. */
  const fitted = useRef(false);

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
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;
  const minimapRef = useRef(false);
  minimapRef.current = !!minimap && graph.nodes.length > 8;

  const fit = useCallback(() => {
    const s = size.current;
    const b = boundsRef.current;
    const w = b.x1 - b.x0;
    const h = b.y1 - b.y0;
    if (!s || !w || !h) return;
    const pad = 32;
    // the overview covers the top-right corner: the flow is fitted beside it or below it (whichever is bigger), so no
    // step lies under it
    const fits = (right: number, top: number) => ({ right, top, k: Math.min((s.w - pad * 2 - right) / w, (s.h - pad * 2 - top) / h, 1.4) });
    const { right, top, k } = minimapRef.current ? [fits(MINIMAP_W + 16, 0), fits(0, MINIMAP_H + 16)].reduce((a, c) => (c.k > a.k ? c : a)) : fits(0, 0);
    const z = Math.max(k, MIN_ZOOM);
    // too big even at the smallest zoom: from its top-left corner (its start), not cut off on both sides
    setView({ k: z, x: z > k ? pad - b.x0 * z : (s.w - right - w * z) / 2 - b.x0 * z, y: z > k && h * z > s.h - top - pad * 2 ? top + pad - b.y0 * z : top + (s.h - top - h * z) / 2 - b.y0 * z });
    fitted.current = true;
  }, []);
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
      // the pane's box, not the svg's: during a gesture the svg is moved by a CSS transform
      const r = (box.current ?? el).getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const v = viewRef.current;
      // a trackpad scrolls in pixels, sideways too, in fractions: two fingers pan (a pinch arrives as Ctrl+wheel and zooms);
      // Shift+wheel pans sideways. A mouse wheel's whole notches zoom around the pointer.
      const trackpad = e.deltaMode === 0 && (e.deltaX !== 0 || !Number.isInteger(e.deltaY));
      if (!e.ctrlKey && !e.metaKey && (trackpad || e.shiftKey)) {
        const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
        const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
        moveView({ ...v, x: v.x - dx, y: v.y - dy });
        return;
      }
      const k = Math.min(4, Math.max(MIN_ZOOM, v.k * Math.exp(-e.deltaY * (e.ctrlKey && trackpad ? 0.01 : 0.0015))));
      moveView({ k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [moveView]);

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
  /** Where the dragged steps go: lined up with another step when one is within a few pixels (a guide shows it), else on the grid when snapping. */
  const placeDrag = (n: NonNullable<typeof nodeDrag.current>, rawDx: number, rawDy: number) => {
    const lead = byId.get(n.lead);
    if (!lead) return { dx: rawDx, dy: rawDy, lines: [] };
    const tol = GUIDE_TOLERANCE / viewRef.current.k;
    const px = lead.x + rawDx;
    const py = lead.y + rawDy;
    // a frame's or a group's steps move as one: lining their first step up with some other step means nothing
    const others = n.frame ? [] : graph.nodes.filter((o) => !n.ids.includes(o.id));
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
    const lines: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
    if (bx) lines.push({ x1: bx.at, y1: Math.min(y, bx.o.y) - 12, x2: bx.at, y2: Math.max(y + lead.h, bx.o.y + bx.o.h) + 12 });
    if (by) lines.push({ x1: Math.min(x, by.o.x) - 12, y1: by.at, x2: Math.max(x + lead.w, by.o.x + by.o.w) + 12, y2: by.at });
    return { dx: x - lead.x, dy: y - lead.y, lines };
  };
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
  const matches = useMemo(() => {
    const words = (find?.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return graph.nodes
      .filter((n) => {
        const s = n.step;
        const hay = [s.name, s.id, s.type, s.method, s.url, s.message, s.if, s.flow, ...(s.uses ?? []).map((v) => `{{${v}}} ${v}`), ...(s.extract ?? []), ...(s.set ?? [])]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .map((n) => n.id);
  }, [find?.q, graph.nodes]);
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

  /** The zoom buttons: in or out around the middle of the view. */
  const zoomTo = (k: number) => {
    const s = size.current ?? { w: 600, h: 400 };
    setView((v) => {
      const z = Math.min(4, Math.max(MIN_ZOOM, k));
      return { k: z, x: s.w / 2 - ((s.w / 2 - v.x) * z) / v.k, y: s.h / 2 - ((s.h / 2 - v.y) * z) / v.k };
    });
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
      {find && (
        <div className="absolute top-2 left-2 flex items-center gap-1 rounded-md border border-line bg-popover shadow-lg px-1.5 py-1 text-xs" data-flow-find>
          <Search size={13} className="text-muted shrink-0" />
          <input
            ref={findInput}
            aria-label="Find steps"
            className="bg-transparent outline-none w-48"
            placeholder="Find a step: name, URL, variable, type"
            value={find.q}
            onChange={(e) => setFind({ q: e.target.value, i: -1 })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                jump(e.shiftKey ? -1 : 1);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                closeFind();
              }
            }}
          />
          <span className="text-muted tabular-nums whitespace-nowrap" data-flow-find-count>
            {find.q.trim() ? `${current ? matches.indexOf(current) + 1 : 0} of ${matches.length}` : ''}
          </span>
          <IconButton label="Previous match (Shift+Enter)" className="h-6 w-6" onClick={() => jump(-1)} disabled={!matches.length}>
            <ChevronUp size={13} />
          </IconButton>
          <IconButton label="Next match (Enter)" className="h-6 w-6" onClick={() => jump(1)} disabled={!matches.length}>
            <ChevronDown size={13} />
          </IconButton>
          <IconButton label="Close (Esc)" className="h-6 w-6" onClick={closeFind}>
            <X size={13} />
          </IconButton>
        </div>
      )}
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
      {checks
        ? checks.length + problems.length > 0 && (
            <div className="absolute left-2 bottom-2 right-2 max-h-28 overflow-auto rounded-md border border-warn/40 bg-popover/95 shadow text-xs py-1" data-flow-checks role="list" aria-label="Problems">
              {problems.map((p, i) => (
                <div key={`p${i}`} className="flex items-center gap-2 px-2 py-0.5 text-warn">
                  <AlertTriangle size={12} className="shrink-0" />
                  <span>{p.message}</span>
                </div>
              ))}
              {checks.map((c, i) => (
                <button
                  key={i}
                  role="listitem"
                  className="w-full flex items-center gap-2 px-2 py-0.5 text-left hover:bg-hover"
                  data-flow-check={c.step}
                  data-flow-check-kind={c.kind}
                  title="Select the step"
                  onClick={() => {
                    reveal(c.step);
                    if (editable) onSelectionChange?.({ steps: [c.step] });
                    else if (byId.get(c.step)) onSelect?.(byId.get(c.step)!.step);
                  }}
                >
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
          )}
    </div>
  );
  if (!toolbar) return canvas;
  return (
    <div className={cx('h-full w-full flex flex-col min-h-0', className)}>
      <div className="@container flex items-center gap-1 px-2 py-1.5 border-b border-line flex-nowrap overflow-hidden whitespace-nowrap shrink-0" data-flow-toolbar>
        {/* the designer's buttons take the room there is (they fold into their ⋯ menu); the view's own stay whole on the right */}
        <div className="flex-1 min-w-0 flex items-center gap-1 overflow-hidden">{toolbar}</div>
        <div className="flex items-center gap-1 shrink-0">
          {toolbarRight}
          <span className="hidden @[760px]:inline-flex">
            <IconButton label="Zoom out" className="h-7 w-7" onClick={() => zoomTo(view.k / 1.25)} data-flow-zoom="out">
            <Minus size={13} />
          </IconButton>
          </span>
          <button type="button" className="hidden @[480px]:block h-7 min-w-11 px-1 rounded text-xs tabular-nums text-muted hover:bg-hover hover:text-fg" onClick={() => zoomTo(1)} title="Zoom: click for 100%" aria-label="Zoom to 100%" data-flow-zoom-level>
            {Math.round(view.k * 100)}%
          </button>
          <span className="hidden @[760px]:inline-flex">
            <IconButton label="Zoom in" className="h-7 w-7" onClick={() => zoomTo(view.k * 1.25)} data-flow-zoom="in">
            <Plus size={13} />
          </IconButton>
          </span>
          <Button size="sm" icon={<Maximize2 size={12} />} onClick={fit} title="Show the whole flow" aria-label="Fit">
            <span className="hidden @[760px]:inline">Fit</span>
          </Button>
        </div>
      </div>
      {canvas}
    </div>
  );
}

const groupKey = (g: FlowGroup) => `${g.kind}:${g.name}`;
const F_LANE: TextFont = { size: 10, weight: 600 };
/** The overview's width (FlowMinimap): Fit keeps the flow out of its corner. */
const MINIMAP_W = 180;
const MINIMAP_H = 120;
/** The farthest out the view goes (Fit, the wheel, the zoom buttons): a long chain of steps still fits a narrow pane. */
const MIN_ZOOM = 0.08;

/** A frame around a parallel group's steps, or the Finally lane; in the designer its label drags its steps. */
function FlowFrame({ group: g, editable }: { group: FlowGroup; editable?: boolean }) {
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
