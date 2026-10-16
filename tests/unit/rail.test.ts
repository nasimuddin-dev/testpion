import { describe, expect, it } from 'vitest';
import { RAIL_DEFAULT_SHOWN, railChange, railModel, railOrder, railShortcut, railTarget } from '../../apps/desktop/src/lib/rail';

// The rail's model: 5 views shown by default, More… for the rest, the person's order and choice (per computer);
// Ctrl/Cmd+Alt+1…9 count the shown views only.
const DEFAULTS = ['home', 'collections', 'debugger', 'tests', 'monitors', 'load', 'ai', 'evaluations', 'environments', 'history', 'traces', 'git'];

describe('rail model', () => {
  it('shows the default five, in the default order, the rest under More…', () => {
    const m = railModel(DEFAULTS);
    expect(m.visible).toEqual(['home', 'collections', 'tests', 'environments', 'history']);
    expect(m.visible).toEqual(DEFAULTS.filter((id) => RAIL_DEFAULT_SHOWN.includes(id)));
    expect(m.more).toEqual(['debugger', 'monitors', 'load', 'ai', 'evaluations', 'traces', 'git']);
    expect(m.all).toEqual(DEFAULTS);
  });

  it('the shortcuts follow the shown views', () => {
    const m = railModel(DEFAULTS);
    expect(railTarget(m.visible, 3)).toBe('tests');
    expect(railTarget(m.visible, 6)).toBeUndefined();
    expect(railShortcut(m.visible, 'history', 'Ctrl')).toBe('Ctrl+Alt+5');
    expect(railShortcut(m.visible, 'debugger', 'Ctrl')).toBeUndefined();
  });

  it('hides, shows (at the end of the shown ones) and moves items', () => {
    let m = railModel(DEFAULTS);
    m = railModel(DEFAULTS, railChange(m, 'history', 'hide'));
    expect(m.visible).toEqual(['home', 'collections', 'tests', 'environments']);
    expect(m.more).toContain('history');
    m = railModel(DEFAULTS, railChange(m, 'git', 'show'));
    expect(m.visible).toEqual(['home', 'collections', 'tests', 'environments', 'git']);
    expect(railTarget(m.visible, 5)).toBe('git');
    m = railModel(DEFAULTS, railChange(m, 'git', 'up'));
    expect(m.visible).toEqual(['home', 'collections', 'tests', 'git', 'environments']);
    m = railModel(DEFAULTS, railChange(m, 'home', 'up')); // already first: nothing changes
    expect(m.visible[0]).toBe('home');
    m = railModel(DEFAULTS, railChange(m, 'environments', 'down')); // already last
    expect(m.visible.at(-1)).toBe('environments');
    // every item is still somewhere: shown or under More…
    expect([...m.visible, ...m.more].sort()).toEqual([...DEFAULTS].sort());
  });

  it('never hides the last shown view', () => {
    let m = railModel(DEFAULTS, { shown: ['tests'] });
    expect(railChange(m, 'tests', 'hide').shown).toEqual(['tests']);
    m = railModel(DEFAULTS, { shown: [] });
    expect(m.visible).toEqual(['home']);
  });

  it('survives a saved choice from another version: unknown ids go, new views go to More… after their default neighbour', () => {
    const saved = { order: ['tests', 'gone', 'home', 'collections', 'environments', 'history'], shown: ['tests', 'home', 'gone'] };
    const m = railModel(DEFAULTS, saved);
    expect(m.visible).toEqual(['tests', 'home']);
    expect(m.all).not.toContain('gone');
    expect(m.all.length).toBe(DEFAULTS.length);
    // debugger's default predecessor is collections: it lands right after it
    expect(m.all.indexOf('debugger')).toBe(m.all.indexOf('collections') + 1);
    expect(m.more).toContain('git');
  });

  it('the default order still comes from the navigation: Collections second, no request editors', () => {
    const order = railOrder([
      { id: 'home', group: 'Start' },
      { id: 'rest', group: 'Requests' },
      { id: 'tests', group: 'Testing' },
    ]);
    expect(order).toEqual(['home', 'collections', 'tests']);
  });
});
