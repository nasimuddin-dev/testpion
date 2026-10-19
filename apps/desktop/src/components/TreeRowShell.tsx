import { useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import type { ItemRef } from '@testpion/shared';
import { buildNodeMenu, type NodeKind, type NodeMenuCtx } from '../lib/node-menu';
import { setDragRefs } from '../lib/drag-ref';
import { LABEL } from '../lib/vocabulary';
import { InlineRename, keepFocusAfterDelete, neighbourRowId, NodeMenu, withRefDefaults } from './TreeParts';
import { cx } from './ui';

/**
 * The one row of every tree and list (planning/menus-uniform.md §3): the same ⋯ button, right-click, keyboard menu
 * (Shift+F10, the menu key), F2 (Rename), Delete (Delete…), `*` (Expand all), Enter (open), the rename field, drag source
 * and drop target, `data-node-id`, a slot for a change mark, the tree semantics for screen readers (treeitem, its level,
 * whether it is selected) and the tooltip (the full name, only when it is cut). The keys run the row's menu items, so a
 * key never does what the menu doesn't offer. The menu is built only while it is open. After a Delete (key or menu)
 * the keyboard moves to the next row instead of nowhere.
 */
export interface TreeRowShellProps {
  kind: NodeKind;
  /** What the row's menu can do (read only when the menu opens or a key asks). */
  ctx: () => NodeMenuCtx;
  /** The row's id in the whole tree (`data-node-id`); also what F2 focuses after a rename, and Undo after a delete. */
  nodeId: string;
  /** The row's name: the ⋯ button's label ("More actions for …"), typeahead, the tooltip when the name is cut. */
  label: string;
  /** What the row shows (icon, name, counts …). */
  children: ReactNode;
  /** A single click (select, a preview tab, fold a folder); the event says whether Ctrl/⌘ was held. */
  onClick?(e: MouseEvent<HTMLButtonElement>): void;
  /** Open for good: a double-click, Enter. */
  onOpen?(): void;
  active?: boolean;
  /** A container's state (aria-expanded; ← and → fold and unfold through onClick). */
  expanded?: boolean;
  /** How deep the row is (0: top level): aria-level, and what a deleted folder's keyboard skips over. */
  depth?: number;
  /** The rename field instead of the row's content, while renaming in place (`validate`: why a name is refused). */
  rename?: { value: string; label?: string; validate?(name: string): string | undefined; done(name?: string): void };
  /** The items a drag of this row carries (a flow canvas, another list, a collection). */
  drag?: ItemRef[];
  /** The view's own drag bookkeeping, with the drag (which row is dragged, for its drop targets) and when it ends. */
  onDragStart?(e: DragEvent): void;
  onDragEnd?(): void;
  /** A drop target: the props of a drop (dragover, drop) and whether something is over it (`'before'`: a line above the row). */
  drop?: { onDragOver(e: DragEvent): void; onDragLeave?(): void; onDrop(e: DragEvent): void; over?: boolean | 'into' | 'before' };
  /** The change mark slot (git: A, M, D …), at the end of the row. */
  mark?: ReactNode;
  /** A row's quick action buttons (Run …), before its ⋯ (each also in the menu). */
  actions?: ReactNode;
  /** A section header: taller, the ⋯ faintly visible. */
  header?: boolean;
  /** A row of two lines (a name and a subtitle): its height follows its content. */
  tall?: boolean;
  /** `false`: a row with nothing to do (a collection whose file cannot be read): no ⋯, no menu, no keys. */
  menu?: boolean;
  /** The row's own keys (Alt+↑/↓ reorder environments), after the shared ones. */
  onKeyDown?(e: KeyboardEvent<HTMLButtonElement>): void;
  /** Extra attributes of the row's element (`data-run-row` …), for what a view's tests look for. */
  attrs?: Record<string, string | undefined>;
  className?: string;
  style?: CSSProperties;
}

export function TreeRowShell({ kind, ctx, nodeId, label, children, onClick, onOpen, active, expanded, depth, rename, drag, onDragStart, onDragEnd, drop, mark, actions, header, tall, menu = true, onKeyDown, attrs, className, style }: TreeRowShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  /** The row's menu context, with Delete… putting the keyboard on the next row once this one is gone. */
  const menuCtx = (): NodeMenuCtx => {
    const c = ctx();
    const del = c.on.delete;
    const row = button.current;
    if (typeof del !== 'function' || !row) return c;
    const neighbour = neighbourRowId(row);
    return {
      ...c,
      on: {
        ...c.on,
        delete: () => {
          keepFocusAfterDelete(row, neighbour);
          return del();
        },
      },
    };
  };
  /** Run the row's menu item with this label (a key does what the menu does, or nothing). */
  const runItem = (test: (label: string) => boolean): boolean => {
    const it = buildNodeMenu(kind, withRefDefaults(menuCtx(), kind)).find((i) => !i.disabled && !i.items && test(i.label));
    if (!it) return false;
    it.onSelect();
    return true;
  };
  const keys = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!menu) return onKeyDown?.(e);
    if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      e.preventDefault();
      e.stopPropagation();
      setMenuOpen(true);
    } else if (e.key === 'F2') {
      if (runItem((l) => l.startsWith('Rename'))) e.preventDefault();
    } else if (e.key === 'Delete') {
      if (runItem((l) => l.startsWith('Delete'))) e.preventDefault();
    } else if (e.key === '*') {
      if (runItem((l) => l === LABEL.expandAll)) e.preventDefault();
    } else if (e.key === 'Enter' && onOpen) {
      e.preventDefault();
      onOpen();
    } else onKeyDown?.(e);
  };
  /** The tooltip: the full name, only when the row's name is cut (a title that repeats what is visible is noise). */
  const tooltip = (e: MouseEvent<HTMLButtonElement>) => {
    const b = e.currentTarget;
    const name = b.querySelector<HTMLElement>('.truncate');
    if (name && name.scrollWidth > name.clientWidth + 1) b.title = label;
    else b.removeAttribute('title');
  };
  return (
    <div
      data-node-id={nodeId}
      data-node-kind={kind}
      {...attrs}
      className={cx(
        'group flex items-center rounded-md mx-1 pr-1 transition-colors',
        header ? 'h-9' : tall ? 'min-h-8' : 'h-8',
        drop?.over === 'before' ? 'shadow-[inset_0_2px_0_var(--accent)]' : drop?.over ? 'bg-accent-soft ring-1 ring-inset ring-accent' : active ? 'bg-accent-soft' : menuOpen ? 'bg-hover' : 'hover:bg-hover',
        className,
      )}
      style={style}
      draggable={!!drag?.length && !rename}
      onDragStart={
        drag?.length
          ? (e) => {
              e.stopPropagation();
              e.dataTransfer.effectAllowed = 'copyMove';
              setDragRefs(e, drag, label);
              onDragStart?.(e);
            }
          : undefined
      }
      onDragEnd={onDragEnd}
      onDragOver={drop?.onDragOver}
      onDragLeave={drop?.onDragLeave}
      onDrop={drop?.onDrop}
      onContextMenu={
        menu
          ? (e) => {
              e.preventDefault();
              setMenuOpen(true);
            }
          : undefined
      }
    >
      {rename ? (
        <div className="flex items-center gap-2 flex-1 min-w-0 text-sm">
          <InlineRename value={rename.value} label={rename.label} validate={rename.validate} onCommit={(name) => rename.done(name)} onCancel={() => rename.done()} />
        </div>
      ) : (
        <button
          ref={button}
          className={cx('flex items-center gap-2 flex-1 min-w-0 text-sm text-left', tall ? 'py-1.5' : 'h-full')}
          onClick={onClick}
          onDoubleClick={onOpen}
          onKeyDown={keys}
          onMouseEnter={tooltip}
          role="treeitem"
          aria-level={(depth ?? 0) + 1}
          aria-selected={!!active}
          aria-expanded={expanded}
          data-tree-row
          data-rename-id={nodeId}
          data-row-name={label}
        >
          {children}
        </button>
      )}
      {mark && <span className="shrink-0 ml-1">{mark}</span>}
      {actions}
      {menu && <NodeMenu kind={kind} label={label} header={header} open={menuOpen} onOpenChange={setMenuOpen} ctx={menuCtx} />}
    </div>
  );
}
