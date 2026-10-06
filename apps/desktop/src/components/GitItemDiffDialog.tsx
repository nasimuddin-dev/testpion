import { useEffect, useState } from 'react';
import { asError, call } from '../api';
import { useApp } from '../store';
import { Empty, Modal } from './ui';
import { PartsTable } from './PartsTable';

/**
 * GIT-205: one changed item side by side, part by part: as the last commit had it, and as it is now (a request, a
 * folder, the collection's settings, or an environment's variables; secret values never shown).
 */
interface ItemDiff {
  title: string;
  parts: Array<{ part: string; before?: string; after?: string; differs: boolean }>;
}

export function GitItemDiffDialog({ file, itemId, onClose }: { file: string; itemId?: string; onClose(): void }) {
  const [d, setD] = useState<ItemDiff>();
  const [onlyDiffs, setOnlyDiffs] = useState(true);
  useEffect(() => {
    void call<ItemDiff>('git.itemDiff', { file, itemId }).then(setD, (e) => useApp.getState().toast(asError(e).message, 'error'));
  }, [file, itemId]);
  const rows = (d?.parts ?? []).filter((p) => !onlyDiffs || p.differs).map((p) => ({ part: p.part, differs: p.differs, values: { before: p.before, after: p.after } }));
  return (
    <Modal title={d ? `What changed: ${d.title}` : 'What changed'} onClose={onClose} width={960}>
      {!d ? (
        <Empty title="Reading both versions…" />
      ) : (
        <div className="grid gap-2">
          <label className="flex items-center gap-1 text-xs text-muted justify-end">
            <input type="checkbox" checked={onlyDiffs} onChange={(e) => setOnlyDiffs(e.target.checked)} /> Only the parts that changed
          </label>
          <div className="rounded-lg border border-line" data-item-diff>
            <PartsTable
              rows={rows}
              emptyText="Nothing differs."
              columns={[
                { key: 'before', label: 'Last commit', missing: 'not there yet (new)' },
                { key: 'after', label: 'Now', missing: 'deleted', highlight: true },
              ]}
            />
          </div>
        </div>
      )}
    </Modal>
  );
}
