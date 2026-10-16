import { useSyncExternalStore } from 'react';

/**
 * Density (Settings ▸ Appearance): comfortable (default) or compact. One switch on the root element, `data-density`,
 * changes the design tokens in styles.css (the spacing every h- / p- / gap- utility is made of, the small text sizes,
 * form fields); lists drawn by VirtualList scale their row heights by `densityScale()`. Kept in localStorage too, so
 * the first paint is already right (main.tsx), before the settings arrive.
 */
export type Density = 'comfortable' | 'compact';

/** How much smaller compact is: the ratio of its spacing token to the default one (styles.css). */
export const COMPACT_SCALE = 0.86;
const KEY = 'aps.density';

let current: Density = 'comfortable';
const listeners = new Set<() => void>();

export function applyDensity(d: Density | undefined): void {
  const next: Density = d === 'compact' ? 'compact' : 'comfortable';
  if (typeof document !== 'undefined') document.documentElement.dataset.density = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* storage unavailable */
  }
  if (next === current) return;
  current = next;
  for (const l of listeners) l();
}

/** Before the first paint: the density this computer used last. */
export function applyStoredDensity(): void {
  let d: string | null = null;
  try {
    d = localStorage.getItem(KEY);
  } catch {
    /* storage unavailable */
  }
  applyDensity(d === 'compact' ? 'compact' : 'comfortable');
}

export const densityScale = (d: Density = current) => (d === 'compact' ? COMPACT_SCALE : 1);

/** A row height in the current density (rounded to whole pixels, so rows never blur or drift). */
export const scaledRow = (px: number, d: Density = current) => Math.round(px * densityScale(d));

/** The current density, for components (VirtualList): re-renders when it changes. */
export function useDensity(): Density {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => current,
    () => current,
  );
}
