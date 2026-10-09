import {
  Plus,
  AlarmClock,
  ChevronsDownUp,
  ChevronsUpDown,
  FolderInput,
  Workflow,
  Braces,
  ChevronDown,
  Undo2,
  Wand2,
  ChevronRight,
  Code2,
  CopyPlus,
  ExternalLink,
  FilePlus2,
  FolderCog,
  FolderPlus,
  Link2,
  MoreHorizontal,
  Pencil,
  Play,
  SquareTerminal,
  Star,
  Terminal,
  TerminalSquare,
  Trash2,
  Settings2,
  History,
} from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { Collection, CollectionFolder, CollectionNode, SavedHttpRequest } from '../types';
import { asError, call, on } from '../api';
import { Button, cx, Menu, menuKeys, rowActionClass, VirtualList, type MenuItem } from './ui';
import { CLOSED_ICON, CountPill, focusRow, FOLDER_ICON, InlineRename, MORE_ICON, OPEN_ICON } from './TreeParts';
import { confirmAction, promptText, toastError, useApp } from '../store';
import { MoveDialog, subtreeIds } from './MoveDialog';
import { closeTabsFor } from './EditorTabs';
import { plural, uid } from '../lib/format';
import { FolderEditor } from './FolderEditor';
import { ChangeMark } from './ChangeMark';
import { GitItemHistory } from './GitItemHistory';
import { useGit } from '../lib/git';
import { fullCollection } from '../lib/collections-store';
import { countCategory, hasCategory, isEmptyFolder, matchesCollectionNode, requestCategory, type RequestCategory } from '../lib/collection-filter';

// the tree's data operations live in lib/collection-nodes (re-exported: views import them from here)
export { mapNodes, findNode, addToFolder, insertBefore, folderIdsTo, withNewIds, duplicateNode } from '../lib/collection-nodes';
import { mapNodes, findNode, addToFolder, insertBefore, folderIdsTo, withNewIds, duplicateNode } from '../lib/collection-nodes';
import { usePersisted } from '../lib/sticky';

/** How each category of request looks in the tree. */
export const CATEGORY_META: Record<RequestCategory, { label: string; badge: string; cls: string }> = {
  rest: { label: 'REST', badge: 'HTTP', cls: 'text-ok' },
  soap: { label: 'SOAP', badge: 'SOAP', cls: 'text-[#0ea5e9]' },
  graphql: { label: 'GraphQL', badge: 'GQL', cls: 'text-[#e535ab]' },
  grpc: { label: 'gRPC', badge: 'gRPC', cls: 'text-[#2ea99e]' },
  websocket: { label: 'WebSocket & MQTT', badge: 'WS', cls: 'text-[#d97706]' },
};

/** Requests in a folder, with its sub-folders. */
const requestCount = (nodes: CollectionNode[]): number => nodes.reduce((a, n) => a + (n.kind === 'folder' ? requestCount(n.items) : 1), 0);

/** The one name of "new request of this kind" in every menu and button: New HTTP request, New GraphQL request … */
export const newRequestOf = (cat: RequestCategory) => (cat === 'rest' ? 'New HTTP request' : `New ${CATEGORY_META[cat].label} request`);

/** Saved items of a collection that aren't collection requests (gRPC calls, WebSocket connections). */
export interface ExtraGroup {
  cat: 'grpc' | 'websocket';
  items: Array<{ id: string; name: string; folder?: string; badge?: string }>;
  onOpen(id: string): void;
  menu?(id: string): MenuItem[];
  /** Rename an item in place (F2, or Rename in its menu). */
  rename?(id: string): { editing: boolean; start(): void; done(name?: string): void };
}

/** Drag data of a saved gRPC call or connection in the tree: `{ kind, id, from? }`. */
export const SAVED_ITEM_MIME = 'application/x-testpion-saved-item';
export function savedItemDragProps(kind: 'grpc' | 'websocket', id: string, name: string, from?: string) {
  return {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.stopPropagation();
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', name);
      e.dataTransfer.setData(SAVED_ITEM_MIME, JSON.stringify({ kind, id, from }));
    },
  };
}

/** Tree of collections → folders → requests with inline actions. */
/** Per collection: sent requests and how many are failing now; refreshed after requests and runs (debounced). */
function useCollectionsHealth(): Record<string, { sent: number; failing: number }> {
  const [health, setHealth] = useState<Record<string, { sent: number; failing: number }>>({});
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => void call<Record<string, { sent: number; failing: number }>>('stats.collectionsHealth').then(setHealth, () => undefined);
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(load, 1500);
    };
    load();
    const offs = [on('console', soon), on('run.finished', soon)];
    return () => {
      clearTimeout(timer);
      offs.forEach((off) => off());
    };
  }, []);
  return health;
}

const SHORT_METHOD: Record<string, string> = { DELETE: 'DEL', OPTIONS: 'OPT' };

/**
 * The type label in front of every row of the explorer (GET, POST, MCP, gRPC, WS …): one pill of one width, so names
 * line up and the space between the label and the name is the same on every row.
 */
export function TreeBadge({ label, className }: { label: string; className?: string }) {
  const text = SHORT_METHOD[label.toUpperCase()] ?? label.slice(0, 5);
  return (
    <span className={cx('mono method-badge text-[0.64rem] font-bold w-[2.375rem] shrink-0', className)} title={label}>
      {text}
    </span>
  );
}

/** One row of the tree as drawn: the open part of every collection, flattened, so only the rows on screen are rendered. */
type TreeRow =
  | { t: 'col'; key: string; c: Collection; open: boolean }
  | { t: 'cat'; key: string; c: Collection; cat: RequestCategory; count: number; open: boolean }
  | { t: 'folder'; key: string; c: Collection; n: CollectionFolder; depth: number; open: boolean }
  | { t: 'req'; key: string; c: Collection; n: Exclude<CollectionNode, CollectionFolder>; depth: number }
  | { t: 'example'; key: string; c: Collection; n: SavedHttpRequest; ex: { id: string; name: string; status: number }; depth: number }
  | { t: 'xfolder'; key: string; folder: string; count: number; open: boolean; depth: number }
  | { t: 'xitem'; key: string; g: ExtraGroup; i: ExtraGroup['items'][number]; depth: number; from?: string }
  | { t: 'empty'; key: string; c: Collection };

/** Below this many rows every row is drawn (a small tree); above it only the rows on screen and a margin. */
const DRAW_ALL = 300;
/** Rows drawn above and below the visible ones in a big tree. */
const OVERSCAN = 25;

