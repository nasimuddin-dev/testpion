import { ChevronRight } from 'lucide-react';
import type { ItemRef } from '@testpion/shared';
import { useApp, type ViewId } from '../store';
import { openRef, revealInSidebar } from '../lib/open-ref';
import { RowMenu } from './TreeParts';
import { type MenuItem } from './ui';

/** One segment of a breadcrumb: what it names and where a click goes (an item, revealed in the sidebar, or a view). */
export interface Crumb {
  label: string;
  /** Opens (and reveals in the sidebar) this item. */
  ref?: ItemRef;
  /** Only shows this item in the sidebar (a folder: its row, its collection and parents open). */
  reveal?: ItemRef;
  /** Or goes to this view (a list: Monitors, Datasets …). */
  view?: ViewId;
  title?: string;
}

/**
 * WF-11: where the open item lives, one line at the top of every item view — *Collection › Folder › Request*, *Tests ›
 * folder › file*, *Monitors › Nightly* — the same everywhere. A segment opens what it names (an item is revealed in
 * the sidebar); the last one is the item itself, with its own ⋯ (the item's menu, as in the tree). `RequestBreadcrumb`
 * is this with a request's segments.
 */
export function ItemBreadcrumb({
  crumbs,
  name,
  dirty,
  actions,
  label = 'Where this is',
  trailing,
}: {
  crumbs: Crumb[];
  name: string;
  dirty?: boolean;
  actions?: MenuItem[];
  label?: string;
  trailing?: React.ReactNode;
}) {
  const go = (c: Crumb) => (c.ref ? void openRef(c.ref, { reveal: true }) : c.reveal ? revealInSidebar(c.reveal) : c.view ? useApp.getState().setView(c.view) : undefined);
  return (
    <nav aria-label={label} data-item-breadcrumb className="flex items-center gap-1 px-3 pt-1.5 text-xs text-muted min-w-0">
      {crumbs.map((c, i) => (
        <span key={i} className="flex items-center gap-1 min-w-0 shrink">
          {c.ref || c.reveal || c.view ? (
            <button
              className="hover:text-fg hover:underline truncate min-w-0"
              title={c.title ?? (c.ref ? `Open ${c.label}` : c.reveal ? `Show ${c.label} in the sidebar` : `Go to ${c.label}`)}
              onClick={() => go(c)}
            >
              {c.label}
            </button>
          ) : (
            <span className="truncate">{c.label}</span>
          )}
          <ChevronRight size={11} className="shrink-0" />
        </span>
      ))}
      <span className="text-fg truncate" data-crumb-item>
        {name}
      </span>
      {dirty && <span className="shrink-0">· unsaved changes</span>}
      {trailing}
      {actions?.length ? (
        <span className="ml-auto shrink-0">
          <RowMenu label={name} items={actions} header />
        </span>
      ) : null}
    </nav>
  );
}
