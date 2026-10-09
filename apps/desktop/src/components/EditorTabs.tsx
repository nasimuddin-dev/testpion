import { ChevronDown, Copy, FileCheck2, Pin, PinOff, Plug, Plus, Radio, Send, Sparkles, Waypoints } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { useApp, type ViewId } from '../store';
import { docKey, isDocView, useDoc, useDocs } from '../lib/docs';
import { loadDraft, saveDraft } from '../lib/draft-store';
import { Button, Empty, Menu, type MenuItem } from './ui';
import { DocTabStrip, type DocTab } from './DocTabStrip';
import { ResponseLayoutButton } from './ResponseSplit';
import { readPersisted, writePersisted } from '../lib/sticky';
import type { PersistFormat } from '../lib/sticky';

/**
 * One tab strip for every request editor (Postman-style): REST's tabs and a tab for each other editor that
 * holds a document (GraphQL, gRPC, WebSocket, MCP). Each editor publishes its own tabs with what selecting,
 * closing and the right-click menu do, so no editor's drafts are touched by the strip.
 */
export interface EditorTab {
  /** Unique across editors, e.g. `rest:tab-123` or `graphql:main`. */
  key: string;
  view: ViewId;
  title: string;
  /** Method or protocol shown before the title (GET, GQL, gRPC, WS, MCP). */
  badge: string;
  badgeClass?: string;
  dirty?: boolean;
  pinned?: boolean;
  /** The saved request (or gRPC call, connection) the tab shows, highlighted in the sidebar. */
  item?: string;
  onSelect?(): void;
  onClose(): void;
  /** Close several of this editor's tabs at once (one question about unsaved changes); by keys. */
  closeMany?(keys: string[]): void;
  onRename?(): void;
  /** Rename to this name (the strip edits the title in place); without it, onRename opens the editor's own dialog. */
  onRenameTo?(name: string): unknown;
  /** Open a copy of this tab (not saved yet). */
  onDuplicate?(): void;
  /** Save what the tab holds as a YAML test file. */
  onSaveAsTest?(): void;
  /** Pin or unpin the tab (pinned tabs come first and stay open on "close other / all"). */
  onTogglePin?(): void;
}

interface EditorTabsState {
  /** Tabs by publisher: an editor (`rest`, `mcp`) or one document of a multi-document editor (`graphql:<docId>`). */
  byView: Record<string, EditorTab[]>;
  /** The tab that's active inside each publisher (REST has several). */
  activeByView: Record<string, string | undefined>;
  publish(group: string, tabs: EditorTab[], active?: string): void;
  /** Editors that have a tab open: they stay mounted (and come back after a restart). REST always does. */
  openViews: ViewId[];
  setOpen(view: ViewId, open: boolean): void;
  /** Pinned tabs of the single- and multi-document editors, by tab key (REST keeps its own). */
  pinned: Record<string, boolean>;
  togglePin(key: string): void;
}

const OPEN_KEY = 'aps.openEditors';
const PIN_KEY = 'aps.pinnedTabs';
const PINNED: PersistFormat<Record<string, boolean>> = { parse: (raw) => (((v) => (v && typeof v === 'object' ? v : undefined))(JSON.parse(raw))) };
const OPEN: PersistFormat<ViewId[]> = { parse: (raw) => (((v) => (Array.isArray(v) ? v : undefined))(JSON.parse(raw))) };

export const useEditorTabsStore = create<EditorTabsState>((set, get) => ({
  byView: {},
  activeByView: {},
  openViews: readPersisted(OPEN_KEY, [], OPEN),
  pinned: readPersisted(PIN_KEY, {}, PINNED),
  togglePin: (key) => {
    const next = { ...get().pinned };
    if (next[key]) delete next[key];
    else next[key] = true;
    writePersisted(PIN_KEY, next, PINNED);
    set({ pinned: next });
  },
  setOpen: (view, open) => {
    const cur = get().openViews;
    if (open === cur.includes(view)) return;
    const next = open ? [...cur, view] : cur.filter((v) => v !== view);
    writePersisted(OPEN_KEY, next, OPEN);
    set({ openViews: next });
  },
  publish: (view, tabs, active) => {
    const prev = get().byView[view];
    // skip identical updates so editors can publish on every render
    const same = prev && prev.length === tabs.length && prev.every((t, i) => sameTab(t, tabs[i]!)) && get().activeByView[view] === active;
    if (same) {
      // keep the handlers fresh without re-rendering the strip
      get().byView[view] = tabs;
      return;
    }
    set({ byView: { ...get().byView, [view]: tabs }, activeByView: { ...get().activeByView, [view]: active } });
  },
}));

