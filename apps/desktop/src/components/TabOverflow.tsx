import { Check, ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '../lib/cx';
import { Menu } from './Menu';

/** One entry of the overflow menu: a tab, named and (when it is the active one) ticked. */
export interface TabOverflowItem {
  id: string;
  label: string;
  active?: boolean;
  /** Drawn before the label when the item is not the active one (a method badge); the active one shows a tick. */
  icon?: ReactNode;
}

// made once: the same two elements in every menu row (React skips an element it has already rendered)
const ACTIVE_ICON = <Check size={14} />;
const SPACER = <span className="inline-block w-3.5" />;

/**
 * The one overflow control of every tab strip (the request editor's Params / Headers / Body … and the document strips
 * of open requests, test files and monitors): a count button with ▾ that lists every tab, the active one ticked. The
 * host says what the count means through `label` (the button's accessible name): "All tabs (3 not shown)" when only
 * the hidden tabs are counted, "All open tabs" when every tab is.
 */
export function TabOverflow({ items, count, label, onSelect, width = 260, className }: { items: TabOverflowItem[]; count: number; label: string; onSelect(id: string): void; width?: number; className?: string }) {
  return (
    <Menu
      align="end"
      width={width}
      items={items.map((t) => ({ label: t.label, icon: t.active ? ACTIVE_ICON : (t.icon ?? SPACER), onSelect: () => onSelect(t.id) }))}
      trigger={
        <button
          aria-label={label}
          title={label}
          data-tab-overflow
          className={cx(
            'shrink-0 inline-flex items-center gap-1 h-7 px-2 rounded-md text-xs font-medium tabular-nums text-muted border border-line bg-bg hover:text-fg hover:bg-hover data-[state=open]:text-fg data-[state=open]:bg-hover',
            className,
          )}
        >
          {count}
          <ChevronDown size={13} />
        </button>
      }
    />
  );
}
