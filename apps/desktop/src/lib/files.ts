import { asError, call } from '../api';
import { useApp } from '../store';

/**
 * Host-agnostic file handling for the UI (desktop today, browser / cloud later). The UI never gets
 * local paths to read: files are picked in the browser and their content goes over RPC, and saved
 * files are either written by the backend (native dialog) or downloaded here.
 */

/** What backend "save" handlers return (see saveOrDownload in the backend). */
export interface SaveResult {
  path?: string;
  download?: { name: string; content: string; encoding: 'base64' | 'utf8'; type: string };
}

/** Download content in the browser. */
export function downloadContent(name: string, content: string, opts: { encoding?: 'base64' | 'utf8'; type?: string } = {}): void {
  const blob =
    opts.encoding === 'base64'
      ? new Blob([Uint8Array.from(atob(content), (c) => c.charCodeAt(0))], { type: opts.type ?? 'application/octet-stream' })
      : new Blob([content], { type: opts.type ?? 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Finish a save: download it when the backend returned content, and tell the user where it went. */
export function finishSave(r: SaveResult | null | undefined, what: string): void {
  if (!r) return;
  if (r.download) {
    downloadContent(r.download.name, r.download.content, { encoding: r.download.encoding, type: r.download.type });
    useApp.getState().toast(`${what} downloaded as ${r.download.name}`, 'success');
  } else if (r.path) useApp.getState().toast(`${what} saved to ${r.path}`, 'success');
}

/** Show HTML or text returned by the backend in a new browser tab (where there is no desktop shell). */
export function viewContent(v: { content: string; encoding: 'base64' | 'utf8'; type: string }): void {
  const bytes = v.encoding === 'base64' ? Uint8Array.from(atob(v.content), (c) => c.charCodeAt(0)) : new TextEncoder().encode(v.content);
  const url = URL.createObjectURL(new Blob([bytes], { type: v.type }));
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Let the user pick a text file in the browser; resolves with its name and content (null if cancelled). */
/**
 * Generate an integration suite (a flow per resource) from an API definition or a collection, after a confirmation that
 * says what gets written; the toast names the variables to set. The Preview tab and the Collections view share it.
 */
export async function generateFlows(source: { path: string } | { collectionId: string; name: string }, confirmAction: (o: { title: string; message: string; confirmLabel: string }) => Promise<boolean>) {
  const from = 'path' in source ? 'this definition' : `"${source.name}"`;
  const ok = await confirmAction({
    title: `Generate integration flows from ${from}?`,
    message:
      'One test file per resource under tests/<api>/flows/: create it, read it back, update it, see it listed, delete it and see it gone, each step depending on the one before, the created id flowing between them; the login operation first. Files that exist are kept.',
    confirmLabel: 'Generate flows',
  });
  if (!ok) return;
  try {
    const r = await call<{ written: Array<{ path: string; tests: number }>; skipped: string[]; resources: string[]; variables: string[] }>('openapi.generateFlows', 'path' in source ? { path: source.path } : { collectionId: source.collectionId });
    const n = r.written.reduce((k, f) => k + f.tests, 0);
    useApp
      .getState()
      .toast(
        r.written.length
          ? `${r.resources.length} flows, ${n} steps${r.skipped.length ? ` (${r.skipped.length} files kept as they were)` : ''}. The environment must set ${r.variables.map((v) => `{{${v}}}`).join(', ')}; review the bodies, then run the suite`
          : r.skipped.length
            ? `Every file exists already: ${r.skipped.join(', ')}`
            : 'No resource to make a flow of: the API needs a POST with a sibling GET / PUT / DELETE /{id} path',
        r.written.length ? 'success' : 'warning',
        r.written.length ? { label: 'Open Tests', onClick: () => useApp.getState().setView('tests') } : undefined,
      );
  } catch (e) {
    useApp.getState().toast(asError(e).message, 'error');
  }
}

export function pickTextFile(accept: string): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = async () => {
      const f = input.files?.[0];
      resolve(f ? { name: f.name, text: await f.text() } : null);
    };
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/**
 * Pick a folder and read the files in it that `keep` accepts (by path relative to the folder), e.g.
 * the .bru files of a Bruno collection. Works in the desktop app and in the browser / cloud alike.
 */
export function pickFolderFiles(keep: (path: string) => boolean, maxBytes = 50 * 1024 * 1024): Promise<{ name: string; files: Array<{ path: string; text: string }> } | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;
    input.onchange = async () => {
      const list = [...(input.files ?? [])];
      if (!list.length) return resolve(null);
      // webkitRelativePath is "<folder>/<path inside>"
      const rel = (f: File) => f.webkitRelativePath.split('/').slice(1).join('/');
      const name = list[0]!.webkitRelativePath.split('/')[0] ?? 'Folder';
      const wanted = list.filter((f) => !/(^|\/)(node_modules|\.[^/]+)\//.test(rel(f)) && keep(rel(f)));
      if (wanted.reduce((n, f) => n + f.size, 0) > maxBytes) return reject(new Error(`The folder's files are larger than ${Math.round(maxBytes / 1024 / 1024)} MB`));
      resolve({ name, files: await Promise.all(wanted.map(async (f) => ({ path: rel(f), text: await f.text() }))) });
    };
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/** Whether this host has native open/save dialogs (desktop app); false in the browser / cloud. */
export function hasNativeDialogs(): boolean {
  return !!(useApp.getState().info as { nativeDialogs?: boolean } | undefined)?.nativeDialogs;
}
