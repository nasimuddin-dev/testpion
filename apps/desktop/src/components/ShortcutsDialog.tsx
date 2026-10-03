import { isMac, modKey } from '../api';
import { useApp } from '../store';
import { Kbd, Modal } from './ui';

const alt = isMac ? '⌥' : 'Alt';
const shift = isMac ? '⇧' : 'Shift';

/** Every keyboard shortcut, grouped (Help ▸ Keyboard Shortcuts, the command palette, or ?). */
const GROUPS: Array<{ title: string; items: Array<{ keys: string[][]; text: string }> }> = [
  {
    title: 'Anywhere',
    items: [
      { keys: [[modKey, 'K']], text: 'Command palette' },
      { keys: [[modKey, shift, 'F']], text: 'Search the workspace' },
      { keys: [[alt, '←'], [alt, '→']], text: 'Back / forward to where you were (also the mouse back and forward buttons)' },
      { keys: [[modKey, 'B']], text: 'Show or hide the Collections explorer' },
      { keys: [[modKey, ',']], text: 'Settings' },
      { keys: [[modKey, 'J']], text: 'Ask the AI assistant about what is on screen (again: close it)' },
      { keys: [[modKey, alt, 'C']], text: 'Show or hide the console' },
      { keys: [[modKey, alt, '1…9']], text: 'Go to a view (REST, GraphQL, WebSocket …)' },
      { keys: [['?']], text: 'This list (outside a text field)' },
    ],
  },
  {
    title: 'Requests and tabs',
    items: [
      { keys: [[modKey, 'Enter']], text: 'Send the request (also runs AI prompts and gRPC calls)' },
      { keys: [[modKey, 'S']], text: 'Save' },
      { keys: [[modKey, 'T']], text: 'New request tab' },
      { keys: [[modKey, 'W']], text: 'Close the tab' },
      { keys: [[modKey, shift, 'W']], text: 'Close all tabs' },
      { keys: [[modKey, 'O']], text: 'Import (Postman, Insomnia, Bruno, OpenAPI, cURL …)' },
    ],
  },
  {
    title: 'Collections sidebar',
    items: [
      { keys: [['↑'], ['↓']], text: 'Move between rows' },
      { keys: [['→'], ['←']], text: 'Expand or collapse a collection, category or folder' },
      { keys: [['F2']], text: 'Rename the focused item in place (request, folder, collection, tab, environment, monitor …); Enter saves, Esc cancels' },
      { keys: [['Delete']], text: 'Delete the focused request or folder (Undo in the message)' },
      { keys: [['Enter']], text: 'Open the focused request' },
    ],
  },
  {
    title: 'Code editors',
    items: [
      { keys: [['{{']], text: 'Suggest variables' },
      { keys: [[modKey, 'Space']], text: 'Suggestions (variables, tp.* snippets, JSON Schema fields)' },
      { keys: [[modKey, 'F']], text: 'Find' },
      { keys: [[modKey, 'H']], text: 'Replace' },
      { keys: [[modKey, '/']], text: 'Comment or uncomment lines' },
      { keys: [[alt, '↑'], [alt, '↓']], text: 'Move lines (and environment variables, in the Envs table)' },
    ],
  },
  {
    title: 'Lists, menus and dialogs',
    items: [
      { keys: [['↑'], ['↓']], text: 'Move through results' },
      { keys: [['Enter']], text: 'Open or run the selected item' },
      { keys: [['Esc']], text: 'Close' },
    ],
  },
];

export function ShortcutsDialog() {
  const close = () => useApp.getState().set({ shortcutsOpen: false });
  return (
    <Modal title="Keyboard shortcuts" onClose={close} width={720}>
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
