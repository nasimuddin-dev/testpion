import { useEffect, useRef, useState } from 'react';
import { ask, confirmAction, useApp, type ViewId } from './store';
import { useDoc } from './lib/docs';
import { setLeaveGuard } from './lib/leave-guard';

/** Intents already handled by keyed consumers (so a component that remounts doesn't handle one again). */
const handled = new Map<string, number>();

/**
 * Handle navigation intents for a view. Give `key` when the component can unmount and mount again
 * (e.g. inside a tab): the intent it already handled isn't handled a second time.
 */
export function useIntent(view: ViewId, handler: (payload: any) => void, key?: string): void {
  // only this view's intents (a stored reference, or nothing): an intent for another view renders nothing here
  const intent = useApp((s) => (s.intent?.view === view ? s.intent : undefined));
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
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && useApp.getState().view === view && active.current && !(e.target as HTMLElement | null)?.closest?.('[role=dialog], [role=alertdialog]')) {
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
 * While `dirty`, leaving this view (another view, an intent, back / forward) asks first, with the dialog the request
 * tabs show on close: `what` names the edits ("The settings"). Save with Ctrl+S is the way to keep them.
 */
export function useLeaveGuard(view: ViewId, dirty: boolean, what: string, save?: () => Promise<unknown>): void {
  const saver = useRef(save);
  saver.current = save;
  useEffect(() => {
    if (!dirty) return;
    setLeaveGuard(view, async () => {
      // with a way to save (collection settings): Save / Don't save / Cancel, like closing a request tab
      if (saver.current) {
        const id = await ask({
          title: 'Unsaved changes',
          message: `${what} have unsaved changes.`,
          detail: 'Save them before you leave, or leave without saving and they are lost.',
          tone: 'question',
          buttons: [
            { id: 'cancel', label: 'Cancel' },
            { id: 'discard', label: "Don't save" },
            { id: 'save', label: 'Save', variant: 'primary' },
          ],
          cancelId: 'cancel',
        });
        if (id === 'discard') return true;
        if (id !== 'save') return false;
        try {
          return (await saver.current()) !== false;
        } catch {
          return false;
        }
      }
      return confirmAction({
        title: 'Unsaved changes',
        message: `${what} have unsaved changes.`,
        detail: 'Leave anyway and discard them? Save with Ctrl+S to keep them.',
        confirmLabel: 'Discard changes',
        danger: true,
      });
    });
    return () => setLeaveGuard(view, undefined);
  }, [view, dirty, what]);
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
