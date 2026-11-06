import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { plural } from '../lib/format';
import { Button, IconButton } from './ui';

/** One thing the picked items can do together (Run, Move to…, Export…, Delete). */
export interface PickedAction {
  label: string;
  icon: ReactNode;
  onClick(): void;
  title?: string;
}

/**
 * The bar above a tree whose items are picked several at a time (Ctrl/⌘+click, Shift+click, Ctrl/⌘+Space): how many,
 * what they can do together, and × (or Esc) to let go. One bar for every tree that picks (requests, test files).
 */
export function PickedBar({ count, noun, where, actions, onClear }: { count: number; noun: string; where?: string; actions: PickedAction[]; onClear(): void }) {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-1 px-2 py-1 mb-1 rounded-md border border-accent/40 bg-accent-soft text-xs" role="toolbar" aria-label={`Picked ${noun}s`} data-picked-bar={count}>
      <span className="font-medium truncate flex-1" title={`${where ? `In ${where}. ` : ''}Ctrl/⌘+click picks or drops one, Shift+click a range, Esc lets go.`}>
        {plural(count, noun)} picked
      </span>
      {actions.map((a) => (
        <Button key={a.label} size="sm" icon={a.icon} onClick={a.onClick} title={a.title}>
          {a.label}
        </Button>
      ))}
      <IconButton size="sm" label={`Let go of the picked ${noun}s (Esc)`} onClick={onClear}>
        <X />
      </IconButton>
    </div>
  );
}
