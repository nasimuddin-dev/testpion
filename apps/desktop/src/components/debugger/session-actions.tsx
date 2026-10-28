import { Save, Trash2 } from 'lucide-react';
import { Button, type MenuItem } from '../ui';

/**
 * Save the session and Clear the session, defined ONCE: the filter strip's buttons, the Session menu and the tool rail's
 * menu all render these two items, so what they do, when they are disabled and why never drift apart.
 */
export interface SessionActions {
  save: MenuItem;
  clear: MenuItem;
}

export function sessionActions(o: { canSave: boolean; canClear: boolean; save(): void; clear(): void }): SessionActions {
  return {
    save: { label: 'Save session…', icon: <Save size={14} />, disabled: !o.canSave, reason: 'Nothing captured yet', title: 'Save the session to open it later', onSelect: o.save },
    clear: { label: 'Clear the session', icon: <Trash2 size={14} />, danger: true, disabled: !o.canClear, reason: 'Nothing captured yet', shortcut: 'Ctrl+E', title: 'Forget every captured exchange (Ctrl+E)', onSelect: o.clear },
  };
}

/** A strip button drawn from one of the shared items (a shorter word for the same action). */
export function ActionButton({ item, label }: { item: MenuItem; label: string }) {
  return (
    <Button size="sm" variant="ghost" icon={item.icon} disabled={item.disabled} reason={item.reason} title={item.title} aria-label={item.label.replace(/…$/, '')} onClick={item.onSelect}>
      {label}
    </Button>
  );
}
