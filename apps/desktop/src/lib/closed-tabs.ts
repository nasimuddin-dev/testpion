import { toItemRef, type ItemRef } from '@testpion/shared';
import { itemKey, sameItem } from './recent-items';
import { create } from 'zustand';
import { useApp } from '../store';
import { openRef } from './open-ref';
import { afterScopeChange, scopedKey } from './ws-scope';

/**
 * WF-10 Reopen closed tab (Ctrl+Shift+T, every tab strip's right-click menu, File ▸ Reopen Closed Tab): the tabs closed
 * lately in this workspace that showed a saved item (a request, a gRPC call, a connection, an MCP server, an API
 * definition, a dataset, a monitor), newest last. A tab with nothing saved behind it is not kept (its draft is gone).
 * Reopening goes through openRef, so an item deleted since says so. Per workspace (ws-scope); names and ids only.
 */
export interface ClosedTab {
  ref: ItemRef;
  label: string;
}

const KEY = 'closed-tabs';
const MAX = 20;

function read(): ClosedTab[] {
  const k = scopedKey(KEY);
  if (!k) return [];
  try {
    const list = JSON.parse(localStorage.getItem(k) ?? '[]') as unknown;
    if (!Array.isArray(list)) return [];
    return list.flatMap((x: { ref?: unknown; label?: unknown }) => {
      const ref = toItemRef(x?.ref);
      return ref && typeof x.label === 'string' ? [{ ref, label: x.label }] : [];
    });
  } catch {
    return [];
  }
}

function write(list: ClosedTab[]): void {
  const k = scopedKey(KEY);
  if (k)
    try {
      localStorage.setItem(k, JSON.stringify(list));
    } catch {
      /* storage full or unavailable: a convenience */
    }
  useClosedTabs.setState({ count: list.length, last: list[list.length - 1] });
}

/** How many closed tabs can be reopened, and the next one (menus show its name). */
export const useClosedTabs = create<{ count: number; last?: ClosedTab }>(() => {
  const list = read();
  return { count: list.length, last: list[list.length - 1] };
});
// another workspace: its own list
afterScopeChange(() => {
  const list = read();
  useClosedTabs.setState({ count: list.length, last: list[list.length - 1] });
});

/** Tabs just closed (several from Close other / all): each moves to the end, the list keeps the newest 20. */
export function noteClosedTabs(tabs: Array<ClosedTab | undefined>): void {
  const add = tabs.filter((t): t is ClosedTab => !!t).map((t) => ({ ...t, ref: sameItem(t.ref) }));
  if (!add.length) return;
  const keys = new Set(add.map((t) => itemKey(t.ref)));
  write([...read().filter((t) => !keys.has(itemKey(t.ref))), ...add].slice(-MAX));
}

/** Open the tab closed last (it leaves the list); nothing to reopen says so. */
export async function reopenClosedTab(): Promise<boolean> {
  const list = read();
  const last = list.pop();
  if (!last) {
    useApp.getState().toast('No closed tab to reopen', 'info');
    return false;
  }
  write(list);
  return openRef(last.ref, { newTab: true });
}
