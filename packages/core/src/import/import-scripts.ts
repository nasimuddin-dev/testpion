import { convertCollectionScripts } from '../scripts/aliases.js';

/**
 * How an import treats scripts written for Postman (`pm.*`) or Insomnia (`insomnia.*`): `'tp'` (the
 * default) rewrites them to TestPion's `tp.*`; `'keep'` leaves `pm.*` (for collections still used in
 * Postman). `pm.*` runs either way: it is a hidden alias of `tp` in the sandbox, and exporting to
 * Postman turns `tp.*` back into `pm.*`.
 */
export type ImportScriptsMode = 'tp' | 'keep';

export interface ImportScriptsSummary {
  /** Scripts rewritten to `tp.*`. */
  converted: number;
  /** Scripts that still use `pm.*`, with the reason (e.g. they declare their own `pm`). */
  unchanged: Array<{ where: string; reason: string }>;
}

type ScriptHolder = { name?: string; preRequestScript?: string; testScript?: string; items?: ScriptHolder[]; kind?: string };

/** Rewrite an imported collection's `pm.*` scripts (collection, folders, requests) to `tp.*`, unless `mode` is `'keep'`. */
export function importScriptsToTp<C extends ScriptHolder>(collection: C, mode: ImportScriptsMode = 'tp'): { collection: C; scripts: ImportScriptsSummary } {
  if (mode === 'keep') return { collection, scripts: { converted: 0, unchanged: [] } };
  const r = convertCollectionScripts(collection, 'pm', 'tp');
  return { collection: r.collection, scripts: { converted: r.changed, unchanged: r.skipped } };
}
