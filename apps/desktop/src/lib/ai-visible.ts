/**
 * Settings ▸ AI assistant ▸ "Hide all AI actions" (B-15): ONE switch that every AI entry point of the window honours.
 * Three layers, so no entry point can forget it:
 *
 *  - the node menus: `buildNodeMenu` leaves out every item that comes from the one AI table (packages/shared/src/ai-actions.ts);
 *  - the store: `set` drops every request to open an AI surface (the assistant panel, the flow / security / drift dialog,
 *    the analysis dialog, the tidy dialog — AI_LAUNCH_KEYS) while AI is hidden, whoever asks (a button, a shortcut, the
 *    palette), and a stale panel closes;
 *  - the controls: a button, a palette command or a rail icon that opens one of them is not rendered (`useAiEnabled()`;
 *    the shared `AiAction` button does it itself).
 *
 * tests/unit/ai-hidden.test.ts lists every entry point of the window and fails for one that is not gated.
 * This module has no React and no store, so the menu builder (and its tests) can use it.
 */

let source: () => boolean = () => false;

/** The store tells this module where the setting is (store.ts, once). */
export function setAiHiddenSource(f: () => boolean): void {
  source = f;
}

/** Whether every AI action is hidden right now. */
export const aiHidden = (): boolean => source();

/** The store keys that open an AI surface of the window: while AI is hidden none of them can be set. */
export const AI_LAUNCH_KEYS = ['assistant', 'flowGenerate', 'aiAnalysis', 'tidyImport', 'askSearch'] as const;

/** `p` without a request to open an AI surface (closing one, `undefined`, stays). Returns `p` itself when there is nothing to drop. */
export function withoutAiLaunch<T extends object>(p: T): T {
  const rec = p as Record<string, unknown>;
  if (!AI_LAUNCH_KEYS.some((k) => rec[k] !== undefined)) return p;
  return Object.fromEntries(Object.entries(rec).filter(([k, v]) => v === undefined || !(AI_LAUNCH_KEYS as readonly string[]).includes(k))) as T;
}
