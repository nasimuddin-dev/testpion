/**
 * The rail's model, one for the rail itself, its tooltips, the Ctrl/Cmd+Alt+1…9 shortcuts, the shortcuts list and the
 * command palette's hints. Every view of NAV is on it but the request editors (reached through Collections, the 2nd
 * item). The person decides which views the rail shows and in what order (right-click an item); the rest are under
 * More…, and Ctrl/Cmd+Alt+1…9 count the shown items only. A per-computer preference (settings.json `rail`).
 */
export type RailId = string;

/** What the person chose: the order of every item, and which are shown (unset: the defaults). */
export interface RailPrefs {
  order?: RailId[];
  shown?: RailId[];
}

/** Shown on a new install: the views most people use every day, AI quality (AU-1, AU-21: a new person should see it) and RAG bots (R-1: its own place); the others wait under More…. */
export const RAIL_DEFAULT_SHOWN: readonly RailId[] = ['home', 'collections', 'tests', 'aiquality', 'rag', 'environments', 'history'];

/** AI Lab and Evaluations became one rail item, AI quality (AU-21): a saved rail keeps the place and the choice of the first of them. */
const RAIL_ALIASES: Record<string, RailId> = { ai: 'aiquality', evaluations: 'aiquality' };
const aliased = (ids: readonly RailId[]): RailId[] => ids.map((id) => RAIL_ALIASES[id] ?? id);

export interface RailModel {
  /** Every item, in the person's order. */
  all: RailId[];
  /** The items the rail shows (never empty), in order: Ctrl/Cmd+Alt+1…9 go to these. */
  visible: RailId[];
  /** The others, listed under More…. */
  more: RailId[];
}

/** The rail's items in the default order, from the navigation (Collections goes after the first, Home). */
export function railOrder(nav: ReadonlyArray<{ id: string; group: string }>): RailId[] {
  const rail = nav.filter((n) => n.group !== 'Requests').map((n) => n.id);
  return rail.length ? [rail[0]!, 'collections', ...rail.slice(1)] : ['collections'];
}

/**
 * The rail for a person's choice. Ids no longer known are dropped; a view added since the order was saved goes after
 * its default predecessor and starts under More… (a new version never rearranges someone's rail).
 */
export function railModel(defaults: readonly RailId[], prefs?: RailPrefs): RailModel {
  const known = new Set(defaults);
  const all = [...new Set(aliased(prefs?.order ?? []).filter((id) => known.has(id)))];
  for (const [i, id] of defaults.entries()) {
    if (all.includes(id)) continue;
    const before = defaults
      .slice(0, i)
      .reverse()
      .find((p) => all.includes(p));
    all.splice(before ? all.indexOf(before) + 1 : 0, 0, id);
  }
  const shown = new Set(aliased(prefs?.shown ?? RAIL_DEFAULT_SHOWN).filter((id) => known.has(id)));
  let visible = all.filter((id) => shown.has(id));
  if (!visible.length) visible = all.slice(0, 1);
  return { all, visible, more: all.filter((id) => !visible.includes(id)) };
}

/** The choice after a change to the rail: hide or show an item, move it one place up or down among the shown ones. */
export function railChange(m: RailModel, id: RailId, change: 'hide' | 'show' | 'up' | 'down'): RailPrefs {
  if (!m.all.includes(id)) return { order: m.all, shown: m.visible };
  if (change === 'hide') return { order: m.all, shown: m.visible.length > 1 ? m.visible.filter((v) => v !== id) : m.visible };
  if (change === 'show') {
    // a shown item goes after the last shown one, so it gets the next number (Ctrl+Alt+n)
    const rest = m.all.filter((v) => v !== id);
    const last = m.visible[m.visible.length - 1];
    const at = last ? rest.indexOf(last) + 1 : 0;
    return { order: [...rest.slice(0, at), id, ...rest.slice(at)], shown: [...m.visible.filter((v) => v !== id), id] };
  }
  const i = m.visible.indexOf(id);
  const j = change === 'up' ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= m.visible.length) return { order: m.all, shown: m.visible };
  const other = m.visible[j]!;
  const order = m.all.map((v) => (v === id ? other : v === other ? id : v));
  return { order, shown: order.filter((v) => m.visible.includes(v)) };
}

/** The shortcut of a rail item (`Ctrl+Alt+3`): the first nine shown items only. */
export function railShortcut(visible: RailId[], id: RailId, mod: string): string | undefined {
  const i = visible.indexOf(id);
  return i >= 0 && i < 9 ? `${mod}+Alt+${i + 1}` : undefined;
}

/** What Ctrl/Cmd+Alt+n goes to, if anything. */
export function railTarget(visible: RailId[], n: number): RailId | undefined {
  return n >= 1 && n <= 9 ? visible[n - 1] : undefined;
}
