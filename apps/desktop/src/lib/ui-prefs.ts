import { toastError, useApp } from '../store';
import type { AppSettings } from '../types';

/** The per-computer UI preferences kept in the app's settings (settings.json): the rail, density and key bindings. */
export type UiPrefs = Pick<AppSettings, 'rail' | 'density' | 'keybindings'>;

let pending: Promise<unknown> = Promise.resolve();

/**
 * Change per-computer preferences at once (the screen follows before the file is written) and save them; saves queue
 * in order, so quick changes (hide, hide, move) all land. A failed save puts the earlier value back and says why.
 */
export function saveUiPrefs(patch: Partial<UiPrefs>): Promise<void> {
  const st = useApp.getState();
  const before = st.settings;
  if (!before) return Promise.resolve();
  st.set({ settings: { ...before, ...patch } });
  const run = pending.then(async () => {
    const latest = useApp.getState().settings;
    if (!latest) return;
    try {
      await useApp.getState().saveSettings({ ...latest, ...patch });
    } catch (e) {
      const now = useApp.getState().settings;
      if (now) useApp.getState().set({ settings: { ...now, ...Object.fromEntries(Object.keys(patch).map((k) => [k, before[k as keyof UiPrefs]])) } });
      toastError(e);
    }
  });
  pending = run.catch(() => undefined);
  return run;
}
