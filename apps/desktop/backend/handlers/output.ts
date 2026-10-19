/**
 * Download / export of every output (the down arrow on every response and result): one RPC family for all of them.
 *
 * - `output.save` writes a format of a surface (OUTPUT_SURFACES) to a file: through the OS "Save as…" dialog on the
 *   desktop (opened in the folder last used for that kind of output in this workspace), or returned for the browser to
 *   download (browser, cloud). Content the window built (small: a table, the headers) comes as `content`; big or
 *   backend-held output comes as a `source` (a spooled response body, a run's reports, the console, a data run's rows,
 *   History, traces …) and is built by core (packages/core/src/output: the same bytes `testpion output` and MCP
 *   `save_output` write) and streamed into the file here: it never passes through the window.
 * - This module keeps what is the window's: dialogs, the last folder, progress, Cancel, Show in folder / Open.
 * - The file is written to `<name>.part` and renamed when complete, so a cancel or a failure leaves no half file.
 * - `output.progress` events tell the window how far a big save is; `output.cancel` stops it.
 * - Secrets: the surface's policy comes from OUTPUT_SURFACES, never from the caller (nor the source: a surface names
 *   the sources it is built from). Log-like outputs are redacted unless `includeSecrets` (the window asks first); a raw
 *   body is saved as is, with a notice when it looks like it holds a credential.
 * - Open after a save (`output.reveal` with `open`) is for documents only: a file of a format the OS would run or hand
 *   to a browser is shown in its folder instead, whatever the window asks.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  ApsError,
  SAMPLE_BYTES,
  checkOutput,
  isRedacting,
  one,
  partPathFor,
  prepareSource,
  redactOutputText,
  secretNotice,
  storeOutputDeps,
  writeChunks,
  type Built,
  type GridPage,
  type OutputDeps,
  type Redactor,
} from '@testpion/core';
import { COPY_LIMIT, LAUNCHER_EXTENSIONS, OUTPUT_FORMATS, fileExtension, sanitizeFileName, type OutputFormatId, type OutputSource } from '@testpion/shared';
import type { Backend, Handlers } from '../backend.js';
import { scaleRowsPage } from './flow-scale.js';

export { partPathFor };

/** Content the window built: at most this much (bigger outputs are sources, streamed here). */
const CONTENT_LIMIT = 16 * 1024 * 1024;
/**
 * Formats "Open" after a save may hand to the OS: documents an editor or viewer shows. Not raw bytes (whatever the
 * server called them), not HTML (a browser would run its scripts from a file: URL) and not a shell script.
 */
const OPENABLE_FORMATS: ReadonlySet<OutputFormatId> = new Set<OutputFormatId>(['json', 'json-min', 'jsonl', 'text', 'csv', 'csv-excel', 'tsv', 'md', 'xml', 'har', 'junit', 'diff', 'png', 'svg', 'zip', 'cookies-txt']);

interface SaveParams {
  surface: string;
  format: string;
  suggestedName: string;
  label?: string;
  content?: { text?: string; base64?: string };
  source?: OutputSource;
  includeSecrets?: boolean;
  jobId?: string;
  environment?: string;
}

/** Last folder used, per workspace and kind of output (`<appDir>/output-folders.json`, never in the workspace's git). */
function folders(be: Backend) {
  const file = join(be.host.appDir, 'output-folders.json');
  const read = (): Record<string, string> => {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  };
  const key = (kind: string) => `${be.store?.id ?? 'none'}:${kind}`;
  return {
    get(kind: string): string {
      const f = read()[key(kind)];
      if (f && existsSync(f)) return f;
      const downloads = join(homedir(), 'Downloads');
      return existsSync(downloads) ? downloads : homedir();
    },
    set(kind: string, dir: string): void {
      try {
        const all = read();
        all[key(kind)] = dir;
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(all, null, 2));
      } catch {
        // remembering the folder is a convenience: a read-only app folder must not fail the save
      }
    },
  };
}

/**
 * Whether a saved file may be opened with the OS: a document format, under a name no OS runs (the dialog lets a person
 * type any name; a launcher extension on a document is still a launcher to a double-click).
 */
export const canOpenSaved = (path: string, format: OutputFormatId): boolean => OPENABLE_FORMATS.has(format) && !LAUNCHER_EXTENSIONS.has(fileExtension(basename(path)));

