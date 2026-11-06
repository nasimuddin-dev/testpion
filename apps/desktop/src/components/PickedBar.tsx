import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { plural } from '../lib/format';
import { Button, IconButton } from './ui';

/** One thing the picked items can do together (Run, Move to…, Export…, Delete). */
export interface PickedAction {
  label: string;
  /** Left out: the label's own icon, as every button with that label has. */
  icon?: ReactNode;
  onClick(): void;
  title?: string;
  disabled?: boolean;
  /** Why it is disabled (its tooltip then). */
  reason?: string;
  /** It removes something (Delete): drawn as every danger action. */
  danger?: boolean;
}

/**
 * The bar above a tree whose items are picked several at a time (Ctrl/⌘+click, Shift+click, Ctrl/⌘+Space): how many,
 * what they can do together, and × (or Esc) to let go. One bar for every tree that picks (requests, test files). It is
 * a toolbar, not one more picked row: the panel's colour with an accent edge, never the selected-row colour.
 */
export function PickedBar({ count, noun, nouns, where, actions, onClear }: { count: number; noun: string; nouns?: string; where?: string; actions: PickedAction[]; onClear(): void }) {
  const many = nouns ?? `${noun}s`;
  return (
    <div
      className="sticky top-0 z-10 flex items-center gap-1 px-2 py-1 mb-1 rounded-md border border-accent/40 bg-panel shadow-sm text-xs"
      role="toolbar"
      aria-label={`Picked ${many}`}
      data-picked-bar={count}
    >
      <span className="font-medium truncate flex-1" title={`${where ? `In ${where}. ` : ''}Ctrl/⌘+click picks or drops one, Shift+click a range, Esc lets go.`}>
        {plural(count, noun, many)} picked
      </span>
      {actions.map((a) => (
        <Button key={a.label} size="sm" variant={a.danger ? 'danger' : 'default'} icon={a.icon} onClick={a.onClick} title={a.title} disabled={a.disabled} reason={a.reason}>
          {a.label}
        </Button>
      ))}
      <IconButton size="sm" label={`Let go of the picked ${many} (Esc)`} onClick={onClear}>
        <X />
      </IconButton>
    </div>
  );
}
