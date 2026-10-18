import { startFlowGenerate } from './ai/flow-generate';
import { Plus, ChevronDown, ChevronRight, Download, FilePlus2, Star, Undo2 } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { Collection, CollectionFolder, CollectionNode } from '../types';
import { asError, call, on } from '../api';
import { Button, cx, menuKeys, VirtualList } from './ui';
import { CLOSED_ICON, CountPill, focusRow, FOLDER_ICON, InlineRename, OPEN_ICON, NodeMenu } from './TreeParts';
import { buildNodeMenu, type NodeMenuCtx } from '../lib/node-menu';
import { LABEL } from '../lib/vocabulary';
import { confirmAction, promptText, toastError, useApp } from '../store';
import { deleteWithUndo, restoreDeleted } from '../lib/undo-delete';
import { MoveDialog, subtreeIds } from './MoveDialog';
import { closeTabsFor } from './EditorTabs';
import { plural, uid } from '../lib/format';
import { FolderEditor } from './FolderEditor';
import { ChangeMark } from './ChangeMark';
import { GitItemHistory } from './GitItemHistory';
import { useGit } from '../lib/git';
import { fullCollection } from '../lib/collections-store';
import { matchesCollectionNode, requestCategory, type RequestCategory } from '../lib/collection-filter';

// the tree's data operations live in lib/collection-nodes (re-exported: views import them from here)
export { mapNodes, findNode, addToFolder, insertBefore, folderIdsTo, withNewIds, duplicateNode } from '../lib/collection-nodes';
import { mapNodes, findNode, addToFolder, insertBefore, folderIdsTo, withNewIds, duplicateNode, moveIntoCollection, nodeIdsExcept } from '../lib/collection-nodes';
import { useTreeOpen } from '../lib/tree-state';
import { requestCopyItems } from '../lib/request-copy';
import { saveAsTest } from '../lib/save-test';
import { openRef } from '../lib/open-ref';
import { deferDrop, setDragRefs, useDragSession } from '../lib/drag-ref';
import { savedItemRef } from '@testpion/shared';
import { buildTreeRows, examplesOpenKey, findTreeRow, folderOpenKey, isOpenKey, scopedNodeId, treeRowKey, type ExtraGroup, type TreeRow } from '../lib/tree-rows';

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

