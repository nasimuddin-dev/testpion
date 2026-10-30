import { useSyncExternalStore } from 'react';
import { gitRefKey, type ItemRef } from '@testpion/shared';
import { call } from '../api';
import { gitSnapshot } from './git';
import { cardOf, type LastChange } from './git-who-text';

/**
 * Who last changed an item (the hover of every versioned row): after the pointer rests on a row of an item in git, a small
 * card says who changed it, when, why (the commit's subject) and what ("URL, headers"). One controller for every list, so
 * a row costs two handlers and no state; the card is drawn once (`<GitWhoTip>`). Asks the backend once per item and commit
 * (`git.lastChange`, cached by HEAD there and by the same key here) and never while the item has a change of yours that is not
 * committed: then the card says that instead.
 */
export interface WhoCard {
  /** The row's box, to place the card beside it. */
  x: number;
  y: number;
  /** Who and when: "Ana, 2 days ago". */
  headline: string;
  /** The commit's subject, then what it changed. */
  lines: string[];
}

/** The rest the pointer needs on a row before the card asks (a pass over rows asks nothing). */
const DELAY_MS = 550;
const cache = new Map<string, LastChange | null>();
let card: WhoCard | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let hovered = '';
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));

function show(next: WhoCard | undefined) {
  card = next;
  emit();
}

/** The pointer rests on the row of an item: after a moment, say who last changed it. */
export function whoEnter(ref: ItemRef, el: HTMLElement): void {
  const snap = gitSnapshot();
  if (!snap.status?.repository) return;
  const key = gitRefKey(ref);
  hovered = key;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void ask(ref, key, el), DELAY_MS);
}

/** The pointer left the row (or the list scrolled, a menu opened). */
export function whoLeave(): void {
  hovered = '';
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (card) show(undefined);
}

async function ask(ref: ItemRef, key: string, el: HTMLElement) {
  const snap = gitSnapshot();
  const place = () => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + Math.min(r.width, 260)), y: Math.round(r.top + r.height / 2) };
  };
  // a change of yours that is not committed yet: the card says so (the row's mark says what)
  const mark = snap.marks.get(key);
  if (mark?.change === 'added') return hovered === key ? show({ ...place(), headline: 'New: not committed yet', lines: ['Commit it in the Git view to share it with your team.'] }) : undefined;
  const id = `${snap.status?.head ?? ''}|${key}`;
  let last = cache.get(id);
  if (last === undefined) {
    try {
      last = await call<LastChange | null>('git.lastChange', { ref });
    } catch {
      last = null;
    }
    if (cache.size > 2000) cache.clear();
    cache.set(id, last);
  }
  if (hovered !== key || !last) return;
  const text = cardOf(last);
  const note = mark ? ['You have changed it since: not committed yet.'] : [];
  show({ ...place(), headline: text.headline, lines: [...text.lines, ...note] });
}

export const useWhoCard = (): WhoCard | undefined => useSyncExternalStore(subscribe, () => card);

/** For tests. */
export function resetWhoForTest(): void {
  cache.clear();
  whoLeave();
}