const sameTab = (a: EditorTab, b: EditorTab) => a.key === b.key && a.title === b.title && a.badge === b.badge && a.dirty === b.dirty && a.pinned === b.pinned;

/** Publish an editor's tabs (call it on every render; unchanged tabs don't re-render the strip). */
export function useEditorTabs(group: string, tabs: EditorTab[], active?: string) {
  const ref = useRef({ tabs, active });
  ref.current = { tabs, active };
  useEffect(() => {
    useEditorTabsStore.getState().publish(group, ref.current.tabs, ref.current.active);
  });
  useEffect(() => () => useEditorTabsStore.getState().publish(group, []), [group]);
}

/**
 * A single-document editor's tab (GraphQL, gRPC, WebSocket, MCP): shown while it holds something, hidden by
 * its close button until the editor is opened again. The draft itself is kept.
 */
export function useSingleEditorTab(view: ViewId, tab: (Omit<EditorTab, 'key' | 'view' | 'onClose'> & { item?: string }) | undefined) {
  const { docId } = useDoc();
  const item = tab?.item;
  useEffect(() => {
    if (docId) useDocs.getState().setItem(view, docId, item);
  }, [view, docId, item]);
  const current = useApp((s) => s.view);
  const [hidden, setHidden] = useState(false);
  const shown = !!tab && !hidden;
  useEffect(() => useEditorTabsStore.getState().setOpen(view, shown), [view, shown]);
  // opening the editor again shows its tab again
  useEffect(() => {
    if (current === view) setHidden(false);
  }, [current, view]);
  const key = `${view}:${docId ?? 'main'}`;
  const pinned = useEditorTabsStore((s) => !!s.pinned[key]);
  const common = {
    pinned,
    onTogglePin: () => useEditorTabsStore.getState().togglePin(key),
    onDuplicate:
      tab?.onDuplicate ??
      (docId
        ? () => {
            // the copy starts from this document's draft, not linked to the saved item (saving creates a new one)
            try {
              const source = loadDraft<Record<string, unknown>>(`${view}${docKey(docId)}`);
              const draft = source ? (JSON.parse(JSON.stringify(source)) as Record<string, unknown>) : null;
              const copy = useDocs.getState().newDoc(view);
              if (draft) {
                delete draft.requestId;
                delete draft.collectionId;
                delete draft.savedId;
                if (typeof draft.name === 'string' && draft.name) draft.name = `${draft.name} copy`;
                saveDraft(`${view}${docKey(copy)}`, draft);
              }
              useApp.getState().setView(view);
            } catch {
              /* storage unavailable */
            }
          }
        : undefined),
  };
  useEditorTabs(
    key,
    docId && tab
      ? [
          {
            ...tab,
            ...common,
            key,
            view,
            onSelect: () => useDocs.getState().select(view, docId),
            onClose: () => {
              useDocs.getState().close(view, docId);
              // the last document of this editor: go to another open tab (or REST). Read the state after the close
              // (a snapshot from before it still lists the closed document, so the editor was never left)
              if (!(useDocs.getState().docs[view] ?? []).length) leaveEditor(view);
            },
          },
        ]
      : tab && !hidden
      ? [
          {
            ...tab,
            ...common,
            key,
            view,
            onClose: () => {
              setHidden(true);
              // leave the editor for another open tab (or REST)
              leaveEditor(view);
            },
          },
        ]
      : [],
    tab ? key : undefined,
  );
}

