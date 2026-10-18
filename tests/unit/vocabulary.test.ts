import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LABEL, MENU_GROUPS, RETIRED_LABELS } from '../../apps/desktop/src/lib/vocabulary';
import { railOrder, railShortcut, railTarget } from '../../apps/desktop/src/lib/rail';

// WF-13: one word per action and one menu order everywhere; the shortcuts follow the rail.
const SRC = join(__dirname, '../../apps/desktop/src');
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : /\.tsx?$/.test(f) ? [join(dir, f)] : []));
/** Files other work owns right now (WF-13 left their call sites as they are; see the plan's Built note). */
const NOT_YET = new Set(['components/RunPanel.tsx', 'views/TestsView.tsx']);

describe('vocabulary', () => {
  it('the retired words are gone from menus, buttons and the palette', () => {
    const found: string[] = [];
    for (const f of files(SRC)) {
      const rel = f.slice(SRC.length + 1).replace(/\\/g, '/');
      if (rel === 'lib/vocabulary.ts' || NOT_YET.has(rel)) continue;
      const text = readFileSync(f, 'utf8');
      for (const w of RETIRED_LABELS)
        if (text.includes(`'${w}'`) || text.includes(`>${w}<`) || new RegExp(`>\\s*${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*<`).test(text)) found.push(`${rel}: ${w}`);
    }
    expect(found).toEqual([]);
  });

  it('a menu item that deletes says so the one way', () => {
    const found: string[] = [];
    for (const f of files(SRC)) {
      const rel = f.slice(SRC.length + 1).replace(/\\/g, '/');
      if (NOT_YET.has(rel)) continue;
      if (/label: 'Delete',\s*icon: <Trash2/.test(readFileSync(f, 'utf8'))) found.push(rel);
    }
    expect(found).toEqual([]);
    expect(LABEL.delete).toBe('Delete…');
  });

  it('one menu order', () => {
    expect(MENU_GROUPS).toEqual(['create', 'open', 'tree', 'run', 'share', 'tools', 'git', 'edit', 'danger']);
  });

  it('Ctrl+Alt+n follows the rail: Collections second, the request editors not numbered', () => {
    const nav = [
      { id: 'home', group: 'Start' },
      { id: 'rest', group: 'Requests' },
      { id: 'graphql', group: 'Requests' },
      { id: 'debugger', group: 'Testing' },
      { id: 'tests', group: 'Testing' },
      ...Array.from({ length: 8 }, (_, i) => ({ id: `v${i}`, group: 'Workspace' })),
    ];
    const order = railOrder(nav);
    expect(order.slice(0, 4)).toEqual(['home', 'collections', 'debugger', 'tests']);
    expect(railShortcut(order, 'collections', 'Ctrl')).toBe('Ctrl+Alt+2');
    expect(railShortcut(order, 'rest', 'Ctrl')).toBeUndefined();
    expect(railShortcut(order, 'v7', 'Ctrl')).toBeUndefined(); // past 9
    expect(railTarget(order, 3)).toBe('debugger');
    expect(railTarget(order, 0)).toBeUndefined();
  });
});
