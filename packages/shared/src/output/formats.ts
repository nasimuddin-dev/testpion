/**
 * The output formats of "Download" (the down arrow on every output of the app) and their builders. One registry for the
 * window, the backend, the CLI and MCP: the same data gives the same bytes wherever it is saved. Pure and browser-safe.
 */
import { toCsv, rowsFromObjects } from './csv-write.js';

export type OutputFormatId =
  'json' | 'json-min' | 'jsonl' | 'raw' | 'text' | 'csv' | 'csv-excel' | 'tsv' | 'html' | 'md' | 'xml' | 'har' | 'curl' | 'diff' | 'junit' | 'png' | 'svg' | 'zip' | 'cookies-txt';

export interface OutputFormatInfo {
  id: OutputFormatId;
  /** "JSON (pretty)", "CSV" … */
  label: string;
  /** Without the dot. */
  ext: string;
  mime: string;
  /** Text (can be copied) or bytes. */
  text: boolean;
}

export const OUTPUT_FORMATS: Readonly<Record<OutputFormatId, OutputFormatInfo>> = {
  json: { id: 'json', label: 'JSON', ext: 'json', mime: 'application/json', text: true },
  'json-min': { id: 'json-min', label: 'JSON (minified)', ext: 'json', mime: 'application/json', text: true },
  jsonl: { id: 'jsonl', label: 'JSON Lines', ext: 'jsonl', mime: 'application/x-ndjson', text: true },
  raw: { id: 'raw', label: 'Raw bytes', ext: 'bin', mime: 'application/octet-stream', text: false },
  text: { id: 'text', label: 'Text', ext: 'txt', mime: 'text/plain', text: true },
  csv: { id: 'csv', label: 'CSV', ext: 'csv', mime: 'text/csv', text: true },
  'csv-excel': { id: 'csv-excel', label: 'CSV for Excel', ext: 'csv', mime: 'text/csv', text: true },
  tsv: { id: 'tsv', label: 'TSV', ext: 'tsv', mime: 'text/tab-separated-values', text: true },
  html: { id: 'html', label: 'HTML', ext: 'html', mime: 'text/html', text: true },
  md: { id: 'md', label: 'Markdown', ext: 'md', mime: 'text/markdown', text: true },
  xml: { id: 'xml', label: 'XML', ext: 'xml', mime: 'application/xml', text: true },
  har: { id: 'har', label: 'HAR', ext: 'har', mime: 'application/json', text: true },
  curl: { id: 'curl', label: 'cURL', ext: 'sh', mime: 'text/x-shellscript', text: true },
  diff: { id: 'diff', label: 'Patch (unified diff)', ext: 'patch', mime: 'text/x-diff', text: true },
  junit: { id: 'junit', label: 'JUnit XML', ext: 'xml', mime: 'application/xml', text: true },
  png: { id: 'png', label: 'PNG image', ext: 'png', mime: 'image/png', text: false },
  svg: { id: 'svg', label: 'SVG image', ext: 'svg', mime: 'image/svg+xml', text: true },
  zip: { id: 'zip', label: 'ZIP (everything)', ext: 'zip', mime: 'application/zip', text: false },
  'cookies-txt': { id: 'cookies-txt', label: 'cookies.txt (Netscape)', ext: 'txt', mime: 'text/plain', text: true },
};

export const isOutputFormatId = (s: string): s is OutputFormatId => Object.hasOwn(OUTPUT_FORMATS, s);

/** Above this a client-built output must be a backend source (it is streamed to the file, never a string in the window). */
export const CLIENT_OUTPUT_LIMIT = 1024 * 1024;
/** Copy is offered up to this size. */
export const COPY_LIMIT = 5 * 1024 * 1024;
/** Saves over this show progress and Cancel. */
export const PROGRESS_THRESHOLD = 5 * 1024 * 1024;

/* ------------------------------------------------------------------ builders */

export const jsonPretty = (v: unknown): string => (JSON.stringify(v, null, 2) ?? 'null') + '\n';
export const jsonMin = (v: unknown): string => JSON.stringify(v) ?? 'null';
/** One JSON value per line (a list's items; anything else is one line). */
export const jsonLines = (items: unknown): string => (Array.isArray(items) ? items : [items]).map((i) => JSON.stringify(i) ?? 'null').join('\n') + '\n';

