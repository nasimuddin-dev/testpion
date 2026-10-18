import { useState, type MouseEvent, type ReactNode } from 'react';
import type { NodeKind, NodeMenuCtx } from '../lib/node-menu';
import { NodeMenu } from './TreeParts';

/**
 * The right-click on the blank part of a tree or list (the explorer, a FolderList, the Tests tree): the menu of the
 * section that owns that area, opened where the pointer is. A right-click on a row is the row's own (rows prevent the
 * default), so only the blank area reaches here.
 */
export function useAreaMenu(kind: NodeKind, ctx: () => NodeMenuCtx, label: string): { onContextMenu(e: MouseEvent): void; menu: ReactNode } {
  const [at, setAt] = useState<{ x: number; y: number }>();
  const onContextMenu = (e: MouseEvent) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    setAt({ x: e.clientX, y: e.clientY });
  };
  const menu = at ? (
    // a zero-size anchor at the pointer: the menu opens there
    <span className="fixed w-0 h-0 overflow-visible z-[60]" style={{ left: at.x, top: at.y }} data-area-menu={kind}>
      <NodeMenu kind={kind} label={label} open onOpenChange={(o) => !o && setAt(undefined)} ctx={ctx} />
    </span>
  ) : null;
  return { onContextMenu, menu };
}
