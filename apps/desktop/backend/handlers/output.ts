/**
 * Download / export of every output (the down arrow on every response and result): one RPC family for all of them.
 *
 * - `output.save` writes a format of a surface (OUTPUT_SURFACES) to a file: through the OS "Save as…" dialog on the
 *   desktop (opened in the folder last used for that kind of output in this workspace), or returned for the browser to
 *   download (browser, cloud). Content the window built (small: a table, the headers) comes as `content`; big or
 *   backend-held output comes as a `source` (a spooled response body, a run's reports, the console, a data run's rows)
 *   and is streamed into the file here: it never passes through the window.
 * - The file is written to `<name>.part` and renamed when complete, so a cancel or a failure leaves no half file.
 * - `output.progress` events tell the window how far a big save is; `output.cancel` stops it.
 * - Secrets: the surface's policy comes from OUTPUT_SURFACES, never from the caller. Log-like outputs are redacted
 *   unless `includeSecrets` (the window asks first); a raw body is saved as is, with a notice when it looks like it holds
 *   a credential.
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { once } from 'node:events';
import { ApsError, maskSensitiveText, type Redactor } from '@testpion/core';
import {
  COPY_LIMIT,
  OUTPUT_FORMATS,
  createJsonMinifier,
  createJsonPrettyPrinter,
  htmlDocument,
  isOutputFormatId,
  jsonLines,
  markdownTable,
  outputSurface,
  sanitizeFileName,
  toCsv,
  zipFiles,
  type OutputFormatId,
  type OutputSource,
} from '@testpion/shared';
import type { Backend, Handlers } from '../backend.js';
import type { ConsoleEntry } from '../console-log.js';

/** Content the window built: at most this much (bigger outputs are sources, streamed here). */
const CONTENT_LIMIT = 16 * 1024 * 1024;
/** How much of a raw output is looked at for the "looks like it holds a secret" notice. */
const SAMPLE_BYTES = 1024 * 1024;
const REPORT_FILES: Record<string, string> = { html: 'report.html', md: 'report.md', junit: 'junit.xml', json: 'report.json' };

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

/** What is written: chunks, as they come (a source streams; content is one chunk). */
type Chunks = AsyncIterable<Buffer | string>;

