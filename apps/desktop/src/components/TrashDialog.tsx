import { Database, FileCode2, FolderTree, KeyRound, Plug, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { call } from '../api';
import { confirmAction, useApp, attempt } from '../store';
import { plural, timeAgo } from '../lib/format';
import { Button, Empty, IconButton, Modal } from './ui';

export interface TrashItem {
  id: string;
  kind: 'collection' | 'environment' | 'dataset' | 'spec' | 'mcp-server';
  itemId: string;
  name: string;
  deletedAt: string;
  size: number;
}

/** Each kind's icon and line in the list (one table: a new trash kind is one row). */
const KIND_ROWS: Record<TrashItem['kind'], { icon: ReactNode; line(it: TrashItem): string }> = {
  collection: { icon: <FolderTree size={16} />, line: (it) => `Collection · ${plural(it.size, 'request')}` },
  environment: { icon: <KeyRound size={16} />, line: (it) => `Environment · ${plural(it.size, 'variable')}` },
  dataset: { icon: <Database size={16} />, line: (it) => `Dataset · ${(it.size / 1024).toFixed(1)} KB` },
  spec: { icon: <FileCode2 size={16} />, line: (it) => `API definition · ${(it.size / 1024).toFixed(1)} KB` },
  'mcp-server': { icon: <Plug size={16} />, line: () => 'MCP server' },
};

/** The kinds the Collections sidebar holds: its Recently deleted lists every one of them (the Environments view lists environments). */
export const SIDEBAR_TRASH_KINDS: readonly TrashItem['kind'][] = ['collection', 'dataset', 'spec', 'mcp-server'];

/** Deleted collections, environments, datasets, API definitions and MCP servers (kept 30 days): restore them, or delete them for good. `kinds`: only these. */
export function TrashDialog({ kinds, onClose, onRestored }: { kinds?: readonly TrashItem['kind'][]; onClose(): void; onRestored?(item: { kind: TrashItem['kind']; id: string; name: string }): void }) {
  const [items, setItems] = useState<TrashItem[]>();
  const toast = useApp((s) => s.toast);
  const shown = kinds?.join(',');
  const load = () => void call<TrashItem[]>('trash.list').then((all) => setItems(kinds ? all.filter((i) => kinds.includes(i.kind)) : all));
  useEffect(load, [shown]);
  const restore = async (it: TrashItem) => {
    await attempt(async () => {
      const r = await call<{ kind: TrashItem['kind']; id: string; name: string }>('trash.restore', { id: it.id });
      toast(`Restored "${r.name}"`, 'success');
      await useApp.getState().refreshWorkspace();
      onRestored?.(r);
      load();
    });
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
          Collections, environments, datasets, API definitions and MCP servers you delete stay here for 30 days, so you can restore them.
        </Empty>
      ) : (
        <ul className="flex flex-col divide-y divide-line/60">
          {(items ?? []).map((it) => (
            <li key={it.id} className="flex items-center gap-3 py-2">
              <span className="text-muted">{KIND_ROWS[it.kind]?.icon ?? <Trash2 size={16} />}</span>
              <div className="min-w-0 flex-1">
                <div className="font-medium truncate">{it.name}</div>
                <div className="text-xs text-muted">
                  {KIND_ROWS[it.kind]?.line(it) ?? it.kind} · deleted {timeAgo(it.deletedAt)}
                </div>
              </div>
              <Button size="sm" icon={<RotateCcw size={13} />} onClick={() => void restore(it)}>
                Restore
              </Button>
              <IconButton label="Delete for good" onClick={() => void purge(it)}>
                <Trash2 size={14} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
