import { FolderPlus, Plus } from 'lucide-react';
import { useMemo, useState, type DragEvent, type ReactNode } from 'react';
import { KIND_INFO, savedItemRef, toItemRef, type ItemRef, type KindId } from '@testpion/shared';
import { deleteWithUndo, putBack } from '../lib/undo-delete';
import { Button, cx, Input } from './ui';
import { closeTabsFor } from './EditorTabs';
import { askFolderName, CLOSED_ICON, CountPill, focusRow, FOLDER_ICON, moveToFolderItem, OPEN_ICON, treeKeys } from './TreeParts';
import { TreeRowShell } from './TreeRowShell';
import { useAreaMenu } from './AreaMenu';
import { useTreeOpen } from '../lib/tree-state';
import { openRef } from '../lib/open-ref';
import { REF_MIME } from '../lib/drag-ref';
import type { NodeKind, NodeMenuCtx } from '../lib/node-menu';
import { uniqueKeys } from '../lib/unique-keys';

export interface FolderListItem {
  id: string;
  name: string;
  folder?: string;
  subtitle?: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
}

/** What a list can do with its items and folders; each view stores them its own way. */
export interface FolderListOps {
  renameItem(id: string, name: string): void | Promise<void>;
  moveItem(id: string, folder: string | undefined): void | Promise<void>;
  /** Delete an item; returns what puts it back (the list then offers Undo instead of asking first). */
  deleteItem(id: string): Undo | Promise<Undo>;
  duplicateItem?(id: string): void | Promise<void>;
  setFolders(folders: string[]): void | Promise<void>;
  renameFolder(from: string, to: string): void | Promise<void>;
  /** Remove a folder; its items move to the top level. Returns what puts the folder and its items back. */
  deleteFolder(name: string): Undo | Promise<Undo>;
}

/** What puts a deleted item or folder back. */
export type Undo = () => unknown;

/** The item kinds a FolderList holds (library kinds: their items are in library/<library>.json). */
export type FolderListKind = Extract<KindId, 'prompt' | 'load-test' | 'evaluation' | 'monitor' | 'mcp-server'>;

/**
 * Sidebar list with folders, like the REST collections: collapsible folders, New folder, rename, move to folder (menu
 * or drag and drop), duplicate, delete with Undo. Every header, folder and row is a node of the list's `kind` with the
 * one menu (lib/node-menu.ts) on the one row (TreeRowShell); the view adds only its kind's own actions (`itemActions`).
 */
