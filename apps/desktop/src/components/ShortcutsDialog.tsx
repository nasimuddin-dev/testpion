import { isMac, modKey } from '../api';
import { useApp } from '../store';
import { Keyboard } from 'lucide-react';
import { Button, Kbd, Modal } from './ui';
import { railItem, useRail } from '../lib/use-rail';
import { shortcutGroups } from '../lib/shortcuts';
import { useBindings } from '../lib/keybindings';

/** Every keyboard shortcut, grouped (Help ▸ Keyboard Shortcuts, the command palette, or ?): lib/shortcuts.ts, the list the docs page follows. */
export function ShortcutsDialog() {
  // Ctrl/Cmd+Alt+1…9: the views shown on the rail, in its order
  const views = useRail().visible.map((id) => railItem(id)?.label ?? id);
  // the person's keys (Settings ▸ Keyboard)
  const bindings = useBindings();
  const GROUPS = shortcutGroups({ mod: modKey, alt: isMac ? '⌥' : 'Alt', shift: isMac ? '⇧' : 'Shift', mac: isMac, views, bindings });
  const close = () => useApp.getState().set({ shortcutsOpen: false });
  return (
    <Modal
      title="Keyboard shortcuts"
      onClose={close}
      width={720}
      footer={
        <Button icon={<Keyboard size={14} />} onClick={() => (close(), useApp.getState().openIntent('settings', { tab: 'keyboard' }))}>
          Change the keys…
        </Button>
      }
    >
      <div className="grid md:grid-cols-2 gap-x-8 gap-y-5">
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted mb-2">{g.title}</h3>
            <dl className="flex flex-col gap-1.5">
              {g.items.map((it) => (
                <div key={it.text} className="flex items-center gap-3 text-sm">
                  <dt className="flex items-center gap-1 shrink-0 min-w-[9rem]">
                    {it.keys.map((combo, i) => (
                      <span key={i} className="flex items-center gap-1">
                        {i > 0 && <span className="text-muted text-xs">/</span>}
                        {combo.map((k) => (
                          <Kbd key={k}>{k}</Kbd>
                        ))}
                      </span>
                    ))}
                  </dt>
                  <dd className="text-muted">{it.text}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
