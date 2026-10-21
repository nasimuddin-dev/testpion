import { call } from '../api';
import { useApp } from '../store';
import { deliverSave, type SaveResult } from './files';

/** What `ws.export` answers: where it went (or the file to download), and what is in it, replaced and left out. */
export interface WorkspaceExportResult extends SaveResult {
  cancelled?: boolean;
  name?: string;
  /** `<workspace name>.testpion.json`. */
  fileName?: string;
  /** One line each: what is in it, the secrets replaced by {{variables}}, what was left out. */
  lines?: string[];
  replaced?: Array<{ kind: string; item: string; field: string; variable: string }>;
  notes?: string[];
}

/**
 * Export a workspace to one `.testpion.json` file (the desktop app asks where; a browser downloads it) and say what was
 * done: what it holds, which secrets were replaced by {{variables}} and what was left out. Every Export workspace entry
 * (the workspace menu, the app menu, the Collections menu, the Export dialog) goes through here, so they all say the
 * same. Resolves to whether it was exported (false when the save dialog was cancelled); errors are thrown.
 */
export async function exportWorkspace(ref?: string): Promise<boolean> {
  const r = await call<WorkspaceExportResult>('ws.export', ref ? { ref } : {});
  if (r.cancelled || !deliverSave(r)) return false;
  const where = r.path ? ` to ${r.path}` : '';
  const lines = r.lines ?? [];
  const warn = !!(r.replaced?.length || r.notes?.length);
  useApp.getState().toast([`Exported "${r.name ?? 'workspace'}"${where}.`, ...lines].join(' '), warn ? 'info' : 'success');
  return true;
}

/** After a workspace export was imported (it opened as a new workspace): what was skipped, and the values to fill in. */
export function toastWorkspaceImported(r: { name?: string; files?: number; notes?: string[]; valuesNeeded?: string[] }): void {
  const { toast } = useApp.getState();
  toast(`Workspace "${r.name ?? ''}" imported and opened${r.files ? ` with ${r.files} file${r.files === 1 ? '' : 's'} of specs/, datasets/, mocks/ and protos/` : ''}`, 'success');
  const notes = r.notes ?? [];
  if (notes.length) toast(`Not imported (${notes.length}): ${notes.slice(0, 5).join(' ')}${notes.length > 5 ? ` … and ${notes.length - 5} more` : ''}`, 'warning');
  const needed = r.valuesNeeded ?? [];
  if (needed.length)
    toast(
      `Values needed (secrets are never in an export; set them as secret variables of an environment): ${needed.slice(0, 8).join(', ')}${needed.length > 8 ? ` … and ${needed.length - 8} more` : ''}`,
      'warning',
      { label: 'Open Environments', onClick: () => useApp.getState().openIntent('environments', {}) },
    );
}