/** What the builders read from this app: the workspace, plus the console, the log, the Debugger session and a data run in progress. */
function outputDeps(be: Backend, redactor: Redactor): OutputDeps {
  return {
    ...storeOutputDeps(be.ws, redactor),
    results: (runId) => be.results(runId),
    scaleRows: (p) => (be.outputProviders.scaleRows ?? ((q) => scaleRowsPage(be, q as never) as unknown as GridPage))(p),
    consoleEntries: () => be.consoleBuffer,
    logEntries: () => be.logBuffer,
    har: be.outputProviders.har,
  };
}

/** What a call writes: its content or its source, built, with the surface's secrets policy applied. */
async function prepare(be: Backend, p: SaveParams, signal: AbortSignal): Promise<{ built: Built; redactor: Redactor; redacting: boolean; notice?: string }> {
  const { info, format, fmt } = checkOutput(p);
  let redactor: Redactor = be.logger.redactor;
  if (p.environment)
    try {
      redactor = be.context({ environment: p.environment }).redactor;
    } catch {
      // an environment that cannot be read: the app's redactor still masks names and shapes
    }
  if (p.source) {
    const r = await prepareSource(outputDeps(be, redactor), { surface: p.surface, format: p.format, source: p.source, includeSecrets: p.includeSecrets }, signal);
    return { built: r.built, redactor, redacting: r.redacting, notice: r.notice };
  }
  const redacting = isRedacting(info, p.includeSecrets);
  // Content the window sent is masked whatever the surface says: the backend never takes the window's word for what is in it.
  const redact = redacting ? (t: string) => redactOutputText(t, format, redactor) : (t: string) => t;
  const content = p.content!;
  if (typeof content.text === 'string') {
    const original = content.text;
    if (original.length > CONTENT_LIMIT) throw new ApsError('ValidationError', 'output.save: the content is too large to send; save it from its source');
    const out = fmt.text ? redact(original) : original;
    const sample = original.slice(0, SAMPLE_BYTES);
    return {
      built: { chunks: one(out), total: Buffer.byteLength(out), sample: () => sample, redacted: redacting && out !== original },
      redactor,
      redacting,
      notice: info.redaction === 'raw-notice' ? secretNotice(sample, redactor) : undefined,
    };
  }
  if (typeof content.base64 === 'string') {
    const buf = Buffer.from(content.base64, 'base64');
    if (buf.length > CONTENT_LIMIT) throw new ApsError('ValidationError', 'output.save: the content is too large to send; save it from its source');
    return { built: { chunks: one(buf), total: buf.length, redacted: false }, redactor, redacting };
  }
  throw new ApsError('ValidationError', 'output.save: content needs text or base64');
}

