/** RPC handlers: the import dialog's preview → import → undo, the reports it keeps, and the Postman API key. */
import {
  ApsError,
  expandImportFiles,
  fetchImportText,
  fetchPostmanInputs,
  importInputs,
  isRequestSnippet,
  listImportReceipts,
  parsePostmanRef,
  planInputs,
  readImportReport,
  reportMarkdown,
  type ImportReport,
  shortId,
  undoMany,
  type ImportInput,
  type RawImportFile,
  type SkippedFile,
} from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';

/** What a preview read, kept for the import that follows (the window never sends the files twice). */
interface Session {
  inputs: ImportInput[];
  skipped: SkippedFile[];
  at: number;
}
const SESSIONS = new Map<string, Session>();
const TTL_MS = 30 * 60_000;

const KEY = 'postman.apiKey';

export interface ImportSource {
  /** Files as picked or dropped: text, or base64 for a ZIP or other binary file. */
  files?: Array<{ path: string; text?: string; base64?: string }>;
  text?: string;
  /** A link, or postman:collection/<id> (needs the API key). */
  url?: string;
  /** Name of the folder that was picked or dropped. */
  folderName?: string;
}

export function importHandlers(be: Backend): Handlers {
  const sweep = () => {
    const now = Date.now();
    for (const [id, s] of SESSIONS) if (now - s.at > TTL_MS) SESSIONS.delete(id);
  };
  return {
    /**
     * Read what the user gave (files, a dropped folder, a ZIP, pasted text, a link, a Postman id) and say what importing
     * it would create and what would not come over: nothing is written. `sessionId` is what `import.apply` takes.
     */
    'import.preview': async (p: ImportSource & { keepPm?: boolean }) => {
      sweep();
      const inputs: ImportInput[] = [];
      const skipped: SkippedFile[] = [];
      if (p.files?.length) {
        const raw: RawImportFile[] = p.files.map((f) => ({ path: f.path, data: f.base64 !== undefined ? Buffer.from(f.base64, 'base64') : f.text ?? '' }));
        const r = expandImportFiles(raw, { folderName: p.folderName });
        inputs.push(...r.inputs);
        skipped.push(...r.skipped);
      }
      if (p.text?.trim()) inputs.push({ name: 'pasted', text: p.text, source: 'pasted text', fileCount: 1 });
      if (p.url?.trim()) {
        const ref = parsePostmanRef(p.url);
        if (ref) inputs.push(...(await fetchPostmanInputs(ref, be.secrets.get(KEY))));
        else {
          const f = await fetchImportText(p.url.trim());
          inputs.push({ name: f.fileName ?? p.url, text: f.text, source: f.url, fileCount: 1 });
        }
      }
      if (!inputs.length) throw new ApsError('ValidationError', skipped.length ? `Nothing to import: ${skipped.slice(0, 3).map((s) => `${s.path} (${s.why})`).join(', ')}` : 'Choose a file or folder, paste a document, or give a link', { suggestions: [] });
      const sessionId = shortId('imps-');
      SESSIONS.set(sessionId, { inputs, skipped, at: Date.now() });
      // a copied request (cURL, fetch …) is saved by import.apply into the "Imported" collection: there is no tree to preview
      const snippets = inputs.filter((i) => isRequestSnippet(i.text)).length;
      return { sessionId, snippets, ...planInputs(be.ws, inputs.filter((i) => !isRequestSnippet(i.text)), skipped, { scripts: p.keepPm ? 'keep' : 'tp' }) };
    },
    /** Import what a preview read. Several inputs: one that fails does not stop the others. Returns the ids `import.undo` takes. */
    'import.apply': ({ sessionId, keepPm, replaceSpec }: { sessionId: string; keepPm?: boolean; replaceSpec?: boolean }) => {
      const s = SESSIONS.get(sessionId);
      if (!s) throw new ApsError('ValidationError', 'That preview has expired: choose the files again', { suggestions: [] });
      SESSIONS.delete(sessionId);
      const snippetInputs = s.inputs.filter((i) => isRequestSnippet(i.text));
      const snippets = snippetInputs.map((i) => be.handlers['col.import']!({ text: i.text, fileName: i.name }) as { request?: string; collection?: string });
      const rest = s.inputs.filter((i) => !isRequestSnippet(i.text));
      const { imported, receipts } = importInputs(be.ws, rest, {
        secrets: be.secrets,
        scripts: keepPm ? 'keep' : 'tp',
        specs: replaceSpec ? 'replace' : 'keep-both',
        envName: (i) => {
          const base = i.source.split(/[\\/]/).pop() ?? i.name;
          return /(^\.env|\.env$)/.test(base) ? base.replace(/^\.env\.?/, '').replace(/\.env$/, '') || undefined : /\.(http|rest|graphqls?|gql)$/i.test(base) ? base.replace(/\.(http|rest|graphqls?|gql)$/i, '') : i.name;
        },
      });
      be.host.emit('data.changed', { kind: 'collections' });
      be.host.emit('data.changed', { kind: 'environments' });
      return { imported, receipts, snippets, skipped: s.skipped };
    },
    'import.cancel': ({ sessionId }: { sessionId: string }) => ({ ok: SESSIONS.delete(sessionId) }),
    /** Take back imports (the receipts `import.apply` returned): to Recently deleted, so it can be restored. */
    'import.undo': ({ receipts, force }: { receipts: string[]; force?: boolean }) => {
      const r = undoMany(be.ws, receipts, { force });
      be.host.emit('data.changed', { kind: 'collections' });
      be.host.emit('data.changed', { kind: 'environments' });
      return r;
    },
    /** The imports this workspace still has a report for (the last 30). */
    'import.list': () => listImportReceipts(be.ws),
    'import.report': ({ id }: { id: string }) => readImportReport(be.ws, id),
    /** A report as Markdown (Download ▸ Markdown). */
    'import.reportMarkdown': ({ report }: { report: ImportReport }) => reportMarkdown(report),
    /** The Postman API key (for importing by link or id) lives in the secret store, never in the workspace; only whether it is set is readable. */
    'import.postmanKey': () => ({ set: !!be.secrets.get(KEY) }),
    'import.setPostmanKey': async ({ key }: { key: string }) => {
      if (key.trim()) await be.secrets.set(KEY, key.trim());
      else await be.secrets.delete(KEY);
      return { set: !!key.trim() };
    },
  };
}
