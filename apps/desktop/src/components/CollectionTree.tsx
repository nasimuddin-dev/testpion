import { startAi } from './ai/AiAction';
import { startFlowGenerate, startTidyImport } from './ai/flow-generate';
import { Download, FilePlus2, Undo2 } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { Collection, CollectionFolder, CollectionNode } from '../types';
import { call, on } from '../api';
import { VirtualList } from './ui';
import { focusRow } from './TreeParts';
import type { NodeMenuCtx } from '../lib/node-menu';
import { LABEL } from '../lib/vocabulary';
import { confirmAction, promptText, toastError, useApp, attempt } from '../store';
import { deleteWithUndo, restoreDeleted } from '../lib/undo-delete';
import { MoveDialog, subtreeIds } from './MoveDialog';
import { closeTabsFor } from './EditorTabs';
import { plural, uid } from '../lib/format';
import { FolderEditor } from './FolderEditor';
import { useGitRepo } from '../lib/git';
import { fullCollection } from '../lib/collections-store';
import { matchIndex, requestCategory, type RequestCategory } from '../lib/collection-filter';

// the tree's data operations live in lib/collection-nodes (re-exported: views import them from here)
export { mapNodes, findNode, addToFolder, insertBefore, folderIdsTo, withNewIds, duplicateNode } from '../lib/collection-nodes';
import { mapNodes, findNode, addToFolder, insertBefore, folderIdsTo, withNewIds, duplicateNode, moveIntoCollection, nodeIdsExcept } from '../lib/collection-nodes';
import { setSubtree as setTreeSubtree, useTreeOpen, treeKey } from '../lib/tree-state';
import { requestCopyItems } from '../lib/request-copy';
import { saveAsTest } from '../lib/save-test';
import { openRef } from '../lib/open-ref';
import { openExportBundle } from '../lib/transfer';
import { deferDrop, useDragSession } from '../lib/drag-ref';
import { buildTreeRows, categoryOpenKey, examplesOpenKey, findTreeRow, folderOpenKey, isOpenKey, scopedNodeId, treeRowKey, type ExtraGroup, type TreeRow } from '../lib/tree-rows';
import { CATEGORY_META, CategoryRow, CollectionRow, EmptyRow, ExampleRow, ExtraFolderRow, ExtraItemRow, FolderRow, RequestRow, SAVED_ITEM_MIME, type DropMode, type RowContext } from './CollectionTreeRows';
import { useOpenRequestId } from './open-request-id';

// THE badge lives in TreeParts; the panels that drew a method badge through this module keep their import
export { TreeBadge } from './TreeParts';
export { CATEGORY_META } from './CollectionTreeRows';
export type { ExtraGroup } from '../lib/tree-rows';

/** The one name of "new request of this kind" in every menu and button: New HTTP request, New GraphQL request … */
const newRequestOf = (cat: RequestCategory) => (cat === 'rest' ? 'New HTTP request' : `New ${CATEGORY_META[cat].label} request`);

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

/** Below this many rows every row is drawn (a small tree); above it only the rows on screen and a margin. */
const DRAW_ALL = 300;
/** Rows drawn above and below the visible ones in a big tree. */
const OVERSCAN = 25;
const CATEGORIES: RequestCategory[] = ['rest', 'soap', 'graphql', 'grpc', 'websocket'];

/** The open/closed keys of every folder in these nodes (a collection's or a folder's), for Expand all / Collapse all. */
const folderKeysOf = (collectionId: string, nodes: CollectionNode[], keys: string[] = []): string[] => {
  for (const n of nodes) if (n.kind === 'folder') (keys.push(folderOpenKey(collectionId, n.id)), folderKeysOf(collectionId, n.items, keys));
  return keys;
};

/**
 * Tree of collections → categories → folders → requests (with saved gRPC calls and connections), flattened to the rows
 * that show and drawn through a VirtualList; every row is the one row (TreeRowShell, CollectionTreeRows) with the one
 * menu (lib/node-menu.ts).
 */
