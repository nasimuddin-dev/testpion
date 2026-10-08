import { Copy, FolderPlus, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { confirmAction } from '../store';
import { Button, cx, Input, type MenuItem } from './ui';
import { closeTabsFor } from './EditorTabs';
import { askFolderName, focusRow, folderMenuItems, InlineRename, moveToFolderItem, RowMenu, TreeFolderRow, TreeHeader, treeKeys } from './TreeParts';
import { usePersisted } from '../lib/sticky';

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
  deleteItem(id: string): void | Promise<void>;
  duplicateItem?(id: string): void | Promise<void>;
  setFolders(folders: string[]): void | Promise<void>;
  renameFolder(from: string, to: string): void | Promise<void>;
  /** Remove a folder; its items move to the top level. */
  deleteFolder(name: string): void | Promise<void>;
}

const collapsedKey = (id: string) => `aps.folders.${id}`;

/**
 * Sidebar list with folders, like the REST collections: collapsible folders, New folder, rename, move to
 * folder (menu or drag and drop), duplicate, delete, and a right-click menu on every row.
 */
export function FolderList({
  id,
  title,
  items,
  folders,
  selected,
  onSelect,
  onAdd,
  addLabel,
  ops,
  itemMenu,
  itemNoun = 'item',
  empty,
}: {
  /** Stable id (remembers which folders are collapsed). */
  id: string;
  title: string;
  items: FolderListItem[];
  folders: string[];
  selected?: string;
  onSelect(id: string): void;
  /** Add an item (inside a folder when given). */
  onAdd(folder?: string): void;
  addLabel: string;
  ops: FolderListOps;
  /** Extra menu entries for an item (shown before the standard ones). */
  itemMenu?(id: string): MenuItem[];
  itemNoun?: string;
  empty?: ReactNode;
}) {
  const [collapsed, setCollapsed] = usePersisted<Record<string, boolean>>(collapsedKey(id), {});
  const [menuFor, setMenuFor] = useState<string>();
  /** The item being renamed in place (F2, or Rename in its menu). */
  const [renaming, setRenaming] = useState<string>();
  const finishRename = (id: string, name?: string) => {
    setRenaming(undefined);
    if (name) void ops.renameItem(id, name);
    focusRow(id);
  };
  // filter by name, subtitle or folder (like the REST collection tree)
  const [q, setQ] = useState('');
  const ql = q.trim().toLowerCase();
  const shown = ql ? items.filter((i) => [i.name, i.folder ?? '', typeof i.subtitle === 'string' ? i.subtitle : ''].some((t) => t.toLowerCase().includes(ql))) : items;
  const [dropTarget, setDropTarget] = useState<string | null>();
  const toggle = (f: string) => setCollapsed((c) => ({ ...c, [f]: !c[f] }));
  const allFolders = [...new Set([...folders, ...items.map((i) => i.folder).filter((f): f is string => !!f)])].sort((a, b) => a.localeCompare(b));

  const newFolder = async () => {
    const name = await askFolderName();
    if (name && !allFolders.includes(name)) await ops.setFolders([...allFolders, name]);
  };
  const moveTo = async (itemId: string, folder: string | undefined) => {
    if (folder && !allFolders.includes(folder)) await ops.setFolders([...allFolders, folder]);
    await ops.moveItem(itemId, folder);
  };
  const standardMenu = (it: FolderListItem): MenuItem[] => [
    ...(itemMenu?.(it.id) ?? []),
    { label: 'Rename', icon: <Pencil size={14} />, separator: !!itemMenu, onSelect: () => setRenaming(it.id) },
    ...(ops.duplicateItem ? [{ label: 'Duplicate', icon: <Copy size={14} />, onSelect: () => void ops.duplicateItem!(it.id) }] : []),
    moveToFolderItem({ folders: allFolders, current: it.folder, move: (f) => moveTo(it.id, f) }),
    {
      label: 'Delete',
      icon: <Trash2 size={14} />,
      danger: true,
      separator: true,
      onSelect: () => void confirmAction({ title: `Delete ${itemNoun}`, message: `Delete "${it.name}"?`, confirmLabel: 'Delete', danger: true }).then((ok) => ok && ops.deleteItem(it.id)),
    },
  ];
  const folderMenu = (f: string): MenuItem[] => folderMenuItems({ name: f, itemNoun, addLabel, onAdd: () => onAdd(f), rename: (to) => ops.renameFolder(f, to), remove: () => ops.deleteFolder(f) });

  // drag an item onto a folder (or the top level) to move it
  const dropProps = (folder: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('application/x-testpion-item')) return;
      e.preventDefault();
      setDropTarget(folder);
    },
    onDragLeave: () => setDropTarget(undefined),
    onDrop: (e: React.DragEvent) => {
      const itemId = e.dataTransfer.getData('application/x-testpion-item');
      setDropTarget(undefined);
      if (itemId) void ops.moveItem(itemId, folder ?? undefined);
    },
  });

  const row = (it: FolderListItem, nested: boolean) => (
    <div
      key={it.id}
      draggable={renaming !== it.id}
      onDragStart={(e) => e.dataTransfer.setData('application/x-testpion-item', it.id)}
      onContextMenu={(e) => (e.preventDefault(), setMenuFor(it.id))}
      className={cx('group flex items-center gap-1 mx-1 pr-1 rounded-md cursor-pointer transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/40', nested ? 'pl-9' : 'pl-3', selected === it.id ? 'bg-accent-soft' : 'hover:bg-hover', menuFor === it.id && selected !== it.id && 'bg-hover')}
      onClick={() => renaming !== it.id && onSelect(it.id)}
      // the keyboard works like in the explorer: Enter opens, F2 renames
      role="button"
      tabIndex={0}
      aria-label={it.name}
      data-tree-row
      data-rename-id={it.id}
      title="Enter opens · F2 renames"
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          onSelect(it.id);
        } else if (e.key === 'F2') {
          e.preventDefault();
          setRenaming(it.id);
        }
      }}
    >
      <div className="flex-1 min-w-0 py-1.5">
        <div className="flex items-center gap-2 text-sm">
          {it.icon && <span className="shrink-0 grid place-items-center w-3.5">{it.icon}</span>}
          {renaming === it.id ? <InlineRename value={it.name} onCommit={(name) => finishRename(it.id, name)} onCancel={() => finishRename(it.id)} /> : <span className="truncate">{it.name}</span>}
          {it.badge && <span className="ml-auto shrink-0">{it.badge}</span>}
        </div>
        {it.subtitle && <div className={cx('text-xs text-muted truncate', !!it.icon && 'pl-[1.375rem]')}>{it.subtitle}</div>}
      </div>
      <RowMenu label={it.name} items={standardMenu(it)} open={menuFor === it.id} onOpenChange={(o) => setMenuFor(o ? it.id : undefined)} />
    </div>
  );

  const top = shown.filter((i) => !i.folder);
  return (
    <div className="h-full flex flex-col min-h-0">
      <TreeHeader title={title} count={items.length} addLabel={addLabel} onAdd={() => onAdd()} menu={[{ label: 'New folder', icon: <FolderPlus size={14} />, onSelect: () => void newFolder() }]} />
      {items.length > 0 && (
        <div className="px-2 pb-2 shrink-0">
          <Input className="w-full h-7 min-h-7 text-sm" placeholder={`Filter ${itemNoun}s`} aria-label={`Filter ${itemNoun}s`} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      )}
      <div className="flex-1 overflow-auto pb-2" onKeyDown={treeKeys}>
        {allFolders.filter((f) => !ql || shown.some((i) => i.folder === f)).map((f) => {
          const inFolder = shown.filter((i) => i.folder === f);
          const open = !!ql || !collapsed[f];
          return (
            <div key={`folder:${f}`}>
              <TreeFolderRow {...dropProps(f)} dropTarget={dropTarget === f} name={f} count={inFolder.length} open={open} onToggle={() => toggle(f)} menu={folderMenu(f)} onRename={(to) => ops.renameFolder(f, to)} />
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
    </div>
  );
}

/** FolderListOps for a Library (lib.get / lib.save) held in state: every change is saved. */
export function libraryOps<T>(lib: { folders: string[]; items: Array<{ id: string; name: string; folder?: string; data: T }> }, save: (next: typeof lib) => void | Promise<void>, newId: () => string): FolderListOps {
  const items = lib.items;
  return {
    renameItem: (id, name) => save({ ...lib, items: items.map((i) => (i.id === id ? { ...i, name } : i)) }),
    moveItem: (id, folder) => save({ ...lib, items: items.map((i) => (i.id === id ? { ...i, folder } : i)) }),
    deleteItem: (id) => {
      closeTabsFor([id]);
      return save({ ...lib, items: items.filter((i) => i.id !== id) });
    },
    duplicateItem: (id) => {
      const it = items.find((i) => i.id === id);
      if (it) return save({ ...lib, items: [...items, { ...it, id: newId(), name: `${it.name} copy` }] });
    },
    setFolders: (folders) => save({ ...lib, folders }),
    renameFolder: (from, to) => save({ folders: lib.folders.map((f) => (f === from ? to : f)), items: items.map((i) => (i.folder === from ? { ...i, folder: to } : i)) }),
    deleteFolder: (name) => save({ folders: lib.folders.filter((f) => f !== name), items: items.map((i) => (i.folder === name ? { ...i, folder: undefined } : i)) }),
  };
}
