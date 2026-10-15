import { itemRefKey, toItemRef, type ItemRef } from '@testpion/shared';
import { create } from 'zustand';
import { afterScopeChange, scopedKey } from './ws-scope';

/**
 * WF-01 / WF-10: the items opened lately in this workspace (the last 30), newest first, with the name they had. Every
 * open goes through openRef, which records it here; Quick Open (Ctrl+P with nothing typed) and Home list them. Kept per
 * workspace (ws-scope), in this window's storage only: names and ids, never values.
 */
export interface RecentItem {
  ref: ItemRef;
  label: string;
  /** When it was opened (ms). */
  at: number;
}

const KEY = 'recent-items';
const MAX = 30;
/** Links to documentation are not "items" one returns to. */
const SKIP = new Set<ItemRef['kind']>(['doc']);

/** The list as a store, for views that show it while it changes (Home's "Pick up where you left off"). */
export const useRecentItems = create<{ items: RecentItem[] }>(() => ({ items: recentItems() }));
afterScopeChange(() => useRecentItems.setState({ items: recentItems() }));

export function recentItems(): RecentItem[] {
  const k = scopedKey(KEY);
  if (!k) return [];
  try {
    const list = JSON.parse(localStorage.getItem(k) ?? '[]') as unknown;
    if (!Array.isArray(list)) return [];
    return list.flatMap((x: { ref?: unknown; label?: unknown; at?: unknown }) => {
      const ref = toItemRef(x?.ref);
      return ref && typeof x.label === 'string' ? [{ ref, label: x.label, at: Number(x.at) || 0 }] : [];
    });
  } catch {
    return [];
  }
}

/**
 * The item a ref names, without hints that don't change which item it is (a request's `protocol`): a request opened
 * from the explorer and from a link is one recent item, one closed tab.
 */
export function sameItem(ref: ItemRef): ItemRef {
  return ref.kind === 'request' ? { kind: 'request', collectionId: ref.collectionId, requestId: ref.requestId } : ref;
}
export const itemKey = (ref: ItemRef): string => itemRefKey(sameItem(ref));

/** Record an item just opened (it moves to the top; the list keeps the newest 30). */
export function rememberItem(given: ItemRef, label: string): void {
  const k = scopedKey(KEY);
  if (!k || SKIP.has(given.kind)) return;
  const ref = sameItem(given);
  const key = itemRefKey(ref);
  const next = [{ ref, label, at: Date.now() }, ...recentItems().filter((r) => itemKey(r.ref) !== key)].slice(0, MAX);
  try {
    localStorage.setItem(k, JSON.stringify(next));
  } catch {
    /* storage full or unavailable: the list is a convenience */
  }
  useRecentItems.setState({ items: next });
}

/** Forget an item (gone: deleted, renamed). */
export function forgetItem(ref: ItemRef): void {
  const k = scopedKey(KEY);
  if (!k) return;
  const key = itemKey(ref);
  const next = recentItems().filter((r) => itemKey(r.ref) !== key);
  try {
    localStorage.setItem(k, JSON.stringify(next));
  } catch {
    /* unavailable */
  }
  useRecentItems.setState({ items: next });
}