/** A table as GitHub-flavoured Markdown (pipes and line breaks in cells escaped). */
export function markdownTable(columns: string[], rows: ReadonlyArray<ReadonlyArray<unknown>>): string {
  const cell = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v)).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  return [`| ${columns.map(cell).join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${columns.map((_, i) => cell(r[i])).join(' | ')} |`)].join('\n') + '\n';
}

/** Objects as a Markdown table. */
export const objectsToMarkdown = (objects: ReadonlyArray<unknown>, columns?: string[]): string => {
  const t = rowsFromObjects(objects, columns);
  return markdownTable(t.columns, t.rows);
};

/** Objects as TSV. */
export const objectsToTsv = (objects: ReadonlyArray<unknown>, columns?: string[]): string => {
  const t = rowsFromObjects(objects, columns);
  return toCsv([t.columns, ...t.rows], { delimiter: '\t' });
};

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Light and dark colours of the exported pages (the same palette as the timeline report). */
const PAGE_CSS = `:root{--bg:#fff;--fg:#1f2230;--muted:#6b6f80;--line:#e2e4ec;--stripe:rgba(120,130,160,.06);--ok:#2e9e5b;--bad:#d9483b}
@media (prefers-color-scheme: dark){:root{--bg:#171a26;--fg:#eceef6;--muted:#a2a7bb;--line:#2c3040;--stripe:rgba(255,255,255,.03);--ok:#3fbf73;--bad:#f0645a}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif}
main{max-width:1200px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:20px 0 8px}.sub{color:var(--muted);margin:0 0 16px;font-size:12px}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:4px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500;font-size:12px}tr:nth-child(even) td{background:var(--stripe)}
pre{background:var(--stripe);border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto;font:12px/1.45 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-word}
.ok{color:var(--ok)}.bad{color:var(--bad)}`;

export type HtmlSection = { title?: string } & ({ table: { columns: string[]; rows: ReadonlyArray<ReadonlyArray<unknown>> } } | { pre: string } | { html: string });

/**
 * A self-contained HTML page (inline CSS, no scripts, no network), themed light / dark like the timeline report: what
 * "Download ▸ HTML" writes. Every value is escaped; `html` sections must already be safe (built from escaped parts).
 */
export function htmlDocument(title: string, sections: HtmlSection[], opts: { subtitle?: string; generatedAt?: string } = {}): string {
  const cell = (v: unknown) => escHtml(v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));
  const body = sections
    .map((s) => {
      const h = s.title ? `<h2>${escHtml(s.title)}</h2>\n` : '';
      if ('table' in s)
        return `${h}<table><thead><tr>${s.table.columns.map((c) => `<th>${cell(c)}</th>`).join('')}</tr></thead><tbody>\n${s.table.rows
          .map((r) => `<tr>${s.table.columns.map((_, i) => `<td>${cell(r[i])}</td>`).join('')}</tr>`)
          .join('\n')}\n</tbody></table>`;
      if ('pre' in s) return `${h}<pre>${escHtml(s.pre)}</pre>`;
      return h + s.html;
    })
    .join('\n');
  const sub = [opts.subtitle, opts.generatedAt ? `generated ${opts.generatedAt}` : ''].filter(Boolean).join(' · ');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>${escHtml(title)}</title>
<style>${PAGE_CSS}</style></head><body><main>
<h1>${escHtml(title)}</h1>
${sub ? `<p class="sub">${escHtml(sub)}</p>\n` : ''}${body}
</main></body></html>
`;
}

/** Objects as a one-table HTML page. */
export const objectsToHtml = (title: string, objects: ReadonlyArray<unknown>, columns?: string[]): string => {
  const t = rowsFromObjects(objects, columns);
  return htmlDocument(title, [{ table: { columns: t.columns, rows: t.rows } }], { generatedAt: new Date().toISOString() });
};

const escXml = (s: string) => escHtml(s).replace(/'/g, '&apos;');

/** Checks as a JUnit XML report (one suite, one test case per check). */
export function junitXml(suite: string, cases: ReadonlyArray<{ name: string; passed: boolean; message?: string; durationMs?: number; skipped?: boolean }>): string {
  const failures = cases.filter((c) => !c.passed && !c.skipped).length;
  const skipped = cases.filter((c) => c.skipped).length;
  const time = (ms?: number) => ((ms ?? 0) / 1000).toFixed(3);
  const total = cases.reduce((n, c) => n + (c.durationMs ?? 0), 0);
  const lines = cases.map((c) => {
    const inner = c.skipped ? '<skipped/>' : c.passed ? '' : `<failure message="${escXml(c.message ?? 'failed')}">${escXml(c.message ?? '')}</failure>`;
    return `    <testcase name="${escXml(c.name)}" classname="${escXml(suite)}" time="${time(c.durationMs)}">${inner}</testcase>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites tests="${cases.length}" failures="${failures}" skipped="${skipped}" time="${time(total)}">
  <testsuite name="${escXml(suite)}" tests="${cases.length}" failures="${failures}" skipped="${skipped}" time="${time(total)}">
