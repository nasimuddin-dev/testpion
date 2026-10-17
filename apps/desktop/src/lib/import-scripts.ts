import { useApp } from '../store';

/** What an import did to Postman / Insomnia / Bruno scripts (from `col.import`, `ws.importFile` …). */
export interface ImportScriptsSummary {
  converted: number;
  unchanged: Array<{ where: string; reason: string }>;
  /** Calls of another tool's script API TestPion has no equivalent for (marked TODO(import) in the script; also in the notes). */
  warnings?: Array<{ where: string; api: string }>;
}

/** "Converted 3 scripts to tp.*", or undefined when nothing was converted. */
export function convertedScriptsText(s: ImportScriptsSummary | undefined): string | undefined {
  return s?.converted ? `Converted ${s.converted} script${s.converted === 1 ? '' : 's'} to tp.*` : undefined;
}

/** The first `n` items joined with '; ', and "and N more" for the rest. */
const some = (list: string[], n = 3) => `${list.slice(0, n).join('; ')}${list.length > n ? ` and ${list.length - n} more` : ''}`;

/** Every import says the same thing about scripts: a warning toast for any left on pm.* (with where and why). */
export function toastUnchangedScripts(s: ImportScriptsSummary | undefined): void {
  const left = s?.unchanged ?? [];
  if (!left.length) return;
  useApp.getState().toast(`${left.length} script${left.length === 1 ? '' : 's'} kept pm.* (it still runs): ${some(left.map((u) => `${u.where}: ${u.reason}`))}`, 'warning');
}

/**
 * Every import shows what did not map the same way (Import dialog, Workspace menu ▸ Import…): the notes (unsupported
 * auth, template tags, values needed …) and the script APIs TestPion doesn't have. Long lists end with "and N more";
 * `testpion import --json` lists them all.
 */
export function toastImportNotes(r: { notes?: string[]; scriptWarnings?: Array<{ where: string; api: string; hint: string }> }): void {
  const notes = r.notes ?? [];
  if (notes.length) useApp.getState().toast(`Check after import (${notes.length} note${notes.length === 1 ? '' : 's'}): ${some(notes)}`, 'warning');
  const w = r.scriptWarnings ?? [];
  if (w.length) {
    const apis = [...new Set(w.map((x) => x.api))].join(', ');
    const where = [...new Set(w.map((x) => x.where))];
    useApp.getState().toast(`${where.length} request${where.length > 1 ? 's' : ''} use${where.length > 1 ? '' : 's'} script APIs TestPion doesn't have (${apis}): ${some(where)}. Tip: ${w[0]!.hint}.`, 'warning');
  }
}
