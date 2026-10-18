import { Plus, type LucideIcon } from 'lucide-react';
import type { ItemRef } from '@testpion/shared';
import type { LibraryTab } from '../lib/library-tabs';
import { DocTabStrip } from './DocTabStrip';
import { noteClosedTabs } from '../lib/closed-tabs';
import { Empty } from './ui';

/**
 * WF-19: the tab strip of a view whose items are saved (Load tests, Evaluations, AI prompts, Environments, Debugger
 * sessions): the shared DocTabStrip (the same tabs, menu, scrolling and keys as every editor) over `useLibraryTabs`, with
 * preview tabs and a + for a new one. `refOf` names a tab's item for Reopen closed tab (default: a library item).
 */
export function LibraryTabStrip({
  label,
  library,
  refOf,
  tabs,
  active,
  titleOf,
  dirty,
  onSelect,
  onClose,
  onKeep,
  onNew,
  newLabel,
  fixed,
}: {
  label: string;
  /** The library the items are saved in (a closed tab can be reopened: Ctrl+Shift+T). */
  library: string;
  /** The item a tab shows, as a ref (Ctrl+Shift+T reopens it); default `{ kind: 'saved', library, itemId }`. */
  refOf?(tab: LibraryTab): ItemRef | undefined;
  tabs: LibraryTab[];
  active: string;
  titleOf(tab: LibraryTab): string;
  /** The active tab has changes not saved to its item. */
  dirty?: boolean;
  onSelect(id: string): void;
  onClose(ids: string[]): void;
  onKeep(id: string): void;
  /** The + for a new tab; without it, none (a view whose tabs only open from its list). */
  onNew?(): void;
  newLabel?: string;
  /** A tab that is always there (the Debugger's live capture): no ✕, never closed by Close other / all. */
  fixed?(tab: LibraryTab): boolean;
}) {
  return (
    <DocTabStrip<LibraryTab>
      label={label}
      className="border-b border-line shrink-0"
      tabs={tabs.map((t) => ({ id: t.id, title: titleOf(t), preview: t.preview, dirty: t.id === active && dirty, data: t, ...(fixed?.(t) ? { closable: false, pinned: true } : {}) }))}
      activeId={active}
      onSelect={(t) => onSelect(t.id)}
      onClose={(ids, closing) => {
        noteClosedTabs(
          closing.map((t) => {
            const ref = t.data && (refOf ? refOf(t.data) : t.data.savedId ? ({ kind: 'saved', library, itemId: t.data.savedId } as const) : undefined);
            return ref ? { ref, label: t.title } : undefined;
          }),
        );
        onClose(ids);
      }}
      onKeep={(t) => onKeep(t.id)}
      afterTabs={
        onNew && (
          <button aria-label={newLabel} title={newLabel} className="mx-1 mb-1 shrink-0 grid place-items-center h-7 w-7 rounded-md text-muted hover:text-fg hover:bg-hover" onClick={onNew}>
            <Plus size={14} />
          </button>
        )
      }
    />
  );
}

/** What a tab view shows when its last tab was closed: the same in every view (Evaluations, Load tests, Playground). */
export function NoOpenItems({ icon: Icon, title, onNew, newLabel, children }: { icon: LucideIcon; title: string; onNew(): void; newLabel: string; children: React.ReactNode }) {
  return (
    <Empty icon={<Icon size={28} />} title={title} actions={[{ label: newLabel, icon: <Plus size={13} />, onClick: onNew }]}>
      {children}
    </Empty>
  );
}