export type { ExtraGroup } from '../lib/tree-rows';

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
      setDragRefs(e, [savedItemRef(kind, id)], name);
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
  onExport,
  filter,
  favoritesOnly = false,
  onMoved,
  newRequestLabel,
  categorize = false,
  extraGroups,
  onNewOfCategory,
  onDropSaved,
  collapseAll,
  expandAll,
  revealKey,
  revealId,
}: {
  collections: Collection[];
  activeRequestId?: string;
  /** Open a request; `preview`: a single click (a preview tab, WF-19), double-click opens it for good. */
  onOpen(c: Collection, node: CollectionNode, o?: { preview?: boolean }): void;
  onChange(c: Collection): void;
  onNewRequest(c: Collection, folderId?: string): void;
  /** Open the Collection Runner for a collection or one of its folders. */
  onRun?(c: Collection, folderId?: string): void;
  /** Open a collection's settings (variables, auth, scripts, runner, docs, mock): shown in its menu. */
  onSettings?(c: Collection): void;
  /** Export a collection (the export dialog, with this collection chosen): Export ▸ in its menu. */
  onExport?(c: Collection): void;
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
  /** Changes (1, 2 …) unfold every collection, category and folder (the explorer's Expand all). */
  expandAll?: number;
  /** Changes whenever something is opened: the open request is revealed again (even if it was already open). */
  revealKey?: number;
  /** With revealKey: reveal this collection, folder, request or saved item instead of the open request. */
  revealId?: string;
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
    // rows carry their collection-scoped id (two collections may share node ids)
    focusRow(id === c.id ? id : scopedNodeId(c.id, id));
  };
  const health = useCollectionsHealth();
  const [moving, setMoving] = useState<{ c: Collection; n: CollectionNode }>();
  const [historyFor, setHistoryFor] = useState<{ c: Collection; n?: CollectionNode }>();
  const git = useGit();
  /** A copy of the collection with everything it holds (its gRPC calls and connections too). */
  const duplicateCollection = async (c: Collection) => {
    try {
      const copy = await call<Collection>('col.duplicate', { id: c.id });
      useApp.getState().toast(`Duplicated as "${copy.name}"`, 'success', { ref: { kind: 'collection', collectionId: copy.id } });
    } catch (e) {
      toastError(e);
    }
  };
  /** Move a collection to Recently deleted (restorable for 30 days); its tabs close; Undo in the message brings it back. */
  const deleteCollection = (c: Collection) =>
    deleteWithUndo({
      what: `the collection "${c.name}"`,
      run: async () => {
        closeTabsFor(c.items.flatMap(subtreeIds));
        await call('col.delete', { id: c.id });
      },
      undo: () => restoreDeleted('collection', c.id),
      note: 'Recently deleted keeps it for 30 days',
    });
  const renameNode = (c: Collection, n: CollectionNode) => setRenaming(scopedNodeId(c.id, n.id));
  /** Delete a request or folder at once, with Undo in the message (lib/undo.ts: puts the collection back as it was). */
  const deleteNode = async (c: Collection, n: CollectionNode) => removeWithUndo(c, n);
  /** F2 renames and Delete deletes the focused request or folder (like a file tree). */
  const rowKeys = (c: Collection, n: CollectionNode) => (e: React.KeyboardEvent) => {
    if (e.key === '*' && n.kind === 'folder') {
      e.preventDefault();
      setSubtree(c, n, true);
    } else if (e.key === 'F2') {
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
      useApp.getState().toast(`Deleted ${n.kind === 'folder' ? 'the folder' : 'the request'} "${n.name}"`, 'info', undefined, { undo: () => onChange(c), restored: `Restored ${n.kind === 'folder' ? 'the folder' : 'the request'} "${n.name}"` });
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
  /** A node arriving from another collection: fresh ids for those another collection already has (B-01). */
  const arriving = <T extends CollectionNode>(n: T, from: Collection, to: Collection) => {
    const r = moveIntoCollection(n, nodeIdsExcept([...collections.filter((x) => x.id !== to.id), to], from.id));
    // tabs of a request whose id changed close (they would name a request that is gone); the others follow it
    if (r.renamed.size) closeTabsFor([...r.renamed.keys()]);
    return { node: r.node, kept: subtreeIds(n).filter((id) => !r.renamed.has(id)) };
  };
  const drop = (to: Collection, place: { beforeId?: string; folderId?: string }) => {
    const d = drag;
    endDrag();
    if (!d || !canDrop(place)) return;
    // after the drop event: the drag loop has ended before anything re-renders or opens (menus-uniform P0-1)
    deferDrop(() =>
      void Promise.all([fullCollection(d.c), to.id === d.c.id ? undefined : fullCollection(to)]).then(([from, other]) => {
        const n = wholeNode(from, d.n);
        const without = mapNodes(from.items, (x) => (x.id === n.id ? null : x));
        const insert = (items: CollectionNode[], m: CollectionNode) => (place.beforeId ? insertBefore(items, place.beforeId, m) : addToFolder(items, place.folderId, m));
        if (!other) onChange({ ...from, items: insert(without, n) });
        else {
          const { node, kept } = arriving(n, from, other);
          onChange({ ...other, items: insert(other.items, node) });
          onChange({ ...from, items: without });
          onMoved?.(kept, from.id, other.id);
        }
      }, toastError),
    );
  };
  /** The drag of a row, set a frame after dragstart (the row must not re-render inside it), and cleared once. */
  const dragFrame = useRef<number | undefined>(undefined);
  const endDrag = () => {
    if (dragFrame.current !== undefined) cancelAnimationFrame(dragFrame.current);
    dragFrame.current = undefined;
    setDrag(undefined);
    setDropAt(undefined);
  };
  // the window ends every drag (drop anywhere, dragend on a row that is gone, Esc, a click, the window losing focus)
  useDragSession(endDrag);
  const dragProps = (c: Collection, n: CollectionNode) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.stopPropagation();
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', n.name);
      // the same item for any other drop target (a flow canvas adds it as a step, a folder as a chain of steps)
      setDragRefs(e, [n.kind === 'folder' ? { kind: 'folder', collectionId: c.id, folderId: n.id } : { kind: 'request', collectionId: c.id, requestId: n.id }], n.name);
      if (dragFrame.current !== undefined) cancelAnimationFrame(dragFrame.current);
      dragFrame.current = requestAnimationFrame(() => {
        dragFrame.current = undefined;
        setDrag({ c, n });
      });
    },
    onDragEnd: endDrag,
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
          if (d.from !== c.id) deferDrop(() => onDropSaved!(d.kind, d.id, c.id));
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
      const shownNode = wholeNode(from, shown);
      const to = other ?? from;
      const without = { ...from, items: mapNodes(from.items, (x) => (x.id === shownNode.id ? null : x)) };
      let n = shownNode;
      if (!other) onChange({ ...without, items: addToFolder(without.items, folderId, n) });
      else {
        const moved = arriving(shownNode, from, other);
        n = moved.node;
        // add to the new collection first: a failed save then leaves a copy rather than losing the request
        onChange({ ...other, items: addToFolder(other.items, folderId, n) });
        onChange(without);
        onMoved?.(moved.kept, from.id, to.id);
      }
      if (!other) onMoved?.(subtreeIds(n), from.id, to.id);
      useApp.getState().toast(`Moved "${n.name}" to ${to.name}${folderId ? ` › ${findNode(to.items, folderId)?.name ?? ''}` : ''}`, 'success', { ref: n.kind === 'folder' ? { kind: 'folder', collectionId: to.id, folderId: n.id } : { kind: 'request', collectionId: to.id, requestId: n.id } });
    }, toastError);
  };
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
  // which collections, categories and folders are open: the workspace's tree state (lib/tree-state)
  const [open, setOpen] = useTreeOpen('collections');
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
  useEffect(() => {
    if (!expandAll) return;
    for (const c of collections) setSubtree(c, undefined, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandAll]);
  /**
   * Expand or collapse everything inside a collection (its categories, folders and saved-item folders), or inside one
   * folder: the collection or folder itself opens or closes with it (a folder of requests only would otherwise not change).
   */
  const setSubtree = (c: Collection, folder: CollectionFolder | undefined, shown: boolean) => {
    const keys: string[] = [];
    const walk = (nodes: CollectionNode[]) => nodes.forEach((n) => n.kind === 'folder' && (keys.push(folderOpenKey(c.id, n.id)), walk(n.items)));
    walk(folder ? folder.items : c.items);
    if (!folder) {
      for (const cat of ['rest', 'soap', 'graphql', 'grpc', 'websocket'] as RequestCategory[]) keys.push(`${c.id}:cat:${cat}`);
      // folders of saved gRPC calls and connections, and anything else remembered under this collection
      for (const k of Object.keys(open)) if (k.startsWith(`${c.id}:`)) keys.push(k);
    }
    setOpen((o) => {
      return { ...o, ...Object.fromEntries(keys.map((k) => [k, shown])), [folder ? folderOpenKey(c.id, folder.id) : c.id]: shown };
    });
  };
  /** Open or close one protocol category of a collection, and every folder in the collection with it. */
  const setCategory = (c: Collection, key: string, shown: boolean) => {
    const keys: string[] = [key];
    const walk = (nodes: CollectionNode[]) => nodes.forEach((n) => n.kind === 'folder' && (keys.push(folderOpenKey(c.id, n.id)), walk(n.items)));
    walk(c.items);
    setOpen((o) => ({ ...o, ...Object.fromEntries(keys.map((k) => [k, shown])) }));
  };
  const newFolderIn = (c: Collection, folderId?: string) => async () => {
    const name = await promptText('New folder', { message: 'Folder name', okLabel: 'Create' });
    if (name) change(c, (c) => ({ ...c, items: addToFolder(c.items, folderId, { kind: 'folder', id: uid('fld-'), name, items: [] } as CollectionFolder) }));
  };
  /** A collection's menu: what this tree can do with it (lib/node-menu.ts decides which of these the menu shows, in which order). */
  const collectionMenu = (c: Collection): NodeMenuCtx => {
    const ref = { kind: 'collection' as const, collectionId: c.id };
    const others = onNewOfCategory ? (['graphql', 'soap', 'grpc', 'websocket'] as const).map((cat) => ({ label: newRequestOf(cat), icon: <FilePlus2 size={14} />, onSelect: () => onNewOfCategory(c, cat) })) : [];
    return {
      ref,
      name: c.name,
      repo: canHistory,
      // the other kinds of request fold into New request ▸ (the menu stays short)
      create: [{ label: newRequestLabel ?? 'New HTTP request', icon: <FilePlus2 size={14} />, onSelect: () => newRequest(c) }, ...(others.length ? [{ label: LABEL.newRequest, icon: <FilePlus2 size={14} />, onSelect: () => undefined, items: others }] : [])],
      on: {
        newFolder: newFolderIn(c),
        expandAll: () => setSubtree(c, undefined, true),
        collapseAll: () => setSubtree(c, undefined, false),
        ...(onRun ? { run: () => onRun(c) } : {}),
        // Export ▸ the export dialog, or the scripts as Postman's pm.* (TestPion itself writes tp.*)
        export: [
          ...(onExport ? [{ label: LABEL.export, icon: <Download size={14} />, onSelect: () => onExport(c) }] : []),
          { label: LABEL.forPostman, icon: <Undo2 size={14} />, onSelect: () => void convertScripts(c, 'pm') },
        ],
        monitor: () => useApp.getState().openIntent('monitors', { create: { collectionId: c.id } }),
        ci: () => useApp.getState().set({ ci: { collection: c.id } }),
        testFile: () => void saveAsTest({ ref, name: c.name }),
        flow: () => startFlowGenerate({ source: { collectionId: c.id }, mode: 'collection' }),
        ...(onSettings ? { collectionSettings: () => onSettings(c) } : {}),
        convertScripts: () => void convertScripts(c, 'tp'),
        historyInGit: () => setHistoryFor({ c }),
        rename: () => setRenaming(c.id),
        duplicate: () => void duplicateCollection(c),
        delete: () => void deleteCollection(c),
      },
    };
  };
  /** A folder's menu: the same groups as its collection's, for what is inside it. */
  const folderMenu = (c: Collection, n: CollectionFolder): NodeMenuCtx => {
    const ref = { kind: 'folder' as const, collectionId: c.id, folderId: n.id };
    return {
      ref,
      name: n.name,
      repo: canHistory,
      create: [{ label: newRequestLabel ?? 'New HTTP request', icon: <FilePlus2 size={14} />, onSelect: () => newRequest(c, n.id) }],
      on: {
        newFolder: newFolderIn(c, n.id),
        expandAll: () => setSubtree(c, n, true),
        collapseAll: () => setSubtree(c, n, false),
        ...(onRun ? { run: () => onRun(c, n.id) } : {}),
        monitor: () => useApp.getState().openIntent('monitors', { create: { collectionId: c.id, selection: [n.id] } }),
        ci: () => useApp.getState().set({ ci: { collection: c.id, folders: [n.id] } }),
        testFile: () => void saveAsTest({ ref, name: n.name }),
        flow: () => startFlowGenerate({ source: { collectionId: c.id, folderId: n.id }, mode: 'collection' }),
        editFolder: () => void fullCollection(c).then((whole) => setEditing({ c: whole, folder: wholeNode(whole, n) }), toastError),
        rename: () => void renameNode(c, n),
        duplicate: () => change(c, (c) => ({ ...c, items: duplicateNode(c.items, n.id, (x) => ({ ...withNewIds(x), name: `${x.name} copy` })) })),
        move: () => setMoving({ c, n }),
        delete: () => void deleteNode(c, n),
      },
    };
  };
  /** A request's menu. */
  const requestMenu = (c: Collection, n: Exclude<CollectionNode, CollectionFolder>): NodeMenuCtx => {
    const ref = { kind: 'request' as const, collectionId: c.id, requestId: n.id };
    return {
      ref,
      name: n.name,
      repo: canHistory,
      favorite: !!n.favorite,
      on: {
        open: () => onOpen(c, n),
        openNewTab: () => void openRef(ref, { newTab: true }),
        // Copy as ▸ the URL and the code forms (HTTP requests)
        ...(n.kind === 'http' ? { copyAs: requestCopyItems(c, n) } : {}),
        monitor: () => useApp.getState().openIntent('monitors', { create: { collectionId: c.id, selection: [n.id] } }),
        testFile: () => void saveAsTest({ ref, name: n.name }),
        historyInGit: () => setHistoryFor({ c, n }),
        rename: () => void renameNode(c, n),
        duplicate: () => change(c, (c) => ({ ...c, items: duplicateNode(c.items, n.id, (y) => ({ ...y, id: uid('req-'), name: `${y.name} copy` })) })),
        move: () => setMoving({ c, n }),
        favorite: () => change(c, (c) => ({ ...c, items: mapNodes(c.items, (y) => (y.id === n.id && y.kind !== 'folder' ? { ...y, favorite: !y.favorite } : y)) })),
        delete: () => void deleteNode(c, n),
      },
    };
  };
  const [editing, setEditing] = useState<{ c: Collection; folder: CollectionFolder }>();
  const f = filter?.toLowerCase();

  // every row that shows (the open collections, categories and folders), in order: a list of thousands is cheap to
  // build; only the rows on screen are drawn
  const rows = useMemo(() => buildTreeRows({ collections, open, filter, favoritesOnly, categorize, extraGroups }), [collections, open, filter, favoritesOnly, categorize, extraGroups]);
  // nothing to show for the filter (or no favourites): say so
  const nothingMatches = useMemo(() => {
    if (!f && !favoritesOnly) return false;
    const extraShown = (i: ExtraGroup['items'][number]) => !f || i.name.toLowerCase().includes(f) || !!i.folder?.toLowerCase().includes(f);
    return !collections.some((c) => c.items.some((n) => matchesCollectionNode(n, filter, favoritesOnly)) || (categorize && (extraGroups?.(c) ?? []).some((g) => g.items.some(extraShown))));
  }, [collections, filter, f, favoritesOnly, categorize, extraGroups]);

  // reveal the open request: when something was opened (search, history, a link), open its collection, category and
  // folders, even ones folded by hand, and scroll its row into view. Switching or closing tabs leaves the tree as it is.
  // (a target named before the tree mounted — Reveal in sidebar from another view — is revealed at once)
  const lastReveal = useRef(revealId ? undefined : revealKey);
  const [reveal, setReveal] = useState<{ id: string; nonce: number; collectionId?: string }>();
  useEffect(() => {
    const target = revealId ?? activeRequestId;
    if (!target) return;
    const opened = revealKey !== lastReveal.current;
    lastReveal.current = revealKey;
    if (!opened) return;
    for (const c of collections) {
      // the collection itself (a breadcrumb's first segment): open it
      const folders = c.id === target ? [] : folderIdsTo(c.items, target);
      if (!folders) continue;
      const node = c.id === target ? undefined : findNode(c.items, target);
      const cat = node && node.kind !== 'folder' ? requestCategory(node) : undefined;
      const keys = [c.id, ...(cat && categorize ? [`${c.id}:cat:${cat}`] : []), ...folders.map((id) => folderOpenKey(c.id, id))];
      setOpen((o) => (keys.every((k) => o[k] !== false) ? o : { ...o, ...Object.fromEntries(keys.map((k) => [k, true])) }));
      break;
    }
    setReveal({ id: target, nonce: revealKey ?? 0, collectionId: collections.find((c) => c.id === target || !!findNode(c.items, target))?.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRequestId, revealKey, revealId]);
  // the row to scroll to (a collection, folder, request or saved item), once the folders on its way are open
  const revealIndex = useMemo(
    () => (reveal ? findTreeRow(rows, reveal.id, reveal.collectionId) : -1),
    [reveal, rows],
  );
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
    requestMenu,
    setMenuFor,
    setMoving,
    setHistoryFor,
  };
  const canHistory = !!git.status?.repository;
  // the dragged row stays drawn while the list scrolls or changes under the drag (its dragend must reach React)
  const dragIndex = useMemo(() => (drag ? rows.findIndex((r) => (r.t === 'req' || r.t === 'folder') && r.c.id === drag.c.id && r.n.id === drag.n.id) : -1), [drag, rows]);
  const rowHeight = 2 * useApp((s) => s.settings?.fontSize ?? 14);

  const folderRow = (r: Extract<TreeRow, { t: 'folder' }>) => {
    const { c, n, depth, open: isOpen, key: sid } = r;
    const openKey = folderOpenKey(c.id, n.id);
    return (
      <div
        data-node-id={sid}
        className={cx('group flex items-center h-8 text-sm rounded-md mx-1 hover:bg-hover pr-1 transition-colors', menuFor === sid && 'bg-hover', dropClass(sid))}
        style={{ paddingLeft: 8 + depth * 12 }}
        {...dragProps(c, n)}
        {...dropProps(c, sid, 'into', { folderId: n.id })}
        // (after dragProps: undefined here would turn its draggable off, and a folder could not be dragged onto a flow)
        draggable={renaming !== sid}
        onContextMenu={(e) => (e.preventDefault(), setMenuFor(sid))}
      >
        {renaming === sid ? (
          <div className="flex items-center gap-1 flex-1 min-w-0">
            {isOpen ? OPEN_ICON : CLOSED_ICON}
            {FOLDER_ICON}
            <InlineRename value={n.name} label="Folder name" onCommit={(name) => finishRename(c, n.id, name)} onCancel={() => finishRename(c, n.id)} />
          </div>
        ) : (
          <button
            className="flex items-center gap-1 flex-1 min-w-0 text-left"
            onClick={() => toggle(openKey, isOpen)}
            onKeyDown={rowKeys(c, n)}
            data-tree-row
            data-rename-id={sid}
            data-row-name={n.name}
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
          kind="folder"
          label={`folder ${n.name}`}
          open={menuFor === sid}
          onOpenChange={(o) => setMenuFor(o ? sid : undefined)}
          ctx={() => folderMenu(c, n)}
        />
      </div>
    );
  };

  const categoryRow = (r: Extract<TreeRow, { t: 'cat' }>) => {
    const { c, cat, count, key, open: isOpen } = r;
    // the same menu as every other row (right-click or ⋯): create here, fold, run the collection
    const ctx = (): NodeMenuCtx => ({
      create: onNewOfCategory ? [{ label: newRequestOf(cat), icon: <FilePlus2 size={14} />, onSelect: () => onNewOfCategory(c, cat) }] : [],
      on: { expandAll: () => setCategory(c, key, true), collapseAll: () => setCategory(c, key, false), ...(onRun ? { run: () => onRun(c) } : {}) },
    });
    return (
      <div
        data-node-id={key}
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
        <NodeMenu kind="category" label={CATEGORY_META[cat].label} open={menuFor === key} onOpenChange={(o) => setMenuFor(o ? key : undefined)} ctx={ctx} />
      </div>
    );
  };

  /** A folder of saved gRPC calls / connections: the same row (and menu) as a collection's folders. */
  const extraFolderRow = (r: Extract<TreeRow, { t: 'xfolder' }>) => (
    <div
      data-node-id={r.key}
      className={cx('group flex items-center h-8 text-sm rounded-md mx-1 pr-1 transition-colors', menuFor === r.key ? 'bg-hover' : 'hover:bg-hover')}
      style={{ paddingLeft: 8 + r.depth * 12 }}
      onContextMenu={(e) => (e.preventDefault(), setMenuFor(r.key))}
    >
      <button className="flex items-center gap-1 flex-1 min-w-0 text-left" onClick={() => toggle(r.key, r.open)} aria-expanded={r.open} data-tree-row>
        {r.open ? OPEN_ICON : CLOSED_ICON}
        {FOLDER_ICON}
        <span className="truncate">{r.folder}</span>
        <span className="ml-auto pl-1">
          <CountPill n={r.count} />
        </span>
      </button>
      <NodeMenu
        kind={r.g.cat === 'websocket' ? 'folder:ws-connection' : 'folder:grpc-call'}
        label={`folder ${r.folder}`}
        open={menuFor === r.key}
        onOpenChange={(o) => setMenuFor(o ? r.key : undefined)}
        ctx={() => {
          const own = r.g.folderMenu?.(r.folder);
          return { ...own, on: { ...own?.on, expandAll: () => setOpen((o) => ({ ...o, [r.key]: true })), collapseAll: () => setOpen((o) => ({ ...o, [r.key]: false })) } };
        }}
      />
    </div>
  );

  /** A saved gRPC call or connection. */
  const extraItemRow = (r: Extract<TreeRow, { t: 'xitem' }>) => {
    const { g, i, depth, from } = r;
    const rn = g.rename?.(i.id);
    return (
      <div
        data-node-id={r.key}
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
              if (g.menu) menuKeys(buildNodeMenu(g.cat === 'grpc' ? 'grpc-call' : 'ws-connection', g.menu(i.id)))?.(e);
            }}
            title={i.name}
            data-tree-row
            data-rename-id={i.id}
            data-row-name={i.name}
          >
            <TreeBadge label={i.badge ?? CATEGORY_META[g.cat].badge} className={CATEGORY_META[g.cat].cls} />
            <span className="truncate">{i.name}</span>
          </button>
        )}
        {g.menu && <NodeMenu kind={g.cat === 'grpc' ? 'grpc-call' : 'ws-connection'} label={i.name} open={menuFor === i.id} onOpenChange={(o) => setMenuFor(o ? i.id : undefined)} ctx={() => g.menu!(i.id)} />}
      </div>
    );
  };

  const collectionRow = (r: Extract<TreeRow, { t: 'col' }>) => {
    const { c, open: isOpen } = r;
    return (
      <div
        data-node-id={r.key}
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
              if (c.problem) return;
              if (e.key === '*') {
                e.preventDefault();
                setSubtree(c, undefined, true);
              } else if (e.key === 'F2') {
                e.preventDefault();
                setRenaming(c.id);
              } else if (e.key === 'Delete') {
                e.preventDefault();
                void deleteCollection(c);
              }
            }}
            aria-expanded={isOpen}
            data-tree-row
            data-rename-id={c.id}
            data-row-name={c.name}
            title={c.problem ? undefined : 'F2 renames · Delete deletes · * expands all'}
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
          <NodeMenu kind="collection" label={c.name} header open={menuFor === c.id} onOpenChange={(o) => setMenuFor(o ? c.id : undefined)} ctx={() => collectionMenu(c)} />
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
            menuOpen={menuFor === r.key}
            renaming={renaming === r.key}
            examplesOpen={!!isOpenKey(open, examplesOpenKey(r.c.id, r.n.id), `${r.n.id}:examples`)}
            dropMode={dropAt?.id === r.key ? dropAt.mode : undefined}
            gitMark={git.items.get(r.n.id)}
            ctx={ctx}
          />
        );
      case 'example':
        return (
          <button
            data-node-id={r.key}
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
          <div className="pl-7 pr-3 h-8 flex items-center gap-2" data-node-id={r.key}>
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
        keyOf={treeRowKey}
        name="CollectionTree"
        keepIndex={dragIndex >= 0 ? dragIndex : undefined}
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

interface RowContext {
  onOpen(c: Collection, n: CollectionNode, o?: { preview?: boolean }): void;
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
  requestMenu(c: Collection, n: Exclude<CollectionNode, CollectionFolder>): NodeMenuCtx;
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
  ctx: React.RefObject<RowContext>;
}) {
  const x = () => ctx.current;
  const method = n.kind === 'http' ? n.request.method : 'GQL';
  const examples = n.kind === 'http' ? (n.examples ?? []) : [];
  // one id for this row in the whole tree: two collections may hold nodes with the same id
  const sid = scopedNodeId(c.id, n.id);
  const exKey = examplesOpenKey(c.id, n.id);
  const dragOf = () => x().dragProps(c, n) as { onDragStart(e: React.DragEvent): void; onDragEnd(): void };
  const dropOf = () => x().dropProps(c, sid, 'before', { beforeId: n.id });
  return (
    <div
      data-node-id={sid}
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
        x().setMenuFor(sid);
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
          data-rename-id={sid}
          data-row-name={n.name}
          title="Enter opens · F2 renames · Delete deletes"
        >
          <TreeBadge label={method} className={n.kind === 'http' ? `method-${method}` : 'text-[#e535ab]'} />
          <span className="truncate">{n.name}</span>
          {n.favorite && <Star size={11} className="shrink-0 text-warn fill-current" aria-label="Favorite" data-favorite />}
          {gitMark && <ChangeMark change={gitMark} className="ml-auto" />}
        </button>
      )}
      <NodeMenu kind="request" label={n.name} open={menuOpen} onOpenChange={(o) => x().setMenuFor(o ? sid : undefined)} ctx={() => x().requestMenu(c, n)} />
    </div>
  );
});

