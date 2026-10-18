/**
 * Download / export of every output (the down arrow on every response and result): one RPC family for all of them.
 *
 * - `output.save` writes a format of a surface (OUTPUT_SURFACES) to a file: through the OS "Save as…" dialog on the
 *   desktop (opened in the folder last used for that kind of output in this workspace), or returned for the browser to
 *   download (browser, cloud). Content the window built (small: a table, the headers) comes as `content`; big or
 *   backend-held output comes as a `source` (a spooled response body, a run's reports, the console, a data run's rows)
 *   and is streamed into the file here (output-sources.ts): it never passes through the window.
 * - The file is written to `<name>.part` and renamed when complete, so a cancel or a failure leaves no half file.
 * - `output.progress` events tell the window how far a big save is; `output.cancel` stops it.
 * - Secrets: the surface's policy comes from OUTPUT_SURFACES, never from the caller (nor the source: a surface names
 *   the sources it is built from). Log-like outputs are redacted unless `includeSecrets` (the window asks first); a raw
 *   body is saved as is, with a notice when it looks like it holds a credential.
 * - Open after a save (`output.reveal` with `open`) is for documents only: a file of a format the OS would run or hand
 *   to a browser is shown in its folder instead, whatever the window asks.
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { once } from 'node:events';
import { ApsError, maskSensitiveText, type Redactor } from '@testpion/core';
import { COPY_LIMIT, LAUNCHER_EXTENSIONS, OUTPUT_FORMATS, fileExtension, isOutputFormatId, outputSurface, sanitizeFileName, type OutputFormatId, type OutputSource } from '@testpion/shared';
import type { Backend, Handlers } from '../backend.js';
import { SAMPLE_BYTES, buildSource, one, type Built } from './output-sources.js';

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
 * Where a save is written before it is renamed onto `dest`: `<name>.part` beside it, or a short hidden name in the same
 * folder when `<name>.part` would pass the 255-byte name limit of macOS / Linux (a name typed in the dialog may be that
 * long). Same folder, so the rename never crosses a volume.
 */
export function partPathFor(dest: string): string {
  const name = basename(dest);
  if (Buffer.byteLength(`${name}.part`) <= 255) return `${dest}.part`;
  return join(dirname(dest), `.testpion-${process.pid}-${Date.now().toString(36)}.part`);
}

/** A file-system failure of a save as a message a person can act on (the folder, not a stack). */
function writeError(e: unknown, dest: string): unknown {
  const code = (e as { code?: string })?.code;
  const where = dirname(dest);
  const name = basename(dest);
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS')
    return new ApsError('ConfigurationError', `Cannot write ${name}: permission denied in ${where}`, {
      suggestions: ['Choose another folder, or close the program that has the file open.'],
    });
  if (code === 'EBUSY') return new ApsError('ConfigurationError', `Cannot replace ${name}: it is open in another program`, { suggestions: ['Close it there, or save under another name.'] });
  if (code === 'ENOSPC' || code === 'EDQUOT')
    return new ApsError('ConfigurationError', `Not enough disk space to save ${name} in ${where}`, { suggestions: ['Free some space, or choose another drive.'] });
  if (code === 'ENAMETOOLONG') return new ApsError('ValidationError', `The file name or path is too long: ${name}`, { suggestions: ['Choose a shorter name or folder.'] });
  if (code === 'ENOENT' || code === 'ENOTDIR') return new ApsError('ConfigurationError', `The folder ${where} is no longer there`, { suggestions: ['Choose another folder.'] });
  return e;
}

/** Mask header values with a sensitive name in `Name: value` lines and curl `-H 'Name: value'` arguments. */
function maskHeaderLines(text: string, redactor: Redactor): string {
  return text
    .replace(/^([ \t]*)([A-Za-z][\w-]*)([ \t]*:[ \t]*)(\S.*)$/gm, (m, a: string, k: string, sep: string) => (redactor.isSensitiveKey(k) ? `${a}${k}${sep}***` : m))
    .replace(/(-H\s+['"])([A-Za-z][\w-]*)(:\s*)([^'"]*)(['"])/g, (m, a: string, k: string, sep: string, _v: string, q: string) => (redactor.isSensitiveKey(k) ? `${a}${k}${sep}***${q}` : m));
}

/** A text output with its secrets masked (known secret values, sensitive field names, credentials by their shape). */
export function redactOutputText(text: string, format: OutputFormatId, redactor: Redactor): string {
  let out = text;
  const json = (s: string, pretty: boolean) => {
    try {
      const v = redactor.redact(JSON.parse(s));
      return pretty ? JSON.stringify(v, null, 2) + (s.endsWith('\n') ? '\n' : '') : JSON.stringify(v);
    } catch {
      return s;
    }
  };
  if (format === 'json' || format === 'har') out = json(out, true);
  else if (format === 'json-min') out = json(out, false);
  else if (format === 'jsonl')
    out = out
      .split('\n')
      .map((l) => (l.trim() ? json(l, false) : l))
      .join('\n');
  else out = maskHeaderLines(out, redactor);
  return maskSensitiveText(redactor.redactString(out), { pii: false });
}

/** "Contains what looks like a token (bearer)": what the redactor would have masked in a raw output, or undefined. */
export function secretNotice(sample: string, redactor: Redactor): string | undefined {
  const kinds = new Set<string>();
  maskSensitiveText(sample, { pii: false }, (k) => kinds.add(k));
  if (redactor.redactString(sample) !== sample) kinds.add('a secret variable value');
  const field = /"(access_?token|refresh_?token|id_?token|client_?secret|password|api_?key)"\s*:/i.exec(sample);
  if (field) kinds.add(field[1]!);
  if (!kinds.size) return undefined;
  return `Contains what looks like a credential (${[...kinds].slice(0, 3).join(', ')}). Saved as is.`;
}

