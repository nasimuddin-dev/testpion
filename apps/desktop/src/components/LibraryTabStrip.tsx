import { Plus } from 'lucide-react';
import type { LibraryTab } from '../lib/library-tabs';
import { DocTabStrip } from './DocTabStrip';
import { noteClosedTabs } from '../lib/closed-tabs';

/**
 * WF-19: the tab strip of a view whose items are saved in a library (Load tests, Evaluations): the shared DocTabStrip
 * (the same tabs, menu, scrolling and keys as every editor) over `useLibraryTabs`, with preview tabs and a + for a new
 * unsaved one.
 */
export function LibraryTabStrip({
  label,
  library,
  tabs,
  active,
  titleOf,
  dirty,
  onSelect,
  onClose,
  onKeep,
  onNew,
  newLabel,
}: {
  label: string;
  /** The library the items are saved in (a closed tab can be reopened: Ctrl+Shift+T). */
  library: string;
  tabs: LibraryTab[];
  active: string;
  titleOf(tab: LibraryTab): string;
  /** The active tab has changes not saved to its item. */
  dirty?: boolean;
  onSelect(id: string): void;
  onClose(ids: string[]): void;
  onKeep(id: string): void;
  onNew(): void;
  newLabel: string;
}) {
  return (
    <DocTabStrip<LibraryTab>
      label={label}
      className="border-b border-line shrink-0"
      tabs={tabs.map((t) => ({ id: t.id, title: titleOf(t), preview: t.preview, dirty: t.id === active && dirty, data: t }))}
      activeId={active}
      onSelect={(t) => onSelect(t.id)}
      onClose={(ids, closing) => {
        noteClosedTabs(closing.map((t) => (t.data?.savedId ? { ref: { kind: 'saved', library, itemId: t.data.savedId }, label: t.title } : undefined)));
        onClose(ids);
      }}
      onKeep={(t) => onKeep(t.id)}
      afterTabs={
        <button aria-label={newLabel} title={newLabel} className="mx-1 mb-1 shrink-0 grid place-items-center h-7 w-7 rounded-md text-muted hover:text-fg hover:bg-hover" onClick={onNew}>
          <Plus size={14} />
        </button>
      }
    />
  );
}
