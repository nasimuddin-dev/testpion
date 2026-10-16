import { useMemo } from 'react';
import { COLLECTIONS_NAV, NAV } from '../components/nav';
import { isRequestView, useApp, type ViewId } from '../store';
import { railChange, railModel, railOrder, type RailId, type RailModel } from './rail';
import { saveUiPrefs } from './ui-prefs';

/** Every rail item in the default order (lib/rail.ts). */
export const RAIL_DEFAULTS = railOrder(NAV);

/** A rail item's label, icon, hint and group (Collections included). */
export function railItem(id: RailId): { id: RailId; label: string; icon: React.ReactNode; hint?: string; group: string } | undefined {
  return id === 'collections' ? COLLECTIONS_NAV : NAV.find((n) => n.id === id);
}

/** The rail now, outside React (the global key handler, the palette's commands). */
export function getRail(): RailModel {
  return railModel(RAIL_DEFAULTS, useApp.getState().settings?.rail);
}

/** The rail, for components: changes when the person rearranges it. */
export function useRail(): RailModel {
  const prefs = useApp((s) => s.settings?.rail);
  return useMemo(() => railModel(RAIL_DEFAULTS, prefs), [prefs]);
}

/** Hide, show or move an item (right-click on the rail, More…); saved for this computer. */
export function changeRail(id: RailId, change: 'hide' | 'show' | 'up' | 'down'): Promise<void> {
  return saveUiPrefs({ rail: railChange(getRail(), id, change) });
}

/** Back to the default rail, or every view shown. */
export function resetRail(all = false): Promise<void> {
  return saveUiPrefs({ rail: all ? { order: getRail().all, shown: getRail().all } : undefined });
}

/** The rail item a view belongs to: the request editors are Collections'. */
export function railIdOf(view: ViewId): RailId {
  return isRequestView(view) ? 'collections' : view;
}

/** Go to a rail item: Collections opens the request editor used last with its explorer. */
export function goToRail(id: RailId): void {
  const st = useApp.getState();
  if (id === 'collections') {
    st.setView(st.lastRequestView);
    st.toggleExplorer(true);
  } else st.setView(id as ViewId);
}
