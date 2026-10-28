import { writeZipAsync, type ZipEntry } from '../transfer/zip.js';
import type { DebuggerExchange } from './proxy.js';
import type { HarRedactor } from './har.js';

/**
 * Export as Fiddler's SAZ (FG-22): the reverse of saz.ts. A zip with `raw/<n>_c.txt` (the request as sent), `raw/<n>_s.txt`
 * (the response), `raw/<n>_m.xml` (timers, client port, program), the content-types part and an index page. Text goes through
 * the redactor like every export (a SAZ is a file that travels); a binary body is not written, as a redactor reads text only.
 */
const CRLF = '\r\n';

const xmlAttr = (v: string): string => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const headerLines = (h: Record<string, string> | undefined): string => Object.entries(h ?? {}).map(([k, v]) => `${k}: ${String(v).replace(/[\r\n]+/g, ' ')}`).join(CRLF);
const iso = (ms: number): string => new Date(ms).toISOString();

/** The three parts of one exchange. */
function sessionFiles(n: number, e: DebuggerExchange, red: HarRedactor): ZipEntry[] {
  const url = red.redactUrl(e.url);
  const tunnel = e.kind === 'tunnel';
  const reqLine = tunnel ? `CONNECT ${e.host} HTTP/1.1` : `${e.method} ${url} ${e.httpVersion === '2' ? 'HTTP/2' : 'HTTP/1.1'}`;
  const reqHeaders = red.redactHeaders(e.requestHeaders ?? {});
  const reqBody = e.requestBody ? red.redactString(e.requestBody) : '';
  const files: ZipEntry[] = [{ name: `raw/${n}_c.txt`, data: Buffer.from(`${reqLine}${CRLF}${headerLines(reqHeaders)}${CRLF}${CRLF}${reqBody}`, 'utf8') }];
  if (e.status !== undefined || tunnel) {
    const status = e.status ?? 200;
    const text = tunnel ? 'Connection Established' : (e.statusText ?? '');
    const resBody = e.responseBody ? red.redactString(e.responseBody) : '';
    files.push({ name: `raw/${n}_s.txt`, data: Buffer.from(`HTTP/1.1 ${status} ${text}${CRLF}${headerLines(red.redactHeaders(e.responseHeaders ?? {}))}${CRLF}${CRLF}${resBody}`, 'utf8') });
  }
  const t0 = Date.parse(e.startedAt);
  const ok = Number.isFinite(t0);
  const timers = ok
    ? ` ClientConnected="${iso(t0)}" ClientBeginRequest="${iso(t0)}"${e.waitMs !== undefined ? ` ServerBeginResponse="${iso(t0 + e.waitMs)}"` : ''}${e.durationMs !== undefined ? ` ClientDoneResponse="${iso(t0 + e.durationMs)}"` : ''}`
    : '';
  const flags = [e.application ? `<SessionFlag N="x-ProcessInfo" V="${xmlAttr(`${e.application}${e.pid ? `:${e.pid}` : ''}`)}" />` : '', e.note ? `<SessionFlag N="ui-comments" V="${xmlAttr(red.redactString(e.note))}" />` : '', e.mark ? `<SessionFlag N="ui-backcolor" V="${xmlAttr(e.mark)}" />` : '']
    .filter(Boolean)
    .join('');
  files.push({
    name: `raw/${n}_m.xml`,
    data: Buffer.from(`<?xml version="1.0" encoding="utf-8"?>${CRLF}<Session SID="${n}" BitFlags="${tunnel ? 0 : 1}">${CRLF}<SessionTimers${timers} />${CRLF}<PipeInfo ClientPort="${e.clientPort || 0}" />${CRLF}<SessionFlags>${flags}</SessionFlags>${CRLF}</Session>`, 'utf8'),
  });
  return files;
}

/** The SAZ file of these exchanges (deflated on the thread pool, a few entries at a time). */
export async function exchangesToSaz(exchanges: DebuggerExchange[], redactor: HarRedactor): Promise<Buffer> {
  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml" /><Default Extension="htm" ContentType="text/html" /><Default Extension="txt" ContentType="text/plain" /></Types>') },
  ];
  const rows: string[] = [];
  exchanges.forEach((e, i) => {
    const n = i + 1;
    entries.push(...sessionFiles(n, e, redactor));
    rows.push(`<tr><td><a href="raw/${n}_c.txt">C</a> <a href="raw/${n}_s.txt">S</a></td><td>${n}</td><td>${e.status ?? ''}</td><td>${xmlAttr(e.method)}</td><td>${xmlAttr(redactor.redactUrl(e.url))}</td></tr>`);
  });
  entries.push({ name: '_index.htm', data: Buffer.from(`<html><head><title>TestPion session</title></head><body><table border="1"><tr><th></th><th>#</th><th>Result</th><th>Method</th><th>URL</th></tr>${rows.join('')}</table></body></html>`) });
  return writeZipAsync(entries);
}
