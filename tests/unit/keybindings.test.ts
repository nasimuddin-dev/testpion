import { describe, expect, it } from 'vitest';
import {
  bindingProblem,
  comboLabel,
  comboOf,
  commandFor,
  COMMANDS,
  effectiveBindings,
  exportBindings,
  importBindings,
  isTextCombo,
  normalizeCombo,
  shortcutGroups,
} from '../../apps/desktop/src/lib/shortcuts';

// Settings ▸ Keyboard: one list of shortcuts (lib/shortcuts.ts), rebinding with conflict checks, export / import; the
// global key handler matches presses through comboOf.
const key = (k: string, o: Partial<{ code: string; ctrl: boolean; meta: boolean; alt: boolean; shift: boolean }> = {}) => ({
  key: k,
  code: o.code,
  ctrlKey: !!o.ctrl,
  metaKey: !!o.meta,
  altKey: !!o.alt,
  shiftKey: !!o.shift,
});

describe('key combinations', () => {
  it('reads presses the same way whatever the event carries', () => {
    expect(comboOf(key('k', { ctrl: true }))).toBe('Mod+K');
    expect(comboOf(key('K', { code: 'KeyK', ctrl: true, shift: true }))).toBe('Mod+Shift+K');
    expect(comboOf(key('?', { code: 'Slash', shift: true }))).toBe('?'); // the character says Shift
    expect(comboOf(key('`', { code: 'Backquote', ctrl: true, shift: true }))).toBe('Mod+Shift+`');
    expect(comboOf(key(',', { ctrl: true }))).toBe('Mod+,');
    expect(comboOf(key('ç', { code: 'KeyC', meta: true, alt: true }), true)).toBe('Mod+Alt+C'); // Alt+C on a Mac types ç
    expect(comboOf(key('ArrowLeft', { alt: true }))).toBe('Alt+←');
    expect(comboOf(key('F8', { shift: true }))).toBe('Shift+F8');
    expect(comboOf(key('3', { ctrl: true, alt: true }))).toBe('Mod+Alt+3');
    expect(comboOf(key('Control', { ctrl: true }))).toBeUndefined();
    expect(comboOf(key('k', { ctrl: true }), true)).toBe('Ctrl+K'); // on a Mac Ctrl is not ⌘
  });

  it('one spelling, labels per platform', () => {
    expect(normalizeCombo('shift+mod+p')).toBe('Mod+Shift+P');
    expect(normalizeCombo('Cmd+Alt+x')).toBe('Mod+Alt+X');
    expect(comboLabel('Mod+Shift+F', { mod: 'Ctrl', alt: 'Alt', shift: 'Shift' })).toBe('Ctrl+Shift+F');
    expect(comboLabel('Mod+Shift+F', { mod: '⌘', alt: '⌥', shift: '⇧' })).toBe('⌘+⇧+F');
    expect(isTextCombo('?')).toBe(true);
    expect(isTextCombo('F8')).toBe(false);
    expect(isTextCombo('Mod+P')).toBe(false);
  });
});

describe('bindings', () => {
  it('defaults, overrides and turned-off commands', () => {
    const b = effectiveBindings({ palette: 'mod+shift+p', search: '' });
    expect(b.palette).toBe('Mod+Shift+P');
    expect(b.search).toBe('');
    expect(commandFor('Mod+Shift+P', b)).toBe('palette');
    expect(commandFor('Mod+K', b)).toBeUndefined();
    expect(commandFor('Mod+Shift+F', b)).toBeUndefined();
    // every command has distinct default keys
    const all = COMMANDS.map((c) => c.combo);
    expect(new Set(all).size).toBe(all.length);
  });

  it('conflicts, reserved keys and keys typing needs are refused with a clear message', () => {
    const b = effectiveBindings();
    expect(bindingProblem('palette', 'Mod+P', b, false)).toEqual({ message: 'Mod+P is already “Quick Open”', conflict: 'quick-open' });
    expect(bindingProblem('palette', 'Mod+S', b, false)?.message).toMatch(/Save.*can't be changed/);
    expect(bindingProblem('palette', 'Mod+C', b, false)?.message).toMatch(/Copy/);
    expect(bindingProblem('palette', 'Mod+Alt+4', b, false)?.message).toMatch(/rail/);
    expect(bindingProblem('palette', 'K', b, false)?.message).toMatch(/needed for typing/);
    expect(bindingProblem('palette', 'Shift+K', b, false)?.message).toMatch(/needed for typing/);
    expect(bindingProblem('palette', 'Mod+Shift+P', b, false)).toBeUndefined();
    expect(bindingProblem('palette', 'Mod+K', b, false)).toBeUndefined(); // its own keys
  });

  it('the shortcuts list shows the person’s keys; the docs keep the defaults', () => {
    const o = { mod: 'Ctrl', alt: 'Alt', shift: 'Shift', mac: false, views: ['Home'] };
    const anywhere = (bindings?: Record<string, string>) => shortcutGroups({ ...o, bindings })[0]!.items;
    const row = (items: ReturnType<typeof anywhere>, id: string) => items.find((i) => i.ids?.includes(id))!;
    expect(row(anywhere(), 'palette').keys).toEqual([['Ctrl', 'K']]);
    expect(row(anywhere({ palette: 'Mod+Shift+P' }), 'palette').keys).toEqual([['Ctrl', 'Shift', 'P']]);
    expect(row(anywhere({ 'previous-problem': '' }), 'next-problem').keys).toEqual([['F8']]);
  });

  it('exports the changed ones, imports what is valid and says what it skipped', () => {
    const text = exportBindings({ palette: 'Mod+Shift+P', search: 'Mod+Shift+F' });
    expect(JSON.parse(text)).toEqual({ testpionKeybindings: 1, bindings: { palette: 'Mod+Shift+P' } });
    const r = importBindings(JSON.stringify({ bindings: { palette: 'Mod+Shift+P', nope: 'Mod+L', settings: 'Mod+S', search: 'Mod+P' } }), false);
    expect(r.bindings.palette).toBe('Mod+Shift+P');
    expect(r.bindings.search).toBe('Mod+P');
    // Quick Open gave its keys to search: it is turned off rather than sharing them
    expect(r.bindings['quick-open']).toBe('');
    expect(r.skipped).toEqual(['nope: not a command', expect.stringMatching(/^settings: Mod\+S is Save/)]);
    expect(() => importBindings('not json', false)).toThrow(/not JSON/);
    expect(() => importBindings('[1]', false)).toThrow(/No key bindings/);
  });
});
