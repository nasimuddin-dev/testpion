/** RPC handlers: the import dialog's preview → import → undo, the reports it keeps, and the Postman API key. */
import {
  ApsError,
  decodeBase64,
  expandImportFiles,
  fetchImportText,
  fetchPostmanInputs,
  fetchRepoFiles,
  parseRepoLink,
  importInputs,
  isRequestSnippet,
  listImportReceipts,
  parsePostmanRef,
  planInputs,
  readImportReport,
  reportMarkdown,
  type ImportReport,
  type ImportSinks,
  type ReimportAction,
  shortId,
  undoMany,
  type ImportInput,
  type RawImportFile,
  type SkippedFile,
} from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';
import { ImportPreviews, type PreviewSession } from '../import-previews.js';

/** What a preview read, kept for the import that follows (import-previews.ts: per session, bounded in count, age and bytes). */
export type Session = PreviewSession;
export { MAX_PREVIEWS as MAX_SESSIONS } from '../import-previews.js';
/** The most one picked or dropped file may be, checked on the base64 text before it is decoded. */
const MAX_FILE_BYTES = 256 * 1024 * 1024;

const previewsBySession = new WeakMap<Backend, ImportPreviews>();
/** This session's previews. */
export function previewsOf(be: Backend): ImportPreviews {
  return previewsBySession.get(be) ?? previewsBySession.set(be, new ImportPreviews(be.host.importBytes)).get(be)!;
}
/** Keep a preview for the import that follows (tests; the handler uses the same store). */
export function rememberSession(be: Backend, id: string, s: Session, now = Date.now()): void {
  previewsOf(be).remember(id, s, now);
}
/** For tests: how many previews this session keeps. */
export const sessionCount = (be: Backend): number => previewsOf(be).size;

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

/** Where an import puts the workspace's globals and cookies: the values and the jar this computer keeps for it. */
function sinks(be: Backend): ImportSinks {
  return {
    ...(be.currentValues
      ? {
          globals: {
            set: async (vars) => {
              for (const v of vars) await be.currentValues!.set('globals', '', v.key, v.value, !!v.secret || be.logger.redactor.isSensitiveKey(v.key));
            },
            remove: (keys) => {
              for (const k of keys) void be.currentValues!.set('globals', '', k, undefined, false);
            },
          },
        }
      : {}),
    ...(be.cookieStore
      ? {
          cookies: {
            add: (cookies) => cookies.forEach((c) => be.cookieStore!.jar.set(c)),
            remove: (list) => list.forEach((c) => be.cookieStore!.jar.remove(c.domain, c.name, c.path)),
          },
        }
      : {}),
  };
}