/** An editor's last tab closed while it's on screen: show the last other open tab (or REST). */
function leaveEditor(view: ViewId) {
  // several tabs closing at once: the batch moves once, at its end (moving now could open an editor whose tab is
  // about to close, and an editor shown with no document starts a new one: that tab would never close)
  if (batchClosing) return;
  if (useApp.getState().view !== view) return;
  const others = Object.values(useEditorTabsStore.getState().byView)
    .flat()
    .filter((t) => t && t.view !== view);
  const next = others[others.length - 1];
  useApp.getState().setView(next?.view ?? 'rest');
  next?.onSelect?.();
}

/** Close every tab that shows one of these saved items (they were deleted), whatever the editor. */
export function closeTabsFor(itemIds: string[]) {
  const ids = new Set(itemIds);
  const open = Object.values(useEditorTabsStore.getState().byView)
    .flat()
    .filter((t) => t?.item && ids.has(t.item));
  for (const view of new Set(open.map((t) => t.view))) {
    const mine = open.filter((t) => t.view === view);
    if (mine[0]?.closeMany) mine[0].closeMany(mine.map((t) => t.key));
    else mine.forEach((t) => t.onClose());
  }
}

/**
 * The editor area when no tab is open: exactly the same in every request view (HTTP, GraphQL, gRPC, WebSocket, MCP,
 * API definitions): every kind of request under "New request", and "Describe with AI".
 */
export function NoOpenTabs({ onDescribe }: { onDescribe?(): void }) {
  const describe = onDescribe ?? (() => useApp.getState().openIntent('rest', { describe: true }));
  return (
    <Empty
      icon={<Send size={28} />}
      title="No open requests"
      action={
        <div className="flex flex-wrap justify-center gap-2">
          <Menu
            width={240}
            align="center"
            items={newRequestItems()}
            trigger={
              <Button variant="primary" icon={<Plus size={13} />}>
                New request
                <ChevronDown size={13} />
              </Button>
            }
          />
          <Button icon={<Sparkles size={13} />} onClick={describe} title="Describe a request in plain words; the AI assistant drafts it and you review it before sending">
            Describe with AI
          </Button>
        </div>
      }
    >
      Open a request from the sidebar, or start a new one.
    </Empty>
  );
}

/** The title of a tab that isn't saved yet (nor renamed): the same wording in every editor, as in the New request menu. */
export const NEW_TAB_TITLE = {
  rest: 'New HTTP request',
  graphql: 'New GraphQL request',
  grpc: 'New gRPC request',
  websocket: 'New WebSocket request',
  socketio: 'New Socket.IO request',
  mqtt: 'New MQTT request',
  kafka: 'New Kafka connection',
  mcp: 'New MCP server',
} as const;
/** Names earlier versions gave new tabs: shown as today's name. */
const OLD_DEFAULTS = new Set(['Untitled request', 'GraphQL query', 'gRPC request', 'WebSocket', 'MCP server']);
export const tabTitle = (name: string | undefined, fallback: string) => (name && !OLD_DEFAULTS.has(name) ? name : fallback);

/** "New request" everywhere (tab strip +, empty editor, explorer): every kind of request, the same list. */
export function newRequestItems(): MenuItem[] {
  const s = useApp.getState();
  return [
    { label: 'HTTP request', icon: <Plus size={14} />, shortcut: 'Ctrl+T', onSelect: () => s.openIntent('rest', { newTab: true }) },
    { label: 'GraphQL request', icon: <Plus size={14} />, onSelect: () => s.openIntent('graphql', { newDoc: true, reset: true }) },
    { label: 'gRPC request', icon: <Waypoints size={14} />, onSelect: () => s.openIntent('grpc', { newDoc: true }) },
    { label: 'WebSocket, Socket.IO, MQTT or Kafka', icon: <Radio size={14} />, onSelect: () => s.openIntent('websocket', { newDoc: true }) },
    { label: 'MCP server', icon: <Plug size={14} />, onSelect: () => s.openIntent('mcp', { addServer: true }) },
  ];
}

/** Set while a batch of tabs closes (Close all / others / to the right). */
let batchClosing = false;

const ORDER: ViewId[] = ['rest', 'graphql', 'grpc', 'websocket', 'mcp', 'apidef', 'dataset'];

