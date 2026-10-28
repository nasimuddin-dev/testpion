/** Shift+F10 and the Menu key open the context menu of the focused item, as a right-click does. */
export const isMenuKey = (ev: { key: string; shiftKey?: boolean }) => ev.key === 'ContextMenu' || (ev.key === 'F10' && !!ev.shiftKey);

/**
 * Open the row menu of an exchange from the keyboard: the grid's rows listen for `contextmenu`, so the same event is sent to the
 * row (at its left edge). False when the row is not on screen (scrolled out of the list).
 */
export function openRowMenu(root: ParentNode, exchangeId: string): boolean {
  const row = root.querySelector<HTMLElement>(`[data-exchange="${CSS.escape(exchangeId)}"]`);
  if (!row) return false;
  const r = row.getBoundingClientRect();
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 24, clientY: r.top + Math.min(r.height, 24) / 2 }));
  return true;
}
