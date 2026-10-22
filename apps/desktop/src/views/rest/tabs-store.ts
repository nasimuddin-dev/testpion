/**
 * The HTTP editor's tabs, owned by a store rather than by the view (UI audit 2026-10-21, F-24): the shared tab strip,
 * Close all from any editor, Ctrl+Shift+T and an edit made outside the app reach them whether or not the HTTP view is
 * mounted, so the view (its editor, response viewer and their libraries) loads the first time it is shown, not at startup.
 * The tabs are the workspace's draft (`rest`), written a moment after each change and read again when the workspace changes.
 */
import { create } from 'zustand';
import { call } from '../../api';
import { confirmAction, toastError } from '../../store';
import type { Collection, SavedHttpRequest } from '../../types';
import { findNode, mapNodes } from '../../lib/collection-nodes';
import { refreshCollection } from '../../lib/collections-store';
import { noteClosedTabs } from '../../lib/closed-tabs';
import { useExternalChange } from '../../lib/external-change';
import { saveAsTestFile } from '../../lib/save-test';
import { fromEngineRequest, toEngineRequest } from '../../lib/url';
import { uid } from '../../lib/format';
import { afterScopeChange } from '../../lib/ws-scope';
import { NEW_TAB_TITLE, tabTitle, useEditorTabsStore, type EditorTab } from '../../components/EditorTabs';
import { blankRequest, drafts, savedSnapshot, type RestTab, type SendResult } from './types';

type Update<T> = T | ((cur: T) => T);
const apply = <T>(u: Update<T>, cur: T): T => (typeof u === 'function' ? (u as (c: T) => T)(cur) : u);

interface RestTabsState {
  tabs: RestTab[];
  /** The tab on screen ('' when every tab was closed). */
  active: string;
  /** The last response of each tab (not saved: a restart starts without them). */
  results: Record<string, SendResult>;
  setTabs(u: Update<RestTab[]>): void;
  setActive(id: string): void;
  setResults(u: Update<Record<string, SendResult>>): void;
}

/** The tabs as the workspace's draft has them. */
function fromDraft(): Pick<RestTabsState, 'tabs' | 'active'> {
  const d = drafts.load();
  // drafts from before the URL/params sync kept the query only in the Params table; a first launch gets a blank request,
  // and a window whose every tab was closed (active saved as '') keeps none
  const tabs = d.tabs.length ? d.tabs.map((t) => (t.request.url.includes('?') ? t : { ...t, request: fromEngineRequest(t.request) })) : d.active === '' ? [] : [blankRequest()];
  return { tabs, active: d.active ?? tabs[0]?.id ?? '' };
}

export const useRestTabs = create<RestTabsState>((set) => ({
  ...fromDraft(),
  results: {},
  setTabs: (u) => set((s) => ({ tabs: apply(u, s.tabs) })),
  setActive: (active) => set({ active }),
  setResults: (u) => set((s) => ({ results: apply(u, s.results) })),
}));

/** Pinned tabs first, in their own order. */
export const orderedTabs = (tabs: RestTab[]): RestTab[] => [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)];

const patchTab = (id: string, patch: Partial<RestTab>) => useRestTabs.getState().setTabs((ts) => ts.map((x) => (x.id === id ? { ...x, ...patch } : x)));

/** Close several tabs, asking once when any has unsaved changes. */
export async function closeRestTabs(ids: string[]): Promise<void> {
  const closing = useRestTabs.getState().tabs.filter((x) => ids.includes(x.id));
  if (!closing.length) return;
  const dirty = closing.filter((x) => x.dirty);
  if (
    dirty.length &&
    !(await confirmAction({
      title: 'Unsaved changes',
      message: dirty.length === 1 ? `"${dirty[0]!.name}" has unsaved changes.` : `${dirty.length} of the tabs you are closing have unsaved changes.`,
      detail: 'Close anyway and discard them? Save with Ctrl+S to keep them.',
      confirmLabel: 'Discard changes',
      danger: true,
    }))
  )
    return;
  // a saved request's tab can be reopened (Ctrl+Shift+T); a draft's cannot (its changes were discarded)
  noteClosedTabs(closing.map((x) => (x.collectionId && x.requestId ? { ref: { kind: 'request', collectionId: x.collectionId, requestId: x.requestId }, label: x.name } : undefined)));
  const { tabs, active, results } = useRestTabs.getState();
  // closing the last tab leaves none (Postman-style), not a new blank request
  const left = tabs.filter((x) => !ids.includes(x.id));
  let next = active;
  if (ids.includes(active)) {
    const ordered = orderedTabs(tabs);
    const i = ordered.findIndex((x) => x.id === active);
    const after = ordered.slice(i + 1).find((x) => !ids.includes(x.id)) ?? [...ordered.slice(0, i)].reverse().find((x) => !ids.includes(x.id));
    next = after?.id ?? left[0]?.id ?? '';
  }
  // a closed tab's response goes with it (kept, every response ever received stayed in memory: soak test)
  const kept = ids.some((id) => id in results) ? Object.fromEntries(Object.entries(results).filter(([k]) => !ids.includes(k))) : results;
  useRestTabs.setState({ tabs: left, active: next, results: kept });
}

/** File menu / command palette / tab bar ⋯: pinned tabs are kept by the bulk commands. */
export function runRestTabCommand(command: string): void {
  const { tabs, active } = useRestTabs.getState();
  const unpinned = orderedTabs(tabs)
    .filter((x) => !x.pinned)
    .map((x) => x.id);
  if (command === 'close') {
    const cur = tabs.find((x) => x.id === active);
    if (cur && !cur.pinned) void closeRestTabs([cur.id]);
  } else if (command === 'closeOthers') void closeRestTabs(unpinned.filter((id) => id !== active));
  else if (command === 'closeAll') void closeRestTabs(unpinned);
}