interface Built {
  chunks: Chunks;
  /** Bytes, when known before writing (progress). */
  total?: number;
  /** A sample of the output's text, for the raw-notice check. */
  sample?: () => string | Promise<string>;
  redacted: boolean;
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

async function* one(x: Buffer | string): Chunks {
  yield x;
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

const consoleLine = (e: ConsoleEntry) =>
  [e.time, e.kind ?? 'http', e.method, e.url, e.status ?? '', e.durationMs !== undefined ? `${e.durationMs} ms` : '', e.error ? `error: ${e.error}` : ''].filter((x) => x !== '').join(' ') +
  e.logs.map((l) => `\n    [${l.phase}] ${l.message}`).join('');

/** Rows of a big grid, page by page through its own RPC (the window shows the same pages). */
async function* gridRows(be: Backend, src: Extract<OutputSource, { kind: 'grid' }>, signal: AbortSignal): AsyncGenerator<{ columns?: string[]; rows: unknown[][]; total?: number }> {
  const method = src.grid === 'scale-rows' ? 'tests.scaleRows' : src.grid === 'eval-matrix' ? 'eval.matrix' : undefined;
  if (!method) throw new ApsError('ValidationError', `output.save: unknown grid ${String(src.grid)}`);
  const limit = 500;
  for (let offset = 0; ; offset += limit) {
    if (signal.aborted) return;
    const page = (await be.handlers[method]!({ ...src.params, offset, limit })) as { rows: Array<Record<string, unknown>>; matched?: number; total?: number; columns?: Array<{ label: string }> };
    if (src.grid === 'eval-matrix') {
      const cols = page.columns ?? [];
      yield {
        columns: ['case', 'tags', ...cols.flatMap((c) => [`${c.label} status`, `${c.label} score`, `${c.label} change`])],
        rows: page.rows.map((r) => {
          const cells = (r.cells as Array<{ status?: string; score?: number; change?: string }>) ?? [];
          return [r.name, ((r.tags as string[]) ?? []).join(' '), ...cols.flatMap((_, i) => [cells[i]?.status ?? '', cells[i]?.score ?? '', cells[i]?.change ?? ''])];
        }),
        total: page.total,
      };
    } else {
      const valueKeys = [...new Set(page.rows.flatMap((r) => Object.keys((r.values as Record<string, unknown>) ?? {})))];
      yield {
        columns: ['row', 'status', 'durationMs', 'startedAt', 'failedStep', 'error', ...valueKeys],
        rows: page.rows.map((r) => [
          r.index,
          r.status,
          r.durationMs,
          r.startedAt,
          r.failedStepName ?? r.failedStep ?? '',
          r.error ?? '',
          ...valueKeys.map((k) => (r.values as Record<string, unknown>)?.[k]),
        ]),
        total: page.matched ?? page.total,
      };
    }
    if (page.rows.length < limit) return;
  }
}

/** A run's results as CSV rows. */
async function runCsv(be: Backend, runId: string): Promise<string> {
  const rows: unknown[][] = [['name', 'status', 'type', 'file', 'durationMs', 'attempts', 'checksPassed', 'checks', 'error', 'startedAt']];
  for await (const r of be.results(runId))
    rows.push([r.name, r.status, r.type, r.file ?? '', r.durationMs, r.attempts, r.checks.filter((c) => c.passed).length, r.checks.length, r.error?.message ?? '', r.startedAt]);
  return toCsv(rows);
}

function checkRunId(runId: unknown): string {
  if (typeof runId !== 'string' || !/^[\w.-]{1,120}$/.test(runId)) throw new ApsError('ValidationError', 'output.save: unknown run');
  return runId;
}

/** Build a format of a source: chunks to write (streamed for the big ones). */
async function buildSource(be: Backend, src: OutputSource, format: OutputFormatId, redact: (t: string) => string, redacted: boolean, signal: AbortSignal): Promise<Built> {
  const text = (t: string): Built => {
    const out = redact(t);
    return { chunks: one(out), total: Buffer.byteLength(out), sample: () => t.slice(0, SAMPLE_BYTES), redacted: redacted && out !== t };
  };
  switch (src.kind) {
    case 'response': {
      // resolved first: a prefix test alone would accept payloads/../../anything
      if (typeof src.payloadPath !== 'string' || !be.ws.isInside(src.payloadPath, 'payloads') || !existsSync(src.payloadPath))
        throw new ApsError('ValidationError', 'The response body is no longer on disk', { suggestions: ['Send the request again.'] });
      const path = src.payloadPath;
      const size = statSync(path).size;
      const sample = () => {
        const buf = Buffer.alloc(Math.min(size, SAMPLE_BYTES));
        const fd = createReadStream(path, { start: 0, end: Math.max(0, buf.length - 1) });
        return new Promise<string>((resolve) => {
          const parts: Buffer[] = [];
          fd.on('data', (c) => parts.push(c as Buffer));
          fd.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
          fd.on('error', () => resolve(''));
        });
      };
      if (src.part === 'pretty' && (format === 'json' || format === 'json-min')) {
        // a 50 MB body is re-indented as it is read: no parse, no copy of the whole value
        async function* pretty(): Chunks {
          const p: { push(c: string): string; end?(): string } = format === 'json' ? createJsonPrettyPrinter() : createJsonMinifier();
          const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 256 * 1024 });
          for await (const chunk of stream) {
            if (signal.aborted) return stream.destroy();
            yield p.push(chunk as string);
          }
          if (p.end) yield p.end();
        }
        return { chunks: pretty(), total: size, sample, redacted: false };
      }
      async function* raw(): Chunks {
        const stream = createReadStream(path, { highWaterMark: 512 * 1024 });
        for await (const chunk of stream) {
          if (signal.aborted) return stream.destroy();
          yield chunk as Buffer;
        }
      }
      return { chunks: raw(), total: size, sample, redacted: false };
    }
    case 'run': {
      const runId = checkRunId(src.runId);
      const dir = be.ws.runDir(runId);
      if (format === 'csv') return text(await runCsv(be, runId));
      if (format === 'zip') {
        const files: Array<{ name: string; data: string }> = [];
        for (const name of Object.values(REPORT_FILES)) {
          const p = join(dir, name);
          if (existsSync(p)) files.push({ name, data: redact(readFileSync(p, 'utf8')) });
        }
        files.push({ name: 'results.csv', data: redact(await runCsv(be, runId)) });
        const zip = Buffer.from(zipFiles(files));
        return { chunks: one(zip), total: zip.length, redacted };
      }
      const name = REPORT_FILES[format];
      if (!name) throw new ApsError('ValidationError', `output.save: a run has no ${format} report`);
      const p = join(dir, name);
      if (!existsSync(p))
        throw new ApsError('ConfigurationError', `Run ${runId} has no ${OUTPUT_FORMATS[format].label} report`, {
          suggestions: ['Reports are written when a run finishes: run it again if it was stopped.'],
        });
      return text(readFileSync(p, 'utf8'));
    }
    case 'flow-timeline': {
      const { flowRunTimelineHtml } = await import('@testpion/core');
      if (format === 'html') {
        const h = await flowRunTimelineHtml(be.ws, src.file, src.runId);
        return text(h.html);
      }
      const t = await be.handlers['tests.flowTimeline']!({ file: src.file, runId: src.runId });
      return text(JSON.stringify(t, null, 2) + '\n');
    }
    case 'console': {
      const entries = be.consoleBuffer;
      return text(format === 'jsonl' ? jsonLines(entries) : entries.map(consoleLine).join('\n') + '\n');
    }
    case 'logs': {
      const recs = be.logBuffer;
      return text(
        format === 'jsonl'
          ? jsonLines(recs)
          : recs.map((r) => `${r.time} ${r.level.toUpperCase()} [${r.scope}] ${r.message}${r.data === undefined ? '' : ` ${JSON.stringify(r.data)}`}`).join('\n') + '\n',
      );
    }
    case 'debugger': {
      const har = (await be.handlers['debug.har']!({})) as {
        log: { entries: Array<{ startedDateTime: string; time: number; request: { method: string; url: string }; response: { status: number; content?: { size?: number; mimeType?: string } } }> };
      };
      if (format === 'csv')
        return text(
          toCsv([
            ['started', 'method', 'url', 'status', 'timeMs', 'size', 'mimeType'],
            ...har.log.entries.map((e) => [
              e.startedDateTime,
              e.request.method,
              e.request.url,
              e.response.status,
              Math.round(e.time),
              e.response.content?.size ?? '',
              e.response.content?.mimeType ?? '',
            ]),
          ]),
        );
      return text(JSON.stringify(format === 'json' ? har.log.entries : har, null, 2) + '\n');
    }
    case 'grid': {
      // rows come page by page and are written as they come (a 10,000-row data run never is one string)
      let columns: string[] | undefined;
      const all: unknown[][] = [];
      const pages = gridRows(be, src, signal);
      if (format === 'csv') {
        async function* csv(): Chunks {
          for await (const p of pages) {
            const head = !columns;
            columns ??= p.columns ?? [];
            yield redact(toCsv(head ? [columns, ...p.rows] : p.rows));
          }
          if (!columns) yield '';
        }
        return { chunks: csv(), redacted };
      }
      for await (const p of pages) {
        columns ??= p.columns ?? [];
        all.push(...p.rows);
      }
      const cols = columns ?? [];
      if (format === 'html')
        return text(htmlDocument(src.grid === 'eval-matrix' ? 'Evaluation matrix' : 'Data run', [{ table: { columns: cols, rows: all } }], { generatedAt: new Date().toISOString() }));
      if (format === 'md') return text(markdownTable(cols, all));
      return text(
        JSON.stringify(
          all.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]]))),
          null,
          2,
        ) + '\n',
      );
    }
    default:
      throw new ApsError('ValidationError', `output.save: unknown source ${String((src as { kind?: unknown }).kind)}`);
  }
}

