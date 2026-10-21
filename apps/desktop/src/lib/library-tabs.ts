import { useEffect, useRef, useState } from 'react';
import { dropDraft, loadDraft, saveDraft } from './draft-store';
import { afterScopeChange } from './ws-scope';
import { uid } from './format';

/** One open tab of a view whose items are saved in a library (Load tests, Evaluations, AI prompts). */
export interface LibraryTab {
  /** The tab's own id (its draft is kept under it); `main` is the first tab, whose draft is the view's old draft. */
  id: string;
  /** The saved item it shows; none: not saved yet. */
  savedId?: string;
  /** A preview tab: the next item opened from the list replaces it, until it is kept (double-click) or edited. */
  preview?: boolean;
}

export interface TabsState {
  tabs: LibraryTab[];
  active: string;
  /** Every tab was closed (a view that can show nothing: its tab strip is empty and it says so). `main` is kept as the next new tab. */
  empty?: boolean;
}

/**
 * Where a saved item opens: its own tab when it has one (opened for good, a preview stops being one); else the preview
 * tab when `preview` (replaced); else the first tab while it is the only one, empty and unsaved; else a new tab
 * (`newId`). `id` is the tab it lands in; `fresh` whether that tab starts from the item's draft. `keepFirst`: the first
 * tab is never reused (the Debugger's live capture is a tab of its own, not an empty one).
 */
export function openTab(s: TabsState, savedId: string, preview: boolean, newId: string, keepFirst = false): { state: TabsState; id: string; fresh: boolean } {
  const had = s.tabs.find((t) => t.savedId === savedId);
  if (had) return { state: { tabs: s.tabs.map((t) => (t.id === had.id && !preview ? { ...t, preview: false } : t)), active: had.id }, id: had.id, fresh: false };
  const reuse = (preview ? s.tabs.find((t) => t.preview) : undefined) ?? (!keepFirst && s.tabs.length === 1 && !s.tabs[0]!.savedId && !s.tabs[0]!.preview ? s.tabs[0] : undefined);
  const id = reuse ? reuse.id : newId;
  const next: LibraryTab = { id, savedId, ...(preview ? { preview: true } : {}) };
  return { state: { tabs: reuse ? s.tabs.map((t) => (t.id === reuse.id ? next : t)) : [...s.tabs, next], active: id }, id, fresh: true };
}

/** Close tabs: the next one to the right becomes active (else the last left); none left: one fresh `main` tab. */
export function closeTabs(s: TabsState, ids: string[]): TabsState {
  const left = s.tabs.filter((t) => !ids.includes(t.id));
  if (!left.length) return { tabs: [{ id: 'main' }], active: 'main' };
  const i = s.tabs.findIndex((t) => t.id === s.active);
  const active = ids.includes(s.active) ? (s.tabs.slice(i + 1).find((t) => !ids.includes(t.id)) ?? left[left.length - 1]!).id : s.active;
  return { tabs: left, active };
}

interface Drafts<D> {
  forDoc(docId?: string): { load(): D; save(v: D): void };
}

const draftKeyOf = (group: string, id: string) => `${group}${id === 'main' ? '' : `:${id}`}`;

/**
 * WF-19 One tab model for views that open saved items: the same tabs as every editor (DocTabStrip), each with its own
 * draft (so switching tabs loses nothing), preview tabs (a single click in the list opens one, in italics; the next
 * single click replaces it; double-click or an edit keeps it), and the open tabs kept per workspace (draft-store,
 * which is scoped). The view's `d` is the active tab's draft.
 */
