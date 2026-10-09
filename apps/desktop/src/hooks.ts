import { useEffect, useRef, useState } from 'react';
import { useApp, type ViewId } from './store';
import { useDoc } from './lib/docs';

/** Intents already handled by keyed consumers (so a component that remounts doesn't handle one again). */
const handled = new Map<string, number>();

/**
 * Handle navigation intents for a view. Give `key` when the component can unmount and mount again
 * (e.g. inside a tab): the intent it already handled isn't handled a second time.
 */
export function useIntent(view: ViewId, handler: (payload: any) => void, key?: string): void {
  const intent = useApp((s) => s.intent);
  // in a multi-document editor only the targeted document (or the one on screen) handles it
  const doc = useDoc();
  const last = useRef(0);
  const h = useRef(handler);
  h.current = handler;
  useEffect(() => {
    if (!intent || intent.view !== view) return;
    if (doc.docId !== undefined && (intent.docId ? intent.docId !== doc.docId : !doc.active)) return;
    const seen = key ? handled.get(key) : last.current;
    if (intent.nonce === seen) return;
    last.current = intent.nonce;
    if (key) handled.set(key, intent.nonce);
    h.current(intent.payload);
  }, [intent, view, key, doc.docId, doc.active]);
}

/** Run `fn` on Ctrl/Cmd+Enter while this view is active. */
export function useSendShortcut(view: ViewId, fn: () => void): void {
  const f = useRef(fn);
  f.current = fn;
  const doc = useDoc();
  const active = useRef(doc.active);
  active.current = doc.active;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && useApp.getState().view === view && active.current) {
        e.preventDefault();
        f.current();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [view]);
}

/** Save on Ctrl/Cmd+S while this view (and, in a multi-document editor, this tab) is on screen. */
export function useSaveShortcut(view: ViewId, fn: () => void): void {
  const f = useRef(fn);
  f.current = fn;
  const doc = useDoc();
  const active = useRef(doc.active);
  active.current = doc.active;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's' && useApp.getState().view === view && active.current) {
        e.preventDefault();
        f.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view]);
}

/**
 * Load a filtered list: at once on mount and whenever a picked filter changes, and 200 ms after the last keystroke in
 * its search text. (A first open used to wait out the typing debounce for nothing.) `skipMount` when something else
 * already loads it on mount, e.g. a view that loads whenever it becomes the active one.
 */
export function useFilteredLoad(load: () => void, query: string, filters: unknown[], skipMount = false): void {
  const fn = useRef(load);
  fn.current = load;
  const first = useRef(true);
  useEffect(() => {
    if (first.current && skipMount) return;
    fn.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, filters);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => fn.current(), 200);
    return () => clearTimeout(t);
  }, [query]);
}

/**
 * Callbacks for a memoised child: the same functions on every render, each calling the latest one given (so a parent
 * that re-renders on every keystroke doesn't re-render a list of thousands of rows through new props). The keys must
 * stay the same from one render to the next.
 */
export function useStableCallbacks<T extends object>(fns: T): T {
  const latest = useRef(fns);
  latest.current = fns;
  const [stable] = useState(() => {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(fns)) o[k] = (...args: unknown[]) => (latest.current as Record<string, ((...a: unknown[]) => unknown) | undefined>)[k]?.(...args);
    return o as T;
  });
  return stable;
}
