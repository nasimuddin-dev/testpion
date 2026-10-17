import { normalizeAiSettings } from '../ai/ai-settings.js';
import type { AppSettings } from './types.js';

/**
 * The desktop app's own preferences in settings (`rail`, `density`, `keybindings`, and the AI settings every host reads) in the shape the app reads, whatever
 * settings.json or a caller holds: a value of the wrong type (a hand-edited file, an older or newer version) is dropped
 * for the default rather than reaching the window, where it would stop the app from starting.
 */
export function normalizeUiPrefs<T extends Partial<AppSettings>>(s: T): T {
  const out = { ...s };
  const strings = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);
  const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if ('rail' in out) {
    const r = out.rail as unknown;
    const order = plain(r) ? strings(r.order) : undefined;
    const shown = plain(r) ? strings(r.shown) : undefined;
    if (order || shown) out.rail = { ...(order ? { order } : {}), ...(shown ? { shown } : {}) };
    else delete out.rail;
  }
  if ('density' in out && out.density !== 'compact' && out.density !== 'comfortable') delete out.density;
  if ('keybindings' in out) {
    const k = out.keybindings as unknown;
    const kept = plain(k) ? Object.entries(k).filter((e): e is [string, string] => typeof e[1] === 'string') : [];
    if (kept.length) out.keybindings = Object.fromEntries(kept);
    else delete out.keybindings;
  }
  if ('ai' in out) {
    const ai = normalizeAiSettings(out.ai);
    if (ai) out.ai = ai;
    else delete out.ai;
  }
  return out;
}
