import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callsInFolders, collectionCallKind, copyCallsWithFolders, moveCallsWithFolders } from '@testpion/shared';
import { call, on } from '../api';
import { closeTabsFor } from '../components/EditorTabs';
import { focusRow } from '../components/TreeParts';
import { useStableCallbacks } from '../hooks';
import { attempt, toastError, useApp } from '../store';
import type { Collection, CollectionNode, Library, LibraryItem, McpServerConfig } from '../types';
import { followersOf } from './call-places';
import { copyText } from './clipboard';
import { touchesFiles, type DataChangedEvent } from './data-changed';
import { uid } from './format';
import type { NodeMenuCtx } from './node-menu';
import { openRef } from './open-ref';
import { saveAsTest } from './save-test';
import { sharedCall } from './shared-call';
import type { ExtraGroup, PlacedKind } from './tree-rows';
import { treeKey } from './tree-state';
import { deleteMcpServerWithUndo, deleteWithUndo, putBack } from './undo-delete';

/**
 * A collection's gRPC calls and connections for the collections tree (CollectionTree): they are kept in the workspace
 * library, each in a collection, a folder of it and after a sibling. The one owner of those lists for every tree that
 * shows collections (the explorer, a collection's Requests tab): the rows and their menus (`extraGroups`), rename in
 * place, drops, and what follows a folder (deleted with it and put back by Undo, moved with it, copied with it).
 *
 * An MCP server can be placed in a collection too (`collectionId`, `folderId`, `after` of its config in
 * mcp-servers.json): it stays in the workspace's list of servers, and shows among the collection's requests as well.
 * It moves like a call. What differs: a folder deleted or copied does not delete or copy a server (a server is a
 * connection the whole workspace uses); the servers of a deleted folder leave the collection, and Undo puts them back.
 */

type CallLibrary = 'grpc' | 'websocket';
const KINDS = ['grpc', 'websocket'] as const;
/** Everything placed in a collection's folders: the calls of the two libraries and MCP servers. */
const PLACED = ['grpc', 'websocket', 'mcp'] as const;
/** What a placed item needs to be moved: a library item and a server's config both have it. */
type Placed = { id: string; name: string; collectionId?: string; folderId?: string; after?: string };

interface SavedItem {
  id: string;
  name: string;
  folder?: string;
  /** The collection it's in (gRPC calls and connections are kept in the workspace library, each in a collection). */
  collectionId?: string;
  /** Its folder of that collection and the sibling it follows (any kind of request in any folder). */
  folderId?: string;
  after?: string;
  badge?: string;
}

const NONE: SavedItem[] = [];

/** Saved items by the collection they're shown in. */
function groupByCollection(items: SavedItem[]): Map<string, SavedItem[]> {
  const map = new Map<string, SavedItem[]>();
  for (const i of items) {
    if (!i.collectionId) continue;
    const list = map.get(i.collectionId);
    if (list) list.push(i);
    else map.set(i.collectionId, [i]);
  }
  return map;
}

const wsBadge = (d: unknown) =>
  (d as { mode?: string })?.mode === 'kafka' ? 'KAFKA' : (d as { mode?: string })?.mode === 'mqtt' ? 'MQTT' : (d as { mode?: string })?.mode === 'socketio' ? 'SIO' : 'WS';

/** These calls with a new `after` each (the others as they are). */
const withAfter = <I extends { id: string; after?: string }>(items: I[], after: ReadonlyMap<string, string | undefined>): I[] =>
  after.size ? items.map((i) => (after.has(i.id) ? { ...i, after: after.get(i.id) } : i)) : items;

/** Where a moved call goes: a folder of the collection, the sibling it follows, and the calls around it that follow something else now. */
export interface CallPlace {
  folderId?: string;
  after?: string;
  others?: ReadonlyMap<string, string>;
}

/** What CollectionTree takes for a collection's calls: spread into it (`<CollectionTree {...calls.tree} />`). */
export interface CollectionCallsTreeProps {
  extraGroups(c: Collection): ExtraGroup[];
  extraRenaming?: string;
  onDropSaved(kind: PlacedKind, id: string, collectionId: string, place?: CallPlace): Promise<void>;
  onCallsAfter(after: ReadonlyMap<string, string>): Promise<(() => Promise<unknown>) | undefined>;
  onFolderCallsRemove(collectionId: string, folderIds: string[]): Promise<(() => Promise<unknown>) | undefined>;
  onFolderCallsMove(from: string, to: string, folderIds: string[], renamed: ReadonlyMap<string, string>): Promise<void>;
  onFolderCallsCopy(collectionId: string, ids: ReadonlyMap<string, string>): Promise<void>;
}

