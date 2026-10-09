import { ChevronDown, ChevronRight, ChevronsDownUp, Copy, CopyPlus, Database, Download, ExternalLink, FileCode2, FolderInput, FolderPlus, GitCompare, Layers, PanelLeftClose, Pencil, Play, Plug, Plus, RefreshCw, ScanSearch, Star, Trash2, Unplug, Upload, Wand2 } from 'lucide-react';
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { call, on } from '../api';
import { confirmAction, promptText, toastError, useApp } from '../store';
import type { Collection, CollectionNode, Library, LibraryItem, McpServerConfig } from '../types';
import { plural, uid } from '../lib/format';
import { addToFolder, CollectionTree, mapNodes, type ExtraGroup } from './CollectionTree';
import type { RequestCategory } from '../lib/collection-filter';
import { closeTabsFor, newRequestItems, useEditorTabsStore } from './EditorTabs';
import { ExportDialog } from './ExportDialog';
import { fullCollection, refreshCollections, useCollectionTree } from '../lib/collections-store';
import { ImportModal } from '../views/rest/dialogs';
import { isDocView, useDocs } from '../lib/docs';
import { Button, cx, IconButton, Input, Menu, menuKeys, type MenuItem } from './ui';
import { askFolderName, focusRow, folderMenuItems, InlineRename, KindBadge, moveToFolderItem, RowMenu, TreeFolderRow, treeKeys } from './TreeParts';
import { usePersisted } from '../lib/sticky';
import { copyText } from '../lib/clipboard';
import { datasetBadge } from '../lib/datasets';
import { GenerateDataDialog } from './GenerateDataDialog';
import { useStableCallbacks } from '../hooks';

/**
 * The Collections explorer: the one sidebar of the request editors. The workspace lists its collections;
 * expanding one shows what it holds by category (REST, SOAP, GraphQL, gRPC, WebSocket & MQTT). MCP servers,
 * API definitions and datasets belong to the whole workspace and follow the collections. Environments, monitors,
 * AI prompts, evaluations and load tests live in their own views.
 */

const openKey = 'aps.explorer.sections.v2';
function useOpenSections() {
  const [open, setOpen] = usePersisted<Record<string, boolean>>(openKey, {});
  const toggle = (id: string, def: boolean) => setOpen((o) => ({ ...o, [id]: !(o[id] ?? def) }));
  return { isOpen: (id: string, def = true) => open[id] ?? def, toggle };
}

/** A collapsible section: icon, title, count, a + that creates that kind of item and a ⋯ menu (also on right-click), like a collection row. */
function Section({
  id,
  title,
  icon,
  count,
  addLabel,
  onAdd,
  menu,
  children,
  def = true,
  sections,
  forceOpen,
}: {
  id: string;
  title: string;
  icon: ReactNode;
  count?: number;
  addLabel?: string;
  onAdd?(): void;
  menu?: MenuItem[];
  children: ReactNode;
  def?: boolean;
  sections: ReturnType<typeof useOpenSections>;
  forceOpen?: boolean;
}) {
  const open = forceOpen || sections.isOpen(id, def);
  const [menuOpen, setMenuOpen] = useState(false);
  const items: MenuItem[] = [
    ...(onAdd ? [{ label: addLabel ?? 'New', icon: <Plus size={14} />, onSelect: onAdd }] : []),
    ...(menu ?? []),
    { label: open ? 'Collapse' : 'Expand', icon: open ? <ChevronRight size={14} /> : <ChevronDown size={14} />, onSelect: () => sections.toggle(id, def), separator: true },
  ];
  return (
    <div className="border-b border-line/60" data-tree-section={id}>
      <div
        className={cx('group flex items-center gap-0.5 h-9 pl-1.5 pr-1 sticky top-0 bg-panel z-10', menuOpen && 'bg-hover')}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuOpen(true);
        }}
      >
        <button className="flex items-center gap-1.5 flex-1 min-w-0 text-left" onClick={() => sections.toggle(id, def)} aria-expanded={open} data-tree-row>
          {open ? <ChevronDown size={13} className="text-muted shrink-0" /> : <ChevronRight size={13} className="text-muted shrink-0" />}
          <span className="text-muted shrink-0">{icon}</span>
          <span className="text-[0.82rem] font-semibold truncate">{title}</span>
          {count !== undefined && count > 0 && <span className="text-[0.7rem] px-1.5 rounded-full bg-panel2 text-muted tabular-nums">{count}</span>}
        </button>
        <RowMenu label={title} items={items} open={menuOpen} onOpenChange={setMenuOpen} header />
      </div>
      {open && <div className="pb-2">{children}</div>}
    </div>
  );
}

/** Renaming a row in place: whether it is being renamed, and how to start and finish. */
interface RowRename {
  editing: boolean;
  start(): void;
  done(name?: string): void;
}

