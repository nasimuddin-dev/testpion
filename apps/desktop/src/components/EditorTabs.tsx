import { ArrowRightToLine, ChevronDown, ChevronLeft, ChevronRight, Copy, FileCheck2, ListX, Pencil, Pin, PinOff, Plug, Plus, Radio, Send, Sparkles, SquareX, Waypoints, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { useApp, type ViewId } from '../store';
import { docKey, isDocView, useDoc, useDocs } from '../lib/docs';
import { loadDraft, saveDraft } from '../lib/draft-store';
import { Button, cx, Empty, Menu, type MenuItem } from './ui';
import { InlineRename } from './TreeParts';
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

/** The right-click menu of every tab: pin, rename, duplicate, save as test, and closing across every tab in the strip. */
function defaultTabMenu(t: EditorTab, all: EditorTab[], startRename: (t: EditorTab) => void): MenuItem[] {
  const i = all.indexOf(t);
  // per editor: one batch close where the editor offers it (REST), else tab by tab
  const close = (list: EditorTab[]) => {
    const open = list.filter((x) => !x.pinned);
    batchClosing = true;
    try {
      for (const view of new Set(open.map((x) => x.view))) {
        const mine = open.filter((x) => x.view === view);
        if (mine[0]?.closeMany) mine[0].closeMany(mine.map((x) => x.key));
        else mine.forEach((x) => x.onClose());
      }
    } finally {
      batchClosing = false;
    }
    // then, once: if the editor on screen lost all its tabs, show the last tab left (or the empty HTTP editor)
    const closed = new Set(open);
    const left = all.filter((x) => !closed.has(x));
    const current = useApp.getState().view;
    if (!left.some((x) => x.view === current)) {
      const next = left[left.length - 1];
      useApp.getState().setView(next?.view ?? 'rest');
      next?.onSelect?.();
    }
  };
  const others = all.filter((x) => x !== t && !x.pinned);
  const right = all.slice(i + 1).filter((x) => !x.pinned);
  // one menu for every tab; what an editor can't do is shown disabled, so every menu reads the same
  return [
    { label: t.pinned ? 'Unpin tab' : 'Pin tab', icon: t.pinned ? <PinOff size={13} /> : <Pin size={13} />, disabled: !t.onTogglePin, onSelect: () => t.onTogglePin?.() },
    { label: 'Rename', icon: <Pencil size={13} />, shortcut: 'F2', disabled: !t.onRename && !t.onRenameTo, onSelect: () => startRename(t) },
    { label: 'Duplicate tab', icon: <Copy size={13} />, disabled: !t.onDuplicate, onSelect: () => t.onDuplicate?.() },
    { label: 'Save as test file…', icon: <FileCheck2 size={13} />, disabled: !t.onSaveAsTest, onSelect: () => t.onSaveAsTest?.() },
    { label: 'Close tab', icon: <X size={13} />, separator: true, shortcut: 'Middle-click', disabled: !!t.pinned, onSelect: () => t.onClose() },
    { label: 'Close other tabs', icon: <SquareX size={13} />, disabled: !others.length, onSelect: () => close(others) },
    { label: 'Close tabs to the right', icon: <ArrowRightToLine size={13} />, disabled: !right.length, onSelect: () => close(right) },
    { label: 'Close all tabs', icon: <ListX size={13} />, disabled: !all.some((x) => !x.pinned), onSelect: () => close(all) },
  ];
}

/** Every tab's menu, the same for every kind of request. */
const tabMenu = defaultTabMenu;

const ORDER: ViewId[] = ['rest', 'graphql', 'grpc', 'websocket', 'mcp', 'apidef'];
const TAB_W = 190;

export function EditorTabStrip() {
  const view = useApp((s) => s.view);
  const byView = useEditorTabsStore((s) => s.byView);
  const activeByView = useEditorTabsStore((s) => s.activeByView);
  const docs = useDocs((s) => s.docs);
  const activeDocs = useDocs((s) => s.active);
  const inOrder = ORDER.flatMap((v) => (isDocView(v) ? (docs[v] ?? []).flatMap((d) => byView[`${v}:${d}`] ?? []) : (byView[v] ?? byView[`${v}:main`] ?? [])));
  const tabs = [...inOrder.filter((t) => t.pinned), ...inOrder.filter((t) => !t.pinned)];
  const activeKey = isDocView(view) ? `${view}:${activeDocs[view]}` : activeByView[view];
  const [menuFor, setMenuFor] = useState<string>();
  /** The tab whose title is being edited in place (double-click, F2 or Rename in its menu). */
  const [editingTab, setEditingTab] = useState<string>();
  const startRename = (t: EditorTab) => {
    if (t.onRenameTo) {
      select(t);
      setEditingTab(t.key);
    } else t.onRename?.();
  };
  const stripRef = useRef<HTMLDivElement>(null);
  // the strip scrolls without a scrollbar: when it overflows, ‹ › buttons show that there is more, and the leftmost
  // tab is always whole (a tab cut at the left edge looked hidden behind the sidebar)
  const [overflow, setOverflow] = useState<{ left: boolean; right: boolean }>({ left: false, right: false });
  const measure = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const left = strip.scrollLeft > 1;
    const right = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1;
    setOverflow((o) => (o.left === left && o.right === right ? o : { left, right }));
  }, []);
  /**
   * Scroll so that a tab starts exactly at the left edge: the one nearest to it (a tab more than half hidden gives way
   * to the next). The active tab stays whole: when aligning would push it off the right edge, it becomes the leftmost.
   */
  const snap = useCallback(() => {
    const strip = stripRef.current;
    if (!strip || strip.scrollLeft <= 0) return;
    const s = strip.getBoundingClientRect();
    const tabs = [...strip.querySelectorAll<HTMLElement>('[role=tab]')];
    let first = tabs.find((t) => {
      const r = t.getBoundingClientRect();
      return r.right - s.left > r.width / 2;
    });
    if (!first) return;
    const active = tabs.find((t) => t.getAttribute('aria-selected') === 'true');
    if (active) {
      const a = active.getBoundingClientRect();
      const shift = first.getBoundingClientRect().left - s.left; // how far the content moves left (negative: right)
      if (a.right - shift > s.right + 1 && tabs.indexOf(active) >= tabs.indexOf(first)) first = active;
    }
    const delta = first.getBoundingClientRect().left - s.left;
    if (Math.abs(delta) > 1) strip.scrollLeft = Math.max(0, strip.scrollLeft + delta);
  }, []);
  const scrollByTabs = (dir: -1 | 1) => {
    const strip = stripRef.current;
    if (!strip) return;
    strip.scrollLeft += dir * Math.max(TAB_W, strip.clientWidth - TAB_W);
    snap();
    measure();
  };
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    measure();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      measure();
      // after the wheel stops: no half tab at the left edge
      clearTimeout(timer);
      timer = setTimeout(snap, 120);
    };
    const onWheel = (e: WheelEvent) => {
      // a mouse wheel scrolls the strip sideways (it has no vertical direction to go)
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && strip.scrollWidth > strip.clientWidth) {
        e.preventDefault();
        strip.scrollLeft += e.deltaY;
      }
    };
    strip.addEventListener('scroll', onScroll, { passive: true });
    strip.addEventListener('wheel', onWheel, { passive: false });
    const ro = new ResizeObserver(measure);
    ro.observe(strip);
    return () => {
      clearTimeout(timer);
      strip.removeEventListener('scroll', onScroll);
      strip.removeEventListener('wheel', onWheel);
      ro.disconnect();
    };
  }, [measure, snap, view]);
  // keep the active tab in view (scrolling only the strip: scrollIntoView could shift the whole window)
  useEffect(() => {
    const reveal = () => {
      const strip = stripRef.current;
      const el = strip?.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!strip || !el) return;
      // measured on screen: offsetLeft counts from the nearest positioned ancestor, not the strip, so it overshot and
      // left the active tab half hidden at the left edge
      const s = strip.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      if (r.left < s.left) strip.scrollLeft -= s.left - r.left;
      else if (r.right > s.right) strip.scrollLeft += Math.min(r.right - s.right, r.left - s.left);
      snap();
      measure();
    };
    reveal();
    // a tab just opened is drawn a moment later (its editor publishes it): look again then
    const id = requestAnimationFrame(reveal);
    const t = setTimeout(reveal, 150);
    return () => (cancelAnimationFrame(id), clearTimeout(t));
  }, [activeKey, view, tabs.length, snap, measure]);
  const select = (t: EditorTab) => {
    if (useApp.getState().view !== t.view) useApp.getState().setView(t.view);
    t.onSelect?.();
  };
  return (
    <div className="flex items-end h-9 border-b border-line bg-panel/40 shrink-0 min-w-0">
      {overflow.left && (
        <button aria-label="Earlier tabs" title="Earlier tabs" className="shrink-0 h-9 w-6 grid place-items-center text-muted hover:text-fg hover:bg-hover border-r border-line" onClick={() => scrollByTabs(-1)}>
          <ChevronLeft size={14} />
        </button>
      )}
      <div ref={stripRef} role="tablist" aria-label="Open requests" className="flex items-end min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((t) => {
          const active = t.view === view && t.key === activeKey;
          return (
            <div
              key={t.key}
              role="tab"
              aria-selected={active}
              title={t.dirty ? `${t.title} (unsaved changes)` : t.title}
              onClick={() => select(t)}
              onDoubleClick={() => startRename(t)}
              tabIndex={active ? 0 : -1}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === 'F2') {
                  e.preventDefault();
                  startRename(t);
                }
              }}
              onAuxClick={(e) => e.button === 1 && !t.pinned && t.onClose()}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenuFor(t.key);
              }}
              style={{ width: t.pinned ? 120 : TAB_W }}
              className={cx(
                'group relative flex items-center gap-1.5 h-9 px-3 border-r border-line text-sm cursor-pointer shrink-0',
                active ? 'bg-bg text-fg after:absolute after:inset-x-0 after:top-0 after:h-0.5 after:bg-[image:var(--brand-gradient)]' : 'text-muted hover:bg-hover hover:text-fg',
              )}
            >
              {t.pinned && <Pin size={11} className="shrink-0 text-muted" aria-label="Pinned" />}
              <span className={cx('mono method-badge text-[0.62rem] font-bold shrink-0', t.badgeClass)}>{t.badge}</span>
              {editingTab === t.key ? (
                <InlineRename
                  value={t.title}
                  label="Tab name"
                  onCommit={(name) => {
                    setEditingTab(undefined);
                    void t.onRenameTo?.(name);
                  }}
                  onCancel={() => setEditingTab(undefined)}
                />
              ) : (
                <span className="truncate flex-1 min-w-0">{t.title}</span>
              )}
              {t.dirty && <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" aria-label="Unsaved changes" />}
              {!t.pinned && (
                <button aria-label={`Close ${t.title}`} className={cx('shrink-0 rounded p-0.5 hover:text-fg hover:bg-hover focus:opacity-100', active ? 'opacity-60' : 'opacity-0 group-hover:opacity-100')} onClick={(e) => (e.stopPropagation(), t.onClose())}>
                  <X size={12} />
                </button>
              )}
              {menuFor === t.key && (
                <Menu open onOpenChange={(o) => !o && setMenuFor(undefined)} align="start" width={210} items={tabMenu(t, tabs, startRename)} trigger={<span aria-hidden className="absolute left-2 bottom-0 w-0 h-0" />} />
              )}
            </div>
          );
        })}
      </div>
      {overflow.right && (
        <button aria-label="Later tabs" title="Later tabs" className="shrink-0 h-9 w-6 grid place-items-center text-muted hover:text-fg hover:bg-hover border-l border-line" onClick={() => scrollByTabs(1)}>
          <ChevronRight size={14} />
        </button>
      )}
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
      <span className="ml-auto" />
      <ResponseLayoutButton />
      {tabs.length > 1 && (
        <Menu
          align="end"
          width={300}
          items={tabs.map((t) => ({ label: `${t.title}${t.dirty ? ' •' : ''}`, icon: <span className={cx('mono method-badge text-[0.6rem] font-bold w-11', t.badgeClass)}>{t.badge}</span>, onSelect: () => select(t) }))}
          trigger={
            <button aria-label="All open tabs" title="All open tabs" className="mr-1.5 mb-1 shrink-0 inline-flex items-center gap-1 h-7 px-2 rounded-md text-xs font-medium text-muted border border-line bg-bg hover:text-fg hover:bg-hover data-[state=open]:text-fg data-[state=open]:bg-hover">
              {tabs.length}
              <ChevronDown size={13} />
            </button>
          }
        />
      )}
    </div>
  );
}