/**
 * Whether a saved file may be opened with the OS: a document format, under a name no OS runs (the dialog lets a person
 * type any name; a launcher extension on a document is still a launcher to a double-click).
 */
export const canOpenSaved = (path: string, format: OutputFormatId): boolean => OPENABLE_FORMATS.has(format) && !LAUNCHER_EXTENSIONS.has(fileExtension(basename(path)));

/**
 * The surface, format and source of a call, checked against OUTPUT_SURFACES (the policy is the registry's, never the
 * caller's: a source is accepted only for a surface that names it, so no surface's policy is borrowed for another's data).
 */
function check(p: { surface: string; format: string; content?: unknown; source?: unknown }) {
  const info = outputSurface(p.surface);
  if (!info) throw new ApsError('ValidationError', `output.save: unknown surface ${p.surface}`);
  if (!isOutputFormatId(p.format) || !info.formats.includes(p.format))
    throw new ApsError('ValidationError', `output.save: ${info.label} cannot be saved as ${p.format}`, { suggestions: [`Use one of: ${info.formats.join(', ')}`] });
  if (!p.content === !p.source) throw new ApsError('ValidationError', 'output.save: give content or a source');
  if (p.source) {
    const kind = (p.source as { kind?: unknown })?.kind;
    if (typeof kind !== 'string' || !info.sources?.includes(kind as OutputSource['kind']))
      throw new ApsError('ValidationError', `output.save: unknown source ${String(kind)} for ${info.label}`, {
        suggestions: info.sources?.length ? [`${info.label} is built from: ${info.sources.join(', ')}`] : [`${info.label} is saved from its content`],
      });
  }
  return { info, format: p.format, fmt: OUTPUT_FORMATS[p.format] };
}

/** What a call writes: its content or its source, built, with the surface's secrets policy applied. */
async function prepare(be: Backend, p: SaveParams, signal: AbortSignal): Promise<{ built: Built; redactor: Redactor; redacting: boolean }> {
  const { info, format, fmt } = check(p);
  let redactor: Redactor = be.logger.redactor;
  if (p.environment)
    try {
      redactor = be.context({ environment: p.environment }).redactor;
    } catch {
      // an environment that cannot be read: the app's redactor still masks names and shapes
    }
  // a surface whose secrets are masked at capture (console, log) has none to include: it is always redacted
  const redacting = info.redaction === 'redacted-default' && (!p.includeSecrets || !!info.capturedRedacted);
  const redact = redacting ? (t: string) => redactOutputText(t, format, redactor) : identity;
  // a source masked at capture (a run's reports, the Debugger's HAR) holds nothing left to mask: the builders skip the
  // second pass (output-sources.ts). Content the window sent is masked whatever the surface says: the backend never
  // takes the window's word for what is in it.
  if (!p.content) return { built: await buildSource(be, p.source!, format, redact, redacting, signal, redacting && !!info.capturedRedacted), redactor, redacting };
  if (typeof p.content.text === 'string') {
    const original = p.content.text;
    if (original.length > CONTENT_LIMIT) throw new ApsError('ValidationError', 'output.save: the content is too large to send; save it from its source');
    const out = fmt.text ? redact(original) : original;
    return { built: { chunks: one(out), total: Buffer.byteLength(out), sample: () => original.slice(0, SAMPLE_BYTES), redacted: redacting && out !== original }, redactor, redacting };
  }
  if (typeof p.content.base64 === 'string') {
    const buf = Buffer.from(p.content.base64, 'base64');
    if (buf.length > CONTENT_LIMIT) throw new ApsError('ValidationError', 'output.save: the content is too large to send; save it from its source');
    return { built: { chunks: one(buf), total: buf.length, redacted: false }, redactor, redacting };
  }
  throw new ApsError('ValidationError', 'output.save: content needs text or base64');
}

const identity = (t: string) => t;

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
      const { info, format, fmt } = check(p);
      const jobId = p.jobId && /^[\w-]{1,64}$/.test(p.jobId) ? p.jobId : `out-${Date.now().toString(36)}-${++seq}`;
      // one save per job: a second one with the same id would take over the first one's Cancel and progress
      if (jobs.has(jobId)) throw new ApsError('ValidationError', `output.save: job ${jobId} is already running`);
      const ctrl = new AbortController();
      jobs.set(jobId, ctrl);
      try {
        const { built, redactor, redacting } = await prepare(be, p, ctrl.signal);
        const notice = info.redaction === 'raw-notice' && built.sample ? secretNotice(await built.sample(), redactor) : undefined;
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
          const part = partPathFor(dest);
          const out = createWriteStream(part);
          const failed = new Promise<never>((_, reject) => out.on('error', reject));
          failed.catch(() => undefined);
          try {
            for await (const c of built.chunks) {
              if (ctrl.signal.aborted) break;
              const buf = typeof c === 'string' ? Buffer.from(c, 'utf8') : c;
              bytes += buf.length;
              if (!out.write(buf)) await Promise.race([once(out, 'drain'), failed]);
              progress();
            }
            out.end();
            await Promise.race([once(out, 'close'), failed]);
            if (ctrl.signal.aborted) throw new ApsError('CancelledError', 'Saving was cancelled');
            renameSync(part, dest);
          } catch (e) {
            out.destroy();
            // closed before it is removed: an open handle can keep the name (or fail the removal) on some file systems
            if (!out.closed) await once(out, 'close').catch(() => undefined);
            try {
              rmSync(part, { force: true });
            } catch {
              // a .part that cannot be removed (the folder became read-only) must not hide why the save failed
            }
            throw writeError(e, dest);
          }
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
      const { fmt } = check(p);
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
