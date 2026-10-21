import { shortId } from '../util/ids.js';
import { readZip, type ZipEntry } from '../transfer/zip.js';
import type { DebuggerExchange } from './proxy.js';

/**
 * Fiddler's SAZ archives (DBG-4): a zip with `raw/<n>_c.txt` (the request as sent), `raw/<n>_s.txt` (the response)
 * and `raw/<n>_m.xml` (timers, the client port, the process). A SAZ file is untrusted input, so it is opened by the
 * one hardened zip reader (transfer/zip.ts: entry count, inflated size, ratio, names, CRC), never by a reader of its own.
 */

/** Raw HTTP text (a request or a response) split into its line, headers and body. */
export function parseRawHttp(text: string): { line: string; headers: Record<string, string>; body: string } {
  const sep = text.indexOf('\r\n\r\n') >= 0 ? '\r\n\r\n' : '\n\n';
  const at = text.indexOf(sep);
  const head = at >= 0 ? text.slice(0, at) : text;
  const body = at >= 0 ? text.slice(at + sep.length) : '';
  const lines = head.split(/\r?\n/);
  const line = lines.shift() ?? '';
  const headers: Record<string, string> = {};
  for (const l of lines) {
    const i = l.indexOf(':');
    if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }
  return { line, headers, body };
}

/** The exchanges of a SAZ file, in Fiddler's order. */
export function exchangesFromSaz(zip: Buffer): DebuggerExchange[] {
  const entries = readZip(zip, undefined, 'SAZ file');
  const byId = new Map<string, { c?: ZipEntry; s?: ZipEntry; m?: ZipEntry }>();
  for (const e of entries) {
    const m = /^raw\/(\d+)_([csm])\.(txt|xml)$/i.exec(e.name);
    if (!m) continue;
    const slot = byId.get(m[1]!) ?? {};
    slot[m[2]!.toLowerCase() as 'c' | 's' | 'm'] = e;
    byId.set(m[1]!, slot);
  }
  const out: DebuggerExchange[] = [];
  for (const [id, slot] of [...byId.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    if (!slot.c) continue;
    const req = parseRawHttp(slot.c.data.toString('utf8'));
    const [method = 'GET', target = '/'] = req.line.split(' ');
    let url = target;
    let host = req.headers.host ?? '';
    if (method === 'CONNECT') url = `https://${target}`;
    else if (!/^https?:\/\//i.test(target)) url = `http://${host}${target}`;
    try {
      host = new URL(url).host;
    } catch {
      /* keep */
    }
    const meta = slot.m ? slot.m.data.toString('utf8') : '';
    const timer = (name: string) => /ClientBeginRequest|ServerBeginResponse|ClientDoneResponse|ClientConnected/.test(name) && new RegExp(`${name}="([^"]+)"`).exec(meta)?.[1];
    const began = timer('ClientBeginRequest') || timer('ClientConnected');
    const started = began ? Date.parse(began) : NaN;
    const firstByte = timer('ServerBeginResponse') ? Date.parse(timer('ServerBeginResponse') as string) : NaN;
    const done = timer('ClientDoneResponse') ? Date.parse(timer('ClientDoneResponse') as string) : NaN;
    const clientPort = Number(/ClientPort="(\d+)"/.exec(meta)?.[1]) || 0;
    const process = /SessionFlag N="x-ProcessInfo" V="([^":]+)/.exec(meta)?.[1];
    const e: DebuggerExchange = {
      id: shortId('saz-'),
      startedAt: Number.isNaN(started) ? new Date(0).toISOString() : new Date(started).toISOString(),
      kind: method === 'CONNECT' ? 'tunnel' : 'http',
      method,
      url,
      host,
      clientPort,
      application: process,
      requestHeaders: req.headers,
      requestBody: req.body || undefined,
      requestBodyBytes: Buffer.byteLength(req.body),
      responseBodyBytes: 0,
      rules: [`Fiddler session ${id}`],
    };
    if (slot.s) {
      const res = parseRawHttp(slot.s.data.toString('utf8'));
      const m = /^HTTP\/[\d.]+\s+(\d{3})\s*(.*)$/.exec(res.line);
      e.status = m ? Number(m[1]) : undefined;
      e.statusText = m?.[2] ?? '';
      e.responseHeaders = res.headers;
      e.contentType = res.headers['content-type'];
      e.responseBody = res.body || undefined;
      e.responseBodyBytes = Buffer.byteLength(res.body);
    }
    if (!Number.isNaN(started) && !Number.isNaN(firstByte)) e.waitMs = Math.max(0, firstByte - started);
    if (!Number.isNaN(started) && !Number.isNaN(done)) e.durationMs = Math.max(0, done - started);
    out.push(e);
  }
  return out;
}
