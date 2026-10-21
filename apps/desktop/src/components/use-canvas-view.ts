import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MINIMAP_H, MINIMAP_W, MIN_ZOOM } from './FlowDiagramParts';

/** Where the diagram is looked at: the offset of its origin in the pane, and the zoom. */
export interface View {
  x: number;
  y: number;
  k: number;
}
export const viewTransform = (v: View) => `translate(${v.x} ${v.y}) scale(${v.k})`;
/** A wheel or pan gesture is over when nothing moved for this long: then the canvas renders for the new view. */
const SETTLE_MS = 140;

/** Everything drawn, in the diagram's units. */
export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * The view of the flow canvas (FlowDiagram): the committed view and the gesture in progress, fit, the zoom, the wheel, and the
 * size of the pane. `fitSignature` says when the flow is fitted again (a new file, steps added or removed); undefined: only
 * when it is first shown. `bounds` is what the fit shows, `minimap` whether the overview covers a corner of it.
 */
export function useCanvasView(o: { bounds: Bounds; minimap: boolean; fitSignature: string | undefined }) {
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
  // the pane's size, from a ResizeObserver: reading clientWidth right after mounting hundreds of nodes forced a layout
  const size = useRef<{ w: number; h: number }>(undefined);
  /** The current graph has been fitted to a known size. */
  const fitted = useRef(false);
  const boundsRef = useRef(o.bounds);
  boundsRef.current = o.bounds;
  const minimapRef = useRef(false);
  minimapRef.current = o.minimap;

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
  }, [setView]);
  const fitNow = useRef(fit);
  fitNow.current = fit;
  // a new graph (another file, more steps) fits the pane; a run that only recolours the nodes keeps the view
  // (in the designer, steps placed by hand keep the view too: it fits again for another file, or when steps are added or removed)
  useLayoutEffect(() => {
    fitted.current = false;
    fitNow.current();
  }, [o.fitSignature]);
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

  /** The zoom buttons: in or out around the middle of the view. */
  const zoomTo = (k: number) => {
    const s = size.current ?? { w: 600, h: 400 };
    setView((v) => {
      const z = Math.min(4, Math.max(MIN_ZOOM, k));
      return { k: z, x: s.w / 2 - ((s.w / 2 - v.x) * z) / v.k, y: s.h / 2 - ((s.h / 2 - v.y) * z) / v.k };
    });
  };
  return { box, svg, view: committed, viewRef, size, setView, moveView, fit, zoomTo };
}
