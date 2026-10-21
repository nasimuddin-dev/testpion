/**
 * RPC handlers: export and import of bundles (packages/core/src/transfer). The window's Export… and Import… items, the
 * shared dialogs and a cloud host go through these; the CLI (`testpion export`/`import`) and MCP call the same core
 * functions. A file is saved with the shared `saveOrDownload` (a native dialog on the desktop, a download in a browser),
 * and a bundle is read from the native open dialog or, in a browser, from the bytes the window sends.
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  ApsError,
  TRANSFER_LIMITS,
  decodeBase64,
  applyImport,
  buildBundle,
  describeBundle,
  forgetPlan,
  listImports,
  parseSelector,
  previewImport,
  readBundle,
  recallBundle,
  rememberBundle,
  sectionRefs,
  undoImport,
  type BuildOptions,
  type BundleRef,
  type ImportChoice,
} from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';

const FILTERS = [{ name: 'TestPion bundle', extensions: ['zip', 'json'] }];

interface ExportParams extends Pick<BuildOptions, 'uses' | 'datasets' | 'providers' | 'format'> {
  /** Items: ItemRefs, kind:id strings, or a collection's name. */
  selection?: unknown[];
  /** A whole section by kind (`dataset`, `mcp-server` …). */
  section?: string;
  /** The whole workspace. */
  all?: boolean;
  title?: string;
  /** Only say what would be exported (the dialog's summary); nothing is saved. */
  dryRun?: boolean;
}

export function bundleHandlers(be: Backend): Handlers {
  const refsOf = (p: ExportParams): BundleRef[] | 'all' => {
    if (p.all) return 'all';
    if (p.section) return sectionRefs(be.ws, p.section);
    const sel = p.selection ?? [];
    if (!sel.length) throw new ApsError('ValidationError', 'Nothing is selected to export');
    return sel.map((s) => parseSelector(be.ws, s));
  };
  return {
    /**
     * Export items to a bundle file. `dryRun` answers with what the bundle would hold (items, replaced secrets, items that
     * are used but not in the workspace) without saving, so the dialog shows it before anything is written.
     */
    'bundle.export': async (p: ExportParams) => {
      const b = buildBundle(be.ws, refsOf(p), { uses: p.uses, datasets: p.datasets, providers: p.providers, format: p.format, title: p.title });
      const summary = {
        title: b.manifest.title,
        fileName: b.fileName,
        format: b.format,
        size: b.bytes.length,
        counts: b.counts,
        items: b.manifest.items.map((i) => ({ kind: i.kind, id: i.id, name: i.name, mode: i.mode })),
        replaced: b.replaced,
        missing: b.manifest.missing,
        notes: b.notes,
        lines: b.lines,
        review: describeBundle(readBundle(b.bytes)).review,
      };
      if (p.dryRun) return summary;
      const saved = await be.saveOrDownload(
        b.fileName,
        [{ name: 'TestPion bundle', extensions: [b.format] }],
        (dest) => writeFileSync(dest, b.bytes),
        () => b.bytes,
        {
          type: b.format === 'zip' ? 'application/zip' : 'application/json',
        },
      );
      return { ...summary, ...saved, saved: !!(saved.path || saved.download) };
    },

    /**
     * Read a bundle and say what importing it would do. `pick`: choose the file with the native open dialog (null when
     * cancelled; `upload: true` where there is none: the window sends `base64` of the file it picked). The answer's
     * `planId` is what `bundle.apply` takes: it applies exactly this.
     */
    'bundle.preview': async ({ pick, base64, path, fileName }: { pick?: boolean; base64?: string; path?: string; fileName?: string }) => {
      let bytes: Buffer;
      let name = fileName ?? 'bundle';
      if (base64 !== undefined) bytes = decodeBase64(base64, TRANSFER_LIMITS.fileBytes, 'That file');
      else {
        let file = path;
        if (pick) {
          if (!be.host.openDialog) return { upload: true };
          file = await be.host.openDialog({ filters: FILTERS });
          if (!file) return null;
        }
        if (!file) throw new ApsError('ValidationError', 'No file to read');
        if (statSync(file).size > TRANSFER_LIMITS.fileBytes) throw new ApsError('ValidationError', 'That file is too large to be a bundle');
        bytes = readFileSync(file);
        name = basename(file);
      }
      const bundle = readBundle(bytes);
      const planId = rememberBundle(be.ws, bundle);
      return { planId, fileName: name, preview: previewImport(be.ws, bundle), description: describeBundle(bundle) };
    },

    /** Apply a previewed bundle with the person's choices; the answer's importId is what `bundle.undo` takes. */
    'bundle.apply': ({ planId, onConflict, decisions, only }: { planId: string; onConflict?: ImportChoice; decisions?: Record<string, ImportChoice | 'import'>; only?: string[] }) =>
      applyImport(be.ws, recallBundle(be.ws, planId), { onConflict, decisions, only }),

    /** Take an import back as one step (the Undo of the toast). */
    'bundle.undo': ({ importId, planId }: { importId: string; planId?: string }) => {
      if (planId) forgetPlan(planId);
      return undoImport(be.ws, importId);
    },

    /** The imports of this workspace that can still be undone. */
    'bundle.imports': () => listImports(be.ws),
  };
}
