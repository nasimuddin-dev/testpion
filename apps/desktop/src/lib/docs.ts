import { createContext, useContext } from 'react';
import { create } from 'zustand';
import type { ViewId } from '../store';
import { dropDraft } from './draft-store';
import { forgetStickyKeys } from './sticky';

/**
 * Multi-document editors (Postman-style tabs for GraphQL, gRPC, WebSocket and MCP servers): each open document is its
 * own instance of the editor, with its own draft, response and connection. The first document of each
 * editor is `main` (it keeps the draft saved before tabs existed).
 */
export const DOC_VIEWS: ViewId[] = ['graphql', 'grpc', 'websocket', 'mcp', 'apidef', 'dataset'];
export const isDocView = (v: ViewId) => DOC_VIEWS.includes(v);

/** Which document an editor instance is, and whether it's the one on screen. */
export const DocContext = createContext<{ docId?: string; active: boolean }>({ active: true });
export const useDoc = () => useContext(DocContext);

interface DocsState {
  docs: Partial<Record<ViewId, string[]>>;
  active: Partial<Record<ViewId, string>>;
  /** What each document shows (a saved request's id), so opening it again selects its tab. */
  items: Record<string, string | undefined>;
  newDoc(view: ViewId): string;
  select(view: ViewId, docId: string): void;
  close(view: ViewId, docId: string): void;
  setItem(view: ViewId, docId: string, item: string | undefined): void;
  /** Make sure an editor has at least one document (opening it from the rail or a shortcut). */
  ensure(view: ViewId): string;
}

const KEY = 'aps.docs';
const load = (): Pick<DocsState, 'docs' | 'active'> => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (v && typeof v === 'object') return { docs: v.docs ?? {}, active: v.active ?? {} };
  } catch {
    /* start fresh */
  }
  return { docs: {}, active: {} };
};
const persist = (s: Pick<DocsState, 'docs' | 'active'>) => {
  try {
    localStorage.setItem(KEY, JSON.stringify({ docs: s.docs, active: s.active }));
  } catch {
    /* storage unavailable */
  }
};
let seq = 0;
const newId = () => `d${Date.now().toString(36)}${(seq++).toString(36)}`;

export const useDocs = create<DocsState>((set, get) => ({
  ...load(),
  items: {},
  newDoc: (view) => {
    const id = (get().docs[view] ?? []).length ? newId() : 'main';
    const docs = { ...get().docs, [view]: [...(get().docs[view] ?? []), id] };
    const active = { ...get().active, [view]: id };
    set({ docs, active });
    persist({ docs, active });
    return id;
  },
  select: (view, docId) => {
    // a document that was closed is not brought back by selecting it (a stale tab)
    if (!(get().docs[view] ?? []).includes(docId)) return;
    const active = { ...get().active, [view]: docId };
    set({ active });
    persist({ docs: get().docs, active });
  },
  close: (view, docId) => {
    const list = get().docs[view] ?? [];
    const i = list.indexOf(docId);
    const rest = list.filter((d) => d !== docId);
    const docs = { ...get().docs, [view]: rest };
    const active = { ...get().active, [view]: get().active[view] === docId ? (rest[Math.min(i, rest.length - 1)] ?? '') : get().active[view] };
    set({ docs, active });
    persist({ docs, active });
    // the closed document's draft goes with it, and what it remembered (its saved item, its title)
    dropDraft(`${view}${docKey(docId)}`);
    const short = view === 'websocket' ? 'ws' : view;
    forgetStickyKeys([`${short}:saved:${docId}`, `${short}:title:${docId}`]);
  },
  setItem: (view, docId, item) => {
    const k = `${view}:${docId}`;
    if (get().items[k] === item) return;
    set({ items: { ...get().items, [k]: item } });
  },
  ensure: (view) => {
    const list = get().docs[view] ?? [];
    if (list.length) return get().active[view] && list.includes(get().active[view]!) ? get().active[view]! : list[0]!;
    return get().newDoc(view);
  },
}));

/**
 * Which document an intent for a multi-document editor goes to: a new one for "new", the tab that already
 * shows the item being opened, or else a new tab for it (like Postman); other intents go to the active one.
 */
export function routeDoc(view: ViewId, payload: Record<string, unknown> | undefined): string | undefined {
  if (!isDocView(view)) return undefined;
  const s = useDocs.getState();
  const p = payload ?? {};
  if (p.newDoc || p.reset || p.addServer) return s.newDoc(view);
  const item = (p.requestId ?? p.savedId ?? p.serverId ?? p.spec ?? p.dataset) as string | undefined;
  if (item) {
    const found = (s.docs[view] ?? []).find((d) => s.items[`${view}:${d}`] === item);
    if (found) {
      s.select(view, found);
      return found;
    }
    // the item gets its own tab
    return s.newDoc(view);
  }
  return s.ensure(view);
}

/** The storage key suffix of a document's draft (`main` keeps the pre-tabs key). */
export const docKey = (docId?: string) => (docId && docId !== 'main' ? `:${docId}` : '');