${lines.join('\n')}
  </testsuite>
</testsuites>
`;
}

/** A response (and what is known of its request) as a HAR 1.2 log with one entry. */
export function harFromExchange(x: {
  method?: string;
  url: string;
  requestHeaders?: Array<[string, string]>;
  requestBody?: { text: string; mimeType?: string };
  status: number;
  statusText?: string;
  httpVersion?: string;
  headers: Array<[string, string]>;
  cookies?: Array<{ name: string; value: string }>;
  contentType?: string;
  body?: string;
  size?: number;
  startedAt?: string;
  durationMs?: number;
  timeline?: Array<{ name: string; durationMs: number }>;
  creator?: string;
}): Record<string, unknown> {
  const hv = x.httpVersion === '2' ? 'HTTP/2' : 'HTTP/1.1';
  const phase = (n: string) => x.timeline?.find((p) => p.name === n)?.durationMs ?? -1;
  const query = (() => {
    const q = /\?([^#]*)/.exec(x.url)?.[1];
    if (!q) return [];
    const dec = (s: string) => {
      try {
        return decodeURIComponent(s.replace(/\+/g, ' '));
      } catch {
        return s;
      }
    };
    return q
      .split('&')
      .filter(Boolean)
      .map((p) => {
        const i = p.indexOf('=');
        return { name: dec(i < 0 ? p : p.slice(0, i)), value: i < 0 ? '' : dec(p.slice(i + 1)) };
      });
  })();
  return {
    log: {
      version: '1.2',
      creator: { name: x.creator ?? 'TestPion', version: '1' },
      entries: [
        {
          startedDateTime: x.startedAt ?? new Date().toISOString(),
          time: x.durationMs ?? 0,
          request: {
            method: (x.method ?? 'GET').toUpperCase(),
            url: x.url,
            httpVersion: hv,
            cookies: [],
            headers: (x.requestHeaders ?? []).map(([name, value]) => ({ name, value })),
            queryString: query,
            ...(x.requestBody ? { postData: { mimeType: x.requestBody.mimeType ?? '', text: x.requestBody.text } } : {}),
            headersSize: -1,
            bodySize: x.requestBody ? x.requestBody.text.length : 0,
          },
          response: {
            status: x.status,
            statusText: x.statusText ?? '',
            httpVersion: hv,
            cookies: (x.cookies ?? []).map((c) => ({ name: c.name, value: c.value })),
            headers: x.headers.map(([name, value]) => ({ name, value })),
            content: { size: x.size ?? x.body?.length ?? 0, mimeType: x.contentType ?? '', ...(x.body !== undefined ? { text: x.body } : {}) },
            redirectURL: x.headers.find(([k]) => k.toLowerCase() === 'location')?.[1] ?? '',
            headersSize: -1,
            bodySize: x.size ?? -1,
          },
          cache: {},
          timings: {
            blocked: -1,
            dns: phase('DNS lookup'),
            connect: phase('TCP connect'),
            ssl: phase('TLS handshake'),
            send: 0,
            wait: Math.max(0, phase('Waiting (TTFB)')),
            receive: Math.max(0, phase('Content download')),
          },
        },
      ],
    },
  };
}

/** Cookies in the Netscape cookies.txt format (curl -b, wget --load-cookies). */
export function netscapeCookies(
  cookies: ReadonlyArray<{ name: string; value: string; domain?: string; path?: string; expires?: string | number; secure?: boolean; attributes?: Record<string, string> }>,
  host = '',
): string {
  const lines = cookies.map((c) => {
    const a = c.attributes ?? {};
    const domain = c.domain ?? a.domain ?? a.Domain ?? host;
    const path = c.path ?? a.path ?? a.Path ?? '/';
    const secure = c.secure ?? Object.keys(a).some((k) => k.toLowerCase() === 'secure');
    const exp = c.expires ?? a.expires ?? a.Expires;
    const expires = exp === undefined ? 0 : typeof exp === 'number' ? Math.floor(exp) : Math.floor(Date.parse(exp) / 1000) || 0;
    return [domain, domain.startsWith('.') ? 'TRUE' : 'FALSE', path, secure ? 'TRUE' : 'FALSE', expires, c.name, c.value].join('\t');
  });
  return `# Netscape HTTP Cookie File\n${lines.join('\n')}\n`;
}

