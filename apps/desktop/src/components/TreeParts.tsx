import { ChevronDown, ChevronRight, Folder, FolderInput, FolderOpen, FolderPlus, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import { confirmAction, promptText } from '../store';
import { cx, Menu, rowActionClass, type MenuItem } from './ui';

/*
 * The parts every sidebar tree is made of (the explorer, monitors, load tests, saved prompts …), so they all look
 * and behave the same: a header with + and ⋯, folder rows, the ⋯ and + buttons of a row, and the folder menus.
 */

/** The ⋯ button of a row: opens its menu (a right-click on the row opens the same one). */
export function RowMenu({ label, items, open, onOpenChange, header }: { label: string; items: MenuItem[]; open?: boolean; onOpenChange?(open: boolean): void; header?: boolean }) {
  return (
    <Menu
      width={230}
      open={open}
      onOpenChange={onOpenChange}
      items={items}
      trigger={
        <button aria-label={`More actions for ${label}`} className={rowActionClass(header)} onClick={(e) => e.stopPropagation()}>
          <MoreHorizontal size={14} />
        </button>
      }
    />
  );
}

/** A count beside a title or folder name. */
export function CountPill({ n }: { n: number }) {
  return <span className="text-[0.7rem] px-1.5 rounded-full bg-panel2 text-muted tabular-nums shrink-0">{n}</span>;
}

/** The header of a sidebar list: title, count, + (new) and ⋯ (also on right-click). */
export function TreeHeader({
  title,
  icon,
  count,
  addLabel,
  onAdd,
  addItems,
  menu = [],
}: {
  title: string;
  icon?: ReactNode;
  count?: number;
  addLabel?: string;
  onAdd?(): void;
  /** The + opens these (kinds of new item) instead of calling onAdd; the ⋯ menu lists them too. */
  addItems?: MenuItem[];
  menu?: MenuItem[];
}) {
  const [open, setOpen] = useState(false);
  const adds: MenuItem[] = addItems ?? (onAdd ? [{ label: addLabel ?? 'New', icon: <Plus size={14} />, onSelect: onAdd }] : []);
  const items: MenuItem[] = [...adds, ...menu.map((m, i) => (i === 0 && adds.length > 1 ? { ...m, separator: true } : m))];
  return (
    <div
      className={cx('group flex items-center gap-0.5 h-9 pl-3 pr-1 shrink-0', open && 'bg-hover')}
      onContextMenu={(e) => {
        e.preventDefault();
        setOpen(true);
      }}
    >
      {icon && <span className="text-muted shrink-0 mr-1">{icon}</span>}
      <span className="text-[0.82rem] font-semibold truncate">{title}</span>
      {count !== undefined && count > 0 && (
        <span className="ml-1.5">
          <CountPill n={count} />
        </span>
      )}
      <span className="flex-1" />
      {items.length > 0 && <RowMenu label={title} items={items} open={open} onOpenChange={setOpen} header />}
    </div>
  );
}

/** A folder row: chevron, folder icon, name, count and ⋯ (also on right-click); drop props make it a drop target. */
export function TreeFolderRow({
  name,
  count,
  open,
  onToggle,
  menu,
  dropTarget,
  className,
  onRename,
  ...rest
}: { name: string; count: number; open: boolean; onToggle(): void; menu: MenuItem[]; dropTarget?: boolean; onRename?(to: string): unknown } & Omit<HTMLAttributes<HTMLDivElement>, 'onToggle'>) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const key = `folder:${name}`;
  // with onRename, "Rename folder" in the menu (and F2) renames in place instead of asking in a dialog
  const items = onRename ? menu.map((m) => (m.label === 'Rename folder' ? { ...m, onSelect: () => setEditing(true) } : m)) : menu;
  return (
    <div
      {...rest}
      className={cx(
        'group flex items-center h-8 text-sm rounded-md mx-1 pr-1 transition-colors',
        dropTarget ? 'bg-accent-soft ring-1 ring-accent' : 'hover:bg-hover',
        menuOpen && 'bg-hover',
        className ?? 'pl-2',
      )}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuOpen(true);
      }}
    >
      {editing ? (
        <div className="flex items-center gap-1 flex-1 min-w-0">
          {open ? <ChevronDown size={13} className="text-muted shrink-0" /> : <ChevronRight size={13} className="text-muted shrink-0" />}
          <Folder size={13} className="text-muted shrink-0" />
          <InlineRename
            value={name}
            label="Folder name"
            onCommit={(to) => {
              setEditing(false);
              void onRename?.(to);
              focusRow(`folder:${to}`);
            }}
            onCancel={() => {
              setEditing(false);
              focusRow(key);
            }}
          />
        </div>
      ) : (
        <button
          className="flex items-center gap-1 flex-1 min-w-0 text-left"
          onClick={onToggle}
          onKeyDown={(e) => {
            if (e.key === 'F2' && onRename) {
              e.preventDefault();
              setEditing(true);
            }
          }}
          aria-expanded={open}
          data-tree-row
          data-rename-id={key}
          title={onRename ? 'F2 renames' : undefined}
        >
          {open ? <ChevronDown size={13} className="text-muted shrink-0" /> : <ChevronRight size={13} className="text-muted shrink-0" />}
          <Folder size={13} className="text-muted shrink-0" />
          <span className="truncate flex-1">{name}</span>
          <CountPill n={count} />
        </button>
      )}
      <RowMenu label={`folder ${name}`} items={items} open={menuOpen} onOpenChange={setMenuOpen} />
    </div>
  );
}

