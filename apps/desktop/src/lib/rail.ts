/**
 * WF-13: the rail's order is the order of Ctrl/Cmd+Alt+1…9, the rail's tooltips and the shortcuts list. The rail shows
 * every view of NAV but the request editors (reached through Collections, the 2nd item), so the numbers are computed
 * from NAV here, once: Home 1, Collections 2, Debugger 3 …
 */
export type RailId = string;

/** The rail's items in order, from the navigation (Collections goes after the first, Home). */
export function railOrder(nav: ReadonlyArray<{ id: string; group: string }>): RailId[] {
  const rail = nav.filter((n) => n.group !== 'Requests').map((n) => n.id);
  return rail.length ? [rail[0]!, 'collections', ...rail.slice(1)] : ['collections'];
}

/** The shortcut of a rail item (`Ctrl+Alt+3`), the first nine only. */
export function railShortcut(order: RailId[], id: RailId, mod: string): string | undefined {
  const i = order.indexOf(id);
  return i >= 0 && i < 9 ? `${mod}+Alt+${i + 1}` : undefined;
}

/** What Ctrl/Cmd+Alt+n goes to, if anything. */
export function railTarget(order: RailId[], n: number): RailId | undefined {
  return n >= 1 && n <= 9 ? order[n - 1] : undefined;
}