export function useCollectionCalls(listed: Collection[]): {
  tree: CollectionCallsTreeProps;
  /** The ids of a collection's calls and connections (their tabs close with it). */ idsIn(collectionId: string): string[];
  reload(): Promise<void>;
} {
  // (a collection whose file cannot be read is listed, but nothing moves into it)
  const collections = useMemo(() => listed.filter((c) => !c.problem), [listed]);
  const wsId = useApp((s) => s.workspace?.id);
  const [grpc, setGrpc] = useState<SavedItem[]>([]);
  const [sockets, setSockets] = useState<SavedItem[]>([]);
  /** The MCP servers placed in a collection. */
  const [servers, setServers] = useState<SavedItem[]>([]);
  const load = useCallback(async () => {
    const [g, w, m] = await Promise.all([
      ...KINDS.map((kind) => sharedCall<Library<unknown>>('lib.get', { kind }).catch(() => undefined)),
      sharedCall<McpServerConfig[]>('mcp.servers').catch(() => undefined),
    ] as [Promise<Library<unknown> | undefined>, Promise<Library<unknown> | undefined>, Promise<McpServerConfig[] | undefined>]);
    if (g) setGrpc(g.items.map(({ data: _, ...i }) => i));
    if (w) setSockets(w.items.map(({ data, ...i }) => ({ ...i, badge: wsBadge(data) })));
    if (m) setServers((was) => {
      const now = m.filter((s) => s.collectionId).map((s) => ({ id: s.id, name: s.name, collectionId: s.collectionId, folderId: s.folderId, after: s.after }));
      return JSON.stringify(now) === JSON.stringify(was) ? was : now;
    });
  }, []);
  useEffect(() => {
    void load();
  }, [load, wsId]);
  // a save of either library in any view (or a change on disk) reads them again, coalesced: an import saves many in a row
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = on<DataChangedEvent>('data.changed', (e) => {
      if (!touchesFiles(e, ['library', 'mcp'])) return;
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 120);
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [load]);

  const listOf = (kind: PlacedKind) => (kind === 'grpc' ? grpc : kind === 'mcp' ? servers : sockets);
  /** Every call, connection and MCP server of a collection. */
  const callsIn = (collectionId: string) => [...grpc, ...sockets, ...servers].filter((i) => i.collectionId === collectionId);
  /** Change a saved gRPC call / connection list (move, rename, duplicate, delete): the one place that loads, edits and saves it. */
  const editLibrary = async (kind: CallLibrary, fn: (items: Array<LibraryItem<unknown>>) => Array<LibraryItem<unknown>>) => {
    await attempt(async () => {
      const lib = await call<Library<unknown>>('lib.get', { kind });
      await call('lib.save', { kind, library: { etag: lib.etag, folders: lib.folders, items: fn(lib.items) } });
      await load();
    });
  };
  /** Change the places of one kind's items: a library's calls, or the workspace's MCP servers (mcp-servers.json). */
  const editPlaced = async (kind: PlacedKind, fn: <I extends Placed>(items: I[]) => I[]) => {
    if (kind !== 'mcp') return editLibrary(kind, fn);
    await attempt(async () => {
      const list = await call<Array<McpServerConfig & { connected?: boolean }>>('mcp.servers');
      await call('mcp.saveServers', { servers: fn(list.map(({ connected: _c, ...s }) => s as McpServerConfig)) });
      await load();
    });
  };
  /** The calls that follow `id` (a call of a collection about to leave its place), and what each follows once it is gone. */
  const followers = (collectionId: string | undefined, id: string): Map<string, string> => {
    const c = collectionId ? collections.find((x) => x.id === collectionId) : undefined;
    return c ? followersOf(c, callsIn(c.id), id) : new Map();
  };
  /**
   * Move a saved gRPC call / connection to another collection, folder or place in its folder. The calls that followed
   * it follow what it followed; `place.others`: the calls around its new place that follow something else now.
   */
  const moveItem = async (kind: PlacedKind, id: string, collectionId: string | undefined, place: CallPlace = {}) => {
    const after = new Map([...followers(listOf(kind).find((i) => i.id === id)?.collectionId, id), ...(place.others ?? [])]);
    after.delete(id);
    for (const k of PLACED) {
      if (k !== kind && !listOf(k).some((i) => after.has(i.id))) continue;
      await editPlaced(k, (items) => withAfter(items, after).map((i) => (k === kind && i.id === id ? { ...i, collectionId, folderId: place.folderId, after: place.after } : i)));
    }
  };
  /** Calls follow other siblings now (a request or folder they followed was deleted, moved or dropped among them); the answer puts them back (Undo). */
  const setAfter = async (after: ReadonlyMap<string, string>) => {
    const before = new Map<string, string | undefined>();
    for (const kind of PLACED) {
      if (!listOf(kind).some((i) => after.has(i.id))) continue;
      await editPlaced(kind, (items) => {
        for (const i of items) if (after.has(i.id)) before.set(i.id, i.after);
        return withAfter(items, after);
      });
    }
    if (!before.size) return undefined;
    return async () => {
      for (const kind of PLACED) if (listOf(kind).some((i) => before.has(i.id))) await editPlaced(kind, (items) => withAfter(items, before));
    };
  };
  /** Copy a saved gRPC call as a grpcurl command, or a connection's URL ({{variables}} resolved). */
  const copySaved = async (kind: CallLibrary, id: string) => {
    try {
      const it = (await call<Library<Record<string, any>>>('lib.get', { kind })).items.find((i) => i.id === id);
      if (!it) return;
      const env = useApp.getState().environment;
      const d = it.data;
      const text =
        kind === 'grpc'
          ? await call<string>('grpc.grpcurl', {
              target: d.target,
              method: d.method,
              message: d.message,
              metadata: d.metadata,
              tls: d.tls,
              protoFiles: d.descriptorSet ? [] : (d.protoFiles ?? []).map((f: { name: string }) => f.name),
              timeoutMs: d.timeoutMs,
              environment: env,
            })
          : String(d.url ?? '');
      await copyText(text, kind === 'grpc' ? 'as grpcurl' : 'the URL');
    } catch (e) {
      toastError(e);
    }
  };
  /**
   * A collection folder's gRPC calls and connections follow it (they are kept outside the collection file): deleted with
   * it (and put back by Undo), moved with it to another collection, copied with it.
   */
  const folderCalls = {
    remove: async (collectionId: string, folderIds: string[]) => {
      const inside = new Set(folderIds);
      const removed: Array<{ kind: CallLibrary; items: Array<LibraryItem<unknown>> }> = [];
      for (const kind of KINDS) {
        const here = callsInFolders(listOf(kind), collectionId, inside);
        if (!here.length) continue;
        const ids = new Set(here.map((i) => i.id));
        closeTabsFor([...ids]);
        await editLibrary(kind, (items) => {
          removed.push({ kind, items: items.filter((i) => ids.has(i.id)) });
          return items.filter((i) => !ids.has(i.id));
        });
      }
      // the folder's MCP servers are not deleted: they leave the collection (the workspace's list keeps them), and come back with Undo
      const left = new Map(callsInFolders(servers, collectionId, inside).map((s) => [s.id, { collectionId: s.collectionId, folderId: s.folderId, after: s.after }]));
      if (left.size) await editPlaced('mcp', (items) => items.map((i) => (left.has(i.id) ? { ...i, collectionId: undefined, folderId: undefined, after: undefined } : i)));
      if (!removed.length && !left.size) return undefined;
      return async () => {
        for (const r of removed) await editLibrary(r.kind, (items) => [...items, ...r.items.filter((x) => !items.some((i) => i.id === x.id))]);
        if (left.size) await editPlaced('mcp', (items) => items.map((i) => (left.has(i.id) ? { ...i, ...left.get(i.id) } : i)));
      };
    },
    move: async (from: string, to: string, folderIds: string[], renamed: ReadonlyMap<string, string>) => {
      const inside = new Set(folderIds);
      for (const kind of PLACED) if (callsInFolders(listOf(kind), from, inside).length) await editPlaced(kind, (items) => moveCallsWithFolders(items, { from, to, folderIds: inside, renamed }));
    },
    copy: async (collectionId: string, ids: ReadonlyMap<string, string>) => {
      const inside = new Set(ids.keys());
      for (const kind of KINDS)
        if (callsInFolders(listOf(kind), collectionId, inside).length)
          await editLibrary(kind, (items) =>
            copyCallsWithFolders(items, { collectionId, ids, newId: () => uid('lib-') }).map((i) => (items.includes(i) ? i : { ...i, updatedAt: new Date().toISOString() })),
          );
    },
  };
  /** The saved gRPC call or connection being renamed in place (its id). */
  const [renaming, setRenaming] = useState<string>();
  /** Rename in place: the row's field, then the save, then the keyboard back on the row (named by its key in the tree). */
  const renameSaved = (kind: PlacedKind, id: string): NonNullable<ReturnType<NonNullable<ExtraGroup['rename']>>> => ({
    editing: renaming === id,
    start: () => setRenaming(id),
    done: (name) => {
      setRenaming(undefined);
      if (name) void editPlaced(kind, (items) => items.map((i) => (i.id === id ? { ...i, name } : i)));
      focusRow(treeKey(listOf(kind).find((i) => i.id === id)?.collectionId ?? '', kind, id));
    },
  });
  /** Move to ▸ a collection ▸ its top level or one of its folders (any kind of request in any folder). */
  const moveTargets = (kind: PlacedKind, item: SavedItem) =>
    collections.map((c) => {
      const folders: Array<{ id: string; path: string }> = [];
      const walk = (nodes: CollectionNode[], prefix: string) => {
        for (const n of nodes) if (n.kind === 'folder') (folders.push({ id: n.id, path: prefix + n.name }), walk(n.items, `${prefix}${n.name} / `));
      };
      walk(c.items, '');
      const top = { label: 'Top level', onSelect: (): void => void moveItem(kind, item.id, c.id) };
      return folders.length
        ? {
            label: c.name,
            onSelect: (): void => undefined,
            items: [top, ...folders.filter((f) => !(c.id === item.collectionId && f.id === item.folderId)).map((f) => ({ label: f.path, onSelect: () => void moveItem(kind, item.id, c.id, { folderId: f.id }) }))],
          }
        : { label: c.name, onSelect: top.onSelect };
    });
  /**
   * The menu of an MCP server placed in a collection: open it, its settings, rename, move (to another folder or
   * collection, or out of the collection: the workspace's list of servers keeps it) and delete (the server itself, with Undo).
   */
  const serverMenu = (item: SavedItem): NodeMenuCtx => {
    const ref = { kind: 'mcp-server' as const, serverId: item.id };
    return {
      ref,
      name: item.name,
      on: {
        open: () => void openRef(ref),
        openNewTab: () => void openRef(ref, { newTab: true }),
        settings: () => useApp.getState().openIntent('mcp', { serverId: item.id, tab: 'settings' }),
        rename: () => setRenaming(item.id),
        move: [...moveTargets('mcp', item), { label: 'Out of the collection (MCP servers only)', onSelect: () => void moveItem('mcp', item.id, undefined) }],
        delete: () => {
          const after = followers(item.collectionId, item.id);
          void (after.size ? setAfter(after) : Promise.resolve(undefined)).then(() => deleteMcpServerWithUndo(item, { after: load }));
        },
      },
    };
  };
  /** The menu of a gRPC call or connection: the same groups as a request's (open, copy, test file, rename, duplicate, move, delete). */
  const savedMenu = (kind: CallLibrary, item: SavedItem): NodeMenuCtx => {
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
        duplicate: () =>
          void editLibrary(kind, (items) => items.flatMap((i) => (i.id === item.id ? [i, { ...i, id: uid('lib-'), name: `${i.name} copy`, after: i.id, updatedAt: new Date().toISOString() }] : [i]))),
        move: moveTargets(kind, item),
        delete: () => {
          // the whole saved item (its request and settings) and its place, to put it back as it was; the calls that
          // followed it follow what it followed, and follow it again after Undo
          let removed: { item: LibraryItem<unknown>; at: number } | undefined;
          let after = new Map<string, string>();
          const others = PLACED.filter((k) => k !== kind);
          void deleteWithUndo({
            kind: collectionCallKind(kind),
            name: item.name,
            focus: treeKey(item.collectionId ?? '', kind, item.id),
            run: async () => {
              closeTabsFor([item.id]);
              after = followers(item.collectionId, item.id);
              await editLibrary(kind, (items) => {
                const at = items.findIndex((i) => i.id === item.id);
                if (at >= 0) removed = { item: items[at]!, at };
                return withAfter(
                  items.filter((i) => i.id !== item.id),
                  after,
                );
              });
              for (const k of others) if (listOf(k).some((i) => after.has(i.id))) await editPlaced(k, (items) => withAfter(items, after));
            },
            undo: async () => {
              if (!removed) return;
              const back = new Map([...after.keys()].map((id) => [id, item.id]));
              await editLibrary(kind, (items) => withAfter(putBack(items, removed!.item, removed!.at), back));
              for (const k of others) if (listOf(k).some((i) => back.has(i.id))) await editPlaced(k, (items) => withAfter(items, back));
            },
          });
        },
      },
    };
  };

  const grpcByCollection = useMemo(() => groupByCollection(grpc), [grpc]);
  const socketsByCollection = useMemo(() => groupByCollection(sockets), [sockets]);
  const serversByCollection = useMemo(() => groupByCollection(servers), [servers]);
  // the tree is memoized: its saved items change only with these lists (or a rename in place); menus read the latest
  const latest = useRef({ savedMenu, serverMenu, renameSaved });
  latest.current = { savedMenu, serverMenu, renameSaved };
  const extraGroups = useCallback(
    (c: Collection): ExtraGroup[] => [
      {
        cat: 'grpc',
        kind: collectionCallKind('grpc'),
        items: grpcByCollection.get(c.id) ?? NONE,
        onOpen: (id) => void openRef({ kind: 'saved', library: 'grpc', itemId: id }),
        menu: (id) =>
          latest.current.savedMenu(
            'grpc',
            grpc.find((i) => i.id === id)!,
          ),
        rename: (id) => latest.current.renameSaved('grpc', id),
      },
      {
        cat: 'websocket',
        kind: collectionCallKind('websocket'),
        items: socketsByCollection.get(c.id) ?? NONE,
        onOpen: (id) => void openRef({ kind: 'saved', library: 'websocket', itemId: id }),
        menu: (id) =>
          latest.current.savedMenu(
            'websocket',
            sockets.find((i) => i.id === id)!,
          ),
        rename: (id) => latest.current.renameSaved('websocket', id),
      },
      {
        cat: 'mcp',
        kind: 'mcp-server',
        items: serversByCollection.get(c.id) ?? NONE,
        onOpen: (id) => void openRef({ kind: 'mcp-server', serverId: id }),
        menu: (id) => latest.current.serverMenu(servers.find((i) => i.id === id)!),
        rename: (id) => latest.current.renameSaved('mcp', id),
      },
    ],
    // (not `renaming`: the tree shows the renamed item by its `extraRenaming` prop; rename() reads `latest`)
    [grpcByCollection, socketsByCollection, serversByCollection, grpc, sockets, servers],
  );
  // the same functions on every render, so the memoized tree re-renders only when what it shows changed
  const stable = useStableCallbacks({
    onDropSaved: moveItem,
    onCallsAfter: setAfter,
    onFolderCallsRemove: folderCalls.remove,
    onFolderCallsMove: folderCalls.move,
    onFolderCallsCopy: folderCalls.copy,
    idsIn: (collectionId: string) => callsIn(collectionId).map((i) => i.id),
  });
  const tree = useMemo<CollectionCallsTreeProps>(
    () => ({
      extraGroups,
      extraRenaming: renaming,
      onDropSaved: stable.onDropSaved,
      onCallsAfter: stable.onCallsAfter,
      onFolderCallsRemove: stable.onFolderCallsRemove,
      onFolderCallsMove: stable.onFolderCallsMove,
      onFolderCallsCopy: stable.onFolderCallsCopy,
    }),
    [extraGroups, renaming, stable],
  );
  return { tree, idsIn: stable.idsIn, reload: load };
}