/** A folder's menu, the same in every tree: new item here, rename, delete (its items move to the top level). */
export function folderMenuItems({
  name,
  itemNoun = 'item',
  addLabel,
  onAdd,
  rename,
  remove,
}: {
  name: string;
  itemNoun?: string;
  addLabel?: string;
  onAdd?(): void;
  rename(to: string): unknown;
  remove(): unknown;
}): MenuItem[] {
  return [
    ...(onAdd ? [{ label: `${addLabel ?? 'New'} here`, icon: <Plus size={14} />, onSelect: onAdd }] : []),
    {
      label: 'Rename folder',
      icon: <Pencil size={14} />,
      onSelect: async () => {
        const to = (await promptText('Rename folder', { message: 'Folder name', value: name, okLabel: 'Rename' }))?.trim();
        if (to && to !== name) await rename(to);
      },
    },
    {
      label: 'Delete folder',
      icon: <Trash2 size={14} />,
      danger: true,
      separator: true,
      onSelect: async () => {
        if (
          await confirmAction({
            title: 'Delete folder',
            message: `Delete the folder "${name}"?`,
            detail: `Its ${itemNoun}s are kept and move to the top level.`,
            confirmLabel: 'Delete folder',
            danger: true,
          })
        )
          await remove();
      },
    },
  ];
}

/** Ask for a new folder's name. */
export const askFolderName = async () => (await promptText('New folder', { message: 'Folder name', okLabel: 'Create' }))?.trim() || undefined;

/** "Move to folder" in an item's menu: each folder, a new one, or the top level. */
export function moveToFolderItem({ folders, current, move }: { folders: string[]; current?: string; move(folder: string | undefined): unknown }): MenuItem {
  const others = folders.filter((f) => f !== current);
  return {
    label: 'Move to folder',
    icon: <FolderInput size={14} />,
    onSelect: () => undefined,
    items: [
      ...others.map((f) => ({ label: f, icon: <Folder size={14} />, onSelect: () => void move(f) })),
      {
        label: 'New folder…',
        icon: <FolderPlus size={14} />,
        separator: others.length > 0,
        onSelect: async () => {
          const name = await askFolderName();
          if (name) await move(name);
        },
      },
      ...(current ? [{ label: 'Move to top level', icon: <FolderOpen size={14} />, onSelect: () => void move(undefined) }] : []),
    ],
  };
}

/**
 * A name edited in place (rename in a tree, a list or a tab): the text is selected, Enter or clicking away saves,
 * Esc cancels. A blank name (or what `validate` refuses) is not saved: the field shows why, and clicking away
 * cancels. Keys stay in the field, so tree shortcuts (F2, Delete, arrows) don't fire while typing.
 */
