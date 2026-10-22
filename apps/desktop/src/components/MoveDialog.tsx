import { Folder, FolderTree } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Collection, CollectionNode } from '../types';
import { Button, cx, Field, Modal, Select, NamedOptions } from './ui';

/** Ids of a node and everything inside it (a folder can't move into itself). */
export function subtreeIds(n: CollectionNode): string[] {
  return n.kind === 'folder' ? [n.id, ...n.items.flatMap(subtreeIds)] : [n.id];
}

/**
 * Move a request or folder to another place: any folder of any collection (or the top level). The
 * caller does the move; this only asks where.
 */
export function MoveDialog({
  node,
  from,
  collections,
  onMove,
  onClose,
}: {
  node: CollectionNode;
  from: Collection;
  collections: Collection[];
  onMove(to: Collection, folderId: string | undefined): void;
  onClose(): void;
}) {
  const [colId, setColId] = useState(from.id);
  const [folderId, setFolderId] = useState<string | undefined>();
  const target = collections.find((c) => c.id === colId) ?? from;
  const blocked = useMemo(() => new Set(subtreeIds(node)), [node]);
  const folders = useMemo(() => {
    const out: Array<{ id: string; name: string; depth: number }> = [];
    const walk = (nodes: CollectionNode[], depth: number) =>
      nodes.forEach((n) => {
        if (n.kind !== 'folder' || blocked.has(n.id)) return;
        out.push({ id: n.id, name: n.name, depth });
        walk(n.items, depth + 1);
      });
    walk(target.items, 0);
    return out;
  }, [target, blocked]);
  const option = (id: string | undefined, label: string, depth: number, icon: React.ReactNode) => (
    <button
      key={id ?? '__top'}
      className={cx('w-full flex items-center gap-2 py-1 pr-2 rounded text-sm text-left', folderId === id ? 'bg-accent/15 text-fg' : 'hover:bg-hover')}
      style={{ paddingLeft: 8 + depth * 18 }}
      onClick={() => setFolderId(id)}
    >
      <span className="text-muted">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
  return (
    <Modal
      title={`Move "${node.name}"`}
      onClose={onClose}
      onSubmit={() => onMove(target, folderId)}
      width={480}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => onMove(target, folderId)}>
            Move here
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Collection">
          <Select value={colId} onChange={(e) => (setColId(e.target.value), setFolderId(undefined))}>
            <NamedOptions items={collections} />
          </Select>
        </Field>
        <Field label="Folder">
          <div className="max-h-64 overflow-auto rounded-md border border-line p-1">
            {option(undefined, `${target.name} (top level)`, 0, <FolderTree size={14} />)}
            {folders.map((f) => option(f.id, f.name, f.depth + 1, <Folder size={14} />))}
          </div>
        </Field>
        {colId !== from.id && node.kind !== 'folder' && <p className="text-xs text-muted">Collection variables, auth and scripts come from the new collection after the move.</p>}
      </div>
    </Modal>
  );
}
