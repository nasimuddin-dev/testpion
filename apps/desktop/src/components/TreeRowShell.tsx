import { useState, type CSSProperties, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { ItemRef } from '@testpion/shared';
import { buildNodeMenu, type NodeKind, type NodeMenuCtx } from '../lib/node-menu';
import { setDragRefs } from '../lib/drag-ref';
import { LABEL } from '../lib/vocabulary';
import { InlineRename, NodeMenu, withRefDefaults } from './TreeParts';
import { cx } from './ui';

/**
 * The one row of every tree and list (planning/menus-uniform.md §3): the same ⋯ button, right-click, keyboard menu
 * (Shift+F10, the menu key), F2 (Rename), Delete (Delete…), `*` (Expand all), Enter (open), the rename field, drag source
 * and drop target, `data-node-id`, and a slot for a change mark. The keys run the row's menu items, so a key never does
 * what the menu doesn't offer. The menu is built only while it is open.
 */
export interface TreeRowShellProps {
  kind: NodeKind;
  /** What the row's menu can do (read only when the menu opens or a key asks). */
  ctx: () => NodeMenuCtx;
  /** The row's id in the whole tree (`data-node-id`); also what F2 focuses after a rename. */
  nodeId: string;
  /** The row's name: the ⋯ button's label ("More actions for …"), typeahead. */
  label: string;
  /** What the row shows (icon, name, counts …). */
  children: ReactNode;
  /** A single click (select, a preview tab, fold a folder). */
  onClick?(): void;
  /** Open for good: a double-click, Enter. */
  onOpen?(): void;
  active?: boolean;
  /** A container's state (aria-expanded; ← and → fold and unfold through onClick). */
  expanded?: boolean;
  /** The rename field instead of the row's content, while renaming in place. */
  rename?: { value: string; label?: string; done(name?: string): void };
  /** The items a drag of this row carries (a flow canvas, another list, a collection). */
  drag?: ItemRef[];
  /** A drop target: the props of a drop (dragover, drop) and whether something is over it. */
  drop?: { onDragOver(e: DragEvent): void; onDragLeave?(): void; onDrop(e: DragEvent): void; over?: boolean };
  /** The change mark slot (git: A, M, D …), at the end of the row. */
  mark?: ReactNode;
  /** A row's quick action buttons (Run …), before its ⋯ (each also in the menu). */
  actions?: ReactNode;
  /** A section header: taller, the ⋯ faintly visible. */
  header?: boolean;
  /** A row of two lines (a name and a subtitle): its height follows its content. */
  tall?: boolean;
  className?: string;
  style?: CSSProperties;
  /** A tooltip for the row's button. */
  title?: string;
}

export function TreeRowShell({ kind, ctx, nodeId, label, children, onClick, onOpen, active, expanded, rename, drag, drop, mark, actions, header, tall, className, style, title }: TreeRowShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  /** Run the row's menu item with this label (a key does what the menu does, or nothing). */
  const runItem = (test: (label: string) => boolean): boolean => {
    const it = buildNodeMenu(kind, withRefDefaults(ctx())).find((i) => !i.disabled && !i.items && test(i.label));
    if (!it) return false;
    it.onSelect();
    return true;
  };
  const keys = (e: KeyboardEvent) => {
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
    }
  };
  return (
    <div
      data-node-id={nodeId}
      data-node-kind={kind}
      className={cx(
        'group flex items-center rounded-md mx-1 pr-1 transition-colors',
        header ? 'h-9' : tall ? 'min-h-8' : 'h-8',
        drop?.over ? 'bg-accent-soft ring-1 ring-accent' : active ? 'bg-accent-soft' : menuOpen ? 'bg-hover' : 'hover:bg-hover',
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
            }
          : undefined
      }
      onDragOver={drop?.onDragOver}
      onDragLeave={drop?.onDragLeave}
      onDrop={drop?.onDrop}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuOpen(true);
      }}
    >
      {rename ? (
        <div className="flex items-center gap-2 flex-1 min-w-0 text-sm">
          <InlineRename value={rename.value} label={rename.label} onCommit={(name) => rename.done(name)} onCancel={() => rename.done()} />
        </div>
      ) : (
        <button
          className={cx('flex items-center gap-2 flex-1 min-w-0 text-sm text-left', tall ? 'py-1.5' : 'h-full')}
          onClick={onClick}
          onDoubleClick={onOpen}
          onKeyDown={keys}
          aria-expanded={expanded}
          data-tree-row
          data-rename-id={nodeId}
          data-row-name={label}
          title={title ?? label}
        >
          {children}
        </button>
      )}
      {mark && <span className="shrink-0 ml-1">{mark}</span>}
      {actions}
      <NodeMenu kind={kind} label={label} header={header} open={menuOpen} onOpenChange={setMenuOpen} ctx={ctx} />
    </div>
  );
}