export function outputHandlers(be: Backend): Handlers {
  const jobs = new Map<string, AbortController>();
  /** Files saved in this session, by job, with the format they hold (for Show in folder / Open: the window never sends a path). */
  const saved = new Map<string, { path: string; format: OutputFormatId }>();
  const remember = folders(be);
  let seq = 0;

  return {
    /** Formats and policies of every surface (for the CLI, MCP and the docs). */
    'output.formats': () => ({ formats: OUTPUT_FORMATS }),

    'output.save': async (p: SaveParams) => {
      const { info, format, fmt } = checkOutput(p);
      const jobId = p.jobId && /^[\w-]{1,64}$/.test(p.jobId) ? p.jobId : `out-${Date.now().toString(36)}-${++seq}`;
      // one save per job: a second one with the same id would take over the first one's Cancel and progress
      if (jobs.has(jobId)) throw new ApsError('ValidationError', `output.save: job ${jobId} is already running`);
      const ctrl = new AbortController();
      jobs.set(jobId, ctrl);
      try {
        const { built, redacting, notice } = await prepare(be, p, ctrl.signal);
        let name = sanitizeFileName(p.suggestedName);
        if (!/\.[\w]{1,16}$/.test(name)) name = sanitizeFileName(`${name}.${fmt.ext}`);
        const ext = /\.([\w]{1,16})$/.exec(name)?.[1] ?? fmt.ext;
        const filters = [
          { name: p.label || fmt.label, extensions: [ext] },
          { name: 'All files', extensions: ['*'] },
        ];
        const kind = info.id.split('.')[0]!;
        let bytes = 0;
        let lastEmit = 0;
        const progress = (force = false) => {
          const now = Date.now();
          if (!force && now - lastEmit < 100) return;
          lastEmit = now;
          be.host.emit('output.progress', { jobId, bytes, total: built.total });
        };
        const write = async (dest: string) => {
          await writeChunks(built.chunks, dest, {
            signal: ctrl.signal,
            onBytes: (n) => {
              bytes += n;
              progress();
            },
          });
          progress(true);
        };
        const read = async () => {
          const parts: Buffer[] = [];
          for await (const c of built.chunks) {
            if (ctrl.signal.aborted) throw new ApsError('CancelledError', 'Saving was cancelled');
            const buf = typeof c === 'string' ? Buffer.from(c, 'utf8') : c;
            bytes += buf.length;
            if (bytes > 100 * 1024 * 1024)
              throw new ApsError('ValidationError', 'The file is larger than 100 MB and can only be saved from the desktop app', {
                suggestions: ['Use the desktop app, or the CLI, for files this big.'],
              });
            parts.push(buf);
          }
          return Buffer.concat(parts);
        };
        let r: { path?: string; download?: unknown };
        try {
          r = await be.saveOrDownload(name, filters, write, read, { defaultPath: join(remember.get(kind), name), type: fmt.mime });
        } catch (e) {
          if (e instanceof ApsError && e.kind === 'CancelledError') return { jobId, cancelled: true };
          throw e;
        }
        if (r.path) {
          remember.set(kind, dirname(r.path));
          saved.set(jobId, { path: r.path, format });
          if (saved.size > 50) saved.delete(saved.keys().next().value!);
        }
        if (!r.path && !r.download) return { jobId, cancelled: true };
        return {
          ...r,
          jobId,
          bytes,
          name,
          redacted: built.redacted || (redacting && fmt.text),
          notice,
          canReveal: !!r.path && !!(be.host.showItemInFolder || be.host.openPath),
          canOpen: !!r.path && !!be.host.openPath && canOpenSaved(r.path, format),
        };
      } finally {
        jobs.delete(jobId);
      }
    },

    /** The text of a format, built and redacted like a save (the Copy beside the down arrow); at most 5 MB. */
    'output.copy': async (p: SaveParams) => {
      const { fmt } = checkOutput(p);
      if (!fmt.text) throw new ApsError('ValidationError', `${fmt.label} is not text: download it instead`);
      const ctrl = new AbortController();
      const { built } = await prepare(be, p, ctrl.signal);
      let text = '';
      for await (const c of built.chunks) {
        text += typeof c === 'string' ? c : c.toString('utf8');
        if (text.length > COPY_LIMIT) {
          ctrl.abort();
          throw new ApsError('ValidationError', 'Too large to copy: download it instead');
        }
      }
      return { text, redacted: built.redacted };
    },

    'output.cancel': ({ jobId }: { jobId: string }) => {
      const c = jobs.get(jobId);
      c?.abort();
      return { cancelled: !!c };
    },

    /**
     * Show a file saved in this session in the file manager, or open it (`open`). Opening is decided here, from the
     * format that was saved: a file the OS would run or a browser would show is shown in its folder instead
     * (`opened: false`), whatever the window asked.
     */
    'output.reveal': async ({ jobId, open }: { jobId: string; open?: boolean }) => {
      const file = saved.get(jobId);
      if (!file || !existsSync(file.path)) throw new ApsError('ConfigurationError', 'The saved file is no longer there');
      const { path } = file;
      if (open && canOpenSaved(path, file.format)) {
        if (!be.host.openPath) throw new ApsError('ConfigurationError', 'Files can only be opened from the desktop app');
        // Electron's shell.openPath answers with an error message (no app for the type …) instead of throwing
        const failed = await be.host.openPath(path);
        if (typeof failed === 'string' && failed)
          throw new ApsError('ConfigurationError', `Could not open ${basename(path)}: ${failed}`, { suggestions: ['Use Show in folder and open it from there.'] });
        return { ok: true, opened: true };
      }
      if (be.host.showItemInFolder) be.host.showItemInFolder(path);
      else if (be.host.openPath) await be.host.openPath(dirname(path));
      else throw new ApsError('ConfigurationError', 'Files can only be shown from the desktop app');
      return { ok: true, opened: false };
    },
  };
}
