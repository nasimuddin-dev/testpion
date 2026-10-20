import { convertCollectionScripts } from '../scripts/aliases.js';

/**
 * How an import treats scripts written for Postman (`pm.*`) or Insomnia (`insomnia.*`): `'tp'` (the
 * default) rewrites them to TestPion's `tp.*`; `'keep'` leaves `pm.*` (for collections still used in
 * Postman). `pm.*` runs either way: it is a hidden alias of `tp` in the sandbox, and exporting to
 * Postman turns `tp.*` back into `pm.*`.
 */
export type ImportScriptsMode = 'tp' | 'keep';

/**
 * The formats whose scripts `'keep'` (`--keep-pm`, the Import dialog's "Keep pm.*") leaves on `pm.*`: Postman's, and
 * Insomnia's (its `insomnia.*` becomes `pm.*` instead of `tp.*`). Other tools' scripts (Bruno's `bru.*` …) are
 * converted to `tp.*` either way, so a hint about `--keep-pm` is only for these.
 */
const KEEP_PM_FORMATS: ReadonlySet<string> = new Set(['postman', 'postman-v1', 'postman-v3', 'insomnia']);

/** Does `--keep-pm` change how scripts of this import format (`detectFormat`) come in? */
export function keepPmApplies(format: string | undefined): boolean {
  return !!format && KEEP_PM_FORMATS.has(format);
}

export interface ImportScriptsSummary {
  /** Scripts rewritten to `tp.*`. */
  converted: number;
  /** Scripts that still use `pm.*`, with the reason (e.g. they declare their own `pm`). */
  unchanged: Array<{ where: string; reason: string }>;
  /** Calls of another tool's script API that TestPion has no equivalent for (marked `// TODO(import)` in the script). */
  warnings?: Array<{ where: string; api: string }>;
}

type ScriptHolder = { name?: string; preRequestScript?: string; testScript?: string; items?: ScriptHolder[]; kind?: string };

/** Rewrite an imported collection's `pm.*` scripts (collection, folders and requests) to `tp.*`, unless `mode` is `'keep'`. */
export function importScriptsToTp<C extends ScriptHolder>(collection: C, mode: ImportScriptsMode = 'tp'): { collection: C; scripts: ImportScriptsSummary } {
  if (mode === 'keep') return { collection, scripts: { converted: 0, unchanged: [] } };
  const r = convertCollectionScripts(collection, 'pm', 'tp');
  return { collection: r.collection, scripts: { converted: r.changed, unchanged: r.skipped } };
}

/**
 * Rewrite another tool's script API (Bruno's `bru.*` …) in every script of a collection with `convert`, then the
 * `pm.*` → `tp.*` pass. One summary: scripts converted, scripts left on `pm.*`, and calls with no TestPion equivalent.
 */
export function importForeignScriptsToTp<C extends ScriptHolder>(
  collection: C,
  convert: (code: string) => { code: string; changed: number; warnings: string[] },
  mode: ImportScriptsMode = 'tp',
): { collection: C; scripts: ImportScriptsSummary } {
  let converted = 0;
  const warnings: Array<{ where: string; api: string }> = [];
  const fix = (code: string | undefined, where: string): string | undefined => {
    if (!code) return code;
    const r = convert(code);
    if (r.changed) converted++;
    for (const api of r.warnings) warnings.push({ where, api });
    return r.code;
  };
  const walk = <T extends ScriptHolder>(n: T, path: string): T => {
    const out: T = { ...n };
    if (n.preRequestScript !== undefined) out.preRequestScript = fix(n.preRequestScript, `${path} (pre-request)`);
    if (n.testScript !== undefined) out.testScript = fix(n.testScript, `${path} (post-response)`);
    if (n.items) out.items = n.items.map((c) => walk(c, `${path} / ${c.name ?? '?'}`));
    return out;
  };
  const tp = importScriptsToTp(walk(collection, collection.name ?? 'collection'), mode);
  return { collection: tp.collection, scripts: { converted: Math.max(converted, tp.scripts.converted), unchanged: tp.scripts.unchanged, ...(warnings.length ? { warnings } : {}) } };
}