export const CollectionTree = memo(function CollectionTree({
  collections,
  activeRequestId,
  onOpen,
  onChange,
  onNewRequest,
  onRun,
  onSettings,
  filter,
  favoritesOnly = false,
  onMoved,
  newRequestLabel,
  categorize = false,
  extraGroups,
  onNewOfCategory,
  onDropSaved,
  collapseAll,
  revealKey,
}: {
  collections: Collection[];
  activeRequestId?: string;
  onOpen(c: Collection, node: CollectionNode): void;
  onChange(c: Collection): void;
  onNewRequest(c: Collection, folderId?: string): void;
  /** Open the Collection Runner for a collection or one of its folders. */
  onRun?(c: Collection, folderId?: string): void;
  /** Open a collection's settings (variables, auth, scripts, runner, docs, mock): shown in its menu. */
  onSettings?(c: Collection): void;
  filter?: string;
  /** Show starred requests while retaining their containing folders for context. */
  favoritesOnly?: boolean;
  /** Requests (ids) moved from one collection to another, so open tabs can follow them. */
  onMoved?(ids: string[], fromCollectionId: string, toCollectionId: string): void;
  /** Label of the "New request" menu entry (e.g. "New GraphQL request"). */
  newRequestLabel?: string;
  /** Group each collection's requests by what they are (REST, SOAP, GraphQL, gRPC, WebSocket). */
  categorize?: boolean;
  /** A collection's gRPC calls and WebSocket connections (saved outside the collection file). */
  extraGroups?(c: Collection): ExtraGroup[];
  /** Create a request of this category in a collection (the + of a category, the collection menu). */
  onNewOfCategory?(c: Collection, cat: RequestCategory): void;
  /** A saved gRPC call or connection was dropped on a collection. */
  onDropSaved?(kind: 'grpc' | 'websocket', id: string, collectionId: string): void;
  /** Changes (1, 2 …) fold every collection and folder. */
  collapseAll?: number;
  /** Changes whenever something is opened: the open request is revealed again (even if it was already open). */
  revealKey?: number;
}) {
  const [menuFor, setMenuFor] = useState<string>();
  /**
   * Change a collection: the list may be outlines (col.tree, no bodies or scripts), so the change is applied to the
   * whole collection, read first; `onChange` always gets a whole collection.
   */
  const change = (c: Collection, f: (whole: Collection) => Collection | undefined) =>
    void fullCollection(c).then((whole) => {
      const next = f(whole);
      if (next) onChange(next);
    }, toastError);
  /** "New request": the callback builds on the collection's items, so it gets the whole collection. */
  const newRequest = (c: Collection, folderId?: string) => void fullCollection(c).then((whole) => onNewRequest(whole, folderId), toastError);
  /** The node as the whole collection has it (with its body, headers and scripts). */
  const wholeNode = <T extends CollectionNode>(whole: Collection, n: T): T => (findNode(whole.items, n.id) as T | undefined) ?? n;
  /** The collection, folder or request being renamed in place (F2, or Rename in its menu). */
  const [renaming, setRenaming] = useState<string>();
  const finishRename = (c: Collection, id: string, name?: string) => {
    setRenaming(undefined);
    if (name) change(c, (c) => (id === c.id ? { ...c, name } : { ...c, items: mapNodes(c.items, (x) => (x.id === id ? { ...x, name } : x)) }));
    focusRow(id);
  };
  const health = useCollectionsHealth();
  const [moving, setMoving] = useState<{ c: Collection; n: CollectionNode }>();
  const [historyFor, setHistoryFor] = useState<{ c: Collection; n?: CollectionNode }>();
  const git = useGit();
  /** A copy of the collection with everything it holds (its gRPC calls and connections too). */
  const duplicateCollection = async (c: Collection) => {
    try {
      const copy = await call<Collection>('col.duplicate', { id: c.id });
      useApp.getState().toast(`Duplicated as "${copy.name}"`, 'success');
    } catch (e) {
      toastError(e);
    }
  };
  /** Move a collection to Recently deleted (restorable for 30 days); its tabs close. */
  const deleteCollection = async (c: Collection) => {
    if (
      !(await confirmAction({
        title: 'Delete collection',
        message: `Delete the collection "${c.name}" and all its requests, gRPC calls and connections?`,
        detail: 'You can restore it, with everything in it, from Recently deleted for 30 days.',
        confirmLabel: 'Delete collection',
        danger: true,
      }))
    )
      return;
    try {
      closeTabsFor(c.items.flatMap(subtreeIds));
      await call('col.delete', { id: c.id });
      useApp.getState().toast(`Deleted "${c.name}"`, 'info');
    } catch (e) {
      toastError(e);
    }
  };
  const renameNode = (_c: Collection, n: CollectionNode) => setRenaming(n.id);
  /** Delete a request or folder, with Undo in the toast (puts the collection back as it was). */
  const deleteNode = async (c: Collection, n: CollectionNode) => {
    const ok =
      n.kind === 'folder'
        ? await confirmAction({ title: 'Delete folder', message: `Delete the folder "${n.name}" and all requests in it?`, confirmLabel: 'Delete folder', danger: true })
        : await confirmAction({ title: 'Delete request', message: `Delete the request "${n.name}"?`, detail: 'Its saved examples are deleted too.', confirmLabel: 'Delete request', danger: true });
    if (ok) removeWithUndo(c, n);
  };
  /** F2 renames and Delete deletes the focused request or folder (like a file tree). */
  const rowKeys = (c: Collection, n: CollectionNode) => (e: React.KeyboardEvent) => {
    if (e.key === 'F2') {
      e.preventDefault();
      void renameNode(c, n);
    } else if (e.key === 'Delete') {
      e.preventDefault();
      void deleteNode(c, n);
    }
  };
  const removeWithUndo = (c: Collection, n: CollectionNode) =>
    change(c, (c) => {
      // its tabs (and those of everything in a deleted folder) close too
      closeTabsFor(subtreeIds(n));
      useApp.getState().toast(`Deleted "${n.name}"`, 'info', { label: 'Undo', onClick: () => onChange(c) });
      return { ...c, items: mapNodes(c.items, (x) => (x.id === n.id ? null : x)) };
    });
  // drag and drop: a request or folder onto a request (before it), a folder (into it) or a collection (top level)
  const [drag, setDrag] = useState<{ c: Collection; n: CollectionNode }>();
  const [dropAt, setDropAt] = useState<{ id: string; mode: 'before' | 'into' }>();
  const canDrop = (place: { beforeId?: string; folderId?: string }) => {
    if (!drag) return false;
    const own = subtreeIds(drag.n);
    return !(place.beforeId && own.includes(place.beforeId)) && !(place.folderId && own.includes(place.folderId));
  };
  const drop = (to: Collection, place: { beforeId?: string; folderId?: string }) => {
    const d = drag;
    setDrag(undefined);
    setDropAt(undefined);
    if (!d || !canDrop(place)) return;
    void Promise.all([fullCollection(d.c), to.id === d.c.id ? undefined : fullCollection(to)]).then(([from, other]) => {
      const n = wholeNode(from, d.n);
      const insert = (items: CollectionNode[]) => (place.beforeId ? insertBefore(items, place.beforeId, n) : addToFolder(items, place.folderId, n));
      const without = mapNodes(from.items, (x) => (x.id === n.id ? null : x));
      if (!other) onChange({ ...from, items: insert(without) });
      else {
        onChange({ ...other, items: insert(other.items) });
        onChange({ ...from, items: without });
        onMoved?.(subtreeIds(n), from.id, other.id);
      }
    }, toastError);
  };
  const dragProps = (c: Collection, n: CollectionNode) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.stopPropagation();
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', n.name);
      setDrag({ c, n });
    },
    onDragEnd: () => (setDrag(undefined), setDropAt(undefined)),
  });
  // a gRPC call or connection dragged from another collection and dropped on this one moves there
  const collectionDropProps = (c: Collection) => {
    const nodes = dropProps(c, c.id, 'into', {});
    const saved = (e: React.DragEvent) => !!onDropSaved && e.dataTransfer.types.includes(SAVED_ITEM_MIME);
    return {
      onDragOver: (e: React.DragEvent) => {
        if (!saved(e)) return nodes.onDragOver(e);
        e.preventDefault();
        e.stopPropagation();
        if (dropAt?.id !== c.id) setDropAt({ id: c.id, mode: 'into' });
      },
      onDragLeave: nodes.onDragLeave,
      onDrop: (e: React.DragEvent) => {
        if (!saved(e)) return nodes.onDrop(e);
        e.preventDefault();
        e.stopPropagation();
        setDropAt(undefined);
        try {
          const d = JSON.parse(e.dataTransfer.getData(SAVED_ITEM_MIME)) as { kind: 'grpc' | 'websocket'; id: string; from?: string };
          if (d.from !== c.id) onDropSaved!(d.kind, d.id, c.id);
        } catch {
          /* not ours */
        }
      },
    };
  };
  const dropProps = (c: Collection, id: string, mode: 'before' | 'into', place: { beforeId?: string; folderId?: string }) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!canDrop(place)) return;
      e.preventDefault();
      e.stopPropagation();
      if (dropAt?.id !== id || dropAt.mode !== mode) setDropAt({ id, mode });
    },
    onDragLeave: () => dropAt?.id === id && setDropAt(undefined),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      drop(c, place);
    },
  });
  const dropClass = (id: string) => (dropAt?.id !== id ? undefined : dropAt.mode === 'into' ? 'ring-1 ring-inset ring-accent bg-accent/10' : 'shadow-[inset_0_2px_0_var(--accent)]');
  const move = (fromShown: Collection, shown: CollectionNode, toShown: Collection, folderId: string | undefined) => {
    setMoving(undefined);
    void Promise.all([fullCollection(fromShown), toShown.id === fromShown.id ? undefined : fullCollection(toShown)]).then(([from, other]) => {
      const n = wholeNode(from, shown);
      const to = other ?? from;
      const without = { ...from, items: mapNodes(from.items, (x) => (x.id === n.id ? null : x)) };
      if (!other) onChange({ ...without, items: addToFolder(without.items, folderId, n) });
      else {
        // add to the new collection first: a failed save then leaves a copy rather than losing the request
        onChange({ ...other, items: addToFolder(other.items, folderId, n) });
        onChange(without);
      }
      onMoved?.(subtreeIds(n), from.id, to.id);
      useApp.getState().toast(`Moved "${n.name}" to ${to.name}${folderId ? ` › ${findNode(to.items, folderId)?.name ?? ''}` : ''}`, 'success');
    }, toastError);
  };
  /** Copy a saved request as its URL or as code, with variables resolved from the active environment. */
  const copyAs = async (c: Collection, shown: SavedHttpRequest, language: string, what: string) => {
    try {
      const n = wholeNode(await fullCollection(c), shown);
      const r = await call<{ text: string; containsSecrets: boolean }>('http.copyCode', { request: n.request, environment: useApp.getState().environment, collectionId: c.id, requestId: n.id, language });
      await navigator.clipboard.writeText(r.text);
      useApp.getState().toast(`Copied ${what}${r.containsSecrets ? ' (it includes secret values such as tokens)' : ''}`, 'success');
    } catch (e) {
      useApp.getState().toast(`Couldn't copy: ${asError(e).message}`, 'error');
    }
  };
  const copyMenu = (c: Collection, n: SavedHttpRequest): MenuItem[] => [
    { label: 'Copy URL', icon: <Link2 size={14} />, onSelect: () => void copyAs(c, n, 'url', 'the URL') },
    { label: 'Copy as cURL (bash)', icon: <Terminal size={14} />, onSelect: () => void copyAs(c, n, 'curl', 'as cURL (bash)') },
    { label: 'Copy as cURL (cmd)', icon: <SquareTerminal size={14} />, onSelect: () => void copyAs(c, n, 'curl-windows', 'as cURL (cmd)') },
    { label: 'Copy as PowerShell', icon: <TerminalSquare size={14} />, onSelect: () => void copyAs(c, n, 'powershell', 'as PowerShell') },
    { label: 'Copy as fetch', icon: <Braces size={14} />, onSelect: () => void copyAs(c, n, 'fetch', 'as fetch') },
    { label: 'More code snippets…', icon: <Code2 size={14} />, onSelect: () => useApp.getState().openIntent('rest', { collectionId: c.id, requestId: n.id, showCode: true }) },
  ];
  /** Rewrite the collection's scripts between Postman's pm.* and TestPion's tp.* (both always work). */
  const convertScripts = async (c: Collection, to: 'tp' | 'pm') => {
    const from = to === 'tp' ? 'pm' : 'tp';
    try {
      const r = await call<{ changed: number; replacements: number; skipped: Array<{ where: string; reason: string }>; collection?: Collection }>('col.convertScripts', {
        collectionId: c.id,
        to,
        dryRun: true,
      });
      const skippedNote = r.skipped.length
        ? `\n\n${plural(r.skipped.length, 'script')} left as they are: ${r.skipped
            .slice(0, 3)
            .map((s) => `${s.where} (${s.reason})`)
            .join('; ')}${r.skipped.length > 3 ? ' …' : ''}`
        : '';
      if (!r.changed || !r.collection) {
        useApp.getState().toast(`No scripts in "${c.name}" use ${from}.*${r.skipped.length ? ` (${r.skipped.length} skipped)` : ''}`, 'success');
        return;
      }
      const ok = await confirmAction({
        title: `Convert scripts to ${to}.*`,
        message: `${plural(r.changed, 'script')} in "${c.name}" use ${from}.* (${plural(r.replacements, 'place')}).`,
        detail: `They will use ${to}.* instead. Both names always work in TestPion, and exports to Postman always use pm.*. Only code changes, not text in strings or comments.${skippedNote}`,
        confirmLabel: 'Convert',
        tone: 'question',
      });
      if (!ok) return;
      onChange(r.collection);
      useApp.getState().toast(`Converted ${plural(r.changed, 'script')} to ${to}.*`, 'success');
    } catch (e) {
      useApp.getState().toast(`Couldn't convert the scripts: ${asError(e).message}`, 'error');
    }
  };
  const [open, setOpen] = usePersisted<Record<string, boolean>>('aps.tree.open', {});
  // flips what is shown: an item open by default (a category, the collection of the open request) closes on the first click
  const toggle = (id: string, shown: boolean) => {
    setOpen((o) => ({ ...o, [id]: !shown }));
  };
  useEffect(() => {
    if (!collapseAll) return;
    // every folder and category closed, and every collection (some are open by default)
    setOpen((o) => {
      const next: Record<string, boolean> = Object.fromEntries(Object.keys(o).map((k) => [k, false]));
      for (const c of collections) next[c.id] = false;
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapseAll]);
  /**
   * Expand or collapse everything inside a collection (its categories, folders and saved-item folders), or inside one
   * folder: the collection or folder itself opens or closes with it (a folder of requests only would otherwise not change).
   */
  const setSubtree = (c: Collection, folder: CollectionFolder | undefined, shown: boolean) => {
    const keys: string[] = [];
    const walk = (nodes: CollectionNode[]) => nodes.forEach((n) => n.kind === 'folder' && (keys.push(n.id), walk(n.items)));
    walk(folder ? folder.items : c.items);
    if (!folder) {
      for (const cat of ['rest', 'soap', 'graphql', 'grpc', 'websocket'] as RequestCategory[]) keys.push(`${c.id}:cat:${cat}`);
      // folders of saved gRPC calls and connections, and anything else remembered under this collection
      for (const k of Object.keys(open)) if (k.startsWith(`${c.id}:`)) keys.push(k);
    }
    setOpen((o) => {
      return { ...o, ...Object.fromEntries(keys.map((k) => [k, shown])), [folder?.id ?? c.id]: shown };
    });
  };
  const [editing, setEditing] = useState<{ c: Collection; folder: CollectionFolder }>();
  const f = filter?.toLowerCase();

  // every row that shows (the open collections, categories and folders), in order: a list of thousands is cheap to
  // build; only the rows on screen are drawn
  const rows = useMemo(() => {
    const out: TreeRow[] = [];
    const matches = (n: CollectionNode) => matchesCollectionNode(n, filter, favoritesOnly);
    // in a category, a folder shows when it holds requests of that category (empty folders: the first category)
    const inScope = (n: CollectionNode, scope?: { cat: RequestCategory; first: boolean }) =>
      !scope || (n.kind === 'folder' ? hasCategory(n.items, scope.cat) || (scope.first && isEmptyFolder(n)) : requestCategory(n) === scope.cat);
    const extraShown = (i: ExtraGroup['items'][number]) => !f || i.name.toLowerCase().includes(f) || !!i.folder?.toLowerCase().includes(f);
    const addNodes = (c: Collection, nodes: CollectionNode[], depth: number, scope?: { cat: RequestCategory; first: boolean }) => {
      for (const n of nodes) {
        if (!matches(n) || !inScope(n, scope)) continue;
        if (n.kind === 'folder') {
          const isOpen = open[n.id] ?? !!f;
          out.push({ t: 'folder', key: n.id, c, n, depth, open: isOpen });
          if (isOpen) addNodes(c, n.items, depth + 1, scope);
          continue;
        }
        out.push({ t: 'req', key: n.id, c, n, depth });
        if (n.kind === 'http' && n.examples?.length && open[`${n.id}:examples`]) for (const ex of n.examples) out.push({ t: 'example', key: `${n.id}:ex:${ex.id}`, c, n, ex, depth });
      }
    };
    const addExtra = (g: ExtraGroup, depth: number, from?: string) => {
      const shown = g.items.filter(extraShown);
      const folders = [...new Set(shown.map((i) => i.folder ?? ''))].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
      for (const folder of folders) {
        // a folder of saved gRPC calls / connections: the same row as a collection's folders
        const key = `${from ?? ''}:${g.cat}:folder:${folder}`;
        const isOpen = !!f || (open[key] ?? true);
        const inside = shown.filter((i) => (i.folder ?? '') === folder);
        if (folder) out.push({ t: 'xfolder', key, folder, count: inside.length, open: isOpen, depth });
        if (isOpen || !folder) for (const i of inside) out.push({ t: 'xitem', key: `${from ?? ''}:${g.cat}:${i.id}`, g, i, depth: depth + (folder ? 1 : 0), from });
      }
    };
    /** A collection's contents: grouped by category when it holds more than one kind of request. */
    const addContents = (c: Collection, extras: ExtraGroup[]) => {
      if (!categorize) return addNodes(c, c.items, 1);
      const cats = (['rest', 'soap', 'graphql'] as const).filter((k) => hasCategory(c.items, k));
      if (!cats.length && c.items.some(isEmptyFolder)) cats.push('rest');
      // the category level shows even for one kind, so every collection reads the same way
      if (!cats.length && !extras.length) {
        addNodes(c, c.items, 1);
        return;
      }
      cats.forEach((cat, i) => {
        const key = `${c.id}:cat:${cat}`;
        const isOpen = !!f || (open[key] ?? true);
        const scope = { cat, first: i === 0 };
        if (f && !c.items.some((n) => matches(n) && inScope(n, scope))) return;
        out.push({ t: 'cat', key, c, cat, count: countCategory(c.items, cat), open: isOpen });
        if (isOpen) addNodes(c, c.items, 2, scope);
      });
      for (const g of extras) {
        const key = `${c.id}:cat:${g.cat}`;
        const isOpen = !!f || (open[key] ?? true);
        if (f && !g.items.some(extraShown)) continue;
        out.push({ t: 'cat', key, c, cat: g.cat, count: g.items.length, open: isOpen });
        if (isOpen) addExtra(g, 2, c.id);
      }
    };
    for (const c of collections) {
      const extras = (extraGroups?.(c) ?? []).filter((g) => g.items.length);
      // grouped by category, collections start folded: the workspace lists them, expanding shows the categories
      // a collection opens when the user opens it (or something is revealed in it), not because its request is open
      const isOpen = categorize && f ? true : (open[c.id] ?? !categorize);
      if (categorize && f && !c.items.some(matches) && !extras.some((g) => g.items.some(extraShown))) continue;
      out.push({ t: 'col', key: c.id, c, open: isOpen });
      if (!isOpen) continue;
      addContents(c, extras);
      if (!f && !favoritesOnly && !c.problem && !c.items.length && !extras.length) out.push({ t: 'empty', key: `${c.id}:empty`, c });
    }
    return out;
  }, [collections, open, filter, f, favoritesOnly, categorize, extraGroups]);
  // nothing to show for the filter (or no favourites): say so
  const nothingMatches = useMemo(() => {
    if (!f && !favoritesOnly) return false;
    const extraShown = (i: ExtraGroup['items'][number]) => !f || i.name.toLowerCase().includes(f) || !!i.folder?.toLowerCase().includes(f);
    return !collections.some((c) => c.items.some((n) => matchesCollectionNode(n, filter, favoritesOnly)) || (categorize && (extraGroups?.(c) ?? []).some((g) => g.items.some(extraShown))));
  }, [collections, filter, f, favoritesOnly, categorize, extraGroups]);

  // reveal the open request: when something was opened (search, history, a link), open its collection, category and
  // folders, even ones folded by hand, and scroll its row into view. Switching or closing tabs leaves the tree as it is.
  const lastReveal = useRef(revealKey);
  const [reveal, setReveal] = useState<{ id: string; nonce: number }>();
  useEffect(() => {
    if (!activeRequestId) return;
    const opened = revealKey !== lastReveal.current;
    lastReveal.current = revealKey;
    if (!opened) return;
    for (const c of collections) {
      const folders = folderIdsTo(c.items, activeRequestId);
      if (!folders) continue;
      const node = findNode(c.items, activeRequestId);
      const cat = node ? requestCategory(node) : undefined;
      const keys = [c.id, ...(cat && categorize ? [`${c.id}:cat:${cat}`] : []), ...folders];
      setOpen((o) => (keys.every((k) => o[k] !== false) ? o : { ...o, ...Object.fromEntries(keys.map((k) => [k, true])) }));
      break;
    }
    setReveal({ id: activeRequestId, nonce: revealKey ?? 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRequestId, revealKey]);
  // the row to scroll to, once the folders on its way are open
  const revealIndex = useMemo(() => (reveal ? rows.findIndex((r) => r.t === 'req' && r.n.id === reveal.id) : -1), [reveal, rows]);
  // done once it scrolled (the list scrolls in its own effect, which runs first): later changes leave the scroll alone
  useEffect(() => {
    if (revealIndex >= 0) setReveal(undefined);
  }, [revealIndex]);

  // What a request row needs from here, through one ref that is always current: rows are memoized, and their
  // handlers read these at event time, so they are never stale
  const ctx = useRef<RowContext>(null!);
  ctx.current = {
    onOpen,
    change,
    toggle,
    rowKeys,
    dragProps,
    dropProps,
    finishRename,
    renameNode,
    deleteNode,
    copyMenu,
    setMenuFor,
    setMoving,
    setHistoryFor,
  };
  const canHistory = !!git.status?.repository;
  const rowHeight = 2 * useApp((s) => s.settings?.fontSize ?? 14);

  const folderRow = (r: Extract<TreeRow, { t: 'folder' }>) => {
    const { c, n, depth, open: isOpen } = r;
    return (
      <div
        className={cx('group flex items-center h-8 text-sm rounded-md mx-1 hover:bg-hover pr-1 transition-colors', menuFor === n.id && 'bg-hover', dropClass(n.id))}
        style={{ paddingLeft: 8 + depth * 12 }}
        {...dragProps(c, n)}
        {...dropProps(c, n.id, 'into', { folderId: n.id })}
        draggable={renaming === n.id ? false : undefined}
        onContextMenu={(e) => (e.preventDefault(), setMenuFor(n.id))}
      >
        {renaming === n.id ? (
          <div className="flex items-center gap-1 flex-1 min-w-0">
            {isOpen ? OPEN_ICON : CLOSED_ICON}
            {FOLDER_ICON}
            <InlineRename value={n.name} label="Folder name" onCommit={(name) => finishRename(c, n.id, name)} onCancel={() => finishRename(c, n.id)} />
          </div>
        ) : (
          <button
            className="flex items-center gap-1 flex-1 min-w-0 text-left"
            onClick={() => toggle(n.id, isOpen)}
            onKeyDown={rowKeys(c, n)}
            data-tree-row
            data-rename-id={n.id}
            aria-expanded={isOpen}
            title="F2 renames · Delete deletes"
          >
            {isOpen ? OPEN_ICON : CLOSED_ICON}
            {FOLDER_ICON}
            <span className="truncate">{n.name}</span>
            {(n.preRequestScript || n.testScript || n.variables?.length || (n as { logic?: true }).logic) && <span className="w-1.5 h-1.5 rounded-full bg-accent/70 shrink-0" title="Has folder scripts or variables" />}
            <span className="ml-auto pl-1">
              <CountPill n={requestCount(n.items)} />
            </span>
          </button>
        )}
        <NodeMenu
          open={menuFor === n.id}
          onOpenChange={(o) => setMenuFor(o ? n.id : undefined)}
          onEdit={() => void fullCollection(c).then((whole) => setEditing({ c: whole, folder: wholeNode(whole, n) }), toastError)}
          onExpandAll={() => setSubtree(c, n, true)}
          onCollapseAll={() => setSubtree(c, n, false)}
          onMove={() => setMoving({ c, n })}
          onRename={() => void renameNode(c, n)}
          onDuplicate={() => change(c, (c) => ({ ...c, items: duplicateNode(c.items, n.id, (x) => ({ ...withNewIds(x), name: `${x.name} copy` })) }))}
          onDelete={() => void deleteNode(c, n)}
          onNewRequest={() => newRequest(c, n.id)}
          newRequestLabel={newRequestLabel}
          onRun={onRun && (() => onRun(c, n.id))}
          runLabel="Run folder"
          onMonitor={() => useApp.getState().openIntent('monitors', { create: { collectionId: c.id, selection: [n.id] } })}
          onNewFolder={async () => {
            const name = await promptText('New folder', { message: 'Folder name', okLabel: 'Create' });
            if (name) change(c, (c) => ({ ...c, items: addToFolder(c.items, n.id, { kind: 'folder', id: uid('fld-'), name, items: [] } as CollectionFolder) }));
          }}
        />
      </div>
    );
  };

  const categoryRow = (r: Extract<TreeRow, { t: 'cat' }>) => {
    const { c, cat, count, key, open: isOpen } = r;
    // the same menu as every other row (right-click or ⋯): create here, run the collection, fold
    const items = (): MenuItem[] => [
      ...(onNewOfCategory ? [{ label: newRequestOf(cat), icon: <FilePlus2 size={14} />, onSelect: () => onNewOfCategory(c, cat) }] : []),
      ...(onRun ? [{ label: 'Run collection', icon: <Play size={14} />, onSelect: () => onRun(c) }] : []),
      { label: isOpen ? 'Collapse' : 'Expand', icon: isOpen ? <ChevronRight size={14} /> : <ChevronDown size={14} />, separator: true, onSelect: () => toggle(key, isOpen) },
    ];
    return (
      <div
        className={cx('group flex items-center h-8 text-sm rounded-md mx-1 pr-1 transition-colors', menuFor === key ? 'bg-hover' : 'hover:bg-hover')}
        style={{ paddingLeft: 20 }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuFor(key);
        }}
        {...(cat === 'rest' || cat === 'soap' || cat === 'graphql' ? dropProps(c, `${c.id}:${cat}`, 'into', {}) : {})}
      >
        <button className="flex items-center gap-1.5 flex-1 min-w-0 text-left" onClick={() => toggle(key, isOpen)} aria-expanded={isOpen} data-tree-row>
          {isOpen ? OPEN_ICON : CLOSED_ICON}
          <TreeBadge label={CATEGORY_META[cat].badge} className={CATEGORY_META[cat].cls} />
          <span className="truncate font-medium">{CATEGORY_META[cat].label}</span>
          <span className="text-[0.7rem] px-1.5 rounded-full bg-panel2 text-muted tabular-nums">{count}</span>
        </button>
        <Menu
          width={230}
          open={menuFor === key}
          onOpenChange={(o) => setMenuFor(o ? key : undefined)}
          items={menuFor === key ? items() : []}
          trigger={
            <button aria-label={`More actions for ${CATEGORY_META[cat].label}`} className={rowActionClass()}>
              {MORE_ICON}
            </button>
          }
        />
      </div>
    );
  };

  /** A folder of saved gRPC calls / connections: the same row as a collection's folders. */
  const extraFolderRow = (r: Extract<TreeRow, { t: 'xfolder' }>) => (
    <div className="group flex items-center h-8 text-sm rounded-md mx-1 hover:bg-hover pr-1 transition-colors" style={{ paddingLeft: 8 + r.depth * 12 }}>
      <button className="flex items-center gap-1 flex-1 min-w-0 text-left" onClick={() => toggle(r.key, r.open)} aria-expanded={r.open} data-tree-row>
        {r.open ? OPEN_ICON : CLOSED_ICON}
        {FOLDER_ICON}
        <span className="truncate">{r.folder}</span>
        <span className="ml-auto pl-1">
          <CountPill n={r.count} />
        </span>
      </button>
    </div>
  );

  /** A saved gRPC call or connection. */
  const extraItemRow = (r: Extract<TreeRow, { t: 'xitem' }>) => {
    const { g, i, depth, from } = r;
    const rn = g.rename?.(i.id);
    return (
      <div
        {...(onDropSaved && !rn?.editing ? savedItemDragProps(g.cat, i.id, i.name, from) : {})}
        onDragEnd={() => setDropAt(undefined)}
        className={cx('group flex items-center h-8 text-sm pr-1 rounded-md mx-1 transition-colors', activeRequestId === i.id ? 'bg-accent-soft text-fg' : menuFor === i.id ? 'bg-hover' : 'hover:bg-hover')}
        style={{ paddingLeft: 8 + depth * 12 }}
        onContextMenu={(e) => {
          if (!g.menu) return;
          e.preventDefault();
          setMenuFor(i.id);
        }}
      >
        {rn?.editing ? (
          <div className="flex items-center gap-1.5 flex-1 min-w-0 pl-4">
            <TreeBadge label={i.badge ?? CATEGORY_META[g.cat].badge} className={CATEGORY_META[g.cat].cls} />
            <InlineRename value={i.name} onCommit={(name) => rn.done(name)} onCancel={() => rn.done()} />
          </div>
        ) : (
          <button
            className="flex items-center gap-1.5 flex-1 min-w-0 text-left pl-4"
            onClick={() => g.onOpen(i.id)}
            onKeyDown={(e) => {
              if (e.key === 'F2' && rn) {
                e.preventDefault();
                return rn.start();
              }
              if (g.menu) menuKeys(g.menu(i.id))?.(e);
            }}
            title={i.name}
            data-tree-row
            data-rename-id={i.id}
          >
            <TreeBadge label={i.badge ?? CATEGORY_META[g.cat].badge} className={CATEGORY_META[g.cat].cls} />
            <span className="truncate">{i.name}</span>
          </button>
        )}
        {g.menu && (
          <Menu
            width={230}
            open={menuFor === i.id}
            onOpenChange={(o) => setMenuFor(o ? i.id : undefined)}
            trigger={
              <button aria-label={`More actions for ${i.name}`} className={rowActionClass()}>
                {MORE_ICON}
              </button>
            }
            items={menuFor === i.id ? g.menu(i.id) : []}
          />
        )}
      </div>
    );
  };

  const collectionRow = (r: Extract<TreeRow, { t: 'col' }>) => {
    const { c, open: isOpen } = r;
    return (
      <div
        className={cx('group flex items-center gap-0.5 h-8 rounded-md mx-1 hover:bg-hover pr-1 pl-1.5 transition-colors', menuFor === c.id && 'bg-hover', dropClass(c.id))}
        {...collectionDropProps(c)}
        onContextMenu={(e) => {
          if (c.problem) return;
          e.preventDefault();
          setMenuFor(c.id);
        }}
      >
        {renaming === c.id ? (
          <div className="flex items-center gap-1 flex-1 min-w-0 font-medium">
            {isOpen ? OPEN_ICON : CLOSED_ICON}
            <InlineRename value={c.name} label="Collection name" onCommit={(name) => finishRename(c, c.id, name)} onCancel={() => finishRename(c, c.id)} />
          </div>
        ) : (
          <button
            className="flex items-center gap-1 flex-1 min-w-0 text-left font-medium"
            onClick={() => toggle(c.id, isOpen)}
            onKeyDown={(e) => {
              if (e.key === 'F2' && !c.problem) {
                e.preventDefault();
                setRenaming(c.id);
              }
            }}
            aria-expanded={isOpen}
            data-tree-row
            data-rename-id={c.id}
            title={c.problem ? undefined : 'F2 renames'}
          >
            {isOpen ? OPEN_ICON : CLOSED_ICON}
            <span className={cx('truncate', c.problem && 'text-bad')} title={c.problem}>
              {c.name}
            </span>
            {health[c.id]?.failing ? (
              <span className="shrink-0 text-[0.65rem] font-semibold px-1 rounded bg-bad/15 text-bad" title={`${health[c.id]!.failing} of ${health[c.id]!.sent} sent requests: the latest response failed`}>
                {health[c.id]!.failing}
              </span>
            ) : null}
            {/* two collections with one name (an import done twice): their ids tell them apart */}
            {collections.some((x) => x !== c && x.name === c.name) && (
              <span className="text-[0.7rem] text-muted font-normal mono truncate shrink-0 max-w-[40%]" title="Another collection has this name; this is its id">
                {c.id}
              </span>
            )}
          </button>
        )}
        {!c.problem && (
          <NodeMenu
            label={c.name}
            open={menuFor === c.id}
            onOpenChange={(o) => setMenuFor(o ? c.id : undefined)}
            onRename={() => setRenaming(c.id)}
            onExpandAll={() => setSubtree(c, undefined, true)}
            onCollapseAll={() => setSubtree(c, undefined, false)}
            onDuplicate={() => void duplicateCollection(c)}
            onDelete={() => void deleteCollection(c)}
            onHistory={canHistory ? () => setHistoryFor({ c }) : undefined}
            otherNew={
              onNewOfCategory ? (['graphql', 'soap', 'grpc', 'websocket'] as const).map((cat) => ({ label: newRequestOf(cat), icon: <FilePlus2 size={14} />, onSelect: () => onNewOfCategory(c, cat) })) : undefined
            }
            runItems={[{ label: 'Run in CI…', icon: <Workflow size={14} />, onSelect: () => useApp.getState().set({ ci: { collection: c.id } }) }]}
            configItems={[
              ...(onSettings ? [{ label: 'Settings, runner & docs', icon: <Settings2 size={14} />, onSelect: () => onSettings(c) }] : []),
              { label: 'Convert scripts to tp.*', icon: <Wand2 size={14} />, onSelect: () => void convertScripts(c, 'tp') },
              { label: 'Convert scripts to pm.*', icon: <Undo2 size={14} />, onSelect: () => void convertScripts(c, 'pm') },
            ]}
            onNewRequest={() => newRequest(c)}
            newRequestLabel={newRequestLabel}
            onRun={onRun && (() => onRun(c))}
            runLabel="Run collection"
            onMonitor={() => useApp.getState().openIntent('monitors', { create: { collectionId: c.id } })}
            onNewFolder={async () => {
              const name = await promptText('New folder', { message: 'Folder name', okLabel: 'Create' });
              if (name) change(c, (c) => ({ ...c, items: [...c.items, { kind: 'folder', id: uid('fld-'), name, items: [] }] }));
            }}
          />
        )}
      </div>
    );
  };

  const renderRow = (r: TreeRow) => {
    switch (r.t) {
      case 'col':
        return collectionRow(r);
      case 'cat':
        return categoryRow(r);
      case 'folder':
        return folderRow(r);
      case 'xfolder':
        return extraFolderRow(r);
      case 'xitem':
        return extraItemRow(r);
      case 'req':
        return (
          <RequestRow
            c={r.c}
            n={r.n}
            depth={r.depth}
            active={activeRequestId === r.n.id}
            menuOpen={menuFor === r.n.id}
            renaming={renaming === r.n.id}
            examplesOpen={!!open[`${r.n.id}:examples`]}
            dropMode={dropAt?.id === r.n.id ? dropAt.mode : undefined}
            gitMark={git.items.get(r.n.id)}
            canHistory={canHistory}
            ctx={ctx}
          />
        );
      case 'example':
        return (
          <button
            className="w-full flex items-center gap-2 h-8 text-xs rounded-md mx-1 pr-2 hover:bg-hover text-left text-muted hover:text-fg"
            style={{ paddingLeft: 8 + r.depth * 12 + 28 }}
            title="Saved example: opens the request (see its Examples tab)"
            onClick={() => onOpen(r.c, r.n)}
          >
            <span className={cx('mono font-bold w-9 shrink-0', r.ex.status < 300 ? 'text-ok' : r.ex.status < 400 ? 'text-warn' : 'text-bad')}>{r.ex.status}</span>
            <span className="truncate">{r.ex.name}</span>
          </button>
        );
      case 'empty':
        return (
          <div className="pl-7 pr-3 h-8 flex items-center gap-2">
            <p className="text-xs text-muted truncate">No requests yet.</p>
            <Button size="sm" icon={<Plus size={12} />} onClick={() => newRequest(r.c)}>
              {newRequestLabel ?? 'New HTTP request'}
            </Button>
          </div>
        );
    }
  };

  return (
    <div className="text-sm" data-tree-rows={rows.length}>
      {editing && (
        <FolderEditor
          folder={editing.folder}
          onClose={() => setEditing(undefined)}
          onSave={(folder) => onChange({ ...editing.c, items: mapNodes(editing.c.items, (x) => (x.id === folder.id && x.kind === 'folder' ? { ...folder, items: x.items } : x)) })}
        />
      )}
      {historyFor && <GitItemHistory target={{ collectionId: historyFor.c.id, itemId: historyFor.n?.id }} name={historyFor.n?.name ?? historyFor.c.name} onClose={() => setHistoryFor(undefined)} />}
      {moving && <MoveDialog node={moving.n} from={moving.c} collections={collections} onClose={() => setMoving(undefined)} onMove={(to, folderId) => move(moving.c, moving.n, to, folderId)} />}
      <VirtualList
        items={rows}
        rowHeight={rowHeight}
        keyOf={rowKey}
        render={renderRow}
        scrollParent
        overscan={rows.length <= DRAW_ALL ? DRAW_ALL : OVERSCAN}
        scrollToIndex={revealIndex >= 0 ? revealIndex : undefined}
        scrollKey={reveal?.nonce}
      />
      {nothingMatches && (
        <p className="px-3 py-4 text-sm text-muted text-center">
          {favoritesOnly ? 'No favorite requests yet. Use a request’s menu to add one.' : f ? 'No requests match this filter.' : 'No requests in these collections yet.'}
        </p>
      )}
    </div>
  );
});

const rowKey = (r: TreeRow) => `${r.t}:${r.key}`;

interface RowContext {
  onOpen(c: Collection, n: CollectionNode): void;
  change(c: Collection, f: (whole: Collection) => Collection | undefined): void;
  toggle(id: string, shown: boolean): void;
  rowKeys(c: Collection, n: CollectionNode): (e: React.KeyboardEvent) => void;
  dragProps(c: Collection, n: CollectionNode): Record<string, unknown>;
  dropProps(
    c: Collection,
    id: string,
    mode: 'before' | 'into',
    place: { beforeId?: string; folderId?: string },
  ): { onDragOver(e: React.DragEvent): void; onDragLeave(): void; onDrop(e: React.DragEvent): void };
  finishRename(c: Collection, id: string, name?: string): void;
  renameNode(c: Collection, n: CollectionNode): void;
  deleteNode(c: Collection, n: CollectionNode): Promise<void>;
  copyMenu(c: Collection, n: SavedHttpRequest): MenuItem[];
  setMenuFor(id: string | undefined): void;
  setMoving(m: { c: Collection; n: CollectionNode } | undefined): void;
  setHistoryFor(h: { c: Collection; n?: CollectionNode } | undefined): void;
}

/**
 * One request of the tree. Memoized: a tab switch or a keystroke in the filter re-renders only the rows whose own
 * state changed (active, menu, rename, drop target, git mark). Everything it calls comes through `ctx`, which the
 * tree keeps current. Its saved examples are rows of their own (under it, while open).
 */
const RequestRow = memo(function RequestRow({
  c,
  n,
  depth,
  active,
  menuOpen,
  renaming,
  examplesOpen,
  dropMode,
  gitMark,
  canHistory,
  ctx,
}: {
  c: Collection;
  n: Exclude<CollectionNode, CollectionFolder>;
  depth: number;
  active: boolean;
  menuOpen: boolean;
  renaming: boolean;
  examplesOpen: boolean;
  dropMode?: 'before' | 'into';
  gitMark?: string;
  canHistory: boolean;
  ctx: React.RefObject<RowContext>;
}) {
  const x = () => ctx.current;
  const method = n.kind === 'http' ? n.request.method : 'GQL';
  const examples = n.kind === 'http' ? (n.examples ?? []) : [];
  const exKey = `${n.id}:examples`;
  const dragOf = () => x().dragProps(c, n) as { onDragStart(e: React.DragEvent): void; onDragEnd(): void };
  const dropOf = () => x().dropProps(c, n.id, 'before', { beforeId: n.id });
  return (
    <div
      data-node-id={n.id}
      className={cx(
        'group flex items-center h-8 text-sm pr-1 rounded-md mx-1 transition-colors',
        active ? 'bg-accent-soft text-fg' : 'hover:bg-hover',
        menuOpen && 'bg-hover',
        dropMode === 'into' ? 'ring-1 ring-inset ring-accent bg-accent/10' : dropMode === 'before' ? 'shadow-[inset_0_2px_0_var(--accent)]' : undefined,
      )}
      style={{ paddingLeft: 8 + depth * 12 }}
      draggable={renaming ? false : true}
      onDragStart={(e) => dragOf().onDragStart(e)}
      onDragEnd={() => dragOf().onDragEnd()}
      onDragOver={(e) => dropOf().onDragOver(e)}
      onDragLeave={() => dropOf().onDragLeave()}
      onDrop={(e) => dropOf().onDrop(e)}
      onContextMenu={(e) => {
        e.preventDefault();
        x().setMenuFor(n.id);
      }}
    >
      {examples.length > 0 && (
        <button
          className="shrink-0 -mr-3.5 w-3.5 text-muted hover:text-fg"
          aria-label={examplesOpen ? 'Hide examples' : `Show ${examples.length} examples`}
          aria-expanded={examplesOpen}
          onClick={() => x().toggle(exKey, examplesOpen)}
        >
          {examplesOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
      )}
      {renaming ? (
        <div className="flex items-center gap-1.5 flex-1 min-w-0 pl-4">
          <TreeBadge label={method} className={n.kind === 'http' ? `method-${method}` : 'text-[#e535ab]'} />
          <InlineRename value={n.name} label="Request name" onCommit={(name) => x().finishRename(c, n.id, name)} onCancel={() => x().finishRename(c, n.id)} />
        </div>
      ) : (
        <button
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left pl-4"
          onClick={() => x().onOpen(c, n)}
          onKeyDown={(e) => x().rowKeys(c, n)(e)}
          data-tree-row
          data-rename-id={n.id}
          title="Enter opens · F2 renames · Delete deletes"
        >
          <TreeBadge label={method} className={n.kind === 'http' ? `method-${method}` : 'text-[#e535ab]'} />
          <span className="truncate">{n.name}</span>
          {n.favorite && <Star size={11} className="shrink-0 text-warn fill-current" aria-label="Favorite" data-favorite />}
          {gitMark && <ChangeMark change={gitMark} className="ml-auto" />}
        </button>
      )}
      <NodeMenu
        open={menuOpen}
        onOpenChange={(o) => x().setMenuFor(o ? n.id : undefined)}
        onOpen={() => x().onOpen(c, n)}
        copyItems={menuOpen && n.kind === 'http' ? x().copyMenu(c, n) : undefined}
        onRename={() => void x().renameNode(c, n)}
        onDelete={() => void x().deleteNode(c, n)}
        onDuplicate={() => x().change(c, (c) => ({ ...c, items: duplicateNode(c.items, n.id, (y) => ({ ...y, id: uid('req-'), name: `${y.name} copy` })) }))}
        onMove={() => x().setMoving({ c, n })}
        onToggleFavorite={() => x().change(c, (c) => ({ ...c, items: mapNodes(c.items, (y) => (y.id === n.id && y.kind !== 'folder' ? { ...y, favorite: !y.favorite } : y)) }))}
        favorite={!!n.favorite}
        onHistory={canHistory ? () => x().setHistoryFor({ c, n }) : undefined}
      />
    </div>
  );
});

function NodeMenu({
  onEdit,
  onRename,
  onDelete,
  onNewRequest,
  onNewFolder,
  onDuplicate,
  onMove,
  onToggleFavorite,
  favorite,
  onHistory,
  onRun,
  runLabel = 'Run',
  onMonitor,
  onExpandAll,
  onCollapseAll,
  onOpen,
  copyItems,
  otherNew,
  runItems,
  configItems,
  open,
  onOpenChange,
  newRequestLabel = 'New HTTP request',
  header,
  label,
}: {
  newRequestLabel?: string;
  /** On a header row (a collection): the button stays faintly visible, like the + beside it. */
  header?: boolean;
  /** What the menu is for (named on the button). */
  label?: string;
  onEdit?(): void;
  onRename?(): void;
  onDelete?(): void;
  onNewRequest?(): void;
  onNewFolder?(): void;
  onDuplicate?(): void;
  /** Move to another folder or collection. */
  onMove?(): void;
  onToggleFavorite?(): void;
  favorite?: boolean;
  /** Its versions in git (when the workspace is in git). */
  onHistory?(): void;
  onRun?(): void;
  runLabel?: string;
  /** Expand / collapse everything inside it (collections and folders). */
  onExpandAll?(): void;
  onCollapseAll?(): void;
  /** Run it on a schedule (opens Monitors with a new monitor). */
  onMonitor?(): void;
  /** Open the request (in a tab). */
  onOpen?(): void;
  /** Copy URL / Copy as cURL … (requests only). */
  copyItems?: MenuItem[];
  /** The other kinds of request it can create (after the first New item). */
  otherNew?: MenuItem[];
  /** More ways to run it (after Run and Monitor). */
  runItems?: MenuItem[];
  /** Its settings and tools (after Edit folder). */
  configItems?: MenuItem[];
  /** Controlled open state, so a right-click on the row can open the menu. */
  open?: boolean;
  onOpenChange?(open: boolean): void;
}) {
  // a row's menu is built only while it is open: a tree of hundreds of rows renders hundreds of these
  const [own, setOwn] = useState(false);
  const isOpen = open ?? own;
  const setOpen = (v: boolean) => (open === undefined ? setOwn(v) : onOpenChange?.(v));
  const build = (): MenuItem[] => {
    // groups, each after a separator, in one order for every row: create (first: this menu is also the row's only
    // button) · open · run · configure · copy · organize · delete
    const groups: MenuItem[][] = [];
    const group = (...g: Array<MenuItem | undefined>) => groups.push(g.filter((x): x is MenuItem => !!x));
    const item = (label: string, icon: React.ReactNode, fn?: () => void, extra: Partial<MenuItem> = {}): MenuItem | undefined => (fn ? { label, icon, onSelect: fn, ...extra } : undefined);
    group(item(newRequestLabel, <FilePlus2 size={14} />, onNewRequest), ...(otherNew ?? []), item('New folder', <FolderPlus size={14} />, onNewFolder));
    group(item('Open in tab', <ExternalLink size={14} />, onOpen), item('History in git…', <History size={14} />, onHistory));
    group(item('Expand all', <ChevronsUpDown size={14} />, onExpandAll), item('Collapse all', <ChevronsDownUp size={14} />, onCollapseAll));
    group(item(runLabel, <Play size={14} />, onRun), item('Monitor on a schedule…', <AlarmClock size={14} />, onMonitor), ...(runItems ?? []));
    group(item('Edit folder (scripts, variables, auth)', <FolderCog size={14} />, onEdit), ...(configItems ?? []));
    group(...(copyItems ?? []));
    group(
      item('Rename', <Pencil size={14} />, onRename),
      item('Duplicate', <CopyPlus size={14} />, onDuplicate),
      item('Move to…', <FolderInput size={14} />, onMove),
      item(favorite ? 'Remove from favorites' : 'Add to favorites', <Star size={14} />, onToggleFavorite),
    );
    group(item('Delete', <Trash2 size={14} />, onDelete, { danger: true }));
    return groups.filter((g) => g.length).flatMap((g, i) => g.map((it, j) => (i > 0 && j === 0 ? { ...it, separator: true } : it)));
  };
  return (
    <Menu
      items={isOpen ? build() : []}
      width={230}
      open={isOpen}
      onOpenChange={setOpen}
      trigger={
        <button aria-label={label ? `More actions for ${label}` : 'More actions'} className={rowActionClass(header)}>
          <MoreHorizontal size={14} />
        </button>
      }
    />
  );
}
