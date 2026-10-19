/**
 * The sources of an output (a `source` of `output.save`, `testpion output`, MCP `save_output`): what is built from the
 * workspace and the running app and streamed into the file because it is big or held only there — a spooled response
 * body, a run's reports, the console and the log, the Debugger's HAR, the rows of a data run or an evaluation matrix, the
 * history, traces, monitor runs, runs list and the workspace's changes. Every builder gives chunks as they come: a 50 MB
 * body is re-indented as it is read, a 100,000-row grid is written page by page, a run's ZIP entry by entry; nothing is
 * one string of the whole. The host gives what only it holds (OutputDeps); the bytes are the same wherever they are saved.
 */
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GRID_SOURCES,
  HTML_DOCUMENT_TAIL,
  HTML_TABLE_TAIL,
  OUTPUT_FORMATS,
  createJsonMinifier,
  createJsonPrettyPrinter,
  createZipWriter,
  htmlDocumentHead,
  htmlTableHead,
  htmlTableRows,
  jsonLines,
  markdownTableHead,
  markdownTableRows,
  toCsv,
  type OutputFormatId,
  type OutputSource,
} from '@testpion/shared';
import { ApsError } from '../errors.js';
import { flowRunTimelineHtml } from '../runner/flow-report.js';
import { plainFileInside } from '../storage/fsutil.js';
import { dataSource } from './sources-data.js';
import { SAMPLE_BYTES, one, type Built, type Chunks, type ConsoleLine, type GridPage, type OutputDeps } from './types.js';

const REPORT_FILES: Record<string, string> = { html: 'report.html', md: 'report.md', junit: 'junit.xml', json: 'report.json' };
/** Entries of the console and the log are written this many at a time (each chunk whole lines, so a mask per chunk is a mask per line). */
const LOG_PAGE = 500;
/**
 * A laid-out body may be this many times its raw size at most (every structural character gets a line and an indent
 * of at most 64 levels), and never under 4 MB: past it the body is not a document anyone reads laid out, and the save
 * stops rather than fill the disk.
 */
const PRETTY_RATIO = 8;
const PRETTY_FLOOR = 4 * 1024 * 1024;

const consoleLine = (e: ConsoleLine) =>
  [e.time, e.kind ?? 'http', e.method, e.url, e.status ?? '', e.durationMs !== undefined ? `${e.durationMs} ms` : '', e.error ? `error: ${e.error}` : ''].filter((x) => x !== '').join(' ') +
  e.logs.map((l) => `\n    [${l.phase}] ${l.message}`).join('');

