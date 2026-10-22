import { useEffect, useRef } from 'react';
import type { ViewId } from '../store';
import { ask } from '../store';

/**
 * One guard for a view that edits something it does not save as you type (collection settings, Settings): going to
 * another view while it holds unsaved changes asks first (Save / Don't save / Cancel), the way closing a request tab does.
 * A view registers with `useLeaveGuard`; the app's navigation (`setView`, `openIntent`, Back and Forward) calls
 * `guardLeave` before it leaves a view.
 */
interface Guard {
  dirty: () => boolean;
  subject: string;
  save?: () => Promise<unknown>; // resolves false when nothing could be saved
}

const guards = new Map<ViewId, Guard>();

/** The guard of a view that holds unsaved changes right now, or undefined. */
export const dirtyGuard = (view: ViewId): Guard | undefined => {
  const g = guards.get(view);
  return g?.dirty() ? g : undefined;
};

/** Register a guard for `view` while the caller is mounted. */
export function registerLeaveGuard(view: ViewId, g: Guard): () => void {
  guards.set(view, g);
  return () => void (guards.get(view) === g && guards.delete(view));
}

/**
 * Ask what to do with the unsaved changes of `view`. Resolves true when the caller may leave (they were saved, or
 * thrown away on purpose), false to stay.
 */
export async function confirmLeave(view: ViewId): Promise<boolean> {
  const g = dirtyGuard(view);
  if (!g) return true;
  const id = await ask({
    title: 'Unsaved changes',
    message: `${g.subject} has unsaved changes.`,
    detail: 'Save them before you leave, or leave without saving and they are lost.',
    tone: 'question',
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'discard', label: "Don't save" },
      { id: 'save', label: 'Save', variant: 'primary' },
    ],
    cancelId: 'cancel',
  });
  if (id === 'discard') return true;
  if (id !== 'save') return false;
  if (!g.save) return true;
  try {
    return (await g.save()) !== false;
  } catch {
    return false;
  }
}

/**
 * Run `go` (a change of view) now, or after the user chose what to do with the unsaved changes of the view being left.
 * Nothing happens when they cancel.
 */
export function guardLeave(from: ViewId, to: ViewId | undefined, go: () => void): void {
  if (from === to || !dirtyGuard(from)) return go();
  void confirmLeave(from).then((ok) => ok && go());
}

/**
 * Guard `view` while it is mounted and `dirty` is true. `save` (optional) is what the dialog's Save runs; the guard
 * lets the user leave unless it resolved to false (the save failed).
 */
export function useLeaveGuard(view: ViewId, dirty: boolean, subject: string, save?: () => Promise<unknown>): void {
  const state = useRef({ dirty, subject, save });
  state.current = { dirty, subject, save };
  useEffect(() => registerLeaveGuard(view, { dirty: () => state.current.dirty, get subject() { return state.current.subject; }, save: () => (state.current.save ? state.current.save() : Promise.resolve()) }), [view]);
}
