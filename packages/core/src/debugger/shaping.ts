import { readFile, realpath, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { extname, isAbsolute, join, resolve, sep } from 'node:path';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import type { ServerResponse } from 'node:http';
import type { Http2ServerResponse } from 'node:http2';
import { BoundedMap } from '../util/collections.js';
import { compileUserRegex, safeReplace } from '../util/safe-regex.js';
import type { RedirectSpec, ReplySpec, TextReplace } from './rules.js';

/**
 * Traffic shaping for the HTTP Debugger's rules (FG-4, FG-6, FG-7): where a redirected or remapped request goes, the path
 * rewrite, the files that map-local replies read (only inside the workspace), find-and-replace in bodies, and the
 * failures the fault rules inject. Pure helpers: the proxy decides when to call them.
 */

/* ---- redirect, remap and path rewrite */

const MAX_PATH_TESTED = 16_384;
const rewriteRegex = new BoundedMap<string, RegExp>(200); // bounded: 200 distinct rewrite patterns, the oldest goes first

/** A glob over a path, every `*` a group (`/api/*` + `/v2/$1`), or the regular expression the rule gives. */
function rewriteRe(from: string, regex: boolean | undefined): RegExp {
  const key = `${regex ? 'r' : 'g'}${from}`;
  let re = rewriteRegex.get(key);
  if (!re) {
    const source = regex ? from : `^${from.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '(.*?)').replace(/\?/g, '.')}$`;
    re = compileUserRegex(source, 'i', 'The rewrite');
    rewriteRegex.set(key, re);
  }
  return re;
}

/** The path and query after a rewrite rule (the same text when it does not match, or the pattern is refused). */
export function rewritePath(pathAndQuery: string, rewrite: NonNullable<RedirectSpec['rewrite']>): string {
  if (!rewrite.from) return pathAndQuery;
  try {
    const text = pathAndQuery.slice(0, MAX_PATH_TESTED);
    // a plain text `from` replaces the first occurrence as written, the others use the groups
    if (!rewrite.regex && !rewrite.from.includes('*') && !rewrite.from.includes('?')) return text.includes(rewrite.from) ? text.replace(rewrite.from, () => rewrite.to) : pathAndQuery;
    return safeReplace(rewriteRe(rewrite.from, rewrite.regex), text, rewrite.to);
  } catch {
    return pathAndQuery;
  }
}

/**
 * Where a redirected (or remapped) request goes: the host and scheme the rule names, the path as rewritten. A scheme change
 * without a port in the new host uses the new scheme's own port.
 */
export function redirectTarget(from: URL, r: RedirectSpec): URL {
  const to = new URL(from.href);
  if (r.host) {
    to.host = r.host.trim();
    if (r.scheme && `${r.scheme}:` !== from.protocol && !/:\d+$/.test(r.host.trim())) to.port = '';
  }
  if (r.scheme) to.protocol = `${r.scheme}:`;
  if (r.rewrite) {
    const was = to.pathname + to.search;
    const now = rewritePath(was, r.rewrite);
    if (now !== was) {
      try {
        const u = new URL(now.startsWith('/') ? now : `/${now}`, to.origin);
        to.pathname = u.pathname;
        to.search = u.search;
      } catch {
        /* keep the path */
      }
    }
  }
  return to;
}

/** One line of an OS hosts file: an address and the names it answers to (comments and blank lines are none). */
export function parseHostsFile(text: string): Array<{ address: string; host: string }> {
  const out: Array<{ address: string; host: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [address, ...names] = line.split(/\s+/);
    if (!address || !isIP(address)) continue;
    for (const host of names) if (host && !/^(localhost|ip6-.*|broadcasthost)$/i.test(host) && !out.some((o) => o.host === host)) out.push({ address, host });
  }
  return out;
}

/* ---- map local: a reply read from the workspace */

const TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.csv': 'text/csv',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.md': 'text/markdown; charset=utf-8',
};
export const contentTypeOfFile = (name: string): string => TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream';

/** The largest file a map-local reply sends. */
const MAX_LOCAL_BYTES = 32 * 1024 * 1024;

/** Whether a relative path stays inside its folder as written: no `..`, no drive or root, no NUL. */
export function isInsidePath(rel: string): boolean {
  if (!rel || rel.includes('\0') || isAbsolute(rel) || /^[a-z]:/i.test(rel) || rel.startsWith('/') || rel.startsWith('\\')) return false;
  return !rel.split(/[\\/]+/).some((seg) => seg === '..');
}

/** A file of the workspace by its relative path: refused outside the folder (`..`, absolute paths, links that lead out). */
export async function resolveInWorkspace(root: string, rel: string): Promise<string> {
  if (!isInsidePath(rel)) throw new Error(`"${rel}" is outside the workspace: use a path inside it`);
  const base = await realpath(root);
  const full = await realpath(resolve(base, rel));
  if (full !== base && !full.startsWith(base + sep)) throw new Error(`"${rel}" is outside the workspace: use a path inside it`);
  return full;
}

