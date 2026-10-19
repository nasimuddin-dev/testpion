/**
 * Saving an output of the app from the command line (`testpion output <surface>`, and `--out` / `--format` on the
 * commands that print results): the same builders and the same secrets policy as the window's down arrow, from core
 * (packages/core/src/output), so a file written here is byte for byte the file the app saves.
 */
import { mkdirSync } from 'node:fs';
import { once } from 'node:events';
import { dirname, extname, resolve } from 'node:path';
import { Command } from 'commander';
import { ApsError, Redactor, WorkspaceManager, one, outputSourceFor, prepareSource, storeOutputDeps, writeChunks, type OutputParams, type WorkspaceStore } from '@testpion/core';
import { OUTPUT_FORMATS, isOutputFormatId, outputSurface, type OutputFormatId } from '@testpion/shared';
import { cliContext, CliError, EXIT } from './shared.js';
import { noteWarning } from './output.js';

export interface SavedOutput {
  surface: string;
  format: OutputFormatId;
  /** The file written (absent when printed). */
  path?: string;
  bytes: number;
  redacted: boolean;
  notice?: string;
}

/** The format a file name asks for among a surface's: `.csv` → csv, `.har` → har, `.md` → md; else the surface's default. */
export function formatForFile(surface: string, file: string | undefined, asked: string | undefined): OutputFormatId {
  const info = outputSurface(surface);
  if (!info) throw new CliError(`Unknown output ${surface}. \`testpion output --list\` shows them.`, EXIT.CONFIG_ERROR);
  if (asked) {
    if (!isOutputFormatId(asked) || !info.formats.includes(asked)) throw new CliError(`${info.label} cannot be saved as ${asked}. Formats: ${info.formats.join(', ')}`, EXIT.CONFIG_ERROR);
    return asked;
  }
  const ext = file ? extname(file).slice(1).toLowerCase() : '';
  return (ext && info.formats.find((f) => OUTPUT_FORMATS[f].ext === ext)) || info.default;
}

/**
 * Build a surface from a workspace and write it to `out` (printed on stdout when there is none). A raw body saves as is;
 * a log-like output is masked unless `includeSecrets`; one masked at capture never offers them.
 */
export async function saveSurface(o: {
  store: WorkspaceStore;
  surface: string;
  format?: string;
  params: OutputParams;
  out?: string;
  includeSecrets?: boolean;
  environment?: string;
}): Promise<SavedOutput> {
  const format = formatForFile(o.surface, o.out, o.format);
  const info = outputSurface(o.surface)!;
  if (o.includeSecrets && info.redaction === 'redacted-default' && info.capturedRedacted) noteWarning(`${info.label} is masked when it is recorded: there are no secrets to include.`);
  const ctx = o.environment ? cliContext(o.store, o.environment) : undefined;
  const redactor = ctx?.redactor ?? new Redactor(new WorkspaceManager().loadSettings().redactFields);
  const ac = new AbortController();
  try {
    const source = outputSourceFor(o.store, o.surface, format, o.params);
    const r = await prepareSource(storeOutputDeps(o.store, redactor), { surface: o.surface, format, source, includeSecrets: o.includeSecrets }, ac.signal, 'output');
    let bytes = 0;
    let path: string | undefined;
    if (o.out) {
      path = resolve(o.out);
      mkdirSync(dirname(path), { recursive: true });
      await writeChunks(r.built.chunks, path, { onBytes: (n) => (bytes += n) });
    } else {
      for await (const c of r.built.chunks) {
        const buf = typeof c === 'string' ? Buffer.from(c, 'utf8') : c;
        bytes += buf.length;
        if (!process.stdout.write(buf)) await once(process.stdout, 'drain');
      }
    }
    return { surface: o.surface, format, path, bytes, redacted: r.built.redacted || (r.redacting && OUTPUT_FORMATS[format].text), notice: r.notice };
  } catch (e) {
    throw e instanceof ApsError && (e.kind === 'ValidationError' || e.kind === 'ConfigurationError') ? new CliError(`${e.message}${e.suggestions.length ? `\n  → ${e.suggestions.join(' ')}` : ''}`, EXIT.CONFIG_ERROR) : e;
  } finally {
    await ctx?.dispose();
  }
}

/** The line that says what was saved (the file, how big, what was masked), for a person. */
export function savedLine(s: SavedOutput): string {
  const size = s.bytes < 1024 ? `${s.bytes} B` : s.bytes < 1024 * 1024 ? `${(s.bytes / 1024).toFixed(1)} KB` : `${(s.bytes / 1024 / 1024).toFixed(1)} MB`;
  return `Wrote ${OUTPUT_FORMATS[s.format].label} to ${s.path} (${size}${s.redacted ? ', secrets masked' : ''})${s.notice ? `\n${s.notice}` : ''}`;
}

/** `--out <file>` and `--format <format>` on a command that prints a result: the surface it writes is named in the help. */
export function addOutputOptions(cmd: Command, surface: string): Command {
  const info = outputSurface(surface)!;
  const has = (flag: string) => cmd.options.some((x) => x.long === flag);
  if (!has('--out')) cmd.option('--out <file>', `write the ${info.label.toLowerCase()} to a file instead (format from the extension, or --format)`);
  if (!has('--format')) cmd.option('--format <format>', `with --out: ${info.formats.join(' | ')} (default ${info.default})`);
  if (!has('--include-secrets') && info.redaction === 'redacted-default' && !info.capturedRedacted) cmd.option('--include-secrets', 'with --out: keep the secrets that are masked by default');
  return cmd;
}

const jsonText = (body: string, pretty: boolean) => (pretty ? JSON.stringify(JSON.parse(body), null, 2) + '\n' : JSON.stringify(JSON.parse(body)));

/**
 * `send --out`: the response body in a file — raw as received (default; `--format raw|text|html|xml`), or laid out as JSON
 * (`json`) or minified (`json-min`). The other formats of the response body (CSV, HAR …) are saved from a History entry:
 * `testpion output response.body --history-id <id>`.
 */
export async function saveResponseBody(body: string, o: { out: string; format?: string }): Promise<SavedOutput> {
  const format = formatForFile('response.body', o.out, o.format);
  let text = body;
  if (format === 'json' || format === 'json-min') {
    try {
      text = jsonText(body, format === 'json');
    } catch {
      throw new CliError(`The response is not JSON, so it cannot be saved as ${format}. Use --format raw.`, EXIT.CONFIG_ERROR);
    }
  } else if (!['raw', 'text', 'html', 'xml'].includes(format))
    throw new CliError(`send saves the body as raw, text, html, xml, json or json-min. For ${format}: testpion output response.body --history-id <id> --format ${format}`, EXIT.CONFIG_ERROR);
  const path = resolve(o.out);
  mkdirSync(dirname(path), { recursive: true });
  await writeChunks(one(text), path);
  return { surface: 'response.body', format, path, bytes: Buffer.byteLength(text), redacted: false };
}
