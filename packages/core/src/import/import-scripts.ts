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

