import { useApp } from '../store';

/** What an import did to Postman / Insomnia scripts (from `col.import`, `ws.importFile` …). */
export interface ImportScriptsSummary {
  converted: number;
  unchanged: Array<{ where: string; reason: string }>;
}

/** "Converted 3 scripts to tp.*", or undefined when nothing was converted. */
export function convertedScriptsText(s: ImportScriptsSummary | undefined): string | undefined {
  return s?.converted ? `Converted ${s.converted} script${s.converted === 1 ? '' : 's'} to tp.*` : undefined;
}

/** Every import says the same thing about scripts: a warning toast for any left on pm.* (with where and why). */
export function toastUnchangedScripts(s: ImportScriptsSummary | undefined): void {
  const left = s?.unchanged ?? [];
  if (!left.length) return;
  useApp.getState().toast(
    `${left.length} script${left.length === 1 ? '' : 's'} kept pm.* (it still runs): ${left
      .slice(0, 3)
      .map((u) => `${u.where}: ${u.reason}`)
      .join('; ')}${left.length > 3 ? ` (+${left.length - 3} more)` : ''}`,
    'warning',
  );
}
