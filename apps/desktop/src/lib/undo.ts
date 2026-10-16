/**
 * Undo for reversible deletes: the toast that says "Deleted …" carries Undo for 8 s, and Ctrl/Cmd+Z (outside text
 * fields, editors, dialogs and menus, and only when nothing on screen used the key itself) runs the latest one still
 * offered. The undo puts the item back through the same RPC that deleted it (a snapshot saved again, or Recently
 * deleted's restore), so the backend, git and the other windows see an ordinary save.
 */
export const UNDO_MS = 8000;

interface Offer {
  id: number;
  run(): void;
  until: number;
}
let latest: Offer | undefined;
let seq = 0;

/**
 * Offer an undo; returns the function the toast's Undo button calls (it runs once, whichever way it is used; Ctrl/Cmd+Z
 * reaches it only while offered, 8 s). `onUndo` does the work; `onDone` is told when it ran (to close the toast).
 */
export function offerUndo(onUndo: () => unknown, ms = UNDO_MS, onDone?: () => void): () => void {
  let used = false;
  const offer: Offer = {
    id: ++seq,
    until: Date.now() + ms,
    run: () => {
      if (used) return;
      used = true;
      if (latest === offer) latest = undefined;
      onDone?.();
      onUndo();
    },
  };
  latest = offer;
  setTimeout(() => {
    if (latest === offer) latest = undefined;
  }, ms);
  return offer.run;
}

/** Run the latest undo still offered; false when there is none. */
export function undoLatest(now = Date.now()): boolean {
  const o = latest;
  if (!o || now > o.until) return false;
  o.run();
  return true;
}

/** Whether an undo is offered now (tests, the key handler). */
export const hasUndo = (now = Date.now()) => !!latest && now <= latest.until;