/** The strip's tab for an editor's tab: the shared model, the editor's tab kept behind it. */
const toDocTab = (t: EditorTab): DocTab<EditorTab> => ({
  id: t.key,
  title: t.title,
  badge: t.badge,
  badgeClass: t.badgeClass,
  dirty: t.dirty,
  pinned: t.pinned,
  rename: t.onRenameTo ? 'inline' : t.onRename ? 'dialog' : undefined,
  data: t,
});

export function EditorTabStrip() {
  const view = useApp((s) => s.view);
  const byView = useEditorTabsStore((s) => s.byView);
  const activeByView = useEditorTabsStore((s) => s.activeByView);
  const docs = useDocs((s) => s.docs);
  const activeDocs = useDocs((s) => s.active);
  const inOrder = ORDER.flatMap((v) => (isDocView(v) ? (docs[v] ?? []).flatMap((d) => byView[`${v}:${d}`] ?? []) : (byView[v] ?? byView[`${v}:main`] ?? [])));
  const tabs = [...inOrder.filter((t) => t.pinned), ...inOrder.filter((t) => !t.pinned)];
  const activeKey = isDocView(view) ? `${view}:${activeDocs[view]}` : activeByView[view];
  const activeTab = tabs.find((t) => t.view === view && t.key === activeKey);
  const select = (t: EditorTab) => {
    if (useApp.getState().view !== t.view) useApp.getState().setView(t.view);
    t.onSelect?.();
  };
  /** Close several tabs at once (Close other / all / to the right): per editor one batch close where the editor offers it (REST), else tab by tab. */
  const close = (list: EditorTab[]) => {
    const open = list.filter((x) => !x.pinned);
    batchClosing = true;
    try {
      for (const v of new Set(open.map((x) => x.view))) {
        const mine = open.filter((x) => x.view === v);
        if (mine[0]?.closeMany) mine[0].closeMany(mine.map((x) => x.key));
        else mine.forEach((x) => x.onClose());
      }
    } finally {
      batchClosing = false;
    }
    // then, once: if the editor on screen lost all its tabs, show the last tab left (or the empty HTTP editor)
    const closed = new Set(open);
    const left = tabs.filter((x) => !closed.has(x));
    const current = useApp.getState().view;
    if (!left.some((x) => x.view === current)) {
      const next = left[left.length - 1];
      useApp.getState().setView(next?.view ?? 'rest');
      next?.onSelect?.();
    }
  };
  return (
    <DocTabStrip<EditorTab>
      label="Open requests"
      tabs={tabs.map(toDocTab)}
      activeId={activeTab?.key}
      onSelect={(t) => select(t.data!)}
      onClose={(_ids, closing) => (closing.length === 1 ? closing[0]!.data!.onClose() : close(closing.map((t) => t.data!)))}
      onRename={(t, name) => (name !== undefined ? t.data!.onRenameTo?.(name) : t.data!.onRename?.())}
      extraItems={({ data: t }) => [
        { label: t!.pinned ? 'Unpin tab' : 'Pin tab', icon: t!.pinned ? <PinOff size={13} /> : <Pin size={13} />, disabled: !t!.onTogglePin, onSelect: () => t!.onTogglePin?.() },
        { label: 'Duplicate tab', icon: <Copy size={13} />, disabled: !t!.onDuplicate, onSelect: () => t!.onDuplicate?.() },
        { label: 'Save as test file…', icon: <FileCheck2 size={13} />, disabled: !t!.onSaveAsTest, onSelect: () => t!.onSaveAsTest?.() },
      ]}
      afterTabs={
        <Menu
          width={240}
          align="start"
          trigger={
            <button aria-label="New tab" title="New request (HTTP, GraphQL, gRPC, WebSocket, MCP)" className="mx-1 mb-1 shrink-0 grid place-items-center h-7 w-7 rounded-md text-muted hover:text-fg hover:bg-hover data-[state=open]:bg-hover">
              <Plus size={14} />
            </button>
          }
          items={newRequestItems()}
        />
      }
      actions={<ResponseLayoutButton />}
    />
  );
}