/* ------------------------------------------------------------------ streaming pretty JSON */

/**
 * Re-indents JSON text as it streams in (no parse, no copy of the whole value): the backend pretty-prints a 50 MB body
 * chunk by chunk. For valid JSON the output equals `JSON.stringify(JSON.parse(text), null, 2)` (numbers are kept as
 * written). Invalid input comes out re-indented as far as it goes.
 */
export function createJsonPrettyPrinter(indent = '  '): { push(chunk: string): string; end(): string } {
  let depth = 0;
  let inString = false;
  let escape = false;
  // an opened { or [ waits for its next character: closed at once it prints {} / []
  let pendingOpen = '';
  const nl = () => '\n' + indent.repeat(depth);
  return {
    push(chunk: string): string {
      let out = '';
      for (let i = 0; i < chunk.length; i++) {
        const c = chunk[i]!;
        if (inString) {
          out += c;
          if (escape) escape = false;
          else if (c === '\\') escape = true;
          else if (c === '"') inString = false;
          continue;
        }
        if (c === ' ' || c === '\n' || c === '\r' || c === '\t') continue;
        if (pendingOpen) {
          if ((pendingOpen === '{' && c === '}') || (pendingOpen === '[' && c === ']')) {
            out += pendingOpen + c;
            pendingOpen = '';
            continue;
          }
          out += pendingOpen;
          pendingOpen = '';
          depth++;
          out += nl();
        }
        if (c === '{' || c === '[') pendingOpen = c;
        else if (c === '}' || c === ']') {
          depth = Math.max(0, depth - 1);
          out += nl() + c;
        } else if (c === ',') out += ',' + nl();
        else if (c === ':') out += ': ';
        else {
          if (c === '"') inString = true;
          out += c;
        }
      }
      return out;
    },
    end(): string {
      const rest = pendingOpen;
      pendingOpen = '';
      return rest + '\n';
    },
  };
}

/** Drops the whitespace outside strings as JSON streams in: `JSON.stringify(JSON.parse(text))` for valid JSON. */
export function createJsonMinifier(): { push(chunk: string): string } {
  let inString = false;
  let escape = false;
  return {
    push(chunk: string): string {
      let out = '';
      for (let i = 0; i < chunk.length; i++) {
        const c = chunk[i]!;
        if (inString) {
          out += c;
          if (escape) escape = false;
          else if (c === '\\') escape = true;
          else if (c === '"') inString = false;
        } else if (c !== ' ' && c !== '\n' && c !== '\r' && c !== '\t') {
          if (c === '"') inString = true;
          out += c;
        }
      }
      return out;
    },
  };
}

/* ------------------------------------------------------------------ ZIP */

let CRC_TABLE: Uint32Array | undefined;
/** CRC-32 (the ZIP / PNG one). */
export function crc32(data: Uint8Array, crc = 0): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

/**
 * Files as a ZIP archive (stored, no compression: reports are small and this stays a few lines with no dependency).
 * Names are UTF-8 (flag bit 11); a name is a relative path with forward slashes.
 */
export function zipFiles(files: ReadonlyArray<{ name: string; data: Uint8Array | string; date?: Date }>): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name.replace(/\\/g, '/').replace(/^\/+/, ''));
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    const d = f.date ?? new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    const dosDate = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let p = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

/** Bytes as base64 (to send a binary output over RPC). */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** How many bytes a text takes in UTF-8. */
export const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;