function Row({ id, icon, label, sub, onClick, title, active, menu, indent, rename }: { id?: string; icon?: ReactNode; label: string; sub?: ReactNode; onClick(): void; title?: string; active?: boolean; menu?: MenuItem[]; indent?: boolean; rename?: RowRename }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div
      className={cx('group mx-1 flex items-center rounded-md pr-1 transition-colors', active ? 'bg-accent-soft' : menuOpen ? 'bg-hover' : 'hover:bg-hover')}
      onContextMenu={(e) => {
        if (!menu) return;
        e.preventDefault();
        setMenuOpen(true);
      }}
    >
      {rename?.editing ? (
        <div className={cx('flex-1 min-w-0 flex items-center gap-2 h-8 pr-1 text-sm', indent ? 'pl-10' : 'pl-6')}>
          {icon && <span className="text-muted shrink-0">{icon}</span>}
          <InlineRename value={label} onCommit={(name) => rename.done(name)} onCancel={() => rename.done()} />
        </div>
      ) : (
        <button
          title={title ?? label}
          onClick={onClick}
          onKeyDown={(e) => {
            if (e.key === 'F2' && rename) {
              e.preventDefault();
              return rename.start();
            }
            menuKeys(menu)?.(e);
          }}
          data-tree-row
          data-rename-id={id}
          className={cx('flex-1 min-w-0 flex items-center gap-2 h-8 pr-1 text-sm text-left', indent ? 'pl-10' : 'pl-6')}
        >
          {icon && <span className="text-muted shrink-0">{icon}</span>}
          <span className="truncate flex-1">{label}</span>
          {sub && <span className="text-xs text-muted truncate max-w-[45%]">{sub}</span>}
        </button>
      )}
      {menu && <RowMenu label={label} items={menu} open={menuOpen} onOpenChange={setMenuOpen} />}
    </div>
  );
}

/** Folders of a section's items: the folder names (kept even when empty), and which folder each item is in. */
interface FolderOps {
  folders: string[];
  /** Change the folder names (new, rename, remove). */
  setFolders(fn: (folders: string[]) => string[]): Promise<void>;
  /** Change which folder items are in: (item id, its folder) → its new folder. */
  assign(fn: (id: string, folder: string | undefined) => string | undefined): Promise<void>;
}

/** What a section is for, and a button to start, when it's empty. */
function EmptyHint({ text, action, onAction }: { text: string; action: string; onAction(): void }) {
  return (
    <div className="px-6 py-1.5 flex flex-col items-start gap-1.5">
      <p className="text-xs text-muted leading-snug">{text}</p>
      <Button size="sm" icon={<Plus size={12} />} onClick={onAction}>
        {action}
      </Button>
    </div>
  );
}

const NONE: SavedItem[] = [];
/** The reveal key of an intent: its nonce, unless it asks not to unfold the tree (opened from the explorer itself). */
const revealKeyOf = (i: { nonce: number; payload?: unknown } | undefined) => (i && !(i.payload as { noReveal?: boolean } | undefined)?.noReveal ? i.nonce : undefined);

/** A file of the workspace's datasets/ folder, as datasets.list answers. */
interface DatasetRow {
  path: string;
  name: string;
  size: number;
  format: string;
  rows?: number;
  tables?: string[];
}
/** Saved items by the collection they're shown in. */
function groupByCollection(items: SavedItem[]): Map<string, SavedItem[]> {
  const map = new Map<string, SavedItem[]>();
  for (const i of items) if (i.collectionId) map.set(i.collectionId, [...(map.get(i.collectionId) ?? []), i]);
  return map;
}

interface SavedItem {
  id: string;
  name: string;
  folder?: string;
  /** The collection it's in (gRPC calls and connections are kept in the workspace library, each in a collection). */
  collectionId?: string;
  badge?: string;
}

const SOAP_ENVELOPE = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
  </soap:Body>