export const CollectionTree = memo(function CollectionTree({
  collections,
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
  extraRenaming,
  onNewOfCategory,
  onDropSaved,
  collapseAll,
  expandAll,
  revealKey,
  revealId,
}: {
  collections: Collection[];
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
  /** The saved gRPC call or connection being renamed in place (its id): the view keeps that state. */
  extraRenaming?: string;
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
  const activeRequestId = useOpenRequestId();
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
  const inGit = useGitRepo();
  /** A copy of the collection with everything it holds (its gRPC calls and connections too). */
  const duplicateCollection = async (c: Collection) => {
    await attempt(async () => {
      const copy = await call<Collection>('col.duplicate', { id: c.id });
      useApp.getState().toast(`Duplicated as "${copy.name}"`, 'success', { ref: { kind: 'collection', collectionId: copy.id } });
    });
  };
  /** Move a collection to Recently deleted (restorable for 30 days); its tabs close; Undo in the message brings it back. */
  const deleteCollection = (c: Collection) =>
    deleteWithUndo({
      kind: 'collection',
      name: c.name,
      trash: true,
      focus: c.id,
      run: async () => {
        closeTabsFor(c.items.flatMap(subtreeIds));
        await call('col.delete', { id: c.id });
      },
      undo: () => restoreDeleted('collection', c.id),
    });
  const renameNode = (c: Collection, n: CollectionNode) => setRenaming(scopedNodeId(c.id, n.id));
  /** Delete a request or folder at once, with Undo in the message (lib/undo.ts: puts the collection back as it was). */
  const deleteNode = (c: Collection, n: CollectionNode) =>
    fullCollection(c).then(
      (whole) =>
        deleteWithUndo({
          kind: n.kind === 'folder' ? 'folder' : 'request',
          name: n.name,
          focus: scopedNodeId(c.id, n.id),
          run: () => {
            // its tabs (and those of everything in a deleted folder) close too
            closeTabsFor(subtreeIds(n));
            onChange({ ...whole, items: mapNodes(whole.items, (x) => (x.id === n.id ? null : x)) });
          },
          undo: () => onChange(whole),
        }),
      toastError,
    );
  // drag and drop: a request or folder onto a request (before it), a folder (into it) or a collection (top level)
  const [drag, setDrag] = useState<{ c: Collection; n: CollectionNode }>();
  const [dropAt, setDropAt] = useState<{ id: string; mode: DropMode }>();
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
  const dragStart = (c: Collection, n: CollectionNode) => {
    if (dragFrame.current !== undefined) cancelAnimationFrame(dragFrame.current);
    dragFrame.current = requestAnimationFrame(() => {
      dragFrame.current = undefined;
      setDrag({ c, n });
    });
  };
  // a gRPC call or connection dragged from another collection and dropped on this one moves there
  const collectionDrop = (c: Collection) => {
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
  const dropProps = (c: Collection, id: string, mode: DropMode, place: { beforeId?: string; folderId?: string }) => ({
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
      toastError(e, "Couldn't convert the scripts");
    }
  };
  // which collections, categories and folders are open: the workspace's tree state (lib/tree-state)
  const [open, setOpen] = useTreeOpen('collections');
  // flips what is shown: an item open by default (a category, the collection of the open request) closes on the first click
  const toggle = (id: string, shown: boolean) => {
    setOpen((o) => ({ ...o, [id]: !shown }));
  };
  /**
   * The keys of everything inside a collection (its categories, folders and saved-item folders) or inside one folder,
   * with the container's own: Expand all and Collapse all set them all in one change of the tree state.
   */
  const subtreeKeys = (c: Collection, folder?: CollectionFolder): string[] => {
    if (folder) return [folderOpenKey(c.id, folder.id), ...folderKeysOf(c.id, folder.items)];
    const keys = [c.id, ...folderKeysOf(c.id, c.items), ...CATEGORIES.map((cat) => categoryOpenKey(c.id, cat))];
    // folders of saved gRPC calls and connections, and anything else remembered under this collection
    for (const k of Object.keys(open)) if (k.startsWith(treeKey(c.id, ''))) keys.push(k);
    return keys;
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
    // one change of the tree state for every collection at once (one write, one render)
    setTreeSubtree(
      'collections',
      collections.flatMap((c) => subtreeKeys(c)),
      true,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandAll]);
  /** Expand or collapse everything inside a collection or one folder: the container itself opens or closes with it. */
  const setSubtree = (c: Collection, folder: CollectionFolder | undefined, shown: boolean) => setTreeSubtree('collections', subtreeKeys(c, folder), shown);
  /** Open or close one protocol category of a collection, and every folder in the collection with it. */
  const setCategory = (c: Collection, key: string, shown: boolean) => setTreeSubtree('collections', [key, ...folderKeysOf(c.id, c.items)], shown);
  const newFolderIn = (c: Collection, folderId?: string) => async () => {
    const name = await promptText('New folder', { message: 'Folder name', okLabel: 'Create' });
    if (name) change(c, (c) => ({ ...c, items: addToFolder(c.items, folderId, { kind: 'folder', id: uid('fld-'), name, items: [] } as CollectionFolder) }));
  };
  /** A collection's menu: what this tree can do with it (lib/node-menu.ts decides which of these the menu shows, in which order). */
  const collectionMenu = (c: Collection): NodeMenuCtx => {
    if (c.problem) return { name: c.name, on: {} };
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
          { label: LABEL.exportWithUses, icon: <Download size={14} />, onSelect: () => openExportBundle({ selection: [ref], uses: true, title: c.name }) },
          { label: LABEL.forPostman, icon: <Undo2 size={14} />, onSelect: () => void convertScripts(c, 'pm') },
        ],
        monitor: () => useApp.getState().openIntent('monitors', { create: { collectionId: c.id } }),
        ci: () => useApp.getState().set({ ci: { collection: c.id } }),
        testFile: () => void saveAsTest({ ref, name: c.name }),
        flow: () => startFlowGenerate({ source: { collectionId: c.id }, mode: 'collection' }),
        securityTests: () => startFlowGenerate({ source: { collectionId: c.id }, mode: 'security' }),
        ...(onSettings ? { collectionSettings: () => onSettings(c) } : {}),
        convertScripts: () => void convertScripts(c, 'tp'),
        tidyImport: () => startTidyImport({ collectionId: c.id }),
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
        securityTests: () => startFlowGenerate({ source: { collectionId: c.id, folderId: n.id }, mode: 'security' }),
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
        suggestChecks: () => startAi({ task: 'generate-assertions', title: `Suggested checks for ${n.name}`, context: {}, item: ref, autoReview: true, preflight: true }),
        rename: () => void renameNode(c, n),
        duplicate: () => change(c, (c) => ({ ...c, items: duplicateNode(c.items, n.id, (y) => ({ ...y, id: uid('req-'), name: `${y.name} copy` })) })),
        move: () => setMoving({ c, n }),
        favorite: () => change(c, (c) => ({ ...c, items: mapNodes(c.items, (y) => (y.id === n.id && y.kind !== 'folder' ? { ...y, favorite: !y.favorite } : y)) })),
        delete: () => void deleteNode(c, n),
      },
    };
  };
  /** A category's menu: the same menu as every other row (right-click or ⋯): create here, fold, run the collection. */
  const categoryMenu = (c: Collection, cat: RequestCategory, key: string): NodeMenuCtx => ({
    create: onNewOfCategory ? [{ label: newRequestOf(cat), icon: <FilePlus2 size={14} />, onSelect: () => onNewOfCategory(c, cat) }] : [],
    on: { expandAll: () => setCategory(c, key, true), collapseAll: () => setCategory(c, key, false), ...(onRun ? { run: () => onRun(c) } : {}) },
  });
  /** The menu of a folder of saved gRPC calls / connections: the view's (rename, delete), with fold and unfold. */
  const extraFolderMenu = (r: Extract<TreeRow, { t: 'xfolder' }>): NodeMenuCtx => {
    const own = r.g.folderMenu?.(r.folder);
    return { name: r.folder, ...own, on: { ...own?.on, expandAll: () => setOpen((o) => ({ ...o, [r.key]: true })), collapseAll: () => setOpen((o) => ({ ...o, [r.key]: false })) } };
  };
  const [editing, setEditing] = useState<{ c: Collection; folder: CollectionFolder }>();
  const f = filter?.trim().toLowerCase();

  // every row that shows (the open collections, categories and folders), in order: a list of thousands is cheap to
  // build; only the rows on screen are drawn
  const rows = useMemo(() => buildTreeRows({ collections, open, filter, favoritesOnly, categorize, extraGroups }), [collections, open, filter, favoritesOnly, categorize, extraGroups]);
  // nothing to show for the filter (or no favourites): say so (the same matches the rows were built from, cached)
  const nothingMatches = useMemo(() => {
    if (!f && !favoritesOnly) return false;
    const extraShown = (i: ExtraGroup['items'][number]) => !f || i.name.toLowerCase().includes(f) || !!i.folder?.toLowerCase().includes(f);
    return !collections.some((c) => c.items.some(matchIndex(c.items, filter, favoritesOnly)) || (categorize && (extraGroups?.(c) ?? []).some((g) => g.items.some(extraShown))));
  }, [collections, filter, f, favoritesOnly, categorize, extraGroups]);
  // two collections with one name (an import done twice): their rows show their ids
  const duplicateNames = useMemo(() => {
    const seen = new Set<string>();
    const twice = new Set<string>();
    for (const c of collections) (seen.has(c.name) ? twice : seen).add(c.name);
    return twice;
  }, [collections]);

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
      const keys = [c.id, ...(cat && categorize ? [categoryOpenKey(c.id, cat)] : []), ...folders.map((id) => folderOpenKey(c.id, id))];
      setOpen((o) => (keys.every((k) => o[k] !== false) ? o : { ...o, ...Object.fromEntries(keys.map((k) => [k, true])) }));
      break;
    }
    setReveal({ id: target, nonce: revealKey ?? 0, collectionId: collections.find((c) => c.id === target || !!findNode(c.items, target))?.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRequestId, revealKey, revealId]);
  // the row to scroll to (a collection, folder, request or saved item), once the folders on its way are open
  const revealIndex = useMemo(() => (reveal ? findTreeRow(rows, reveal.id, reveal.collectionId) : -1), [reveal, rows]);
  // done once it scrolled (the list scrolls in its own effect, which runs first): later changes leave the scroll alone
  useEffect(() => {
    if (revealIndex >= 0) setReveal(undefined);
  }, [revealIndex]);

  // What a row needs from here, through one ref that is always current: rows are memoized, and their handlers read
  // these at event time, so they are never stale
  const ctx = useRef<RowContext>(null!);
  ctx.current = {
    onOpen,
    toggle,
    dragStart,
    dragEnd: endDrag,
    dropProps,
    collectionDrop,
    savedDragEnd: () => setDropAt(undefined),
    finishRename,
    requestMenu,
    folderMenu,
    collectionMenu,
    categoryMenu,
    extraFolderMenu,
    newRequest,
    newRequestLabel,
  };
  const canHistory = inGit;
  // the dragged row stays drawn while the list scrolls or changes under the drag (its dragend must reach React)
  const dragIndex = useMemo(() => (drag ? rows.findIndex((r) => (r.t === 'req' || r.t === 'folder') && r.c.id === drag.c.id && r.n.id === drag.n.id) : -1), [drag, rows]);
  const rowHeight = 2 * useApp((s) => s.settings?.fontSize ?? 14);
  const dropModeOf = (id: string): DropMode | undefined => (dropAt?.id === id ? dropAt.mode : undefined);

  const renderRow = (r: TreeRow) => {
    switch (r.t) {
      case 'col':
        return <CollectionRow c={r.c} open={r.open} renaming={renaming === r.c.id} dropMode={dropModeOf(r.c.id)} failing={health[r.c.id]?.failing} sent={health[r.c.id]?.sent} duplicate={duplicateNames.has(r.c.name)} ctx={ctx} />;
      case 'cat':
        return <CategoryRow c={r.c} cat={r.cat} count={r.count} open={r.open} id={r.key} dropMode={dropModeOf(treeKey(r.c.id, r.cat))} ctx={ctx} />;
      case 'folder':
        return <FolderRow c={r.c} n={r.n} depth={r.depth} open={r.open} renaming={renaming === r.key} dropMode={dropModeOf(r.key)} ctx={ctx} />;
      case 'xfolder':
        return <ExtraFolderRow r={r} ctx={ctx} />;
      case 'xitem':
        return <ExtraItemRow g={r.g} i={r.i} depth={r.depth} from={r.from} id={r.key} active={activeRequestId === r.i.id} renaming={extraRenaming === r.i.id} ctx={ctx} />;
      case 'req':
        return (
          <RequestRow
            c={r.c}
            n={r.n}
            depth={r.depth}
            active={activeRequestId === r.n.id}
            renaming={renaming === r.key}
            examplesOpen={!!isOpenKey(open, examplesOpenKey(r.c.id, r.n.id), treeKey(r.n.id, 'examples'))}
            dropMode={dropModeOf(r.key)}
            ctx={ctx}
          />
        );
      case 'example':
        return <ExampleRow r={r} ctx={ctx} />;
      case 'empty':
        return <EmptyRow r={r} ctx={ctx} />;
    }
  };

  return (
    <div className="text-sm" data-tree-rows={rows.length} role="tree" aria-label="Collections">
      {editing && (
        <FolderEditor
          folder={editing.folder}
          onClose={() => setEditing(undefined)}
          onSave={(folder) => onChange({ ...editing.c, items: mapNodes(editing.c.items, (x) => (x.id === folder.id && x.kind === 'folder' ? { ...folder, items: x.items } : x)) })}
        />
      )}
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
