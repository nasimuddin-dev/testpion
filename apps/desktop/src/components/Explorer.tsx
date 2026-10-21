import { ArchiveRestore, Database, Download, FileCode2, FilePlus2, FolderPlus, Layers, PanelLeftClose, Plug, Plus, RefreshCw, Star, Upload } from 'lucide-react';
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { call, on } from '../api';
import { touchesFiles, type DataChangedEvent, type FileKind } from '../lib/data-changed';
import { confirmAction, promptText, toastError, useApp, attempt } from '../store';
import { deleteMcpServerWithUndo, deleteWithUndo, putBack, restoreDeleted } from '../lib/undo-delete';
import type { Collection, CollectionNode, Library, LibraryItem, McpServerConfig } from '../types';
import { plural, uid } from '../lib/format';
import { addToFolder, CollectionTree, duplicateNode, mapNodes, type ExtraGroup } from './CollectionTree';
import { openRef, revealInSidebar } from '../lib/open-ref';
import { scopedNodeId } from '../lib/tree-rows';
import type { RequestCategory } from '../lib/collection-filter';
import { closeTabsFor, newRequestItems } from './EditorTabs';
import { ExportDialog } from './ExportDialog';
import { SIDEBAR_TRASH_KINDS, TrashDialog } from './TrashDialog';
import { fullCollection, refreshCollections, useCollectionTree } from '../lib/collections-store';
import { ImportModal } from '../views/rest/dialogs';
import { IconButton, Input, Menu } from './ui';
import { ExpandCollapseToggle } from './ExpandCollapseToggle';
import { focusRow, KIND_COLOR, TreeBadge, treeKeys } from './TreeParts';
import { usePersisted } from '../lib/sticky';
import { copyText } from '../lib/clipboard';
import { datasetBadge, datasetYaml } from '../lib/datasets';
import { GenerateDataDialog } from './GenerateDataDialog';
import { useStableCallbacks } from '../hooks';
import { saveAsTest } from '../lib/save-test';
import type { NodeMenuCtx } from '../lib/node-menu';
import { LABEL } from '../lib/vocabulary';
import { requestCopyItems } from '../lib/request-copy';
import { generateFlows } from '../lib/files';
import { startAi } from './ai/AiAction';
import { startAiAnalysis } from './ai/ai-analysis';
import { startFlowGenerate } from './ai/flow-generate';
import { generateSpecTests } from './ApiPreviewPanel';
import { useAreaMenu } from './AreaMenu';
import { EmptyHint, FolderedRows, folderKey, folderNames, ItemRow, moveToFolderSubmenu, newFolderIn, Section, useOpenSections, type FolderOps, type RowRename } from './ExplorerParts';
import { collectionCallKind, isCollectionCallLibrary } from '@testpion/shared';
import { treeKey } from '../lib/tree-state';

/**
 * The Collections explorer: the one sidebar of the request editors. The workspace lists its collections;
 * expanding one shows what it holds by category (REST, SOAP, GraphQL, gRPC, WebSocket & MQTT). MCP servers,
 * API definitions and datasets belong to the whole workspace and follow the collections. Environments, monitors,
 * AI prompts, evaluations and load tests live in their own views. Every header, folder and row is a node of its kind
 * with the one menu (lib/node-menu.ts) on the one row (TreeRowShell).
 */

const NONE: SavedItem[] = [];
/** The reveal key of an intent: its nonce, unless it asks not to unfold the tree (opened from the explorer itself). */
const revealKeyOf = (i: { nonce: number; payload?: unknown } | undefined) => (i && !(i.payload as { noReveal?: boolean } | undefined)?.noReveal ? i.nonce : undefined);

/** The explorer's lists, by what a change touches (lib/data-changed.ts kinds): each reloads only for its own changes. */
type ListPart = 'library' | 'mcp' | 'specs' | 'datasets';
const PART_KINDS: Array<[ListPart, FileKind[]]> = [
  ['library', ['library']],
  ['mcp', ['mcp']],
  ['specs', ['specs']],
  ['datasets', ['datasets']],
];
const ALL_PARTS: ReadonlySet<ListPart> = new Set(PART_KINDS.map(([p]) => p));
const LIBRARY: ReadonlySet<ListPart> = new Set(['library']);
const MCP: ReadonlySet<ListPart> = new Set(['mcp']);
const SPECS: ReadonlySet<ListPart> = new Set(['specs']);
const DATASETS: ReadonlySet<ListPart> = new Set(['datasets']);

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