export interface LocalReply {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * The reply of a map-local rule, read when the request comes (so a file edited meanwhile is served as it is now): the `file`,
 * or the `folder`'s file that the request path names (`index.html` for a folder). A missing file answers 404 and says which.
 */
export async function localReply(root: string | undefined, reply: ReplySpec, url: URL): Promise<LocalReply> {
  const say = (status: number, text: string): LocalReply => ({ status, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: Buffer.from(text) });
  if (!root) return say(502, 'TestPion map local: this capture has no workspace folder to read files from');
  let rel = reply.file ?? '';
  if (!rel && reply.folder) {
    let path = decodeURIComponent(url.pathname);
    if (reply.stripPrefix && path.startsWith(reply.stripPrefix)) path = path.slice(reply.stripPrefix.length);
    path = path.replace(/^\/+/, '');
    rel = join(reply.folder, path || 'index.html').replace(/\\/g, '/');
    if (!isInsidePath(path || 'index.html')) return say(403, 'TestPion map local: that path leaves the folder');
  }
  try {
    let full = await resolveInWorkspace(root, rel);
    if ((await stat(full)).isDirectory()) full = await resolveInWorkspace(root, `${rel.replace(/[\\/]+$/, '')}/index.html`);
    const info = await stat(full);
    if (info.size > MAX_LOCAL_BYTES) return say(413, `TestPion map local: ${rel} is larger than ${MAX_LOCAL_BYTES / 1024 / 1024} MB`);
    const headers = { 'content-type': contentTypeOfFile(full), ...Object.fromEntries(Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])) };
    return { status: reply.status || 200, headers, body: await readFile(full) };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return say(code === 'ENOENT' || code === 'ENOTDIR' ? 404 : 403, code === 'ENOENT' || code === 'ENOTDIR' ? `TestPion map local: no file ${rel}` : `TestPion map local: ${(e as Error).message}`);
  }
}

/* ---- find and replace in a body */

const textRegex = new BoundedMap<string, RegExp>(200); // bounded: 200 distinct replace patterns, the oldest goes first
const MAX_DECODED = 64 * 1024 * 1024;

/** A body without its content-encoding (gzip, deflate, br); undefined when it is encoded some other way, or too big. */
export function decodeBody(body: Buffer, encoding: string | undefined): Buffer | undefined {
  const enc = (encoding ?? '').toLowerCase().trim();
  if (!enc || enc === 'identity') return body;
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return gunzipSync(body, { maxOutputLength: MAX_DECODED });
    if (enc === 'deflate') return inflateSync(body, { maxOutputLength: MAX_DECODED });
    if (enc === 'br') return brotliDecompressSync(body, { maxOutputLength: MAX_DECODED });
  } catch {
    /* not what it says */
  }
  return undefined;
}

/** Text with each replacement applied in order; a pattern that is refused or runs too long leaves the text as it was. */
export function replaceText(text: string, list: TextReplace[]): string {
  let out = text;
  for (const r of list) {
    if (!r.find) continue;
    try {
      if (r.regex) {
        const key = `${r.ignoreCase ? 'i' : ''}${r.find}`;
        let re = textRegex.get(key);
        if (!re) textRegex.set(key, (re = compileUserRegex(r.find, r.ignoreCase ? 'gi' : 'g', 'The replacement')));
        out = safeReplace(re, out, r.replace);
      } else out = r.ignoreCase ? out.replace(new RegExp(r.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), () => r.replace) : out.split(r.find).join(r.replace);
    } catch {
      /* keep the text */
    }
  }
  return out;
}

/** Whether a content type is text that a replacement can read. */
const replaceable = (ct: string | undefined) => !ct || /json|text|xml|javascript|html|form|yaml|graphql|csv|urlencoded/i.test(ct);

/**
 * A body with the replacements applied, unencoded (the caller drops the content-encoding header), or undefined when it was not
 * changed: not text, an encoding that cannot be read, or the pattern found nothing.
 */
export function rewriteBody(body: Buffer, contentType: string | undefined, contentEncoding: string | undefined, list: TextReplace[]): Buffer | undefined {
  if (!list.length || !body.length || !replaceable(contentType)) return undefined;
  const plain = decodeBody(body, contentEncoding);
  if (!plain) return undefined;
  const text = plain.toString('utf8');
  const out = replaceText(text, list);
  return out === text ? undefined : Buffer.from(out, 'utf8');
}

/* ---- faults */

type Res = ServerResponse | Http2ServerResponse;
const isH2Res = (res: Res): res is Http2ServerResponse => 'stream' in res && !!(res as Http2ServerResponse).stream;

/** Ends the connection of a response abruptly (the program sees a reset, not an answer). */
export function dropConnection(res: Res): void {
  if (isH2Res(res)) res.stream.close(8); // NGHTTP2_CANCEL
  else res.socket?.destroy();
}

export const DEFAULT_FAULT_TIMEOUT_MS = 30_000;
export const MAX_FAULT_TIMEOUT_MS = 300_000;

/**
 * "Never answer": the request hangs until the program gives up, or `ms` has passed (then the connection is closed).
 * `done` is called once, with what happened.
 */
export function hangRequest(res: Res, ms: number | undefined, done: (why: string) => void): void {
  const wait = Math.min(Math.max(ms ?? DEFAULT_FAULT_TIMEOUT_MS, 1), MAX_FAULT_TIMEOUT_MS);
  let over = false;
  const end = (why: string) => {
    if (over) return;
    over = true;
    clearTimeout(timer);
    done(why);
  };
  const timer = setTimeout(() => {
    dropConnection(res);
    end('No answer, by a rule (the connection was closed after the wait)');
  }, wait);
  res.on('close', () => end('No answer, by a rule (the program gave up)'));
}

/** The head and the first `bytes` of a body, then the connection is cut: the program has an incomplete response. */
export function writeCutResponse(res: ServerResponse, status: number, headers: Record<string, string | string[] | number | undefined>, body: Buffer, bytes: number): void {
  const cut = body.subarray(0, Math.max(0, bytes));
  res.writeHead(status, headers as Record<string, string | string[]>);
  res.write(cut, () => dropConnection(res));
}
