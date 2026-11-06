import { Download, FolderInput, Play, Trash2, X } from 'lucide-react';
import { plural } from '../lib/format';
import { Button, IconButton } from './ui';

/**
 * What can be done with the requests picked in the Collections tree (Ctrl/⌘+click, Shift+click): run them as one run,
 * move them to a folder, delete them (one Undo brings them all back), or let go (Esc).
 */
export function PickedRequestsBar({ count, collection, onRun, onMove, onExport, onDelete, onClear }: { count: number; collection: string; onRun(): void; onMove(): void; onExport(): void; onDelete(): void; onClear(): void }) {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-1 px-2 py-1 mb-1 rounded-md border border-accent/40 bg-accent-soft text-xs" role="toolbar" aria-label="Picked requests" data-picked-bar={count}>
      <span className="font-medium truncate flex-1" title={`In ${collection}. Ctrl/⌘+click picks or drops one, Shift+click a range, Esc lets go.`}>
        {plural(count, 'request')} picked
      </span>
      <Button size="sm" icon={<Play size={12} />} onClick={onRun} title="Run them in the order the tree shows, in the active environment">
        Run
      </Button>
      <Button size="sm" icon={<FolderInput size={12} />} onClick={onMove}>
        Move to…
      </Button>
      <Button size="sm" icon={<Download size={12} />} onClick={onExport} title="One file with just these requests (and what they use, if you choose)">
        Export…
      </Button>
      <Button size="sm" icon={<Trash2 size={12} />} onClick={onDelete}>
        Delete
      </Button>
      <IconButton size="sm" label="Let go of the picked requests (Esc)" onClick={onClear}>
        <X />
      </IconButton>
    </div>
  );
}