/** An MCP server as an agent's config file holds it (.mcp.json, claude_desktop_config.json): values as saved, {{variables}} unresolved. */
function mcpConfigOf(s: McpServerConfig): Record<string, unknown> | undefined {
  if (s.transport === 'stdio') return { command: s.command, ...(s.args?.length ? { args: s.args } : {}), ...(s.env && Object.keys(s.env).length ? { env: s.env } : {}) };
  if ('url' in s && s.url) return { type: s.transport === 'sse' ? 'sse' : 'http', url: s.url, ...('headers' in s && s.headers?.length ? { headers: Object.fromEntries(s.headers.filter((h) => h.enabled !== false).map((h) => [h.key, h.value])) } : {}) };
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
  // folders of the MCP servers (a server keeps its own folder; empty folders are kept here), of the API definitions and
  // of the datasets (virtual: path → folder, the files never move)
  const [mcpFolders, setMcpFolders] = useState<string[]>([]);
  const [specFolders, setSpecFolders] = useState<Library<unknown>>({ folders: [], items: [] });
  const [datasetFolders, setDatasetFolders] = useState<Library<unknown>>({ folders: [], items: [] });

  /**
   * The explorer's own lists, or the part of them that changed (`what`: the saved gRPC calls and connections and
   * every folder library, the MCP servers, the API definitions, the datasets); the collections too when asked (on a
   * change the shared list refreshes them itself).
   */
  const load = useCallback(async (withCollections = true, what: ReadonlySet<ListPart> = ALL_PARTS) => {
    const quiet = <T,>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
    const empty: Library<unknown> = { folders: [], items: [] };
    const lib = (kind: string, when: ListPart) => (what.has(when) ? quiet(call<Library<unknown>>('lib.get', { kind }), empty) : undefined);
    const [, g, w, s, sp, mf, sf, ds, df] = await Promise.all([
      withCollections ? refreshCollections() : undefined,
      lib('grpc', 'library'),
      lib('websocket', 'library'),
      what.has('mcp') ? quiet(call<Array<McpServerConfig & { connected?: boolean }>>('mcp.servers'), []) : undefined,
      what.has('specs') ? quiet(call<string[]>('openapi.specs', { includeAsync: true }), []) : undefined,
      lib('mcp-folders', 'library'),
      lib('spec-folders', 'library'),
      what.has('datasets') ? quiet(call<DatasetRow[]>('datasets.list'), []) : undefined,
      lib('dataset-folders', 'library'),
    ]);
    if (g) setGrpc(g.items.map(({ data: _, ...i }) => i));
    const wsBadge = (d: unknown) => ((d as { mode?: string })?.mode === 'kafka' ? 'KAFKA' : (d as { mode?: string })?.mode === 'mqtt' ? 'MQTT' : (d as { mode?: string })?.mode === 'socketio' ? 'SIO' : 'WS');
    if (w) setSockets(w.items.map(({ data, ...i }) => ({ ...i, badge: wsBadge(data) })));
    if (s) setServers(s);
    if (sp) setSpecs(sp);
    if (mf) setMcpFolders(mf.folders);
    if (sf) setSpecFolders(sf);
    if (ds) setDatasets([...ds].sort((a, b) => a.name.localeCompare(b.name)));
    if (df) setDatasetFolders(df);
  }, []);
  useEffect(() => {
    void load();
  }, [load, ws?.id]);
  // saving anything (in any view) refreshes the lists it touched (lib/data-changed.ts says which kinds of file a
  // change wrote; an MCP server connecting or disconnecting is an `mcp.*` call that writes nothing), coalesced: a run
  // or an import saves many things in a row, one reload follows the last of them
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let parts = new Set<ListPart>();
    const off = on<DataChangedEvent>('data.changed', (e) => {
      for (const [part, kinds] of PART_KINDS) if (touchesFiles(e, kinds)) parts.add(part);
      if (e?.method?.startsWith('mcp.')) parts.add('mcp');
      if (!parts.size) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const what = parts;
        parts = new Set();
        void load(false, what);
      }, 120);
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
    await attempt(async () => {
      await call('col.save', c);
      // the saved collection is read back by the shared list (its data.changed); the explorer's other lists did not change
    });
  };
  /** Change a collection the tree shows (an outline): the change applies to the whole collection. */
  const editCollection = async (c: Collection, f: (whole: Collection) => Collection) => {
    await attempt(async () => {
      await saveCollection(f(await fullCollection(c)));
    });
  };
  const newCollection = async () => {
    const name = await promptText('New collection', { message: 'Collection name', placeholder: 'My API', okLabel: 'Create' });
    if (name) await saveCollection({ schemaVersion: '1.0', id: uid('col-'), name, version: 0, variables: [], items: [], updatedAt: '' });
  };
  // Import and Export open here, without leaving the request editors
  const [importing, setImporting] = useState(false);
  const [collapseAll, setCollapseAll] = useState(0);
  const [expandAll, setExpandAll] = useState(0);
  // reveal the opened request in the tree when it was opened from elsewhere (search, history, a link): not when it was
  // opened from the explorer itself (e.g. Favorites), which would unfold its collection under the user's hand
  // (watched, not subscribed to: the explorer keeps only this key, so an intent that reveals nothing re-renders nothing)
  // what to reveal: the open request, or what Reveal in sidebar / a breadcrumb segment named (WF-11), also when that
  // brought the explorer up (it asked before this mounted)
  const latestReveal = () => {
    const { intent, reveal } = useApp.getState();
    const k = revealKeyOf(intent);
    return reveal && reveal.nonce > (k ?? 0) ? { key: reveal.nonce, id: reveal.id } : { key: k, id: undefined };
  };
  const [revealKey, setRevealKey] = useState(() => latestReveal().key);
  const [revealId, setRevealId] = useState<string | undefined>(() => latestReveal().id);
  useEffect(
    () =>
      useApp.subscribe((s, prev) => {
        const k = s.intent !== prev.intent ? revealKeyOf(s.intent) : undefined;
        if (k !== undefined) (setRevealId(undefined), setRevealKey(k));
        if (s.reveal && s.reveal !== prev.reveal) (setRevealId(s.reveal.id), setRevealKey(s.reveal.nonce));
      }),
    [],
  );
  const [exporting, setExporting] = useState(false);
  /** The collection a collection menu's Export ▸ Export… chose (the dialog opens on it). */
  const [exportFor, setExportFor] = useState<string>();
  // Recently deleted: what this sidebar's deletes moved there (collections, datasets, API definitions, MCP servers)
  const [trashOpen, setTrashOpen] = useState(false);
  const importDefinition = () => setImporting(true);
  /** The datasets: a new empty one, generated test data, and a row's rename, duplicate and delete (the file goes to Recently deleted). */
  const [generatingData, setGeneratingData] = useState(false);
  const datasetAction = async (fn: () => Promise<unknown>) => {
    await attempt(async () => {
      await fn();
      await load(false, DATASETS);
    });
  };
  const newDataset = async (format: 'csv' | 'jsonl') => {
    const name = await promptText(`New ${format.toUpperCase()} dataset`, { message: 'File name in the datasets folder', placeholder: format === 'csv' ? 'users' : 'cases', okLabel: 'Create' });
    if (!name) return;
    await datasetAction(async () => {
      const r = await call<{ name: string }>('datasets.create', { name, format });
      intent('dataset', { dataset: r.name, tab: 'file' });
    });
  };
  const deleteDataset = (d: DatasetRow) =>
    deleteWithUndo({
      kind: 'dataset',
      name: d.name,
      trash: true,
      focus: `datasets:${d.name}`,
      run: () => datasetAction(() => call('datasets.delete', { name: d.name })),
      undo: () => datasetAction(() => restoreDeleted('dataset', d.name)),
    });
  /** The server, saved gRPC call, connection, API definition or dataset being renamed in place. */
  const [renaming, setRenaming] = useState<string>();
  /** Rename in place: the row's field, then `apply` (an RPC), then the keyboard back on the row. */
  const renamer = (id: string, nodeId: string, apply: (name: string) => unknown): RowRename => ({
    editing: renaming === id,
    start: () => setRenaming(id),
    done: (name) => {
      setRenaming(undefined);
      if (name) void apply(name);
      focusRow(nodeId);
    },
  });
  /** Change a saved gRPC call / connection list (move, rename, duplicate, delete): the one place that loads, edits and saves it. */
  const editLibrary = async (kind: 'grpc' | 'websocket', fn: (items: Array<LibraryItem<unknown>>) => Array<LibraryItem<unknown>>) => {
    await attempt(async () => {
      const lib = await call<Library<unknown>>('lib.get', { kind });
      await call('lib.save', { kind, library: { folders: lib.folders, items: fn(lib.items) } });
      await load(false, LIBRARY);
    });
  };
  /** Move a saved gRPC call / connection to another collection. */
  const moveItem = (kind: 'grpc' | 'websocket', id: string, collectionId: string) => editLibrary(kind, (items) => items.map((i) => (i.id === id ? { ...i, collectionId } : i)));
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
  /** A folder of saved gRPC calls or connections: rename it, or delete it (its items move to the top level, Undo puts them back). */
  const savedFolderMenu = (kind: 'grpc' | 'websocket', folder: string): NodeMenuCtx => ({
    name: folder,
    on: {
      rename: async () => {
        const to = (await promptText(LABEL.renameFolder, { message: 'Folder name', value: folder, okLabel: 'Rename' }))?.trim();
        if (to && to !== folder) await editLibrary(kind, (items) => items.map((i) => (i.folder === folder ? { ...i, folder: to } : i)));
      },
      delete: () => {
        const was = new Set<string>();
        void deleteWithUndo({
          kind: 'folder',
          name: folder,
          note: `Its ${kind === 'grpc' ? 'gRPC calls' : 'connections'} moved to the top level`,
          run: () => editLibrary(kind, (items) => items.map((i) => (i.folder === folder ? (was.add(i.id), { ...i, folder: undefined }) : i))),
          undo: () => editLibrary(kind, (items) => items.map((i) => (was.has(i.id) && !i.folder ? { ...i, folder } : i))),
        });
      },
    },
  });
  const renameSaved = (kind: 'grpc' | 'websocket', id: string): RowRename => renamer(id, id, (name) => editLibrary(kind, (items) => items.map((i) => (i.id === id ? { ...i, name } : i))));
  /** The menu of a gRPC call or connection: the same groups as a request's (open, copy, test file, rename, duplicate, move, delete). */
  const savedMenu = (kind: 'grpc' | 'websocket', item: SavedItem): NodeMenuCtx => {
    const ref = { kind: 'saved' as const, library: kind, itemId: item.id };
    return {
      ref,
      name: item.name,
      on: {
        open: () => void openRef(ref),
        openNewTab: () => void openRef(ref, { newTab: true }),
        ...(kind === 'grpc' ? { copyGrpcurl: () => void copySaved(kind, item.id) } : { copyUrl: () => void copySaved(kind, item.id) }),
        testFile: () => void saveAsTest({ ref, name: item.name }),
        rename: () => setRenaming(item.id),
        duplicate: () => void editLibrary(kind, (items) => items.flatMap((i) => (i.id === item.id ? [i, { ...i, id: uid('lib-'), name: `${i.name} copy`, updatedAt: new Date().toISOString() }] : [i]))),
        move: collections.filter((c) => c.id !== item.collectionId).map((c) => ({ label: c.name, onSelect: () => void moveItem(kind, item.id, c.id) })),
        delete: () => {
          // the whole saved item (its request and settings) and its place, to put it back as it was
          let removed: { item: LibraryItem<unknown>; at: number } | undefined;
          void deleteWithUndo({
            kind: collectionCallKind(kind),
            name: item.name,
            focus: treeKey(item.collectionId ?? '', kind, item.id),
            run: async () => {
              closeTabsFor([item.id]);
              await editLibrary(kind, (items) => {
                const at = items.findIndex((i) => i.id === item.id);
                if (at >= 0) removed = { item: items[at]!, at };
                return items.filter((i) => i.id !== item.id);
              });
            },
            undo: () => removed && editLibrary(kind, (items) => putBack(items, removed!.item, removed!.at)),
          });
        },
      },
    };
  };
  /** Change the MCP server list (rename, duplicate, move to a folder). */
  const editServers = async (fn: (list: McpServerConfig[]) => McpServerConfig[]) => {
    await attempt(async () => {
      await call('mcp.saveServers', { servers: fn(servers.map(({ connected: _c, ...s }) => s as McpServerConfig)) });
      await load(false, MCP);
    });
  };
  /** Change a folders library (the folder names, and which folder each item is in), read fresh so steps in a row see each other. */
  const editFolderLib = async (kind: 'mcp-folders' | 'spec-folders' | 'dataset-folders', fn: (lib: Library<unknown>) => Pick<Library<unknown>, 'folders' | 'items'>) => {
    await attempt(async () => {
      const lib = await call<Library<unknown>>('lib.get', { kind });
      await call('lib.save', { kind, library: fn(lib) });
      await load(false, LIBRARY);
    });
  };
  const specFolderOf = new Map(specFolders.items.map((i) => [i.id, i.folder]));
  const datasetFolderOf = new Map(datasetFolders.items.map((i) => [i.id, i.folder]));
  const mcpOps: FolderOps = {
    folders: mcpFolders,
    setFolders: (fn) => editFolderLib('mcp-folders', (lib) => ({ folders: fn(lib.folders), items: [] })),
    assign: (fn) => editServers((list) => list.map((s) => ({ ...s, folder: fn(s.id, s.folder) || undefined }))),
  };
  /** The folders of files the user keeps (API definitions, datasets): a library naming each file by its path. */
  const pathFolderOps = (kind: 'spec-folders' | 'dataset-folders', lib: Library<unknown>, paths: string[]): FolderOps => ({
    folders: lib.folders,
    setFolders: (fn) => editFolderLib(kind, (l) => ({ folders: fn(l.folders), items: l.items })),
    assign: (fn) =>
      editFolderLib(kind, (l) => {
        const now = new Map(l.items.map((i) => [i.id, i.folder]));
        return { folders: l.folders, items: paths.map((p) => ({ id: p, name: p, folder: fn(p, now.get(p)) || undefined, data: null })).filter((i) => i.folder) };
      }),
  });
  const specOps = pathFolderOps('spec-folders', specFolders, specs);
  const datasetOps = pathFolderOps('dataset-folders', datasetFolders, datasets.map((d) => d.name));
  /** The keys of a section and its folders (its Expand all and Collapse all). */
  const sectionKeys = (section: string, ops: FolderOps, items: Array<{ folder?: string }>) => [section, ...folderNames(ops, items).map((n) => folderKey(section, n))];
  const sectionTree = (section: string, ops: FolderOps, items: Array<{ folder?: string }>) => ({
    expandAll: () => sections.set(sectionKeys(section, ops, items), true),
    collapseAll: () => sections.set(sectionKeys(section, ops, items), false),
  });

  /** The menu of an MCP server: open, connect, copy its config, settings, rename, duplicate, move to a folder, delete (Undo). */
  const serverMenu = (s: McpServerConfig & { connected?: boolean }): NodeMenuCtx => {
    const ref = { kind: 'mcp-server' as const, serverId: s.id };
    const config = mcpConfigOf(s);
    return {
      ref,
      name: s.name,
      on: {
        open: () => void openRef(ref),
        openNewTab: () => void openRef(ref, { newTab: true }),
        ...(s.connected ? { disconnect: () => void call('mcp.disconnect', { serverId: s.id }).then(() => load(false, MCP), toastError) } : { connect: () => intent('mcp', { serverId: s.id, connect: true }) }),
        copyMcpConfig: () => void copyText(JSON.stringify({ mcpServers: { [s.name]: config } }, null, 2), 'the MCP config (.mcp.json, claude_desktop_config.json)'),
        settings: () => intent('mcp', { serverId: s.id, tab: 'settings' }),
        rename: () => setRenaming(s.id),
        duplicate: () => void editServers((list) => list.flatMap((x) => (x.id === s.id ? [x, { ...x, id: uid('mcp-'), name: `${x.name} copy` }] : [x]))),
        move: moveToFolderSubmenu(mcpOps, servers, s.id, s.folder),
        // at once, with Undo (Recently deleted keeps it: its place in the list comes back, a connected server reconnects)
        delete: () => void deleteMcpServerWithUndo(s, { after: () => load(false, MCP) }),
      },
      disabled: config ? {} : { copyMcpConfig: 'A mock server runs inside TestPion: there is no config for another app' },
    };
  };
  /** The menu of an API definition: open, lint, coverage, compare, copy, generate tests or flows, rename, move, delete (Undo). */
  const specMenu = (path: string, folder: string | undefined): NodeMenuCtx => {
    const ref = { kind: 'spec' as const, path };
    const isAsync = path.startsWith('specs/asyncapi/');
    return {
      ref,
      name: path,
      on: {
        open: () => intent('apidef', { spec: path, tab: 'definition' }),
        revealFile: () => void call('workspace.revealFile', { path }).catch(toastError),
        lint: () => intent('apidef', { spec: path, tab: 'lint' }),
        apiCoverage: () => intent('apidef', { spec: path, tab: 'coverage' }),
        compareVersions: () => intent('apidef', { spec: path, tab: 'compare' }),
        copyPath: () => void copyText(path, 'the path'),
        generateTests: () => void generateSpecTests(path),
        generateFlows: () => void generateFlows({ path }, confirmAction),
        generateSpecTests: () => startFlowGenerate({ mode: 'spec', spec: path }),
        driftReport: () => startAiAnalysis({ kind: 'drift', spec: path }),
        rename: () => setRenaming(path),
        move: moveToFolderSubmenu(specOps, specFolders.items, path, folder),
        delete: () => {
          let trashId: string | undefined;
          void deleteWithUndo({
            kind: 'spec',
            name: path,
            trash: true,
            focus: `specs:${path}`,
            run: async () => {
              closeTabsFor([path]);
              trashId = (await call<{ trashId: string }>('openapi.spec.delete', { path })).trashId;
              await load(false, SPECS);
            },
            undo: async () => {
              if (trashId) await call('trash.restore', { id: trashId });
              await load(false, SPECS);
            },
          });
        },
      },
      disabled: isAsync ? { generateSpecTests: 'Tests from a spec read OpenAPI documents', driftReport: 'Contract drift reads OpenAPI documents', lint: 'Lint reads OpenAPI documents', apiCoverage: 'API coverage reads OpenAPI documents', compareVersions: 'Compare versions reads OpenAPI documents' } : {},
    };
  };
  /** The menu of a dataset: open, preview, run a collection with it, copy, use in a test, rename, duplicate, move, delete (Undo). */
  const datasetMenu = (d: DatasetRow, folder: string | undefined): NodeMenuCtx => ({
    ref: { kind: 'dataset', name: d.name },
    name: d.name,
    on: {
      open: () => void openRef({ kind: 'dataset', name: d.name }),
      revealFile: () => void call('workspace.revealFile', { path: `datasets/${d.name}` }).catch(toastError),
      preview: () => intent('dataset', { dataset: d.name, tab: 'preview' }),
      runWithDataset: () => intent('collections', { run: true, dataPath: d.path }),
      copyPath: () => void copyText(`datasets/${d.name}`, 'the path'),
      useInTest: () => void copyText(datasetYaml(d.name), 'the dataset block for a test file'),
      rename: () => setRenaming(d.name),
      duplicate: () => void datasetAction(() => call('datasets.duplicate', { name: d.name })),
      move: moveToFolderSubmenu(datasetOps, datasetFolders.items, d.name, folder),
      delete: () => void deleteDataset(d),
    },
  });
  /** A favorite is a request: the request's menu (no variant), with what the explorer can do from here. */
  const favoriteMenu = (c: Collection, n: Extract<CollectionNode, { kind: 'http' | 'graphql' }>): NodeMenuCtx => {
    const ref = { kind: 'request' as const, collectionId: c.id, requestId: n.id };
    return {
      ref,
      name: n.name,
      favorite: true,
      on: {
        open: () => void openRef(ref, { noReveal: true }),
        openNewTab: () => void openRef(ref, { newTab: true, noReveal: true }),
        revealInSidebar: () => revealInSidebar(ref),
        ...(n.kind === 'http' ? { copyAs: requestCopyItems(c, n) } : {}),
        monitor: () => intent('monitors', { create: { collectionId: c.id, selection: [n.id] } }),
        testFile: () => void saveAsTest({ ref, name: n.name }),
        suggestChecks: () => startAi({ task: 'generate-assertions', title: `Suggested checks for ${n.name}`, context: {}, item: ref, autoReview: true, preflight: true }),
        rename: async () => {
          const name = (await promptText(LABEL.rename, { message: 'Request name', value: n.name, okLabel: 'Rename' }))?.trim();
          if (name && name !== n.name) await editCollection(c, (w) => ({ ...w, items: mapNodes(w.items, (x) => (x.id === n.id ? { ...x, name } : x)) }));
        },
        duplicate: () => void editCollection(c, (w) => ({ ...w, items: duplicateNode(w.items, n.id, (y) => ({ ...y, id: uid('req-'), name: `${y.name} copy` })) })),
        favorite: () => void editCollection(c, (w) => ({ ...w, items: mapNodes(w.items, (x) => (x.id === n.id && x.kind !== 'folder' ? { ...x, favorite: false } : x)) })),
        delete: () =>
          void fullCollection(c).then(
            (whole) =>
              deleteWithUndo({
                kind: 'request',
                name: n.name,
                focus: `favorites:fav-${scopedNodeId(c.id, n.id)}`,
                run: async () => {
                  closeTabsFor([n.id]);
                  await saveCollection({ ...whole, items: mapNodes(whole.items, (x) => (x.id === n.id ? null : x)) });
                },
                undo: () => saveCollection(whole),
              }),
            toastError,
          ),
      },
    };
  };

  // the tree is memoized: its saved items change only with these lists (or a rename in place); menus read the latest
  const savedLatest = useRef({ savedMenu, renameSaved, savedFolderMenu });
  savedLatest.current = { savedMenu, renameSaved, savedFolderMenu };
  const extraGroups = useCallback(
    (c: Collection): ExtraGroup[] => [
      {
        cat: 'grpc',
        kind: collectionCallKind('grpc'),
        items: grpcByCollection.get(c.id) ?? NONE,
        onOpen: (id) => void openRef({ kind: 'saved', library: 'grpc', itemId: id }),
        menu: (id) => savedLatest.current.savedMenu('grpc', grpc.find((i) => i.id === id)!),
        rename: (id) => savedLatest.current.renameSaved('grpc', id),
        folderMenu: (folder) => savedLatest.current.savedFolderMenu('grpc', folder),
      },
      {
        cat: 'websocket',
        kind: collectionCallKind('websocket'),
        items: socketsByCollection.get(c.id) ?? NONE,
        onOpen: (id) => void openRef({ kind: 'saved', library: 'websocket', itemId: id }),
        menu: (id) => savedLatest.current.savedMenu('websocket', sockets.find((i) => i.id === id)!),
        rename: (id) => savedLatest.current.renameSaved('websocket', id),
        folderMenu: (folder) => savedLatest.current.savedFolderMenu('websocket', folder),
      },
    ],
    // (not `renaming`: the tree shows the renamed item by its `extraRenaming` prop; rename() reads savedLatest)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [grpcByCollection, socketsByCollection, grpc, sockets],
  );
  const newOfCategory = (c: Collection, cat: RequestCategory) => {
    if (isCollectionCallLibrary(cat)) return intent(cat, { newDoc: true, collectionId: c.id });
    const node = newNode(cat)!;
    void editCollection(c, (c) => ({ ...c, items: addToFolder(c.items, undefined, node) })).then(() => openRef({ kind: 'request', collectionId: c.id, requestId: node.id, protocol: cat === 'graphql' ? 'graphql' : 'http' }));
  };
  // the same functions on every render, so the memoized tree re-renders only when what it shows changed
  const treeCallbacks = useStableCallbacks({
    onNewOfCategory: newOfCategory,
    onDropSaved: (kind: 'grpc' | 'websocket', id: string, to: string) => void moveItem(kind, id, to),
    onOpen: (c: Collection, n: CollectionNode, o?: { preview?: boolean }) => void openRef({ kind: 'request', collectionId: c.id, requestId: n.id }, o?.preview ? { preview: true } : {}),
    onChange: (c: Collection) => void saveCollection(c),
    onRun: (c: Collection, folderId?: string) => intent('collections', { collectionId: c.id, run: true, folderId }),
    onNewRequest: (c: Collection, folderId?: string) => {
      const node = newNode('rest')!;
      void saveCollection({ ...c, items: addToFolder(c.items, folderId, node) }).then(() => openRef({ kind: 'request', collectionId: c.id, requestId: node.id, protocol: 'http' }));
    },
    onSettings: (c: Collection) => void openRef({ kind: 'collection', collectionId: c.id }),
    onExport: (c: Collection) => (setExportFor(c.id), setExporting(true)),
  });

  /** Everything in the explorer, folded or unfolded: every collection and folder, every section and its folders. */
  const everySection = () => [...sectionKeys('mcp', mcpOps, servers), ...sectionKeys('specs', specOps, specFolders.items), ...sectionKeys('datasets', datasetOps, datasetFolders.items), 'favorites'];
  // the blank part of the sidebar: the workspace's menu (new collection or request, import, expand or collapse everything)
  const area = useAreaMenu(
    'section:collection',
    () => ({
      create: [{ label: 'New collection', icon: <FolderPlus size={14} />, onSelect: () => void newCollection() }, ...newRequestItems()],
      on: {
        import: importDefinition,
        recentlyDeleted: () => setTrashOpen(true),
        ci: () => useApp.getState().set({ ci: {} }),
        expandAll: () => (sections.set(everySection(), true), setExpandAll((n) => n + 1)),
        collapseAll: () => (sections.set(everySection(), false), setCollapseAll((n) => n + 1)),
      },
    }),
    ws?.name ?? 'Workspace',
  );

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
        <ExpandCollapseToggle start="collapse" onExpand={() => (sections.set(everySection(), true), setExpandAll((n) => n + 1))} onCollapse={() => (sections.set(everySection(), false), setCollapseAll((n) => n + 1))} />
        <IconButton label="Recently deleted" className="h-7 w-7 shrink-0" onClick={() => setTrashOpen(true)}>
          <ArchiveRestore size={14} />
        </IconButton>
      </div>
      {/* keyboard, like a file tree: ↑ ↓ move between rows, → expands, ← collapses (Enter opens, F2 renames, Delete deletes, Shift+F10 the menu) */}
      <div className="flex-1 overflow-auto" onKeyDown={treeKeys} onContextMenu={area.onContextMenu} data-explorer-area>
        {/* favorite requests from every collection, one click away (⋯ ▸ Add to favorites on a request) */}
        {favorites.length > 0 && (
          <Section
            id="favorites"
            kind="favorites"
            title="Favorites"
            icon={<Star size={14} />}
            count={favorites.length}
            sections={sections}
            def
            forceOpen={!!f && shownFavorites.length > 0}
            menu={() => ({ on: { expandAll: () => sections.set(['favorites'], true), collapseAll: () => sections.set(['favorites'], false) } })}
          >
            {shownFavorites.map(({ c, n }) => (
              <ItemRow
                // a favourite is a request of one collection: two collections may hold the same request id
                key={`fav-${scopedNodeId(c.id, n.id)}`}
                kind="request"
                nodeId={`favorites:fav-${scopedNodeId(c.id, n.id)}`}
                icon={<TreeBadge label={n.kind === 'http' ? n.request.method : 'GQL'} className={n.kind === 'http' ? `method-${n.request.method}` : KIND_COLOR.graphql} />}
                label={n.name}
                sub={c.name}
                activeId={n.id}
                onClick={() => void openRef({ kind: 'request', collectionId: c.id, requestId: n.id }, { noReveal: true })}
                git={{ kind: 'request', collectionId: c.id, requestId: n.id }}
                ctx={() => favoriteMenu(c, n)}
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
              extraRenaming={renaming}
              collapseAll={collapseAll}
              expandAll={expandAll}
              revealKey={revealKey}
              revealId={revealId}
              {...treeCallbacks}
            />
          </div>
        ) : (
          <div className="border-b border-line/60 py-2">
            <EmptyHint text="Collections hold your requests: REST, SOAP, GraphQL, gRPC and WebSocket, organised in folders. Create one, or import OpenAPI, Postman, Insomnia, Bruno, WSDL or HAR." action="New collection" onAction={() => void newCollection()} />
          </div>
        )}

        <Section
          id="mcp"
          kind="section:mcp-server"
          title="MCP servers"
          icon={<Plug size={14} />}
          count={servers.length}
          sections={sections}
          def={servers.length > 0}
          forceOpen={!!f && shownServers.length > 0}
          menu={() => ({
            create: [{ label: 'Add an MCP server', icon: <Plus size={14} />, onSelect: () => intent('mcp', { addServer: true }) }],
            on: { newFolder: () => void newFolderIn(mcpOps), openMcpInspector: () => intent('mcp', {}), ...sectionTree('mcp', mcpOps, servers) },
          })}
        >
          {servers.length || mcpFolders.length ? (
            <FolderedRows
              section="mcp"
              kind="folder:mcp-server"
              items={shownServers}
              ops={mcpOps}
              sections={sections}
              filtering={!!f}
              itemNoun="server"
              create={() => [{ label: 'Add an MCP server here', icon: <Plus size={14} />, onSelect: () => intent('mcp', { addServer: true }) }]}
              row={(s, inFolder) => (
                <ItemRow
                  key={s.id}
                  kind="mcp-server"
                  nodeId={`mcp:${s.id}`}
                  indent={inFolder}
                  icon={<TreeBadge label="MCP" className={s.connected ? 'text-ok' : KIND_COLOR.mcp} />}
                  label={s.name}
                  sub={s.connected ? 'connected' : s.transport === 'streamable-http' ? 'http' : s.transport}
                  activeId={s.id}
                  onClick={() => void openRef({ kind: 'mcp-server', serverId: s.id })}
                  ctx={() => serverMenu(s)}
                  rename={renamer(s.id, `mcp:${s.id}`, (name) => editServers((list) => list.map((x) => (x.id === s.id ? { ...x, name } : x))))}
                  drag={[{ kind: 'mcp-server', serverId: s.id }]}
                  git={{ kind: 'mcp-server', serverId: s.id }}
                />
              )}
            />
          ) : (
            <EmptyHint text="MCP servers to inspect and test: a local command, Streamable HTTP, SSE or a mock." action="Add server" onAction={() => intent('mcp', { addServer: true })} />
          )}
        </Section>

        <Section
          id="specs"
          kind="section:spec"
          title="API definitions"
          icon={<FileCode2 size={14} />}
          count={specs.length}
          sections={sections}
          def={specs.length > 0}
          forceOpen={!!f && shownSpecs.length > 0}
          menu={() => ({
            create: [{ label: 'Import an OpenAPI document', icon: <Upload size={14} />, onSelect: importDefinition }],
            on: { newFolder: () => void newFolderIn(specOps), openApiDefinitions: () => intent('apidef', {}), ...sectionTree('specs', specOps, specFolders.items) },
          })}
        >
          {specs.length || specFolders.folders.length ? (
            <FolderedRows
              section="specs"
              kind="folder:spec"
              items={shownSpecs.map((p) => ({ id: p, folder: specFolderOf.get(p) }))}
              ops={specOps}
              sections={sections}
              filtering={!!f}
              itemNoun="API definition"
              row={({ id: s, folder }, inFolder) => (
                <ItemRow
                  key={s}
                  kind="spec"
                  nodeId={`specs:${s}`}
                  indent={inFolder}
                  icon={<TreeBadge label="API" className={KIND_COLOR.api} />}
                  label={s.replace(/^specs\//, '')}
                  activeId={s}
                  onClick={() => void openRef({ kind: 'spec', path: s })}
                  ctx={() => specMenu(s, folder)}
                  rename={renamer(s, `specs:${s}`, (to) =>
                    call<{ path: string }>('openapi.spec.rename', { path: s, to: to.replace(/^.*\//, '') }).then(
                      () => load(false, SPECS),
                      toastError,
                    ),
                  )}
                  drag={[{ kind: 'spec', path: s }]}
                  git={{ kind: 'spec', path: s }}
                />
              )}
            />
          ) : (
            <EmptyHint text="OpenAPI documents: importing one keeps it here for contract checks, API coverage and comparing versions." action="Import OpenAPI" onAction={importDefinition} />
          )}
        </Section>

        <Section
          id="datasets"
          kind="section:dataset"
          title="Datasets"
          icon={<Database size={14} />}
          count={datasets.length}
          sections={sections}
          def={datasets.length > 0}
          forceOpen={!!f && shownDatasets.length > 0}
          menu={() => ({
            create: [
              { label: 'New CSV', icon: <FilePlus2 size={14} />, onSelect: () => void newDataset('csv') },
              { label: 'New JSONL', icon: <FilePlus2 size={14} />, onSelect: () => void newDataset('jsonl') },
            ],
            on: { newFolder: () => void newFolderIn(datasetOps), generateData: () => setGeneratingData(true), ...sectionTree('datasets', datasetOps, datasetFolders.items) },
          })}
        >
          {datasets.length || datasetFolders.folders.length ? (
            <FolderedRows
              section="datasets"
              kind="folder:dataset"
              items={shownDatasets.map((d) => ({ ...d, id: d.name, folder: datasetFolderOf.get(d.name) }))}
              ops={datasetOps}
              sections={sections}
              filtering={!!f}
              itemNoun="dataset"
              row={(d, inFolder) => (
                <ItemRow
                  key={d.name}
                  kind="dataset"
                  nodeId={`datasets:${d.name}`}
                  indent={inFolder}
                  icon={<TreeBadge label={datasetBadge(d.format).text} className={datasetBadge(d.format).cls} />}
                  label={d.name}
                  sub={d.rows !== undefined ? plural(d.rows, 'row') : d.tables ? plural(d.tables.length, 'table') : undefined}
                  activeId={d.name}
                  onClick={() => void openRef({ kind: 'dataset', name: d.name })}
                  ctx={() => datasetMenu(d, d.folder)}
                  rename={renamer(d.name, `datasets:${d.name}`, (to) => datasetAction(() => call('datasets.rename', { name: d.name, to })))}
                  drag={[{ kind: 'dataset', name: d.name }]}
                  git={{ kind: 'dataset', name: d.name }}
                />
              )}
            />
          ) : (
            <EmptyHint text="Data files (CSV, JSONL, JSON, Markdown tables, SQLite) that drive collection runs and tests, in the workspace's datasets folder." action="New CSV" onAction={() => void newDataset('csv')} />
          )}
        </Section>
        {/* the blank rest of the sidebar takes the workspace's menu too */}
        <div className="min-h-16" aria-hidden />
      </div>
      {area.menu}
      {generatingData && (
        <GenerateDataDialog
          onClose={() => setGeneratingData(false)}
          onDone={(g) => {
            setGeneratingData(false);
            void load(false, DATASETS);
            intent('dataset', { dataset: g.path.replace(/^datasets\//, '') });
          }}
        />
      )}
      {importing && <ImportModal onClose={() => setImporting(false)} onDone={() => void load()} />}
      {trashOpen && <TrashDialog kinds={SIDEBAR_TRASH_KINDS} onClose={() => setTrashOpen(false)} onRestored={() => void load()} />}
      {exporting && <ExportDialog collections={collections.map((c) => ({ id: c.id, name: c.name }))} initial={exportFor} onClose={() => (setExporting(false), setExportFor(undefined))} />}
    </aside>
  );
}