export function FolderList({
  id,
  kind,
  title,
  items,
  folders,
  selected,
  onSelect,
  onOpen,
  onAdd,
  addLabel,
  ops,
  itemActions,
  itemNoun = 'item',
  empty,
}: {
  /** Stable id (remembers which folders are open). */
  id: string;
  /** What its items are (their ItemRef, their menu). */
  kind: FolderListKind;
  title: string;
  items: FolderListItem[];
  folders: string[];
  selected?: string;
  onSelect(id: string): void;
  /** Open for good (double-click, Enter) where a click only previews (WF-19); without it they select too. */
  onOpen?(id: string): void;
  /** Add an item (inside a folder when given). */
  onAdd(folder?: string): void;
  addLabel: string;
  ops: FolderListOps;
  /** The kind's own actions for an item (Run, Pause …): handlers by action id, and why one can't run now. */
  itemActions?(id: string): Pick<NodeMenuCtx, 'on' | 'disabled'>;
  itemNoun?: string;
  empty?: ReactNode;
}) {
  const [opened, setOpened] = useTreeOpen(`list:${id}`);
  // one key per row even if two items share an id (a hand-edited or older library file): React never merges them
  const rowKey = useMemo(() => {
    const keys = uniqueKeys(items, (it) => it.id, `FolderList ${id}`);
    return new Map(items.map((it, i) => [it, String(keys[i])]));
  }, [items, id]);
  /** The item or folder being renamed in place (F2, or Rename in its menu). */
  const [renaming, setRenaming] = useState<string>();
  const finishRename = (itemId: string, name?: string) => {
    setRenaming(undefined);
    if (name) void ops.renameItem(itemId, name);
    focusRow(`${id}:${itemId}`);
  };
  // filter by name, subtitle or folder (like the REST collection tree)
  const [q, setQ] = useState('');
  const ql = q.trim().toLowerCase();
  const shown = ql ? items.filter((i) => [i.name, i.folder ?? '', typeof i.subtitle === 'string' ? i.subtitle : ''].some((t) => t.toLowerCase().includes(ql))) : items;
  const [dropTarget, setDropTarget] = useState<string | null>();
  const isOpen = (f: string) => opened[f] ?? true;
  const toggle = (f: string) => setOpened((o) => ({ ...o, [f]: !(o[f] ?? true) }));
  const allFolders = [...new Set([...folders, ...items.map((i) => i.folder).filter((f): f is string => !!f)])].sort((a, b) => a.localeCompare(b));
  const library = KIND_INFO[kind].library;
  const refOf = (itemId: string): ItemRef => (kind === 'mcp-server' ? { kind: 'mcp-server', serverId: itemId } : savedItemRef(library!, itemId));

  const newFolder = async () => {
    const name = await askFolderName();
    if (name && !allFolders.includes(name)) await ops.setFolders([...allFolders, name]);
  };
  const moveTo = async (itemId: string, folder: string | undefined) => {
    if (folder && !allFolders.includes(folder)) await ops.setFolders([...allFolders, folder]);
    await ops.moveItem(itemId, folder);
  };
  const setAll = (to: boolean) => setOpened((o) => ({ ...o, ...Object.fromEntries(allFolders.map((f) => [f, to])) }));
  /** The list's header (and its blank area): new item, new folder, expand or collapse every folder. */
  const headerCtx = (): NodeMenuCtx => ({
    create: [{ label: addLabel, icon: <Plus size={14} />, onSelect: () => onAdd() }],
    on: { newFolder: () => void newFolder(), expandAll: () => setAll(true), collapseAll: () => setAll(false) },
  });
  const itemCtx = (it: FolderListItem): NodeMenuCtx => {
    const own = itemActions?.(it.id);
    const ref = refOf(it.id);
    return {
      ref,
      name: it.name,
      on: {
        open: () => (onOpen ?? onSelect)(it.id),
        openNewTab: () => void openRef(ref, { newTab: true }),
        rename: () => setRenaming(it.id),
        ...(ops.duplicateItem ? { duplicate: () => void ops.duplicateItem!(it.id) } : {}),
        move: moveToFolderItem({ folders: allFolders, current: it.folder, move: (f) => moveTo(it.id, f) }).items!,
        delete: () => void deleteWithUndo({ what: `${itemNoun} "${it.name}"`, run: () => ops.deleteItem(it.id) }),
        ...own?.on,
      },
      disabled: own?.disabled,
    };
  };
  const folderCtx = (f: string): NodeMenuCtx => ({
    name: f,
    create: [{ label: `${addLabel} here`, icon: <Plus size={14} />, onSelect: () => onAdd(f) }],
    on: {
      expandAll: () => setOpened((o) => ({ ...o, [f]: true })),
      collapseAll: () => setOpened((o) => ({ ...o, [f]: false })),
      rename: () => setRenaming(`folder:${f}`),
      // at once, with Undo in the message: nothing is lost (its items move to the top level)
      delete: () => void deleteWithUndo({ what: `the folder "${f}"`, run: () => ops.deleteFolder(f), note: `Its ${itemNoun}s moved to the top level` }),
    },
  });

  // drag an item onto a folder (or the top level) to move it: the one drag type every list and tree uses (its ItemRef)
  const idsOf = (e: DragEvent): string[] => {
    try {
      const refs = (JSON.parse(e.dataTransfer.getData(REF_MIME) || '[]') as unknown[]).map(toItemRef);
      const mine = new Set(items.map((i) => i.id));
      return refs.map((r) => (r?.kind === 'saved' ? r.itemId : r?.kind === 'monitor' ? r.monitorId : r?.kind === 'mcp-server' ? r.serverId : undefined)).filter((x): x is string => !!x && mine.has(x));
    } catch {
      return [];
    }
  };
  const dropProps = (folder: string | null) => ({
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(REF_MIME)) return;
      e.preventDefault();
      setDropTarget(folder);
    },
    onDragLeave: () => setDropTarget(undefined),
    onDrop: (e: DragEvent) => {
      const ids = idsOf(e);
      setDropTarget(undefined);
      if (!ids.length) return;
      e.preventDefault();
      for (const itemId of ids) void ops.moveItem(itemId, folder ?? undefined);
    },
    over: dropTarget === folder,
  });

  const row = (it: FolderListItem, nested: boolean) => (
    <TreeRowShell
      key={rowKey.get(it) ?? it.id}
      kind={kind}
      nodeId={`${id}:${rowKey.get(it) ?? it.id}`}
      label={it.name}
      tall={!!it.subtitle}
      active={selected === it.id}
      onClick={() => renaming !== it.id && onSelect(it.id)}
      onOpen={() => renaming !== it.id && (onOpen ?? onSelect)(it.id)}
      ctx={() => itemCtx(it)}
      drag={[refOf(it.id)]}
      rename={renaming === it.id ? { value: it.name, done: (name) => finishRename(it.id, name) } : undefined}
      className={nested ? 'pl-9' : 'pl-3'}
      title={`${it.name} · Enter opens · F2 renames · Delete deletes`}
    >
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-2">
          {it.icon && <span className="shrink-0 grid place-items-center w-3.5">{it.icon}</span>}
          <span className="truncate">{it.name}</span>
          {it.badge && <span className="ml-auto shrink-0">{it.badge}</span>}
        </span>
        {it.subtitle && <span className={cx('block text-xs text-muted truncate', !!it.icon && 'pl-[1.375rem]')}>{it.subtitle}</span>}
      </span>
    </TreeRowShell>
  );

  const area = useAreaMenu(`section:${kind}` as NodeKind, headerCtx, title);
  const top = shown.filter((i) => !i.folder);
  return (
    <div className="h-full flex flex-col min-h-0">
      <TreeRowShell kind={`section:${kind}` as NodeKind} nodeId={`${id}:section`} label={title} header ctx={headerCtx} className="mx-0 pl-3 shrink-0">
        <span className="text-[0.82rem] font-semibold truncate">{title}</span>
        {items.length > 0 && <CountPill n={items.length} />}
      </TreeRowShell>
      {items.length > 0 && (
        <div className="px-2 pb-2 shrink-0">
          <Input className="w-full h-7 min-h-7 text-sm" placeholder={`Filter ${itemNoun}s`} aria-label={`Filter ${itemNoun}s`} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      )}
      <div className="flex-1 overflow-auto pb-2" onKeyDown={treeKeys} onContextMenu={area.onContextMenu}>
        {allFolders
          .filter((f) => !ql || shown.some((i) => i.folder === f))
          .map((f) => {
            const inFolder = shown.filter((i) => i.folder === f);
            const open = !!ql || isOpen(f);
            return (
              <div key={`folder:${f}`}>
                <TreeRowShell
                  kind={`folder:${kind}` as NodeKind}
                  nodeId={`${id}:folder:${f}`}
                  label={f}
                  expanded={open}
                  onClick={() => toggle(f)}
                  ctx={() => folderCtx(f)}
                  drop={dropProps(f)}
                  className="pl-2"
                  rename={
                    renaming === `folder:${f}`
                      ? {
                          value: f,
                          label: 'Folder name',
                          done: (to) => {
                            setRenaming(undefined);
                            if (to && to !== f) void ops.renameFolder(f, to);
                            focusRow(`${id}:folder:${to || f}`);
                          },
                        }
                      : undefined
                  }
                >
                  {open ? OPEN_ICON : CLOSED_ICON}
                  {FOLDER_ICON}
                  <span className="truncate flex-1">{f}</span>
                  <CountPill n={inFolder.length} />
                </TreeRowShell>
                {open && inFolder.map((it) => row(it, true))}
                {open && !inFolder.length && <div className="pl-9 py-1 text-xs text-muted">Empty folder: drag a {itemNoun} here or use Move to folder.</div>}
              </div>
            );
          })}
        <div {...dropProps(null)} className={cx(dropTarget === null && 'bg-accent-soft/60')}>
          {top.map((it) => row(it, false))}
          {!items.length && !allFolders.length && (
            <>
              {empty}
              <div className="flex flex-wrap justify-center gap-2 px-3 pb-3">
                <Button size="sm" icon={<Plus size={12} />} onClick={() => onAdd()}>
                  {addLabel}
                </Button>
                <Button size="sm" variant="ghost" icon={<FolderPlus size={12} />} onClick={() => void newFolder()}>
                  New folder
                </Button>
              </div>
            </>
          )}
          {ql && !shown.length && <p className="px-3 py-4 text-sm text-muted text-center">No {itemNoun}s match this filter.</p>}
          {allFolders.length > 0 && <div className="h-6" aria-hidden />}
        </div>
      </div>
      {area.menu}
    </div>
  );
}