export function importHandlers(be: Backend): Handlers {
  const sweep = () => previewsOf(be).sweep();
  return {
    /**
     * Read what the user gave (files, a dropped folder, a ZIP, pasted text, a link, a Postman id) and say what importing
     * it would create and what would not come over: nothing is written. `sessionId` is what `import.apply` takes.
     */
    'import.preview': async (p: ImportSource & { keepPm?: boolean; liftTests?: boolean }) => {
      sweep();
      const inputs: ImportInput[] = [];
      const skipped: SkippedFile[] = [];
      if (p.files?.length) {
        // sizes are checked on the base64 text, before any of it is decoded
        const asked = p.files.reduce((n, f) => n + Math.floor(((f.base64?.length ?? 0) * 3) / 4), 0);
        const maxUpload = previewsOf(be).maxBytes;
        if (asked > maxUpload) throw new ApsError('ValidationError', `Those files are larger than ${Math.round(maxUpload / 1048576)} MB together`, { suggestions: [] });
        const raw: RawImportFile[] = p.files.map((f) => ({ path: f.path, data: f.base64 !== undefined ? decodeBase64(f.base64, Math.min(MAX_FILE_BYTES, maxUpload), f.path) : (f.text ?? '') }));
        const r = expandImportFiles(raw, { folderName: p.folderName });
        inputs.push(...r.inputs);
        skipped.push(...r.skipped);
      }
      if (p.text?.trim()) inputs.push({ name: 'pasted', text: p.text, source: 'pasted text', fileCount: 1 });
      if (p.url?.trim()) {
        const ref = parsePostmanRef(p.url);
        const repo = ref ? undefined : parseRepoLink(p.url.trim());
        if (ref) inputs.push(...(await fetchPostmanInputs(ref, be.secrets.get(KEY))));
        else if (repo) {
          // a public GitHub / GitLab repository or folder: its files are read without any credential
          const fetched = await fetchRepoFiles(repo);
          const r = expandImportFiles(fetched.files, { folderName: fetched.folderName });
          inputs.push(...r.inputs);
          skipped.push(...fetched.skipped, ...r.skipped);
        } else {
          const f = await fetchImportText(p.url.trim());
          inputs.push({ name: f.fileName ?? p.url, text: f.text, source: f.url, fileCount: 1 });
        }
      }
      if (!inputs.length) throw new ApsError('ValidationError', skipped.length ? `Nothing to import: ${skipped.slice(0, 3).map((s) => `${s.path} (${s.why})`).join(', ')}` : 'Choose a file or folder, paste a document, or give a link', { suggestions: [] });
      const sessionId = shortId('imps-');
      previewsOf(be).remember(sessionId, { inputs, skipped, at: Date.now() });
      // a copied request (cURL, fetch …) is saved by import.apply into the "Imported" collection: there is no tree to preview
      const snippets = inputs.filter((i) => isRequestSnippet(i.text)).length;
      return { sessionId, snippets, ...planInputs(be.ws, inputs.filter((i) => !isRequestSnippet(i.text)), skipped, { scripts: p.keepPm ? 'keep' : 'tp', liftTests: p.liftTests }) };
    },
    /** Import what a preview read. Several inputs: one that fails does not stop the others. Returns the ids `import.undo` takes. */
    'import.apply': ({ sessionId, keepPm, replaceSpec, liftTests, newCopy, decisions }: { sessionId: string; keepPm?: boolean; replaceSpec?: boolean; liftTests?: boolean; newCopy?: boolean; decisions?: Record<string, ReimportAction> }) => {
      const s = previewsOf(be).get(sessionId);
      if (!s) throw new ApsError('ValidationError', 'That preview has expired: choose the files again', { suggestions: [] });
      previewsOf(be).delete(sessionId);
      const snippetInputs = s.inputs.filter((i) => isRequestSnippet(i.text));
      const snippets = snippetInputs.map((i) => be.handlers['col.import']!({ text: i.text, fileName: i.name }) as { request?: string; collection?: string });
      const rest = s.inputs.filter((i) => !isRequestSnippet(i.text));
      const { imported, receipts } = importInputs(be.ws, rest, {
        secrets: be.secrets,
        scripts: keepPm ? 'keep' : 'tp',
        liftTests,
        // a source imported before updates the collection it made, item by item (replace / new / skip), unless a copy is asked for
        update: newCopy ? false : decisions && Object.keys(decisions).length ? { decisions } : true,
        sinks: sinks(be),
        specs: replaceSpec ? 'replace' : 'keep-both',
        envName: (i) => {
          const base = i.source.split(/[\\/]/).pop() ?? i.name;
          return /(^\.env|\.env$)/.test(base) ? base.replace(/^\.env\.?/, '').replace(/\.env$/, '') || undefined : /\.(http|rest|graphqls?|gql)$/i.test(base) ? base.replace(/\.(http|rest|graphqls?|gql)$/i, '') : i.name;
        },
      });
      be.host.emit('data.changed', { kind: 'collections' });
      be.host.emit('data.changed', { kind: 'environments' });
      if (imported.some((x) => x.result?.globals)) be.host.emit('data.changed', { kind: 'globals' });
      return { imported, receipts, snippets, skipped: s.skipped };
    },
    'import.cancel': ({ sessionId }: { sessionId: string }) => ({ ok: previewsOf(be).delete(sessionId) }),
    /** Take back imports (the receipts `import.apply` returned): to Recently deleted, so it can be restored. */
    'import.undo': ({ receipts, force }: { receipts: string[]; force?: boolean }) => {
      const r = undoMany(be.ws, receipts, { force, sinks: sinks(be) });
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