export function InlineRename({ value, onCommit, onCancel, validate, label = 'Name', className }: { value: string; onCommit(name: string): void; onCancel(): void; validate?(name: string): string | undefined; label?: string; className?: string }) {
  const [text, setText] = useState(value);
  const [error, setError] = useState<string>();
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    // after a menu closes (Rename in a ⋯ menu) its focus handling may run late and take the focus: take it back
    const grab = () => {
      const a = document.activeElement as HTMLElement | null;
      // never from another field the user went to: only from nothing, or a button / menu that just closed
      const typing = a && a !== ref.current && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
      if (ref.current && a !== ref.current && !typing) {
        ref.current.focus();
        ref.current.select();
      }
    };
    const id = requestAnimationFrame(grab);
    const timers = [60, 200, 450, 900].map((ms) => setTimeout(grab, ms));
    return () => (cancelAnimationFrame(id), timers.forEach(clearTimeout));
  }, []);
  // a click anywhere else ends the rename, even if the field lost the focus to something else
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) ref.current.blur(), finishRef.current();
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, []);
  const check = (t: string) => (!t.trim() ? 'A name is required' : validate?.(t.trim()));
  const finish = (save: boolean) => {
    if (done.current) return;
    const t = text.trim();
    const problem = check(text);
    if (save && problem) return setError(problem);
    done.current = true;
    if (save && t !== value) onCommit(t);
    else onCancel();
  };
  // what clicking away does, with the latest text
  const finishRef = useRef(() => {});
  finishRef.current = () => (check(text) ? finish(false) : finish(true));
  return (
    <span className={cx('relative flex-1 min-w-0', className)}>
      <input
        ref={ref}
        aria-label={label}
        aria-invalid={!!error}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (error) setError(check(e.target.value));
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            finish(true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            finish(false);
          }
        }}
        // clicking away saves a valid name and drops an invalid one
        onBlur={() => (check(text) ? finish(false) : finish(true))}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onDragStart={(e) => (e.preventDefault(), e.stopPropagation())}
        className={cx('w-full h-6 px-1.5 -ml-1.5 rounded-md bg-field text-fg text-sm border outline-none focus:ring-2', error ? 'border-bad focus:ring-bad/30' : 'border-accent focus:ring-accent/30')}
      />
      {error && <span role="alert" className="absolute left-0 top-full mt-1 z-20 rounded-md bg-bad text-white text-xs px-2 py-0.5 shadow whitespace-nowrap">{error}</span>}
    </span>
  );
}

/** Put the keyboard back on a row after an inline rename (rows carry data-rename-id). */
export const focusRow = (id: string) => requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-rename-id="${CSS.escape(id)}"]`)?.focus());

/**
 * The keyboard in every tree and list (put it on the container's onKeyDown): ↑ ↓ move between rows, Home / End jump to
 * the first and last, → opens a closed folder and ← closes an open one. Rows are the elements with data-tree-row.
 */
export function treeKeys(e: React.KeyboardEvent<HTMLElement>): void {
  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-tree-row]');
  if (!row || (e.target as HTMLElement).tagName === 'INPUT') return;
  const rows = () => [...e.currentTarget.querySelectorAll<HTMLElement>('[data-tree-row]')].filter((r) => r.offsetParent);
  const go = (next?: HTMLElement) => {
    if (!next) return;
    e.preventDefault();
    next.focus();
    next.scrollIntoView({ block: 'nearest' });
  };
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const all = rows();
    go(all[all.indexOf(row) + (e.key === 'ArrowDown' ? 1 : -1)]);
  } else if (e.key === 'Home') go(rows()[0]);
  else if (e.key === 'End') go(rows().at(-1));
  else if ((e.key === 'ArrowRight' && row.getAttribute('aria-expanded') === 'false') || (e.key === 'ArrowLeft' && row.getAttribute('aria-expanded') === 'true')) {
    e.preventDefault();
    row.click();
  }
}

/** The kind of a row (gRPC, WS, MQTT, MCP, API …), in the same small badge as a request's method; colours match the editor tabs. */
export function KindBadge({ text, cls }: { text: string; cls: string }) {
  return <span className={cx('mono text-[0.6rem] font-bold w-8 inline-block', cls)}>{text}</span>;
}