/** Rows of a big grid, page by page through the host (the window shows the same pages). */
async function* gridRows(deps: OutputDeps, src: Extract<OutputSource, { kind: 'grid' }>, signal: AbortSignal): AsyncGenerator<{ columns?: string[]; rows: unknown[][]; total?: number }> {
  if (!(src.grid in GRID_SOURCES)) throw new ApsError('ValidationError', `output.save: unknown grid ${String(src.grid)}`);
  const limit = 500;
  for (let offset = 0; ; offset += limit) {
    if (signal.aborted) return;
    const paged = { ...src.params, offset, limit };
    const page: GridPage = await (src.grid === 'eval-matrix' ? deps.evalMatrix(paged) : deps.scaleRows(paged));
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
async function runCsv(deps: OutputDeps, runId: string): Promise<string> {
  const rows: unknown[][] = [['name', 'status', 'type', 'file', 'durationMs', 'attempts', 'checksPassed', 'checks', 'error', 'startedAt']];
  for await (const r of deps.results(runId))
    rows.push([r.name, r.status, r.type, r.file ?? '', r.durationMs, r.attempts, r.checks.filter((c) => c.passed).length, r.checks.length, r.error?.message ?? '', r.startedAt]);
  return toCsv(rows);
}

function checkRunId(runId: unknown): string {
  if (typeof runId !== 'string' || !/^[\w.-]{1,120}$/.test(runId)) throw new ApsError('ValidationError', 'output.save: unknown run');
  return runId;
}

const asBuffer = (u8: Uint8Array) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);

/** A spooled response body: raw as it is, or re-indented / minified as it streams (no parse, no copy of the whole). */
function responseSource(src: Extract<OutputSource, { kind: 'response' }>, deps: OutputDeps, format: OutputFormatId, signal: AbortSignal): Built {
  // really inside payloads/ and a plain file: a prefix test alone would accept payloads/../../anything, and a link put
  // under payloads/ would have the file it points to read out
  const found = typeof src.payloadPath === 'string' ? plainFileInside(deps.store.path('payloads'), src.payloadPath) : undefined;
  if (found === undefined) throw new ApsError('ValidationError', 'The response body is no longer on disk', { suggestions: ['Send the request again.'] });
  const size = found;
  const path = src.payloadPath;
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
      const most = Math.max(size * PRETTY_RATIO, PRETTY_FLOOR);
      let written = 0;
      for await (const chunk of stream) {
        if (signal.aborted) return stream.destroy();
        const out = p.push(chunk as string);
        written += out.length;
        if (written > most) {
          stream.destroy();
          throw new ApsError('ValidationError', 'The body is nested too deep to lay out as JSON', { suggestions: ['Save it as Raw body instead.'] });
        }
        yield out;
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

/** The rows of a grid as CSV, JSON, HTML or Markdown, written page by page (a 10,000-row data run never is one string). */
function gridSource(deps: OutputDeps, src: Extract<OutputSource, { kind: 'grid' }>, format: OutputFormatId, redact: (t: string) => string, redacted: boolean, signal: AbortSignal): Built {
  const pages = gridRows(deps, src, signal);
  const title = GRID_SOURCES[src.grid]?.title ?? 'Rows';
  async function* csv(): Chunks {
    let columns: string[] | undefined;
    for await (const p of pages) {
      const head = !columns;
      columns ??= p.columns ?? [];
      yield redact(toCsv(head ? [columns, ...p.rows] : p.rows));
    }
    if (!columns) yield '';
  }
  async function* html(): Chunks {
    let columns: string[] | undefined;
    for await (const p of pages) {
      if (!columns) yield htmlDocumentHead(title, { generatedAt: new Date().toISOString() }) + htmlTableHead((columns = p.columns ?? []));
      yield redact(htmlTableRows(columns, p.rows));
    }
    if (!columns) yield htmlDocumentHead(title, { generatedAt: new Date().toISOString() }) + htmlTableHead([]);
    yield HTML_TABLE_TAIL + HTML_DOCUMENT_TAIL;
  }
  async function* md(): Chunks {
    let columns: string[] | undefined;
    for await (const p of pages) {
      if (!columns) yield markdownTableHead((columns = p.columns ?? []));
      yield redact(markdownTableRows(columns, p.rows));
    }
    if (!columns) yield markdownTableHead([]);
  }
  // the same bytes as JSON.stringify(rows, null, 2): one object per row, each laid out and indented under the list
  async function* json(): Chunks {
    let columns: string[] | undefined;
    let first = true;
    yield '[';
    for await (const p of pages) {
      columns ??= p.columns ?? [];
      const cols = columns;
      let out = '';
      for (const r of p.rows) {
        out +=
          (first ? '\n  ' : ',\n  ') +
          redact(JSON.stringify(Object.fromEntries(cols.map((c, i) => [c, r[i]])), null, 2))
            .trimEnd()
            .replace(/\n/g, '\n  ');
        first = false;
      }
      yield out;
    }
    yield first ? ']\n' : '\n]\n';
  }
  const chunks = format === 'csv' ? csv() : format === 'html' ? html() : format === 'md' ? md() : json();
  return { chunks, redacted };
}

/** A run's reports and results: one report, the results as CSV, or everything as a ZIP written entry by entry. */
async function runSource(
  deps: OutputDeps,
  src: Extract<OutputSource, { kind: 'run' }>,
  format: OutputFormatId,
  text: (t: string) => Built,
  redact: (t: string) => string,
  redacted: boolean,
): Promise<Built> {
  const runId = checkRunId(src.runId);
  const dir = deps.store.runDir(runId);
  if (format === 'csv') return text(await runCsv(deps, runId));
  if (format === 'zip') {
    // each entry's header and bytes go out as the entry is read; only the central directory waits for the end
    async function* zip(): Chunks {
      const w = createZipWriter();
      for (const name of Object.values(REPORT_FILES)) {
        const p = join(dir, name);
        if (existsSync(p)) for (const part of w.add(name, redact(readFileSync(p, 'utf8')))) yield asBuffer(part);
      }
      for (const part of w.add('results.csv', redact(await runCsv(deps, runId)))) yield asBuffer(part);
      yield asBuffer(w.end());
    }
    return { chunks: zip(), redacted };
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

/** The console or the log, a page of entries at a time (JSON Lines or text; each chunk is whole lines, so the mask sees every line once). */
function logSource<T>(entries: readonly T[], format: OutputFormatId, line: (e: T) => string, redact: (t: string) => string, redacted: boolean): Built {
  async function* pages(): Chunks {
    for (let i = 0; i < entries.length; i += LOG_PAGE) {
      const page = entries.slice(i, i + LOG_PAGE);
      yield redact(format === 'jsonl' ? jsonLines(page) : page.map(line).join('\n') + '\n');
    }
    if (!entries.length) yield '\n';
  }
  return { chunks: pages(), redacted };
}

const identity = (t: string) => t;

/** What the app holds and a CLI or an MCP server does not: said when a source needs it. */
function needs<T>(have: T | undefined, what: string): T {
  if (have === undefined) throw new ApsError('ConfigurationError', `${what} only exists in the running TestPion app`, { suggestions: ['Save it from the app, or use the command that records it to a file.'] });
  return have;
}

/**
 * Build a format of a source: chunks to write (streamed for the big ones). `redact` masks a text when the surface's
 * policy says so; with `capturedRedacted` the stored outputs (a run's reports, a timeline, a grid's rows, the HAR) were
 * written masked and are not parsed and written a second time. The console and the log are the exception: their
 * entries stream a page of lines at a time, so masking them costs nothing, and an entry that reached the buffer
 * unmasked still never leaves it.
 */
export async function buildSource(
  deps: OutputDeps,
  src: OutputSource,
  format: OutputFormatId,
  redact: (t: string) => string,
  redacted: boolean,
  signal: AbortSignal,
  capturedRedacted = false,
): Promise<Built> {
  const stored = capturedRedacted ? identity : redact;
  const text = (t: string): Built => {
    const out = stored(t);
    return { chunks: one(out), total: Buffer.byteLength(out), sample: () => t.slice(0, SAMPLE_BYTES), redacted: redacted && out !== t };
  };
  switch (src.kind) {
    case 'response':
      return responseSource(src, deps, format, signal);
    case 'run':
      return runSource(deps, src, format, text, stored, redacted);
    case 'flow-timeline': {
      if (format === 'html') return text((await flowRunTimelineHtml(deps.store, src.file, src.runId)).html);
      return text(JSON.stringify(await deps.flowTimeline({ file: src.file, runId: src.runId }), null, 2) + '\n');
    }
    case 'console':
      return logSource(needs(deps.consoleEntries, 'The console')(), format, consoleLine, redact, redacted);
    case 'logs':
      return logSource(needs(deps.logEntries, 'The application log')(), format, (r) => `${r.time} ${r.level.toUpperCase()} [${r.scope}] ${r.message}${r.data === undefined ? '' : ` ${JSON.stringify(r.data)}`}`, redact, redacted);
    case 'debugger': {
      const har = await needs(deps.har, "The Debugger's session")();
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
    case 'grid':
      return gridSource(deps, src, format, stored, redacted, signal);
    case 'history':
    case 'traces':
    case 'monitor-runs':
    case 'runs-overview':
    case 'git-diff':
    case 'workspace-report':
      return text(await dataSource(deps, src, format));
    default:
      throw new ApsError('ValidationError', `output.save: unknown source ${String((src as { kind?: unknown }).kind)}`);
  }
}
