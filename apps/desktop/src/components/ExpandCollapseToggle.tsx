import { useState } from 'react';
import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { LABEL } from '../lib/vocabulary';
import { IconButton } from './ui';

/**
 * Expand all / Collapse all as ONE toolbar button, the same in every tree and list (the JSON tree, the explorer …).
 * It offers one action first (Expand all, unless the tree is usually open), then the other after each press, so it reads as a switch; an action that could change
 * nothing (everything is already open, or nothing is) is never the one offered. Menus keep both as two plain items.
 */
export function ExpandCollapseToggle({
  onExpand,
  onCollapse,
  canExpand = true,
  canCollapse = true,
  start = 'expand',
  size = 14,
  className = 'h-7 w-7 shrink-0',
}: {
  onExpand(): void;
  onCollapse(): void;
  /** Something is still closed (default: yes). */
  canExpand?: boolean;
  /** Something is open (default: yes). */
  canCollapse?: boolean;
  /** The action offered first: Expand all (default); a tree that is usually open starts on Collapse all. */
  start?: 'expand' | 'collapse';
  size?: number;
  className?: string;
}) {
  const [next, setNext] = useState<'expand' | 'collapse'>(start);
  const offer = next === 'expand' ? (canExpand || !canCollapse ? 'expand' : 'collapse') : canCollapse || !canExpand ? 'collapse' : 'expand';
  return offer === 'expand' ? (
    <IconButton label={LABEL.expandAll} className={className} data-expand-collapse="expand" onClick={() => (onExpand(), setNext('collapse'))}>
      <ChevronsUpDown size={size} />
    </IconButton>
  ) : (
    <IconButton label={LABEL.collapseAll} className={className} data-expand-collapse="collapse" onClick={() => (onCollapse(), setNext('expand'))}>
      <ChevronsDownUp size={size} />
    </IconButton>
  );
}