/** FolderListOps for a Library (lib.get / lib.save) held in state: every change is saved. */
export function libraryOps<T>(
  lib: { folders: string[]; items: Array<{ id: string; name: string; folder?: string; data: T }> },
  save: (next: typeof lib) => void | Promise<void>,
  newId: () => string,
  /** The library as saved now (an undo puts its item back into that, not into the list it was deleted from). */
  latest: () => Promise<typeof lib> = async () => lib,
): FolderListOps {
  const items = lib.items;
  return {
    renameItem: (id, name) => save({ ...lib, items: items.map((i) => (i.id === id ? { ...i, name } : i)) }),
    moveItem: (id, folder) => save({ ...lib, items: items.map((i) => (i.id === id ? { ...i, folder } : i)) }),
    deleteItem: async (id) => {
      const at = items.findIndex((i) => i.id === id);
      const it = items[at];
      closeTabsFor([id]);
      await save({ ...lib, items: items.filter((i) => i.id !== id) });
      return async () => {
        const cur = await latest();
        if (it) await save({ ...cur, items: putBack(cur.items, it, at) });
      };
    },
    duplicateItem: (id) => {
      const it = items.find((i) => i.id === id);
      if (it) return save({ ...lib, items: [...items, { ...it, id: newId(), name: `${it.name} copy` }] });
    },
    setFolders: (folders) => save({ ...lib, folders }),
    renameFolder: (from, to) => save({ folders: lib.folders.map((f) => (f === from ? to : f)), items: items.map((i) => (i.folder === from ? { ...i, folder: to } : i)) }),
    deleteFolder: async (name) => {
      const was = new Set(items.filter((i) => i.folder === name).map((i) => i.id));
      const at = lib.folders.indexOf(name);
      await save({ folders: lib.folders.filter((f) => f !== name), items: items.map((i) => (i.folder === name ? { ...i, folder: undefined } : i)) });
      return async () => {
        const cur = await latest();
        await save({ folders: restoreFolder(cur.folders, name, at), items: cur.items.map((i) => (was.has(i.id) && !i.folder ? { ...i, folder: name } : i)) });
      };
    },
  };
}

/** The folder list with `name` back at `index` (unless it is there again). */
export function restoreFolder(folders: string[], name: string, index: number): string[] {
  if (folders.includes(name)) return folders;
  const at = Math.max(0, Math.min(index < 0 ? folders.length : index, folders.length));
  return [...folders.slice(0, at), name, ...folders.slice(at)];
}
