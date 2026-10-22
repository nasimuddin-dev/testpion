/**
 * Unsaved edits on a view that is not a tab (Settings): the view registers `ask`, which asks the user before the app
 * shows another view (setView, an intent, back / forward); leaving is cancelled when it answers false. One guard per
 * view; the request editors' tabs ask on close instead, with the same dialog. Registered by useLeaveGuard (hooks.ts).
 */
const guards = new Map<string, () => Promise<boolean>>();

export function setLeaveGuard(view: string, ask: (() => Promise<boolean>) | undefined): void {
  if (ask) guards.set(view, ask);
  else guards.delete(view);
}

/** Whether `view` may be left now: true at once without a guard, else what the guard answers (after asking). */
export function mayLeave(view: string): Promise<boolean> | true {
  const ask = guards.get(view);
  return ask ? ask() : true;
}