/** The surface and format of a call, checked against OUTPUT_SURFACES (the policy is the registry's, never the caller's). */
function check(p: { surface: string; format: string; content?: unknown; source?: unknown }) {
  const info = outputSurface(p.surface);
  if (!info) throw new ApsError('ValidationError', `output.save: unknown surface ${p.surface}`);
  if (!isOutputFormatId(p.format) || !info.formats.includes(p.format))
    throw new ApsError('ValidationError', `output.save: ${info.label} cannot be saved as ${p.format}`, { suggestions: [`Use one of: ${info.formats.join(', ')}`] });
  if (!p.content === !p.source) throw new ApsError('ValidationError', 'output.save: give content or a source');
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
  if (!p.content) return { built: await buildSource(be, p.source!, format, redact, redacting, signal), redactor, redacting };
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
  /** Files saved in this session, by job (for Show in folder / Open: the window never sends a path). */
  const saved = new Map<string, string>();
  const remember = folders(be);
  let seq = 0;

  return {
    /** Formats and policies of every surface (for the CLI, MCP and the docs). */
    'output.formats': () => ({ formats: OUTPUT_FORMATS }),

    'output.save': async (p: SaveParams) => {
      const { info, fmt } = check(p);
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
          saved.set(jobId, r.path);
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
          canOpen: !!r.path && !!be.host.openPath,
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

    /** Show a file saved in this session in the file manager, or open it (`open`). */
    'output.reveal': async ({ jobId, open }: { jobId: string; open?: boolean }) => {
      const path = saved.get(jobId);
      if (!path || !existsSync(path)) throw new ApsError('ConfigurationError', 'The saved file is no longer there');
      if (open) {
        if (!be.host.openPath) throw new ApsError('ConfigurationError', 'Files can only be opened from the desktop app');
        // Electron's shell.openPath answers with an error message (no app for the type …) instead of throwing
        const failed = await be.host.openPath(path);
        if (typeof failed === 'string' && failed)
          throw new ApsError('ConfigurationError', `Could not open ${basename(path)}: ${failed}`, { suggestions: ['Use Show in folder and open it from there.'] });
      } else if (be.host.showItemInFolder) be.host.showItemInFolder(path);
      else if (be.host.openPath) await be.host.openPath(dirname(path));
      else throw new ApsError('ConfigurationError', 'Files can only be shown from the desktop app');
      return { ok: true };
    },
  };
}