export function useLibraryTabs<D>(group: string, drafts: Drafts<D>, opts: { keepFirst?: boolean; canBeEmpty?: boolean } = {}) {
  const stateKey = `tabs:${group}`;
  const read = (): TabsState => {
    const s = loadDraft<TabsState>(stateKey);
    return s && Array.isArray(s.tabs) && s.tabs.length && s.tabs.some((t) => t.id === s.active) ? s : { tabs: [{ id: 'main' }], active: 'main' };
  };
  const [st, setSt] = useState<TabsState>(read);
  // another workspace: its own tabs
  useEffect(() => afterScopeChange(() => setSt(read())), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => saveDraft(stateKey, st), [stateKey, st]);
  const draftsOf = (id: string) => drafts.forDoc(id === 'main' ? undefined : id);

  const tab = st.tabs.find((t) => t.id === st.active) ?? st.tabs[0]!;
  // the active tab's draft; a switch reads the other tab's (the one left was saved as it changed)
  const [cur, setCur] = useState(() => ({ id: tab.id, d: draftsOf(tab.id).load() }));
  if (cur.id !== tab.id) setCur({ id: tab.id, d: draftsOf(tab.id).load() });
  useEffect(() => draftsOf(cur.id).save(cur.d), [cur]); // eslint-disable-line react-hooks/exhaustive-deps
  const stRef = useRef(st);
  stRef.current = st;

  const update = (f: (s: TabsState) => TabsState) => setSt((s) => f(s));
  const keep = (id: string) => update((s) => ({ ...s, tabs: s.tabs.map((t) => (t.id === id && t.preview ? { ...t, preview: false } : t)) }));
  /** Change the active tab's draft; an edit keeps a preview tab. */
  const setD = (f: D | ((d: D) => D)) => {
    setCur((c) => ({ ...c, d: typeof f === 'function' ? (f as (d: D) => D)(c.d) : f }));
    if (tab.preview) keep(tab.id);
  };
  /**
   * Open a saved item: its tab when it has one, else a new tab of its own.
   * `data` is the item's saved draft (the tab starts from it).
   */
  const keepFirst = !!opts.keepFirst;
  const open = (savedId: string, data: D, _o: { preview?: boolean } = {}) => {
    // every click opens its own tab (a preview that the next click replaced lost the response and the edits of the one before: owner, 2026-10-21); `_o.preview` is accepted for the callers that still pass it
    const r = openTab(stRef.current, savedId, false, uid('t'), keepFirst);
    if (r.fresh) {
      draftsOf(r.id).save(data);
      // the tab on screen was reused: it shows the item now
      if (r.id === cur.id) setCur({ id: r.id, d: data });
    }
    update(() => r.state);
  };
  /** A new, unsaved tab with this draft. */
  const newTab = (data: D) => {
    // after closing every tab, the new one takes the hidden `main` tab
    const id = stRef.current.empty ? 'main' : uid('t');
    draftsOf(id).save(data);
    if (id === cur.id) setCur({ id, d: data });
    update((x) => (x.empty ? { tabs: [{ id }], active: id } : { tabs: [...x.tabs, { id }], active: id }));
  };
  const select = (id: string) => update((x) => ({ ...x, active: id }));
  /** Close tabs (their drafts go); closing the last leaves one fresh tab. */
  const close = (ids: string[], fresh: D) => {
    for (const id of ids) dropDraft(draftKeyOf(group, id));
    const next = closeTabs(stRef.current, ids);
    // every tab closed: one fresh tab, or (a view that can be empty) none, with a fresh one waiting
    if (stRef.current.tabs.every((t) => ids.includes(t.id))) {
      draftsOf('main').save(fresh);
      if (cur.id === 'main') setCur({ id: 'main', d: fresh });
      if (opts.canBeEmpty) return update(() => ({ ...next, empty: true }));
    }
    update(() => next);
  };
  /** The active tab now shows this saved item (after Save, or Save as). */
  const setSaved = (savedId: string | undefined) => update((x) => ({ ...x, tabs: x.tabs.map((t) => (t.id === x.active ? { ...t, savedId, preview: false } : t)) }));

  return { tabs: st.empty ? [] : st.tabs, empty: !!st.empty, active: tab, d: cur.d, setD, open, newTab, select, close, keep, setSaved };
}