function duplicateTab(t: RestTab): void {
  const copy: RestTab = { ...structuredClone(t), id: uid('tab-'), name: `${t.name} copy`, collectionId: undefined, requestId: undefined, examples: undefined, pinned: false, dirty: true };
  const s = useRestTabs.getState();
  s.setTabs((ts) => {
    const i = ts.findIndex((x) => x.id === t.id);
    return [...ts.slice(0, i + 1), copy, ...ts.slice(i + 1)];
  });
  s.setActive(copy.id);
}

/** Rename a tab (edited in place in the tab strip); a saved request is renamed in its collection too. */
async function renameTabTo(t: RestTab, name: string): Promise<void> {
  if (!name || name === t.name) return;
  patchTab(t.id, { name });
  if (!t.collectionId || !t.requestId) return;
  try {
    const c = await call<Collection>('col.get', { id: t.collectionId }).catch(() => undefined);
    if (!c || !findNode(c.items, t.requestId)) return;
    await call('col.save', { ...c, items: mapNodes(c.items, (x) => (x.id === t.requestId ? { ...x, name } : x)) });
    await refreshCollection(c.id);
  } catch (e) {
    toastError(e);
  }
}

/** Save a tab's request as a YAML test file (the tab menu, the breadcrumb). */
export function saveRestTabAsTest(t: RestTab): void {
  const status = useRestTabs.getState().results[t.id]?.response?.status;
  void saveAsTestFile(t.name, { kind: 'http', request: toEngineRequest(t.request), preRequestScript: t.preRequestScript, testScript: t.testScript, status }, t.assertions);
}

/** A tab of the shared strip (EditorTabs) for one HTTP tab. */
const stripTab = (t: RestTab): EditorTab => ({
  key: `rest:${t.id}`,
  view: 'rest',
  title: tabTitle(t.name, NEW_TAB_TITLE.rest),
  badge: t.request.method,
  badgeClass: `method-${t.request.method}`,
  item: t.requestId,
  dirty: t.dirty,
  pinned: t.pinned,
  preview: t.preview,
  onKeep: () => patchTab(t.id, { preview: false }),
  onSelect: () => useRestTabs.getState().setActive(t.id),
  onClose: () => void closeRestTabs([t.id]),
  closeMany: (keys: string[]) => void closeRestTabs(keys.map((k) => k.replace(/^rest:/, ''))),
  // the tab menu itself is the shared one (EditorTabs), the same on every request tab
  onRenameTo: (name: string) => renameTabTo(t, name),
  onDuplicate: () => duplicateTab(t),
  onSaveAsTest: () => saveRestTabAsTest(t),
  onTogglePin: () => patchTab(t.id, { pinned: !t.pinned }),
});

/** The tabs in the shared strip, the one on screen marked. */
function publish(): void {
  const { tabs, active } = useRestTabs.getState();
  const cur = tabs.find((t) => t.id === active) ?? tabs[0];
  useEditorTabsStore.getState().publish('rest', orderedTabs(tabs).map(stripTab), cur ? `rest:${cur.id}` : undefined);
}

useRestTabs.subscribe((s, prev) => {
  if (s.tabs === prev.tabs && s.active === prev.active) return;
  drafts.save({ tabs: s.tabs, active: s.active });
  publish();
});
publish();
// another workspace: its own tabs (the draft is per workspace); responses do not cross over
afterScopeChange(() => useRestTabs.setState({ ...fromDraft(), results: {} }));

/**
 * Open requests follow their saved version when files change outside the app (GIT-103 / GIT-302, WF-15): a tab without
 * edits takes it, one with edits asks first, only when that very request changed on disk. Mounted by the window (App),
 * so the tabs follow also while the HTTP view was never shown.
 */
export function RestTabsFollower(): null {
  useExternalChange<SavedHttpRequest>({
    kinds: ['collections'],
    items: () =>
      useRestTabs
        .getState()
        .tabs.filter((t) => t.collectionId && t.requestId)
        .map((t) => ({ key: t.id, label: t.name, base: t.base, dirty: !!t.dirty })),
    read: async (keys) => {
      const open = useRestTabs.getState().tabs.filter((t) => keys.includes(t.id));
      // the open requests' collections, read whole (the shared list refreshes itself from the same event)
      const ids = [...new Set(open.map((t) => t.collectionId!))];
      const cols = (await Promise.all(ids.map((id) => call<Collection>('col.get', { id }).catch(() => undefined)))).filter((c): c is Collection => !!c);
      const out = new Map<string, { snapshot: string; value: SavedHttpRequest }>();
      for (const t of open) {
        const n = findNode(cols.find((c) => c.id === t.collectionId)?.items ?? [], t.requestId!);
        if (n?.kind === 'http') out.set(t.id, { snapshot: savedSnapshot(n), value: n });
      }
      return out;
    },
    take: (id, n) => useRestTabs.getState().setTabs((ts) => ts.map((x) => (x.id === id ? { ...x, ...tabFromSaved(n), id: x.id, collectionId: x.collectionId, pinned: x.pinned } : x))),
    keep: (id, snapshot) => patchTab(id, { base: snapshot }),
  });
  return null;
}

/** A tab's contents from a saved request (opening it, or taking the version on disk). */
export function tabFromSaved(n: SavedHttpRequest): RestTab {
  return {
    id: uid('tab-'),
    name: n.name,
    request: fromEngineRequest(structuredClone(n.request)),
    preRequestScript: n.preRequestScript,
    testScript: n.testScript,
    assertions: n.assertions ?? [],
    requestId: n.id,
    examples: n.examples,
    description: n.description,
    dirty: false,
    base: savedSnapshot(n),
  };
}
