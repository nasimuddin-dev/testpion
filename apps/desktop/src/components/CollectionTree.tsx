import { startAi } from './ai/AiAction';
import { startFlowGenerate, startTidyImport } from './ai/flow-generate';
import { Download, FilePlus2, FolderInput, Play, Trash2, Undo2 } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { Collection, CollectionFolder, CollectionNode } from '../types';
import { call, on } from '../api';
import { sharedCall } from '../lib/shared-call';
import { VirtualList } from './ui';
import { focusRow } from './TreeParts';
import type { NodeMenuCtx } from '../lib/node-menu';
import { LABEL } from '../lib/vocabulary';
import { dropBefore, followersOf, followersOfMany } from '../lib/call-places';
import { confirmAction, promptText, toastError, useApp, attempt } from '../store';
import { deleteWithUndo, restoreDeleted } from '../lib/undo-delete';
import { MoveDialog, subtreeIds } from './MoveDialog';
import { closeTabsFor } from './EditorTabs';
import { plural, uid } from '../lib/format';
import { FolderEditor } from './FolderEditor';
import { useGitRepo } from '../lib/git';
import { fullCollection } from '../lib/collections-store';
import { matchIndex, type RequestCategory } from '../lib/collection-filter';

// the tree's data operations live in lib/collection-nodes (re-exported: views import them from here)
export { mapNodes, findNode, addToFolder, insertBefore, folderIdsTo, withNewIds, duplicateNode } from '../lib/collection-nodes';
import { placesOf, putBackNodes, type NodePlace, mapNodes, findNode, addToFolder, insertBefore, folderIdsTo, withNewIds, duplicateNode, moveIntoCollection, nodeIdsExcept } from '../lib/collection-nodes';
import { setSubtree as setTreeSubtree, useTreeOpen, treeKey } from '../lib/tree-state';
import { requestCopyItems } from '../lib/request-copy';
import { saveAsTest } from '../lib/save-test';
import { openRef } from '../lib/open-ref';
import { openExportBundle } from '../lib/transfer';
import { deferDrop, useDragSession } from '../lib/drag-ref';
import { buildTreeRows, callShown, examplesOpenKey, findTreeRow, folderOpenKey, isOpenKey, scopedNodeId, treeRowKey, type ExtraGroup, type TreeRow } from '../lib/tree-rows';
import { CATEGORY_META, CollectionRow, EmptyRow, ExampleRow, ExtraItemRow, FolderRow, RequestRow, SAVED_ITEM_MIME, type DropMode, type RowContext } from './CollectionTreeRows';
import { useOpenRequestId } from './open-request-id';
import { pickRequest, type Picked } from '../lib/picked-requests';
import { PickedBar } from './PickedBar';

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
    const load = () => void sharedCall<Record<string, { sent: number; failing: number }>>('stats.collectionsHealth').then(setHealth, () => undefined);
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

/** The open/closed keys of every folder in these nodes (a collection's or a folder's), for Expand all / Collapse all. */
const folderKeysOf = (collectionId: string, nodes: CollectionNode[], keys: string[] = []): string[] => {
  for (const n of nodes) if (n.kind === 'folder') (keys.push(folderOpenKey(collectionId, n.id)), folderKeysOf(collectionId, n.items, keys));
  return keys;
};

