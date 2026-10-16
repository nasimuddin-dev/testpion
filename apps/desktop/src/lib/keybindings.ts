import { useMemo } from 'react';
import { isMac, modKey } from '../api';
import { useApp } from '../store';
import { comboLabel, effectiveBindings, type Combo } from './shortcuts';
import { saveUiPrefs } from './ui-prefs';

/** The platform's names of the modifiers, for labels. */
export const KEY_NAMES = { mod: modKey, alt: isMac ? '⌥' : 'Alt', shift: isMac ? '⇧' : 'Shift' };

let cache: { from?: Record<string, string>; bindings: Record<string, Combo> } = { from: undefined, bindings: effectiveBindings() };
/** The key combination of every app-wide command now (the person's, else the default), outside React. */
export function getBindings(): Record<string, Combo> {
  const from = useApp.getState().settings?.keybindings;
  if (cache.from !== from) cache = { from, bindings: effectiveBindings(from) };
  return cache.bindings;
}

/** The same, for components: changes when a binding does. */
export function useBindings(): Record<string, Combo> {
  const from = useApp((s) => s.settings?.keybindings);
  return useMemo(() => effectiveBindings(from), [from]);
}

/** A command's keys as text (`Ctrl+Shift+F`), '' when turned off: tooltips, menus, the palette's hints. */
export function keyLabel(id: string, bindings: Record<string, Combo> = getBindings()): string {
  return comboLabel(bindings[id] ?? '', KEY_NAMES);
}

/** Save the person's bindings (only those that differ from the defaults are kept; per computer). */
export function saveBindings(overrides: Record<string, string>): Promise<void> {
  const defaults = effectiveBindings();
  const changed = Object.fromEntries(Object.entries(overrides).filter(([id, c]) => id in defaults && c !== defaults[id]));
  return saveUiPrefs({ keybindings: Object.keys(changed).length ? changed : undefined });
}
