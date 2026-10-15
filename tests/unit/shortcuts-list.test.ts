import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shortcutGroups } from '../../apps/desktop/src/lib/shortcuts';

// The in-app Shortcuts dialog (lib/shortcuts.ts) and docs/getting-started/keyboard-shortcuts.md list the same
// "Anywhere" shortcuts: one added to either must be added to the other.
const doc = readFileSync(join(__dirname, '../../docs/getting-started/keyboard-shortcuts.md'), 'utf8');
const section = doc.slice(doc.indexOf('## Anywhere'), doc.indexOf('\n## ', doc.indexOf('## Anywhere') + 5));
const norm = (s: string) =>
  s
    .replace(/<\/?kbd>/g, '')
    .replace(/&#96;/g, '`')
    .replace(/\s+/g, '');
/** Each docs row's key combinations, as "Ctrl+Shift+E". */
const docRows = section
  .split('\n')
  .filter((l) => l.startsWith('| <kbd>'))
  .map((l) => norm(l.split('|')[1]!).split('/'));

const app = shortcutGroups({ mod: 'Ctrl', alt: 'Alt', shift: 'Shift', mac: false, views: ['Home', 'Collections'] });
const anywhere = app.find((g) => g.title === 'Anywhere')!.items.map((i) => i.keys.map((k) => norm(k.join('+'))));

describe('the Shortcuts dialog and the docs page', () => {
  it('list the same shortcuts under Anywhere (F8 for Problems and F12 included)', () => {
    // (the docs' "1 … 9" and "&#96;" read as the app's "1…9" and "`")
    const inDocs = new Set(docRows.map((r) => r[0]!));
    const inApp = new Set(anywhere.map((r) => r[0]!));
    expect([...inApp].filter((k) => !inDocs.has(k))).toEqual([]);
    expect([...inDocs].filter((k) => !inApp.has(k))).toEqual([]);
    expect(inApp.has('F8')).toBe(true);
    expect(inApp.has('F12')).toBe(true);
    // the second key of a pair too (Shift+F8, Alt+→)
    expect(anywhere.find((r) => r[0] === 'F8')).toEqual(['F8', 'Shift+F8']);
  });

  it('macOS has no F12 (Developer Tools are in the View menu)', () => {
    const mac = shortcutGroups({ mod: '⌘', alt: '⌥', shift: '⇧', mac: true, views: [] });
    expect(mac[0]!.items.some((i) => i.keys[0]![0] === 'F12')).toBe(false);
  });
});
