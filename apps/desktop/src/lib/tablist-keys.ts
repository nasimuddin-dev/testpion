/**
 * The keys of a tab strip (the WAI-ARIA tabs pattern), shared by every strip (`Tabs`, `DocTabStrip`): ← / → go to the
 * previous / next tab (wrapping round), Home / End to the first / last. The tab it lands on is chosen at once and takes
 * the focus. Returns the id to go to, or undefined when the key is not one of these (it then goes on as it was).
 */
export function tabKeyTarget(key: string, ids: readonly string[], current: string | undefined): string | undefined {
  if (!ids.length) return undefined;
  const i = current === undefined ? -1 : ids.indexOf(current);
  if (key === 'ArrowRight') return ids[(i + 1) % ids.length];
  if (key === 'ArrowLeft') return ids[(i - 1 + ids.length) % ids.length];
  if (key === 'Home') return ids[0];
  if (key === 'End') return ids[ids.length - 1];
  return undefined;
}

/** Focus the tab drawn with `data-tab-id={id}` inside `list` once it is drawn as chosen (the next frame). */
export function focusTab(list: HTMLElement | null, id: string): void {
  requestAnimationFrame(() => list?.querySelector<HTMLElement>(`[role=tab][data-tab-id="${CSS.escape(id)}"]`)?.focus());
}
