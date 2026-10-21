import { useSyncExternalStore } from 'react';
import { isDocView, useDocs } from '../lib/docs';
import { useApp } from '../store';
import { useEditorTabsStore } from './EditorTabs';

/**
 * The item the window is showing (as recorded for Back / Forward, or, for a tab restored at start-up, the item its active tab
 * shows): the row of the explorer that is highlighted.
 */
export function openItemId(): string | undefined {
  const app = useApp.getState();
  const view = app.view;
  const group = isDocView(view) ? `${view}:${useDocs.getState().active[view] ?? 'main'}` : view;
  const tabs = useEditorTabsStore.getState();
  const list = tabs.byView[group] ?? [];
  const tabItem = (list.find((t) => t.key === tabs.activeByView[group]) ?? (list.length === 1 ? list[0] : undefined))?.item;
  return tabItem ?? ((app.nav.current.payload?.requestId ?? app.nav.current.payload?.savedId) as string | undefined);
}

const subscribe = (notify: () => void) => {
  const off = [useApp.subscribe(notify), useDocs.subscribe(notify), useEditorTabsStore.subscribe(notify)];
  return () => off.forEach((f) => f());
};

/** The open item's id. */
export const useOpenRequestId = (): string | undefined => useSyncExternalStore(subscribe, openItemId);

/**
 * Whether `id` is the item the window shows. Rows ask this themselves, so a switch of tab re-renders the two rows whose highlight
 * changes (the snapshot is a boolean), not the whole explorer and every row in it.
 */
export const useIsOpenItem = (id: string | undefined): boolean => useSyncExternalStore(subscribe, () => id !== undefined && openItemId() === id);