/**
 * Tree of collections → folders → requests of every kind (saved gRPC calls and connections among them, when `extraGroups` gives them), flattened to the rows
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
  explorer = false,
  extraGroups,
  extraRenaming,
  onNewOfCategory,
  onDropSaved,
  onCallsAfter,
  onFolderCallsRemove,
  onFolderCallsMove,
  onFolderCallsCopy,
  collapseAll,
  expandAll,
  revealKey,
  revealId,
  owners,
}: {
  collections: Collection[];
  /** The owners of each collection from CODEOWNERS, by id: shown on its row. */
  owners?: Record<string, string[]>;
  /** Open a request; `preview`: a single click (a preview tab, WF-19), double-click opens it for good. */
  onOpen(c: Collection, node: CollectionNode, o?: { preview?: boolean }): void;
  /**
   * Save a changed collection. A promise is waited for where the next step depends on it (a move to another collection
   * takes the request out of the first only once it is saved in the second); it rejects when the collection was not
   * saved, and the tree shows why.
   */
  onChange(c: Collection): void | Promise<unknown>;
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
  /** The explorer's tree: collections start folded. */
  explorer?: boolean;
  /**
   * A collection's gRPC calls and WebSocket connections (saved outside the collection file), shown in its folders. These
   * props come from the one owner of those lists, for every tree: `{...useCollectionCalls(collections).tree}`.
   */
  extraGroups?(c: Collection): ExtraGroup[];
  /** The saved gRPC call or connection being renamed in place (its id): the owner of the lists keeps that state. */
  extraRenaming?: string;
  /** Create a request of this kind in a collection or one of its folders (New request ▸ in their menus). */
  onNewOfCategory?(c: Collection, cat: RequestCategory, folderId?: string): void;
  /**
   * A saved gRPC call or connection was dropped on a collection, on a folder, or before a request or another call
   * (`after`: the sibling it follows now; `others`: the calls around it that follow something else now).
   */
  onDropSaved?(kind: 'grpc' | 'websocket', id: string, collectionId: string, place?: { folderId?: string; after?: string; others?: ReadonlyMap<string, string> }): void | Promise<unknown>;
  /**
   * Calls follow another sibling now (call id → what it follows): the request or folder they followed was deleted or
   * moved away, or one was dropped among them. The answer puts them back as they were (Undo).
   */
  onCallsAfter?(after: ReadonlyMap<string, string>): Promise<(() => Promise<unknown>) | undefined>;
  /**
   * A folder's gRPC calls and connections follow it (they are kept outside the collection file): deleted with it (the
   * answer puts them back, for Undo), moved with it to another collection (`renamed`: ids that changed on the way), and
   * copied with it (`ids`: old id → new id of every copied folder and request).
   */
  onFolderCallsRemove?(collectionId: string, folderIds: string[]): Promise<(() => Promise<unknown>) | undefined>;
  onFolderCallsMove?(from: string, to: string, folderIds: string[], renamed: ReadonlyMap<string, string>): void | Promise<unknown>;
  onFolderCallsCopy?(collectionId: string, ids: ReadonlyMap<string, string>): void | Promise<unknown>;
  /** Changes (1, 2 …) fold every collection and folder. */
  collapseAll?: number;
  /** Changes (1, 2 …) unfold every collection and folder (the explorer's Expand all). */
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
  /** Save a collection; rejects when it could not be saved (for a step that shows the failure itself). */
  const saveNow = async (c: Collection): Promise<void> => {
    await onChange(c);
  };
  /**
   * Save a collection and say whether it was saved. Every save of the tree goes through here or `saveNow`, so a save
   * that fails is always shown, once.
   */
  const save = (c: Collection): Promise<boolean> => attempt(() => saveNow(c));
  const change = (c: Collection, f: (whole: Collection) => Collection | undefined) =>
    void fullCollection(c).then((whole) => {
      const next = f(whole);
      if (next) void save(next);
    }, toastError);
  /** A collection's gRPC calls and connections (every kind, in every folder). */
  const callsOf = (c: Collection) => (extraGroups?.(c) ?? []).flatMap((g) => g.items);
  /** Calls follow other siblings now; nothing to do when none changes. The answer puts them back (Undo). */
  const callsAfter = async (after: ReadonlyMap<string, string>) => (after.size ? await onCallsAfter?.(after) : undefined);
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
        // the tabs of its requests, and of its gRPC calls and connections
        closeTabsFor([...c.items.flatMap(subtreeIds), ...callsOf(c).map((i) => i.id)]);
        await call('col.delete', { id: c.id });
      },
      undo: () => restoreDeleted('collection', c.id),
    });
  const renameNode = (c: Collection, n: CollectionNode) => setRenaming(scopedNodeId(c.id, n.id));
  /** Delete a request or folder at once, with Undo in the message (lib/undo.ts: puts the collection back as it was). */
  const deleteNode = (c: Collection, n: CollectionNode) => {
    let putCallsBack: (() => Promise<unknown>) | undefined;
    let followAgain: (() => Promise<unknown>) | undefined;
    // the calls that follow it in its folder follow what it followed (read now, while it is still in its place)
    const followers = followersOf(c, callsOf(c), n.id);
    return fullCollection(c).then(
      (whole) =>
        deleteWithUndo({
          kind: n.kind === 'folder' ? 'folder' : 'request',
          name: n.name,
          focus: scopedNodeId(c.id, n.id),
          run: async () => {
            // its tabs (and those of everything in a deleted folder) close too
            closeTabsFor(subtreeIds(n));
            // (a save that fails stops here: nothing else is touched, and the message is the error, not "Deleted")
            await saveNow({ ...whole, items: mapNodes(whole.items, (x) => (x.id === n.id ? null : x)) });
            // a folder's gRPC calls and connections go with it, and come back with Undo
            if (n.kind === 'folder') putCallsBack = await onFolderCallsRemove?.(c.id, subtreeIds(n));
            followAgain = await callsAfter(followers);
          },
          // put back where it was, into the collection as it is now (an edit made since stays)
          undo: async () => {
            // (the collection gone since, deleted or renamed away: it comes back as it was before the delete)
            const now = await call<Collection>('col.get', { id: c.id }).catch(() => undefined);
            await saveNow(now ? { ...now, items: putBackNodes(now.items, placesOf(whole.items, new Set([n.id]))) } : whole);
            await putCallsBack?.();
            await followAgain?.();
          },
        }),
      toastError,
    );
  };
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
    return { node: r.node, kept: subtreeIds(n).filter((id) => !r.renamed.has(id)), renamed: r.renamed };
  };
  /**
   * A request or folder moves to another collection, one step after the other: saved in the new collection first, and
   * taken out of the old one only once that worked (a save that fails leaves a copy at most, never loses the request;
   * its error is shown and nothing else follows). Then its tabs follow it, the calls that followed it in its old folder
   * follow what it followed (`after`, with the calls around its new place), and a folder's calls move with it.
   * Resolves whether it moved.
   */
  const moveAcross = async (from: Collection, without: Collection, to: Collection, n: CollectionNode, moved: { kept: string[]; renamed: ReadonlyMap<string, string> }, after: ReadonlyMap<string, string>): Promise<boolean> => {
    if (!(await save(to)) || !(await save(without))) return false;
    // tabs of a request whose id changed close (they would name a request that is gone); the others follow it
    if (moved.renamed.size) closeTabsFor([...moved.renamed.keys()]);
    onMoved?.(moved.kept, from.id, to.id);
    await callsAfter(after);
    // a folder's gRPC calls and connections move with it
    if (n.kind === 'folder') await onFolderCallsMove?.(from.id, to.id, subtreeIds(n), moved.renamed);
    return true;
  };
  const drop = (to: Collection, place: { beforeId?: string; folderId?: string }) => {
    const d = drag;
    endDrag();
    if (!d || !canDrop(place)) return;
    // the calls that follow it in its folder follow what it followed (read now, while it is still in its place)
    const followers = followersOf(d.c, callsOf(d.c), d.n.id);
    // after the drop event: the drag loop has ended before anything re-renders or opens (menus-uniform P0-1)
    deferDrop(
      () =>
        void (async () => {
          const [from, other] = await Promise.all([fullCollection(d.c), to.id === d.c.id ? undefined : fullCollection(to)]);
          const n = wholeNode(from, d.n);
          const without = mapNodes(from.items, (x) => (x.id === n.id ? null : x));
          const arrived = other ? arriving(n, from, other) : undefined;
          const node = arrived?.node ?? n;
          // dropped before a gRPC call or connection: among the folder's requests where the call is shown, and the
          // calls from there on follow it
          const atCall = place.beforeId && callsOf(to).some((i) => i.id === place.beforeId) ? dropBefore(to, callsOf(to), { id: node.id, node: true }, place.beforeId) : undefined;
          const insert = (items: CollectionNode[], m: CollectionNode) =>
            atCall ? (atCall.beforeNode ? insertBefore(items, atCall.beforeNode, m) : addToFolder(items, atCall.folderId, m)) : place.beforeId ? insertBefore(items, place.beforeId, m) : addToFolder(items, place.folderId, m);
          const after = new Map([...followers, ...(atCall?.after ?? [])]);
          if (!other) {
            if (await save({ ...from, items: insert(without, n) })) await callsAfter(after);
          } else await moveAcross(from, { ...from, items: without }, { ...other, items: insert(other.items, node) }, n, arrived!, after);
        })().catch(toastError),
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
          deferDrop(() => void onDropSaved!(d.kind, d.id, c.id, {}));
        } catch {
          /* not ours */
        }
      },
    };
  };
  /**
   * A gRPC call or connection dropped on a folder (inside it, at its end) or just before a request, a folder or another
   * call: its place in the folder, and the calls around it that follow something else now (so the order shown stays).
   */
  const savedPlace = (c: Collection, place: { beforeId?: string; folderId?: string }, dragged: string): { folderId?: string; after?: string; others?: ReadonlyMap<string, string> } => {
    const at = place.beforeId ? dropBefore(c, callsOf(c), { id: dragged }, place.beforeId) : undefined;
    return at ? { folderId: at.folderId, after: at.after.get(dragged), others: at.after } : { folderId: place.folderId };
  };
  const isSavedDrag = (e: React.DragEvent) => !!onDropSaved && e.dataTransfer.types.includes(SAVED_ITEM_MIME);
  const dropProps = (c: Collection, id: string, mode: DropMode, place: { beforeId?: string; folderId?: string }) => ({
    onDragOver: (e: React.DragEvent) => {
      if (isSavedDrag(e)) {
        e.preventDefault();
        e.stopPropagation();
        if (dropAt?.id !== id || dropAt.mode !== mode) setDropAt({ id, mode });
        return;
      }
      if (!canDrop(place)) return;
      e.preventDefault();
      e.stopPropagation();
      if (dropAt?.id !== id || dropAt.mode !== mode) setDropAt({ id, mode });
    },
    onDragLeave: () => dropAt?.id === id && setDropAt(undefined),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (isSavedDrag(e)) {
        setDropAt(undefined);
        try {
          const d = JSON.parse(e.dataTransfer.getData(SAVED_ITEM_MIME)) as { kind: 'grpc' | 'websocket'; id: string };
          if (d.id !== place.beforeId) deferDrop(() => void onDropSaved!(d.kind, d.id, c.id, savedPlace(c, place, d.id)));
        } catch {
          /* not ours */
        }
        return;
      }
      drop(c, place);
    },
  });
  const move = (fromShown: Collection, shown: CollectionNode, toShown: Collection, folderId: string | undefined) => {
    setMoving(undefined);
    // the calls that follow it in its folder follow what it followed (read now, while it is still in its place)
    const followers = followersOf(fromShown, callsOf(fromShown), shown.id);
    void (async () => {
      const [from, other] = await Promise.all([fullCollection(fromShown), toShown.id === fromShown.id ? undefined : fullCollection(toShown)]);
      const shownNode = wholeNode(from, shown);
      const to = other ?? from;
      // a folder that is gone (a pull, another window) takes nothing: the request stays where it is
      if (folderId && findNode(to.items, folderId)?.kind !== 'folder') return useApp.getState().toast('That folder is no longer there: nothing was moved', 'error');
      const without = { ...from, items: mapNodes(from.items, (x) => (x.id === shownNode.id ? null : x)) };
      let n = shownNode;
      if (!other) {
        if (!(await save({ ...without, items: addToFolder(without.items, folderId, n) }))) return;
        await callsAfter(followers);
        onMoved?.(subtreeIds(n), from.id, to.id);
      } else {
        const moved = arriving(shownNode, from, other);
        n = moved.node;
        if (!(await moveAcross(from, without, { ...other, items: addToFolder(other.items, folderId, n) }, shownNode, moved, followers))) return;
      }
      useApp.getState().toast(`Moved "${n.name}" to ${to.name}${folderId ? ` › ${findNode(to.items, folderId)?.name ?? ''}` : ''}`, 'success', { ref: n.kind === 'folder' ? { kind: 'folder', collectionId: to.id, folderId: n.id } : { kind: 'request', collectionId: to.id, requestId: n.id } });
    })().catch(toastError);
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
      if (!(await save(r.collection))) return;
      useApp.getState().toast(`Converted ${plural(r.changed, 'script')} to ${to}.*`, 'success');
    } catch (e) {
      toastError(e, "Couldn't convert the scripts");
    }
  };
  // which collections and folders are open: the workspace's tree state (lib/tree-state)
  const [open, setOpen] = useTreeOpen('collections');
  // flips what is shown: an item open by default (the collection of the open request) closes on the first click
  const toggle = (id: string, shown: boolean) => {
    setOpen((o) => ({ ...o, [id]: !shown }));
  };
  /**
   * The keys of everything inside a collection (its folders) or inside one folder,
   * with the container's own: Expand all and Collapse all set them all in one change of the tree state.
   */
  const subtreeKeys = (c: Collection, folder?: CollectionFolder): string[] => {
    if (folder) return [folderOpenKey(c.id, folder.id), ...folderKeysOf(c.id, folder.items)];
    const keys = [c.id, ...folderKeysOf(c.id, c.items)];
    // anything else remembered under this collection
    for (const k of Object.keys(open)) if (k.startsWith(treeKey(c.id, ''))) keys.push(k);
    return keys;
  };
  useEffect(() => {
    if (!collapseAll) return;
    // every folder closed, and every collection (some are open by default)
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
      // any kind of request in any folder: New request ▸ GraphQL, SOAP, gRPC, WebSocket … into this folder
      create: [
        { label: newRequestLabel ?? 'New HTTP request', icon: <FilePlus2 size={14} />, onSelect: () => newRequest(c, n.id) },
        ...(onNewOfCategory ? [{ label: LABEL.newRequest, icon: <FilePlus2 size={14} />, onSelect: () => undefined, items: (['graphql', 'soap', 'grpc', 'websocket'] as const).map((cat) => ({ label: newRequestOf(cat), icon: <FilePlus2 size={14} />, onSelect: () => onNewOfCategory(c, cat, n.id) })) }] : []),
      ],
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
        duplicate: () => {
          // the copy's ids, old → new, so the folder's gRPC calls and connections are copied into the copied folders
          const ids = new Map<string, string>();
          const pair = (a: CollectionNode, b: CollectionNode) => {
            ids.set(a.id, b.id);
            if (a.kind === 'folder' && b.kind === 'folder') a.items.forEach((x, i) => b.items[i] && pair(x, b.items[i]!));
          };
          change(c, (whole) => {
            const items = duplicateNode(whole.items, n.id, (x) => {
              const copy = { ...withNewIds(x), name: `${x.name} copy` };
              pair(x, copy);
              return copy;
            });
            // (here, once the whole collection is read and the copy has its ids)
            if (ids.size) void onFolderCallsCopy?.(whole.id, ids);
            return { ...whole, items };
          });
        },
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
  const [editing, setEditing] = useState<{ c: Collection; folder: CollectionFolder }>();
  const f = filter?.trim().toLowerCase();
  // several requests of one collection picked (Ctrl/⌘+click, Shift+click), to run, move or delete together; Esc lets go
  const [picked, setPicked] = useState<Picked>();
  const [movingPicked, setMovingPicked] = useState(false);
  const pickedCollection = picked ? collections.find((c) => c.id === picked.collectionId) : undefined;
  // what is still there (a request deleted or moved away is no longer picked)
  const pickedIds = useMemo(() => (picked && pickedCollection ? picked.ids.filter((id) => !!findNode(pickedCollection.items, id)) : []), [picked, pickedCollection]);
  const pickedSet = useMemo(() => new Set(pickedIds), [pickedIds]);
  const runPicked = () =>
    void attempt(async () => {
      const r = await call<{ runId: string }>('col.run', { collectionId: pickedCollection!.id, selection: pickedIds, environment: useApp.getState().environment || undefined });
      useApp.getState().toast(`Running ${plural(pickedIds.length, 'request')} of ${pickedCollection!.name}`, 'success', { ref: { kind: 'run', runId: r.runId } });
    });
  /** Delete them at once; one Undo puts them all back where they were. */
  const deletePicked = () => {
    const c = pickedCollection!;
    const ids = new Set(pickedIds);
    setPicked(undefined);
    // the calls that follow one of them follow what the first of a run of them followed (read now, while they are in place)
    const followers = followersOfMany(c, callsOf(c), ids);
    let followAgain: (() => Promise<unknown>) | undefined;
    let places: NodePlace[] = [];
    return fullCollection(c).then(
      (whole) => (places = placesOf(whole.items, ids)) &&
        deleteWithUndo({
          kind: 'request',
          name: plural(ids.size, 'request'),
          run: async () => {
            closeTabsFor([...ids]);
            await saveNow({ ...whole, items: mapNodes(whole.items, (x) => (ids.has(x.id) ? null : x)) });
            followAgain = await callsAfter(followers);
          },
          // put back where they were, into the collection as it is now (an edit made since stays)
          undo: async () => {
            // (the collection gone since: it comes back as it was before the delete)
            const now = await call<Collection>('col.get', { id: c.id }).catch(() => undefined);
            await saveNow(now ? { ...now, items: putBackNodes(now.items, places) } : whole);
            await followAgain?.();
          },
        }),
      toastError,
    );
  };
  /** Move them, in the order the tree shows them, to a folder of their collection (or its top level). */
  const movePicked = (folderId: string | undefined) => {
    setMovingPicked(false);
    const c = pickedCollection!;
    const ids = pickedIds;
    setPicked(undefined);
    const followers = followersOfMany(c, callsOf(c), new Set(ids));
    void (async () => {
      const whole = await fullCollection(c);
      // a folder that is gone (a pull, another window) takes nothing: the requests stay where they are
      if (folderId && findNode(whole.items, folderId)?.kind !== 'folder') return useApp.getState().toast('That folder is no longer there: nothing was moved', 'error');
      const nodes = ids.map((id) => findNode(whole.items, id)).filter((n): n is CollectionNode => !!n);
      const without = mapNodes(whole.items, (x) => (ids.includes(x.id) ? null : x));
      if (!(await save({ ...whole, items: nodes.reduce((items, n) => addToFolder(items, folderId, n), without) }))) return;
      await callsAfter(followers);
      useApp.getState().toast(`Moved ${plural(nodes.length, 'request')} to ${folderId ? (findNode(whole.items, folderId)?.name ?? c.name) : c.name}`, 'success');
    })().catch(toastError);
  };

  // every row that shows (the open collections and folders), in order: a list of thousands is cheap to
  // build; only the rows on screen are drawn
  const rows = useMemo(() => buildTreeRows({ collections, open, filter, favoritesOnly, explorer, extraGroups }), [collections, open, filter, favoritesOnly, explorer, extraGroups]);
  // nothing to show for the filter (or no favourites): say so (the same matches the rows were built from, cached)
  const nothingMatches = useMemo(() => {
    if (!f && !favoritesOnly) return false;
    return !collections.some((c) => c.items.some(matchIndex(c.items, filter, favoritesOnly)) || (extraGroups?.(c) ?? []).some((g) => g.items.some((i) => callShown(i, f || undefined, favoritesOnly))));
  }, [collections, filter, f, favoritesOnly, extraGroups]);
  // two collections with one name (an import done twice): their rows show their ids
  const duplicateNames = useMemo(() => {
    const seen = new Set<string>();
    const twice = new Set<string>();
    for (const c of collections) (seen.has(c.name) ? twice : seen).add(c.name);
    return twice;
  }, [collections]);

  // reveal the open request: when something was opened (search, history, a link), open its collection and
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
      // a gRPC call or connection in the folder view: the folders on its way to its own folder
      const call = callsOf(c).find((i) => i.id === target);
      if (call) {
        const to = call.folderId ? folderIdsTo(c.items, call.folderId) : undefined;
        const keys = [c.id, ...(to ? [...to, call.folderId!] : []).map((id) => folderOpenKey(c.id, id))];
        setOpen((o) => (keys.every((k) => o[k] !== false) ? o : { ...o, ...Object.fromEntries(keys.map((k) => [k, true])) }));
        break;
      }
      // the collection itself (a breadcrumb's first segment): open it
      const folders = c.id === target ? [] : folderIdsTo(c.items, target);
      if (!folders) continue;
      const keys = [c.id, ...folders.map((id) => folderOpenKey(c.id, id))];
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
    newRequest,
    newRequestLabel,
    pick: (c, n, how) => setPicked((p) => pickRequest(p, c.id, n.id, how, rows.filter((r) => r.t === 'req' && r.c.id === c.id).map((r) => (r as { n: CollectionNode }).n.id))),
  };
  const canHistory = inGit;
  // the dragged row stays drawn while the list scrolls or changes under the drag (its dragend must reach React)
  const dragIndex = useMemo(() => (drag ? rows.findIndex((r) => (r.t === 'req' || r.t === 'folder') && r.c.id === drag.c.id && r.n.id === drag.n.id) : -1), [drag, rows]);
  const rowHeight = 2 * useApp((s) => s.settings?.fontSize ?? 14);
  const dropModeOf = (id: string): DropMode | undefined => (dropAt?.id === id ? dropAt.mode : undefined);

  const renderRow = (r: TreeRow) => {
    switch (r.t) {
      case 'col':
        return <CollectionRow c={r.c} open={r.open} renaming={renaming === r.c.id} dropMode={dropModeOf(r.c.id)} failing={health[r.c.id]?.failing} sent={health[r.c.id]?.sent} duplicate={duplicateNames.has(r.c.name)} owners={owners?.[r.c.id]} ctx={ctx} />;
      case 'folder':
        return <FolderRow c={r.c} n={r.n} depth={r.depth} open={r.open} calls={r.calls} renaming={renaming === r.key} dropMode={dropModeOf(r.key)} ctx={ctx} />;
      case 'xitem':
        return <ExtraItemRow c={r.c} g={r.g} i={r.i} depth={r.depth} from={r.from} id={r.key} active={activeRequestId === r.i.id} renaming={extraRenaming === r.i.id} dropMode={dropModeOf(r.key)} ctx={ctx} />;
      case 'req':
        return (
          <RequestRow
            c={r.c}
            n={r.n}
            depth={r.depth}
            active={activeRequestId === r.n.id}
            renaming={renaming === r.key}
            examplesOpen={!!isOpenKey(open, examplesOpenKey(r.c.id, r.n.id), treeKey(r.n.id, 'examples'))}
            picked={picked?.collectionId === r.c.id && pickedSet.has(r.n.id)}
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
    <div
      className="text-sm"
      data-tree-rows={rows.length}
      role="tree"
      aria-label="Collections"
      aria-multiselectable={pickedIds.length > 0 || undefined}
      onKeyDown={(e) => {
        // Esc on a row of the tree (not in a dialog or a rename field inside it) lets go of the picks
        if (e.key === 'Escape' && pickedIds.length && (e.target as HTMLElement).closest?.('[data-tree-row]') && !(e.target as HTMLElement).closest('input, textarea, [role=dialog]'))
          (e.stopPropagation(), setPicked(undefined));
      }}
    >
      {pickedIds.length > 0 && pickedCollection && (
        <PickedBar
          count={pickedIds.length}
          noun="request"
          where={pickedCollection.name}
          onClear={() => setPicked(undefined)}
          actions={[
            { label: LABEL.run, icon: <Play size={12} />, onClick: runPicked, title: 'Run them in the order the tree shows, in the active environment' },
            { label: LABEL.moveTo, icon: <FolderInput size={12} />, onClick: () => setMovingPicked(true) },
            {
              label: LABEL.export,
              icon: <Download size={12} />,
              title: 'One file with just these requests (and what they use, if you choose)',
              onClick: () => openExportBundle({ selection: pickedIds.map((id) => ({ kind: 'request' as const, collectionId: pickedCollection.id, requestId: id })), title: `${plural(pickedIds.length, 'request')} of ${pickedCollection.name}` }),
            },
            { label: LABEL.delete, icon: <Trash2 size={12} />, onClick: () => void deletePicked() },
          ]}
        />
      )}
      {movingPicked && pickedCollection && pickedIds.length > 0 && (
        // within their collection: a move to another one goes one request at a time (its menu's Move to…)
        <MoveDialog node={findNode(pickedCollection.items, pickedIds[0]!)!} from={pickedCollection} collections={[pickedCollection]} onClose={() => setMovingPicked(false)} onMove={(_to, folderId) => movePicked(folderId)} />
      )}
      {editing && (
        <FolderEditor
          folder={editing.folder}
          onClose={() => setEditing(undefined)}
          onSave={(folder) => void save({ ...editing.c, items: mapNodes(editing.c.items, (x) => (x.id === folder.id && x.kind === 'folder' ? { ...folder, items: x.items } : x)) })}
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
