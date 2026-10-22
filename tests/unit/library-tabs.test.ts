import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeTabs, openTab, type TabsState } from '../../apps/desktop/src/lib/library-tabs';

// WF-19: views whose items are saved in a library (Load tests, Evaluations) open them as tabs, with preview tabs.
const start: TabsState = { tabs: [{ id: 'main' }], active: 'main' };

describe('library tabs', () => {
  it('the first open uses the empty unsaved tab; a preview is replaced by the next preview; opening for good keeps it', () => {
    const a = openTab(start, 's1', false, 'n1');
    expect(a.state).toEqual({ tabs: [{ id: 'main', savedId: 's1' }], active: 'main' });
    const b = openTab(a.state, 's2', true, 'n2');
    expect(b.state.tabs).toEqual([
      { id: 'main', savedId: 's1' },
      { id: 'n2', savedId: 's2', preview: true },
    ]);
    const c = openTab(b.state, 's3', true, 'n3');
    expect(c).toMatchObject({ id: 'n2', fresh: true });
    expect(c.state.tabs).toEqual([
      { id: 'main', savedId: 's1' },
      { id: 'n2', savedId: 's3', preview: true },
    ]);
    // the item already open: its tab, and opened for good it stops being a preview
    const d = openTab(c.state, 's3', false, 'n4');
    expect(d).toMatchObject({ id: 'n2', fresh: false });
    expect(d.state.tabs[1]).toEqual({ id: 'n2', savedId: 's3', preview: false });
    // a new preview now opens a new tab
    expect(openTab(d.state, 's4', true, 'n5').state.tabs.map((t) => t.id)).toEqual(['main', 'n2', 'n5']);
  });

  it('keepFirst: the first tab is never reused (the Debugger’s live capture stays; a saved session gets its own tab)', () => {
    const a = openTab(start, 'session-1', false, 'n1', true);
    expect(a.state).toEqual({ tabs: [{ id: 'main' }, { id: 'n1', savedId: 'session-1' }], active: 'n1' });
    const b = openTab(a.state, 'session-2', true, 'n2', true);
    const c = openTab(b.state, 'session-3', true, 'n3', true);
    expect(c.state.tabs.map((t) => [t.id, t.savedId])).toEqual([
      ['main', undefined],
      ['n1', 'session-1'],
      ['n2', 'session-3'],
    ]);
  });

  it('closing activates the next tab to the right; closing all leaves one fresh tab', () => {
    const s: TabsState = { tabs: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], active: 'b' };
    expect(closeTabs(s, ['b']).active).toBe('c');
    expect(closeTabs(s, ['b', 'c']).active).toBe('a');
    expect(closeTabs(s, ['a']).active).toBe('b');
    expect(closeTabs(s, ['a', 'b', 'c'])).toEqual({ tabs: [{ id: 'main' }], active: 'main' });
  });

  // B-08b: the AI prompts tab never closed its last tab (the view had no empty state); every view whose tabs can all be
  // closed shows the shared NoOpenItems, and the UI plan tab-close-button closes the last tab of each
  it('a view that can close every tab draws the shared empty state', () => {
    const views = ['views/ai/Playground.tsx', 'views/EvaluationsView.tsx', 'views/LoadView.tsx', 'views/EnvironmentsView.tsx'];
    const withEmpty = views.filter((v) => /canBeEmpty: true/.test(readFileSync(join(__dirname, '../../apps/desktop/src', v), 'utf8')));
    expect(withEmpty).toEqual(views);
    for (const v of withEmpty) {
      const src = readFileSync(join(__dirname, '../../apps/desktop/src', v), 'utf8');
      expect(src, v).toMatch(/tabs\.empty/);
      expect(src, v).toContain('<NoOpenItems');
    }
    // the tab views with their own tab state (DocTabStrip) draw the same one when their last tab closes; the Debugger's
    // first tab is the live capture, which never closes (`fixed`), so it is never empty
    for (const v of ['views/TestsView.tsx', 'views/MonitorsView.tsx']) expect(readFileSync(join(__dirname, '../../apps/desktop/src', v), 'utf8'), v).toContain('<NoOpenItems');
    expect(readFileSync(join(__dirname, '../../apps/desktop/src/views/DebuggerView.tsx'), 'utf8')).toMatch(/fixed=\{\(t\) => !t\.savedId\}/);
  });

  // UI audit I1: the open item's ⋯ is its node menu (lib/item-menu.ts → buildNodeMenu), with the kind's Delete…, in every editor
  it('every item editor builds its ⋯ from the node menu of its kind', () => {
    const editors: Record<string, string> = {
      'views/MonitorsView.tsx': 'monitor',
      'views/LoadView.tsx': 'load-test',
      'views/EvaluationsView.tsx': 'evaluation',
      'views/ai/Playground.tsx': 'prompt',
      'views/McpView.tsx': 'mcp-server',
      'views/CollectionsView.tsx': 'collection',
      'views/TestsView.tsx': 'test',
      'views/DatasetView.tsx': 'dataset',
      'views/ApiDefinitionView.tsx': 'spec',
    };
    for (const [v, kind] of Object.entries(editors)) {
      const src = readFileSync(join(__dirname, '../../apps/desktop/src', v), 'utf8');
      expect(src, v).toContain(`openItemMenu('${kind}'`);
      // no "Delete monitor", "Delete file" or a red Delete button of its own: the menu's Delete… is the one
      expect(src, v).not.toMatch(/label[:=] ?["'`]Delete (monitor|file)|className="text-bad"\s+icon=\{<Trash2/);
    }
    expect(readFileSync(join(__dirname, '../../apps/desktop/src/views/EnvironmentsView.tsx'), 'utf8')).toMatch(/buildNodeMenu\(\s*'environment'/);
  });
});