</soap:Envelope>`;

/** A new request of this category as a collection node (gRPC and WebSocket open their editors instead). */
function newNode(cat: RequestCategory): CollectionNode | undefined {
  if (cat === 'rest') return { kind: 'http', id: uid('req-'), name: 'New request', request: { method: 'GET', url: '{{baseUrl}}/' }, assertions: [] };
  if (cat === 'soap')
    return {
      kind: 'http',
      id: uid('req-'),
      name: 'New SOAP request',
      request: { method: 'POST', url: '{{baseUrl}}/', headers: [{ key: 'Content-Type', value: 'text/xml; charset=utf-8', enabled: true }, { key: 'SOAPAction', value: '', enabled: true }], body: { type: 'xml', content: SOAP_ENVELOPE } },
      assertions: [],
    };
  if (cat === 'graphql') return { kind: 'graphql', id: uid('gql-'), name: 'New GraphQL request', request: { endpoint: '{{baseUrl}}/graphql', query: 'query {\n  \n}', variables: '', headers: [] }, assertions: [] };
  return undefined;
}

const WIDTH_KEY = 'aps.explorer.width';
const DEFAULT_WIDTH = 272;
const clampWidth = (w: number) => Math.round(Math.min(Math.max(w, 200), Math.min(640, window.innerWidth * 0.6)));

/** The sidebar's width: dragged on its right edge, remembered; double-click the edge resets it. */
function useExplorerWidth() {
  const [saved, save] = usePersisted(WIDTH_KEY, DEFAULT_WIDTH, { text: true, parse: (v) => (Number(v) ? clampWidth(Number(v)) : undefined) });
  // while the edge is dragged the width follows the pointer; it is remembered when it is let go
  const [dragged, setDragged] = useState<number>();
  const width = dragged ?? saved;
  const handle = (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the sidebar (double-click to reset)"
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      className="absolute top-0 -right-1 z-20 h-full w-2 cursor-col-resize group/resize outline-none"
      onPointerDown={(e) => {
        e.preventDefault();
        const startX = e.clientX;
        const start = width;
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        const move = (ev: PointerEvent) => setDragged(clampWidth(start + ev.clientX - startX));
        const up = (ev: PointerEvent) => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          setDragged(undefined);
          save(clampWidth(start + ev.clientX - startX));
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
      }}
      onDoubleClick={() => save(DEFAULT_WIDTH)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          save(clampWidth(width + (e.key === 'ArrowRight' ? 16 : -16)));
        }
      }}
    >
      <span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-transparent transition-colors group-hover/resize:bg-accent/60 group-focus-visible/resize:bg-accent" />
    </div>
  );
  return { width, handle };
}

export function Explorer() {
  const ws = useApp((s) => s.workspace);
  const { width, handle } = useExplorerWidth();
  const sections = useOpenSections();
  const [filter, setFilter] = useState('');
  // the box shows each keystroke at once; the lists follow as a lower-priority render (big workspaces stay smooth)
  const shownFilter = useDeferredValue(filter);
  // the outline (no bodies or scripts): what the tree shows; a change reads the whole collection first
  const allCollections = useCollectionTree();
  const collections = useMemo(() => allCollections.filter((x) => !x.problem), [allCollections]);
  // requests starred with ⋯ ▸ Add to favorites, in every collection
  const favorites = useMemo(() => {
    const out: Array<{ c: Collection; n: Extract<CollectionNode, { kind: 'http' | 'graphql' }> }> = [];
    const walk = (c: Collection, nodes: CollectionNode[]) => nodes.forEach((n) => (n.kind === 'folder' ? walk(c, n.items) : n.favorite && (n.kind === 'http' || n.kind === 'graphql') && out.push({ c, n })));
    collections.forEach((c) => walk(c, c.items));
    return out;
  }, [collections]);
  const [grpc, setGrpc] = useState<SavedItem[]>([]);
  const [sockets, setSockets] = useState<SavedItem[]>([]);
  const [servers, setServers] = useState<Array<McpServerConfig & { connected?: boolean }>>([]);
  const [specs, setSpecs] = useState<string[]>([]);
  const [datasets, setDatasets] = useState<DatasetRow[]>([]);
  // folders of the MCP servers (a server keeps its own folder; empty folders are kept here) and of the API definitions (path → folder)
  const [mcpFolders, setMcpFolders] = useState<string[]>([]);
  const [specFolders, setSpecFolders] = useState<Library<unknown>>({ folders: [], items: [] });
  // the request that's open (as recorded for Back / Forward) is highlighted in the tree
  // (or, for a tab restored at start-up, the item its active tab shows)
  const navItem = useApp((s) => (s.nav.current.payload?.requestId ?? s.nav.current.payload?.savedId) as string | undefined);
  const view = useApp((s) => s.view);
  const activeDoc = useDocs((s) => s.active[view]);
  const tabItem = useEditorTabsStore((s) => {
    const group = isDocView(view) ? `${view}:${activeDoc ?? 'main'}` : view;
    const tabs = s.byView[group] ?? [];
    return (tabs.find((t) => t.key === s.activeByView[group]) ?? (tabs.length === 1 ? tabs[0] : undefined))?.item;
  });
  const openRequestId = tabItem ?? navItem;

  /** The explorer's own lists; the collections too when asked (on a change the shared list refreshes them itself). */
  const load = useCallback(async (withCollections = true) => {
    const quiet = <T,>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
    const empty: Library<unknown> = { folders: [], items: [] };
    const [, g, w, s, sp, mf, sf, ds] = await Promise.all([
      withCollections ? refreshCollections() : undefined,
      quiet(call<Library<unknown>>('lib.get', { kind: 'grpc' }), empty),
      quiet(call<Library<unknown>>('lib.get', { kind: 'websocket' }), empty),
      quiet(call<Array<McpServerConfig & { connected?: boolean }>>('mcp.servers'), []),
      quiet(call<string[]>('openapi.specs', { includeAsync: true }), []),
      quiet(call<Library<unknown>>('lib.get', { kind: 'mcp-folders' }), empty),
      quiet(call<Library<unknown>>('lib.get', { kind: 'spec-folders' }), empty),
      quiet(call<DatasetRow[]>('datasets.list'), []),
    ]);
    setGrpc(g.items.map(({ data: _, ...i }) => i));
    const wsBadge = (d: unknown) => ((d as { mode?: string })?.mode === 'kafka' ? 'KAFKA' : (d as { mode?: string })?.mode === 'mqtt' ? 'MQTT' : (d as { mode?: string })?.mode === 'socketio' ? 'SIO' : 'WS');
    setSockets(w.items.map(({ data, ...i }) => ({ ...i, badge: wsBadge(data) })));
    setServers(s);
    setSpecs(sp);
    setMcpFolders(mf.folders);
    setSpecFolders(sf);
    setDatasets([...ds].sort((a, b) => a.name.localeCompare(b.name)));
  }, []);
  useEffect(() => {
    void load();
  }, [load, ws?.id]);
  // saving anything (in any view), or connecting an MCP server, refreshes the lists
  // (coalesced: a run or an import saves many things in a row, one reload follows the last of them)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = on('data.changed', () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(false), 120);
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [load]);

  const grpcByCollection = useMemo(() => groupByCollection(grpc), [grpc]);
  const socketsByCollection = useMemo(() => groupByCollection(sockets), [sockets]);
  const f = shownFilter.trim().toLowerCase();
  const match = (...t: Array<string | undefined>) => !f || t.some((x) => x?.toLowerCase().includes(f));
  const shownServers = servers.filter((s) => match(s.name, s.transport));
  const shownFavorites = favorites.filter(({ c, n }) => match(n.name, c.name));
  const shownSpecs = specs.filter((s) => match(s));
  const shownDatasets = datasets.filter((d) => match(d.name, d.format));

  const intent = useApp.getState().openIntent;
  const saveCollection = async (c: Collection) => {
    try {
      await call('col.save', c);
      // the saved collection is read back by the shared list (its data.changed); the explorer's other lists did not change
    } catch (e) {
      toastError(e);
    }
  };
  /** Change a collection the tree shows (an outline): the change applies to the whole collection. */
  const editCollection = async (c: Collection, f: (whole: Collection) => Collection) => {
    try {
      await saveCollection(f(await fullCollection(c)));
    } catch (e) {
      toastError(e);
    }
  };
  const newCollection = async () => {
    const name = await promptText('New collection', { message: 'Collection name', placeholder: 'My API', okLabel: 'Create' });
    if (name) await saveCollection({ schemaVersion: '1.0', id: uid('col-'), name, version: 0, variables: [], items: [], updatedAt: '' });
  };
  // Import and Export open here, without leaving the request editors
  const [importing, setImporting] = useState(false);
  const [collapseAll, setCollapseAll] = useState(0);
  // reveal the opened request in the tree when it was opened from elsewhere (search, history, a link): not when it was
  // opened from the explorer itself (e.g. Favorites), which would unfold its collection under the user's hand
  // (watched, not subscribed to: the explorer keeps only this key, so an intent that reveals nothing re-renders nothing)
  const [revealKey, setRevealKey] = useState(() => revealKeyOf(useApp.getState().intent));
  useEffect(
    () =>
      useApp.subscribe((s, prev) => {
        const k = s.intent !== prev.intent ? revealKeyOf(s.intent) : undefined;
        if (k !== undefined) setRevealKey(k);
      }),
    [],
  );
  const [exporting, setExporting] = useState(false);
  const importDefinition = () => setImporting(true);
  /** The datasets: a new empty one, generated test data, and a row's rename, duplicate and delete (the file goes to Recently deleted). */
  const [generatingData, setGeneratingData] = useState(false);
  const datasetAction = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load(false);
    } catch (e) {
      toastError(e);
    }
  };
  const newDataset = async (format: 'csv' | 'jsonl') => {
    const name = await promptText(`New ${format.toUpperCase()} dataset`, { message: 'File name in the datasets folder', placeholder: format === 'csv' ? 'users' : 'cases', okLabel: 'Create' });
    if (!name) return;
    await datasetAction(async () => {
      const r = await call<{ name: string }>('datasets.create', { name, format });
      intent('dataset', { dataset: r.name, tab: 'file' });
    });
  };
  const deleteDataset = async (d: DatasetRow) => {
    if (!(await confirmAction({ title: 'Delete dataset', message: `Delete datasets/${d.name}?`, detail: 'It goes to Recently deleted (Collections ▸ Recently deleted) for 30 days.', confirmLabel: 'Delete', danger: true }))) return;
    await datasetAction(() => call('datasets.delete', { name: d.name }));
  };
  const datasetMenu = (d: DatasetRow): MenuItem[] => [
    { label: 'Open in tab', icon: <ExternalLink size={14} />, onSelect: () => intent('dataset', { dataset: d.name }) },
    { label: 'Run a collection with it', icon: <Play size={14} />, onSelect: () => intent('collections', { run: true, dataPath: d.path }) },
    { label: 'Rename', icon: <Pencil size={14} />, separator: true, onSelect: () => setRenaming(d.name) },
    { label: 'Duplicate', icon: <CopyPlus size={14} />, onSelect: () => void datasetAction(() => call('datasets.duplicate', { name: d.name })) },
    { label: 'Delete', icon: <Trash2 size={14} />, danger: true, separator: true, onSelect: () => void deleteDataset(d) },
  ];
  const renameDataset = (name: string): RowRename => ({
    editing: renaming === name,
    start: () => setRenaming(name),
    done: (to) => {
      setRenaming(undefined);
      if (to && to !== name) void datasetAction(() => call('datasets.rename', { name, to }));
      focusRow(name);
    },
  });
  /** Change a saved gRPC call / connection list (move, rename, duplicate, delete): the one place that loads, edits and saves it. */
  const editLibrary = async (kind: 'grpc' | 'websocket', fn: (items: Array<LibraryItem<unknown>>) => Array<LibraryItem<unknown>>) => {
    try {
      const lib = await call<Library<unknown>>('lib.get', { kind });
      await call('lib.save', { kind, library: { folders: lib.folders, items: fn(lib.items) } });
      await load(false);
    } catch (e) {
      toastError(e);
    }
  };
  /** Move a saved gRPC call / connection to another collection. */
  const moveItem = (kind: 'grpc' | 'websocket', id: string, collectionId: string) => editLibrary(kind, (items) => items.map((i) => (i.id === id ? { ...i, collectionId } : i)));
  /** The menu of a gRPC call or connection: the same actions as a request's (open, rename, duplicate, move, delete). */
  /** Copy a saved gRPC call as a grpcurl command, or a connection's URL ({{variables}} resolved). */
  const copySaved = async (kind: 'grpc' | 'websocket', id: string) => {
    try {
      const it = (await call<Library<Record<string, any>>>('lib.get', { kind })).items.find((i) => i.id === id);
      if (!it) return;
      const env = useApp.getState().environment;
      const d = it.data;
      const text =
        kind === 'grpc'
          ? await call<string>('grpc.grpcurl', { target: d.target, method: d.method, message: d.message, metadata: d.metadata, tls: d.tls, protoFiles: d.descriptorSet ? [] : (d.protoFiles ?? []).map((f: { name: string }) => f.name), timeoutMs: d.timeoutMs, environment: env })
          : String(d.url ?? '');
      await copyText(text, kind === 'grpc' ? 'as grpcurl' : 'the URL');
    } catch (e) {
      toastError(e);
    }
  };
  /** The server, saved gRPC call or connection being renamed in place. */
  const [renaming, setRenaming] = useState<string>();
  const renameSaved = (kind: 'grpc' | 'websocket', id: string): RowRename => ({
    editing: renaming === id,
    start: () => setRenaming(id),
    done: (name) => {
      setRenaming(undefined);
      if (name) void editLibrary(kind, (items) => items.map((i) => (i.id === id ? { ...i, name } : i)));
      focusRow(id);
    },
  });
  const renameServer = (id: string): RowRename => ({
    editing: renaming === id,
    start: () => setRenaming(id),
    done: (name) => {
      setRenaming(undefined);
      if (name) void editServers((list) => list.map((x) => (x.id === id ? { ...x, name } : x)));
      focusRow(id);
    },
  });
  const moveMenu = (kind: 'grpc' | 'websocket', item: SavedItem): MenuItem[] => [
    { label: 'Open in tab', icon: <ExternalLink size={14} />, onSelect: () => intent(kind, { savedId: item.id }) },
    { label: kind === 'grpc' ? 'Copy as grpcurl' : 'Copy URL', icon: <Copy size={14} />, onSelect: () => void copySaved(kind, item.id) },
    {
      label: 'Rename',
      icon: <Pencil size={14} />,
      onSelect: () => setRenaming(item.id),
    },
    {
      label: 'Duplicate',
      icon: <CopyPlus size={14} />,
      onSelect: () => void editLibrary(kind, (items) => items.flatMap((i) => (i.id === item.id ? [i, { ...i, id: uid('lib-'), name: `${i.name} copy`, updatedAt: new Date().toISOString() }] : [i]))),
    },
    {
      label: 'Move to',
      icon: <FolderInput size={14} />,
      onSelect: () => undefined,
      items: collections.filter((c) => c.id !== item.collectionId).map((c) => ({ label: c.name, onSelect: () => void moveItem(kind, item.id, c.id) })),
    },
    {
      label: 'Delete',
      icon: <Trash2 size={14} />,
      danger: true,
      separator: true,
      onSelect: async () => {
        if (!(await confirmAction({ title: kind === 'grpc' ? 'Delete gRPC call' : 'Delete connection', message: `Delete "${item.name}"?`, confirmLabel: 'Delete', danger: true }))) return;
        closeTabsFor([item.id]);
        await editLibrary(kind, (items) => items.filter((i) => i.id !== item.id));
      },
    },
  ];
  /** Change the MCP server list (rename, duplicate, delete). */
  const editServers = async (fn: (list: McpServerConfig[]) => McpServerConfig[]) => {
    try {
      await call('mcp.saveServers', { servers: fn(servers.map(({ connected: _c, ...s }) => s as McpServerConfig)) });
      await load(false);
    } catch (e) {
      toastError(e);
    }
  };
  /** The menu of an MCP server: open, connect, rename, duplicate, delete. */
  const serverMenu = (s: McpServerConfig & { connected?: boolean }): MenuItem[] => [
    { label: 'Open in tab', icon: <ExternalLink size={14} />, onSelect: () => intent('mcp', { serverId: s.id }) },
    s.connected
      ? { label: 'Disconnect', icon: <Unplug size={14} />, onSelect: () => void call('mcp.disconnect', { serverId: s.id }).then(load, toastError) }
      : { label: 'Connect', icon: <Plug size={14} />, onSelect: () => intent('mcp', { serverId: s.id, connect: true }) },
    { label: 'Settings', icon: <Pencil size={14} />, onSelect: () => intent('mcp', { serverId: s.id, tab: 'settings' }) },
    {
      label: 'Rename',
      icon: <Pencil size={14} />,
      separator: true,
      onSelect: () => setRenaming(s.id),
    },
    { label: 'Duplicate', icon: <CopyPlus size={14} />, onSelect: () => void editServers((list) => list.flatMap((x) => (x.id === s.id ? [x, { ...x, id: uid('mcp-'), name: `${x.name} copy` }] : [x]))) },
    {
      label: 'Delete',
      icon: <Trash2 size={14} />,
      danger: true,
      separator: true,
      onSelect: async () => {
        if (!(await confirmAction({ title: 'Remove MCP server', message: `Remove the MCP server "${s.name}"?`, detail: 'Saved tests that call it will fail until you add it again.', confirmLabel: 'Remove server', danger: true }))) return;
        closeTabsFor([s.id]);
        if (s.connected) await call('mcp.disconnect', { serverId: s.id }).catch(() => undefined);
        await editServers((list) => list.filter((x) => x.id !== s.id));
      },
    },
  ];
  /** Change a folders library (the folder names, and for API definitions which folder each one is in), read fresh so steps in a row see each other. */
  const editFolderLib = async (kind: 'mcp-folders' | 'spec-folders', fn: (lib: Library<unknown>) => Pick<Library<unknown>, 'folders' | 'items'>) => {
    try {
      const lib = await call<Library<unknown>>('lib.get', { kind });
      await call('lib.save', { kind, library: fn(lib) });
      await load(false);
    } catch (e) {
      toastError(e);
    }
  };
  const specFolderOf = new Map(specFolders.items.map((i) => [i.id, i.folder]));
  const mcpOps: FolderOps = {
    folders: mcpFolders,
    setFolders: (fn) => editFolderLib('mcp-folders', (lib) => ({ folders: fn(lib.folders), items: [] })),
    assign: (fn) => editServers((list) => list.map((s) => ({ ...s, folder: fn(s.id, s.folder) || undefined }))),
  };
  const specOps: FolderOps = {
    folders: specFolders.folders,
    setFolders: (fn) => editFolderLib('spec-folders', (lib) => ({ folders: fn(lib.folders), items: lib.items })),
    assign: (fn) =>
      editFolderLib('spec-folders', (lib) => {
        const now = new Map(lib.items.map((i) => [i.id, i.folder]));
        return { folders: lib.folders, items: specs.map((p) => ({ id: p, name: p, folder: fn(p, now.get(p)) || undefined, data: null })).filter((i) => i.folder) };
      }),
  };
  /** All folder names of a section: the kept ones and the ones its items are in. */
  const folderNames = (ops: FolderOps, items: Array<{ folder?: string }>) => [...new Set([...ops.folders, ...items.map((i) => i.folder).filter((x): x is string => !!x)])].sort((a, b) => a.localeCompare(b));
  const newFolder = async (ops: FolderOps) => {
    const name = await askFolderName();
    if (name) await ops.setFolders((fs) => [...fs, name]);
  };
  /** The ⋯ menu of a folder (the shared one): rename it, or delete it (its items move to the top level). */
  const renameFolder = async (ops: FolderOps, name: string, next: string) => {
    await ops.assign((_, folder) => (folder === name ? next : folder));
    await ops.setFolders((fs) => fs.map((x) => (x === name ? next : x)));
  };
  const folderMenu = (ops: FolderOps, name: string, itemNoun: string, addLabel: string, onAdd: () => void): MenuItem[] =>
    folderMenuItems({
      name,
      itemNoun,
      addLabel,
      onAdd,
      rename: (next) => renameFolder(ops, name, next),
      remove: async () => {
        await ops.assign((_, folder) => (folder === name ? undefined : folder));
        await ops.setFolders((fs) => fs.filter((x) => x !== name));
      },
    });
  /** "Move to folder" in an item's menu (the shared one). */
  const moveToFolder = (ops: FolderOps, all: Array<{ folder?: string }>, itemId: string, current: string | undefined): MenuItem => ({
    ...moveToFolderItem({
      folders: folderNames(ops, all),
      current,
      move: async (to) => {
        if (to && !ops.folders.includes(to)) await ops.setFolders((fs) => [...fs, to]);
        await ops.assign((id, folder) => (id === itemId ? to : folder));
      },
    }),
    separator: true,
  });
  /** A section's items in their folders (like a collection's), then the ones in none. */
  const renderFoldered = <T extends { id: string; folder?: string }>(section: string, items: T[], ops: FolderOps, menuOf: (name: string) => MenuItem[], row: (item: T, inFolder: boolean) => ReactNode) => {
    const names = folderNames(ops, items);
    return (
      <>
        {names.map((name) => {
          const inside = items.filter((i) => i.folder === name);
          if (f && !inside.length) return null;
          const key = `${section}:folder:${name}`;
          const isOpen = !!f || sections.isOpen(key, true);
          return (
            <div key={key}>
              <TreeFolderRow className="pl-5" name={name} count={inside.length} open={isOpen} onToggle={() => sections.toggle(key, true)} menu={menuOf(name)} onRename={(to) => renameFolder(ops, name, to)} />
              {isOpen && (inside.length ? inside.map((i) => row(i, true)) : <p className="pl-10 py-1 text-xs text-muted">Empty folder</p>)}
            </div>
          );
        })}
        {items.filter((i) => !i.folder || !names.includes(i.folder)).map((i) => row(i, false))}
      </>
    );
  };
  /** An item's menu with "Move to folder" before Delete / Remove (or at the end). */
  const withMove = (menu: MenuItem[], move: MenuItem) => (menu[menu.length - 1]?.danger ? [...menu.slice(0, -1), move, menu[menu.length - 1]!] : [...menu, move]);

  // the tree is memoized: its saved items change only with these lists (or a rename in place); menus read the latest
  const savedLatest = useRef({ moveMenu, renameSaved });
  savedLatest.current = { moveMenu, renameSaved };
  const extraGroups = useCallback(
    (c: Collection): ExtraGroup[] => [
      {
        cat: 'grpc',
        items: grpcByCollection.get(c.id) ?? NONE,
        onOpen: (id) => intent('grpc', { savedId: id }),
        menu: (id) => savedLatest.current.moveMenu('grpc', grpc.find((i) => i.id === id)!),
        rename: (id) => savedLatest.current.renameSaved('grpc', id),
      },
      {
        cat: 'websocket',
        items: socketsByCollection.get(c.id) ?? NONE,
        onOpen: (id) => intent('websocket', { savedId: id }),
        menu: (id) => savedLatest.current.moveMenu('websocket', sockets.find((i) => i.id === id)!),
        rename: (id) => savedLatest.current.renameSaved('websocket', id),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [grpcByCollection, socketsByCollection, grpc, sockets, renaming],
  );
  const newOfCategory = (c: Collection, cat: RequestCategory) => {
    if (cat === 'grpc' || cat === 'websocket') return intent(cat, { newDoc: true, collectionId: c.id });
    const node = newNode(cat)!;
    void editCollection(c, (c) => ({ ...c, items: addToFolder(c.items, undefined, node) })).then(() => intent(cat === 'graphql' ? 'graphql' : 'rest', { collectionId: c.id, requestId: node.id }));
  };
  // the same functions on every render, so the memoized tree re-renders only when what it shows changed
  const treeCallbacks = useStableCallbacks({
    onNewOfCategory: newOfCategory,
    onDropSaved: (kind: 'grpc' | 'websocket', id: string, to: string) => void moveItem(kind, id, to),
    onOpen: (c: Collection, n: CollectionNode) => intent(n.kind === 'graphql' ? 'graphql' : 'rest', { collectionId: c.id, requestId: n.id }),
    onChange: (c: Collection) => void saveCollection(c),
    onRun: (c: Collection, folderId?: string) => intent('collections', { collectionId: c.id, run: true, folderId }),
    onNewRequest: (c: Collection, folderId?: string) => {
      const node = newNode('rest')!;
      void saveCollection({ ...c, items: addToFolder(c.items, folderId, node) }).then(() => intent('rest', { collectionId: c.id, requestId: node.id }));
    },
    onSettings: (c: Collection) => intent('collections', { collectionId: c.id }),
  });

  return (
    <aside aria-label="Collections explorer" style={{ width }} className="relative shrink-0 border-r border-line bg-panel flex flex-col min-h-0">
      {handle}
      <div className="flex items-center gap-1 px-2 h-10 border-b border-line shrink-0">
        <Layers size={15} className="text-accent shrink-0" />
        <span className="font-semibold text-sm flex-1 truncate" title={ws?.name}>
          {ws?.name ?? 'Workspace'}
        </span>
        <Menu
          width={240}
          trigger={
            <IconButton label="New" className="h-7 w-7">
              <Plus size={15} />
            </IconButton>
          }
          items={[{ label: 'Collection', icon: <FolderPlus size={14} />, onSelect: () => void newCollection() }, ...newRequestItems().map((it, i) => (i === 0 ? { ...it, separator: true } : it))]}
        />
        {/* in the header, not in a menu: the actions used every day */}
        <IconButton label="Import (OpenAPI, AsyncAPI, Postman, Insomnia, Bruno, HAR, WSDL, cURL …)" className="h-7 w-7" onClick={importDefinition}>
          <Upload size={14} />
        </IconButton>
        <IconButton label="Export a collection or the workspace" className="h-7 w-7" onClick={() => setExporting(true)}>
          <Download size={14} />
        </IconButton>
        <IconButton label="Refresh" className="h-7 w-7" onClick={() => void load()}>
          <RefreshCw size={14} />
        </IconButton>
        <IconButton label="Hide the sidebar (Ctrl+B)" className="h-7 w-7" onClick={() => useApp.getState().toggleExplorer(false)}>
          <PanelLeftClose size={14} />
        </IconButton>
      </div>
      <div className="p-2 shrink-0 flex items-center gap-1">
        <Input className="flex-1 min-w-0 h-7 min-h-7 text-sm" placeholder="Filter" aria-label="Filter requests, connections, servers and definitions" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <IconButton label="Collapse all" className="h-7 w-7 shrink-0" onClick={() => setCollapseAll((n) => n + 1)}>
          <ChevronsDownUp size={14} />
        </IconButton>
      </div>
      {/* keyboard, like a file tree: ↑ ↓ move between rows, → expands, ← collapses (Enter opens, F2 renames, Delete deletes) */}
      <div className="flex-1 overflow-auto" onKeyDown={treeKeys}>
        {/* favorite requests from every collection, one click away (⋯ ▸ Add to favorites on a request) */}
        {favorites.length > 0 && (
          <Section id="favorites" title="Favorites" icon={<Star size={14} />} count={favorites.length} sections={sections} def forceOpen={!!f && shownFavorites.length > 0}>
            {shownFavorites.map(({ c, n }) => (
              <Row
                key={`fav-${n.id}`}
                id={`fav-${n.id}`}
                icon={
                  <span className={cx('mono method-badge text-[0.6rem] font-bold w-8 inline-block', n.kind === 'http' ? `method-${n.request.method}` : 'text-[#e535ab]')}>
                    {(n.kind === 'http' ? n.request.method : 'GQL').slice(0, 5)}
                  </span>
                }
                label={n.name}
                sub={c.name}
                title={`${n.name} (${c.name})`}
                active={openRequestId === n.id}
                onClick={() => intent(n.kind === 'graphql' ? 'graphql' : 'rest', { collectionId: c.id, requestId: n.id, noReveal: true })}
                menu={[
                  { label: 'Open in tab', icon: <ExternalLink size={14} />, onSelect: () => intent(n.kind === 'graphql' ? 'graphql' : 'rest', { collectionId: c.id, requestId: n.id, noReveal: true }) },
                  {
                    label: 'Remove from favorites',
                    icon: <Star size={14} />,
                    separator: true,
                    onSelect: () => void editCollection(c, (c) => ({ ...c, items: mapNodes(c.items, (x) => (x.id === n.id && x.kind !== 'folder' ? { ...x, favorite: false } : x)) })),
                  },
                ]}
              />
            ))}
          </Section>
        )}
        {allCollections.length ? (
          <div className="pb-2 border-b border-line/60">
            <CollectionTree
              // a collection whose file cannot be read stays listed (in red, with why), never silently gone
              collections={allCollections}
              filter={shownFilter}
              categorize
              extraGroups={extraGroups}
              collapseAll={collapseAll}
              revealKey={revealKey}
              activeRequestId={openRequestId}
              {...treeCallbacks}
            />
          </div>
        ) : (
          <div className="border-b border-line/60 py-2">
            <EmptyHint text="Collections hold your requests: REST, SOAP, GraphQL, gRPC and WebSocket, organised in folders. Create one, or import OpenAPI, Postman, Insomnia, Bruno, WSDL or HAR." action="New collection" onAction={() => void newCollection()} />
          </div>
        )}

        <Section id="mcp" title="MCP servers" icon={<Plug size={14} />} count={servers.length} sections={sections} def={servers.length > 0} forceOpen={!!f && shownServers.length > 0} addLabel="Add an MCP server" onAdd={() => intent('mcp', { addServer: true })} menu={[{ label: 'New folder', icon: <FolderPlus size={14} />, onSelect: () => void newFolder(mcpOps) }, { label: 'Open MCP inspector', icon: <ExternalLink size={14} />, onSelect: () => intent('mcp', {}) }]}>
          {servers.length || mcpFolders.length ? (
            renderFoldered('mcp', shownServers, mcpOps, (name) => folderMenu(mcpOps, name, 'server', 'Add an MCP server', () => intent('mcp', { addServer: true })), (s, inFolder) => (
              <Row
                key={s.id}
                indent={inFolder}
                icon={<KindBadge text="MCP" cls={s.connected ? 'text-ok' : 'text-accent'} />}
                label={s.name}
                sub={s.connected ? 'connected' : s.transport === 'streamable-http' ? 'http' : s.transport}
                title={`${s.name} (${s.connected ? 'connected' : 'not connected'})`}
                active={openRequestId === s.id}
                onClick={() => intent('mcp', { serverId: s.id })}
                menu={withMove(serverMenu(s), moveToFolder(mcpOps, servers, s.id, s.folder))}
                id={s.id}
                rename={renameServer(s.id)}
              />
            ))
          ) : (
            <EmptyHint text="MCP servers to inspect and test: a local command, Streamable HTTP, SSE or a mock." action="Add server" onAction={() => intent('mcp', { addServer: true })} />
          )}
        </Section>

        <Section id="specs" title="API definitions" icon={<FileCode2 size={14} />} count={specs.length} sections={sections} def={specs.length > 0} forceOpen={!!f && shownSpecs.length > 0} addLabel="Import an OpenAPI document" onAdd={importDefinition} menu={[{ label: 'New folder', icon: <FolderPlus size={14} />, onSelect: () => void newFolder(specOps) }, { label: 'Open API definitions', icon: <ExternalLink size={14} />, onSelect: () => intent('apidef', {}) }]}>
          {specs.length || specFolders.folders.length ? (
            renderFoldered('specs', shownSpecs.map((p) => ({ id: p, folder: specFolderOf.get(p) })), specOps, (name) => folderMenu(specOps, name, 'API definition', 'Import an OpenAPI document', importDefinition), ({ id: s, folder }, inFolder) => (
              <Row
                key={s}
                indent={inFolder}
                icon={<KindBadge text="API" cls="text-[#8b5cf6]" />}
                label={s.replace(/^specs\//, '')}
                title={s}
                active={openRequestId === s}
                onClick={() => intent('apidef', { spec: s })}
                menu={[
                  { label: 'Open in tab', icon: <ExternalLink size={14} />, onSelect: () => intent('apidef', { spec: s, tab: 'definition' }) },
                  { label: 'API coverage', icon: <ScanSearch size={14} />, onSelect: () => intent('apidef', { spec: s, tab: 'coverage' }) },
                  { label: 'Compare versions', icon: <GitCompare size={14} />, onSelect: () => intent('apidef', { spec: s, tab: 'compare' }) },
                  moveToFolder(specOps, specFolders.items, s, folder),
                ]}
              />
            ))
          ) : (
            <EmptyHint text="OpenAPI documents: importing one keeps it here for contract checks, API coverage and comparing versions." action="Import OpenAPI" onAction={importDefinition} />
          )}
        </Section>

        <Section
          id="datasets"
          title="Datasets"
          icon={<Database size={14} />}
          count={datasets.length}
          sections={sections}
          def={datasets.length > 0}
          forceOpen={!!f && shownDatasets.length > 0}
          addLabel="New CSV"
          onAdd={() => void newDataset('csv')}
          menu={[
            { label: 'New JSONL', icon: <Plus size={14} />, onSelect: () => void newDataset('jsonl') },
            { label: 'Generate test data…', icon: <Wand2 size={14} />, onSelect: () => setGeneratingData(true) },
          ]}
        >
          {datasets.length ? (
            shownDatasets.map((d) => (
              <Row
                key={d.name}
                icon={<KindBadge text={datasetBadge(d.format).text} cls={datasetBadge(d.format).cls} />}
                label={d.name}
                sub={d.rows !== undefined ? plural(d.rows, 'row') : d.tables ? plural(d.tables.length, 'table') : undefined}
                title={`datasets/${d.name} (${d.format}${d.rows !== undefined ? `, ${plural(d.rows, 'row')}` : ''})`}
                active={openRequestId === d.name}
                onClick={() => intent('dataset', { dataset: d.name })}
                menu={datasetMenu(d)}
                id={d.name}
                rename={renameDataset(d.name)}
              />
            ))
          ) : (
            <EmptyHint text="Data files (CSV, JSONL, JSON, Markdown tables, SQLite) that drive collection runs and tests, in the workspace's datasets folder." action="New CSV" onAction={() => void newDataset('csv')} />
          )}
        </Section>
      </div>
      {generatingData && (
        <GenerateDataDialog
          onClose={() => setGeneratingData(false)}
          onDone={(g) => {
            setGeneratingData(false);
            void load(false);
            intent('dataset', { dataset: g.path.replace(/^datasets\//, '') });
          }}
        />
      )}
      {importing && <ImportModal onClose={() => setImporting(false)} onDone={() => void load()} />}
      {exporting && <ExportDialog collections={collections.map((c) => ({ id: c.id, name: c.name }))} onClose={() => setExporting(false)} />}
    </aside>
  );
}
