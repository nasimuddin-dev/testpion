import { FolderTree, KeyRound, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { call } from '../api';
import { confirmAction, toastError, useApp } from '../store';
import { plural, timeAgo } from '../lib/format';
import { Button, Empty, IconButton, Modal, Tooltip } from './ui';

export interface TrashItem {
  id: string;
  kind: 'collection' | 'environment';
  itemId: string;
  name: string;
  deletedAt: string;
  size: number;
}

/** Deleted collections and environments (kept 30 days): restore them, or delete them for good. */
export function TrashDialog({ kind, onClose, onRestored }: { kind?: TrashItem['kind']; onClose(): void; onRestored?(item: { kind: TrashItem['kind']; id: string; name: string }): void }) {
  const [items, setItems] = useState<TrashItem[]>();
  const toast = useApp((s) => s.toast);
  const load = () => void call<TrashItem[]>('trash.list').then((all) => setItems(kind ? all.filter((i) => i.kind === kind) : all));
  useEffect(load, [kind]);
  const restore = async (it: TrashItem) => {
    try {
      const r = await call<{ kind: TrashItem['kind']; id: string; name: string }>('trash.restore', { id: it.id });
      toast(`Restored "${r.name}"`, 'success');
      await useApp.getState().refreshWorkspace();
      onRestored?.(r);
      load();
    } catch (e) {
      toastError(e);
    }
  };
  const purge = async (it?: TrashItem) => {
    const what = it ? `"${it.name}"` : `all ${items?.length ?? 0} deleted items`;
    if (!(await confirmAction({ title: 'Delete for good', message: `Delete ${what} for good?`, detail: 'This cannot be undone.', confirmLabel: 'Delete for good', danger: true }))) return;
    await call('trash.purge', it ? { id: it.id } : {});
    load();
  };
  return (
    <Modal
      title="Recently deleted"
      onClose={onClose}
      width={620}
      footer={
        items?.length ? (
          <>
            <span className="text-xs text-muted mr-auto">Deleted items are kept for 30 days.</span>
            <Button variant="ghost" className="text-bad" icon={<Trash2 size={13} />} onClick={() => void purge()}>
              Empty
            </Button>
          </>
        ) : undefined
      }
    >
      {items && !items.length ? (
        <Empty icon={<Trash2 size={22} />} title="Nothing deleted recently">
          Collections and environments you delete stay here for 30 days, so you can restore them.
        </Empty>
      ) : (
        <ul className="flex flex-col divide-y divide-line/60">
          {(items ?? []).map((it) => (
            <li key={it.id} className="flex items-center gap-3 py-2">
              <span className="text-muted">{it.kind === 'collection' ? <FolderTree size={16} /> : <KeyRound size={16} />}</span>
              <div className="min-w-0 flex-1">
                <div className="font-medium truncate">{it.name}</div>
                <div className="text-xs text-muted">
                  {it.kind === 'collection' ? `Collection · ${plural(it.size, 'request')}` : `Environment · ${plural(it.size, 'variable')}`} · deleted {timeAgo(it.deletedAt)}
                </div>
              </div>
              <Button size="sm" icon={<RotateCcw size={13} />} onClick={() => void restore(it)}>
                Restore
              </Button>
              <Tooltip content="Delete for good">
                <IconButton label="Delete for good" onClick={() => void purge(it)}>
                  <Trash2 size={14} />
                </IconButton>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
