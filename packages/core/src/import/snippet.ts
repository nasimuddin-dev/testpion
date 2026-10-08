import type { HttpRequestSpec } from '../model/types.js';
import { ApsError } from '../errors.js';
import { isCurlCommand, parseCurl, parseCurlArgs, shellSplit } from './curl.js';

/**
 * Paste-to-request: turn what browser devtools "Copy as …" puts on the clipboard into a request.
 * Supported: cURL (bash and cmd), fetch, fetch (Node.js) and PowerShell (Invoke-WebRequest /
 * Invoke-RestMethod). fetch and PowerShell snippets are converted to curl arguments so they share
 * the cURL importer's URL, body, cookie and auth handling.
 */
export type RequestSnippetFormat = 'curl' | 'fetch' | 'powershell' | 'httpie';

const FETCH_RE = /(?:^|[\s;=(])(?:await\s+)?fetch\s*\(/;
const PWSH_RE = /\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i;

/** Detect which "Copy as …" format a pasted text is, or undefined if it isn't one. */
export function detectRequestSnippet(text: string): RequestSnippetFormat | undefined {
  const t = text.trim();
  if (isCurlCommand(t)) return 'curl';
  if (/^(?:(?:const|let|var)\s+\w+\s*=\s*)?(?:await\s+)?fetch\s*\(/.test(t)) return 'fetch';
  if (/^(\$\w+\s*=|Invoke-WebRequest|Invoke-RestMethod|iwr\s|irm\s)/i.test(t) && PWSH_RE.test(t) && /-Uri\b|https?:\/\//i.test(t)) return 'powershell';
  // HTTPie (and xh): http [flags] [METHOD] URL [items]
  if (isHttpieCommand(t)) return 'httpie';
  return undefined;
}

export function isRequestSnippet(text: string): boolean {
  return detectRequestSnippet(text) !== undefined;
}

/** Parse a cURL, fetch or PowerShell snippet into a request. */
export function parseRequestSnippet(text: string): HttpRequestSpec {
  const format = detectRequestSnippet(text);
  if (format === 'curl') return parseCurl(text);
  if (format === 'fetch') return parseFetch(text);
  if (format === 'powershell') return parsePowerShell(text);
  if (format === 'httpie') return parseHttpie(text);
  throw new ApsError('ValidationError', 'Not a cURL, fetch, PowerShell or HTTPie request');
}

// ---------------------------------------------------------------------------------------------
// HTTPie

/** HTTPie (and xh): http [flags] [METHOD] URL [items], with a URL-like first argument. */
function isHttpieCommand(t: string): boolean {
  if (!/^(https?|xhs?)\s/i.test(t)) return false;
  let args: string[];
  try {
    args = shellSplit(t).slice(1);
  } catch {
    return false;
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('-')) {
      if (HTTPIE_VALUE_FLAGS.has(a)) i++;
      continue;
    }
    const url = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(a) ? args[i + 1] ?? '' : a;
    return /^(https?:\/\/|:\d|localhost([:/]|$)|[\w.-]+\.[a-z]{2,}([:/]|$)|[\w.-]+:\d+)/i.test(url);
  }
  return false;
}

const HTTPIE_VALUE_FLAGS = new Set(['-a', '--auth', '-A', '--auth-type', '--timeout', '--session', '--session-read-only', '-o', '--output', '--pretty', '-s', '--style', '-p', '--print', '--cert', '--cert-key', '--verify', '--proxy', '--max-redirects', '--format-options', '--boundary', '--raw', '--path-as-is']);

/**
 * `http POST api.test/pets name=Rex age:=3 Authorization:'Bearer x' q==search` (HTTPie or xh):
 * name=value is a JSON string field (a form field with --form), name:=json raw JSON, name==value a
 * query parameter, Name:value a header, field@file a file (multipart).
 */
function parseHttpie(text: string): HttpRequestSpec {
  const args = shellSplit(text.trim());
  const prog = (args.shift() ?? '').toLowerCase();
  let form = false;
  let multipart = false;
  let auth: string | undefined;
  let authType = 'basic';
  let insecure = false;
  let timeoutMs: number | undefined;
  let rawBody: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('-') || a === '-') {
      rest.push(a);
      continue;
    }
    const [flag, inline] = a.includes('=') && a.startsWith('--') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    const value = () => inline ?? args[++i] ?? '';
    if (flag === '-f' || flag === '--form') form = true;
    else if (flag === '--multipart') multipart = form = true;
    else if (flag === '-j' || flag === '--json') form = false;
    else if (flag === '-a' || flag === '--auth') auth = value();
    else if (flag === '-A' || flag === '--auth-type') authType = value().toLowerCase();
    else if (flag === '--verify') insecure = /^(no|false)$/i.test(value());
    else if (flag === '--timeout') timeoutMs = Number(value()) * 1000 || undefined;
    else if (flag === '--raw') rawBody = value();
    else if (HTTPIE_VALUE_FLAGS.has(flag)) value();
  }
  let method: string | undefined;
  if (rest[0] && /^[A-Z]+$/.test(rest[0]) && rest.length > 1) method = rest.shift();
  let url = rest.shift() ?? '';
  if (!url) throw new ApsError('ValidationError', 'The HTTPie command has no URL');
  // :3000/path is localhost; no scheme means http (https for https / xhs)
  if (url.startsWith(':')) url = `localhost${url}`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `${prog === 'https' || prog === 'xhs' ? 'https' : 'http'}://${url}`;
  const headers: Array<{ key: string; value: string }> = [];
  const params: Array<{ key: string; value: string }> = [];
  const data: Record<string, unknown> = {};
  const fields: Array<{ key: string; value: string; kind?: 'text' | 'file' }> = [];
  for (const item of rest) {
    // the earliest separator wins; at the same place the longer one (== before =, := before :)
    const m = /^((?:\\.|[^:=@\\])+?)(==|:=@|:=|=@|@|=|:)(.*)$/s.exec(item);
    if (!m) continue;
    const key = m[1]!.replace(/\\(.)/g, '$1');
    const sep = m[2]!;
    const val = m[3]!;
    if (sep === '==') params.push({ key, value: val });
    else if (sep === ':') {
      if (!isPseudoHeader(key)) headers.push({ key, value: val.trim() });
    } else if (sep === ':=') {
      try {
        data[key] = JSON.parse(val);
      } catch {
        data[key] = val;
      }
    } else if (sep === '@' || sep === '=@') {
      fields.push({ key, value: val, kind: 'file' });
      multipart = form = true;
    } else {
      data[key] = val;
      fields.push({ key, value: val, kind: 'text' });
    }
  }
  const hasData = Object.keys(data).length > 0 || fields.length > 0 || rawBody !== undefined;
  const req: HttpRequestSpec = { method: (method ?? (hasData ? 'POST' : 'GET')).toUpperCase(), url, headers };
  if (params.length) req.params = params;
  if (rawBody !== undefined) req.body = { type: /^\s*[[{]/.test(rawBody) ? 'json' : 'text', content: rawBody };
  else if (multipart) req.body = { type: 'multipart', fields: fields.map((f) => ({ key: f.key, value: f.value, kind: f.kind ?? 'text' })) };
  else if (form && fields.length) req.body = { type: 'form-urlencoded', fields: fields.filter((f) => f.kind !== 'file').map((f) => ({ key: f.key, value: f.value })) };
  else if (Object.keys(data).length) req.body = { type: 'json', content: JSON.stringify(data, null, 2) };
  if (auth !== undefined) {
    const i = auth.indexOf(':');
    req.auth = authType === 'bearer' ? { type: 'bearer', token: auth } : authType === 'digest' ? { type: 'digest', username: i >= 0 ? auth.slice(0, i) : auth, password: i >= 0 ? auth.slice(i + 1) : '' } : { type: 'basic', username: i >= 0 ? auth.slice(0, i) : auth, password: i >= 0 ? auth.slice(i + 1) : '' };
  }
  if (insecure || timeoutMs) req.settings = { ...(insecure ? { insecure: true } : {}), ...(timeoutMs ? { timeoutMs } : {}) };
  return req;
}

/** HTTP/2 pseudo headers that devtools sometimes include; they are not real request headers. */
const isPseudoHeader = (k: string) => k.startsWith(':') || /^(authority|method|path|scheme)$/i.test(k);

// ---------------------------------------------------------------------------------------------
// fetch

/** Parse `fetch("url", { method, headers, body, … })` as copied from devtools (browser or Node.js). */
export function parseFetch(text: string): HttpRequestSpec {
  const m = FETCH_RE.exec(text);
  if (!m) throw new ApsError('ValidationError', 'Not a fetch call');
  let i = m.index + m[0].length;
  const skipWs = () => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };
  skipWs();
  const q = text[i];
  if (q !== '"' && q !== "'" && q !== '`') throw new ApsError('ValidationError', 'The fetch URL must be a string literal');
  const urlEnd = scanString(text, i);
  const url = jsString(text.slice(i, urlEnd));
  i = urlEnd;
  skipWs();
  let init: Record<string, unknown> = {};
  if (text[i] === ',') {
    i++;
    skipWs();
    if (text[i] === '{') {
      const end = scanBalanced(text, i, '{', '}');
      init = parseLooseJson(text.slice(i, end)) as Record<string, unknown>;
    }
  }
  const args = ['curl', url];
  if (typeof init.method === 'string') args.push('-X', init.method.toUpperCase());
  const headers = init.headers;
  if (headers && typeof headers === 'object') {
    const entries = Array.isArray(headers) ? (headers as Array<[string, unknown]>) : Object.entries(headers as Record<string, unknown>);
    for (const [k, v] of entries) if (!isPseudoHeader(k) && v != null) args.push('-H', `${k}: ${String(v)}`);
  }
  if (typeof init.referrer === 'string' && init.referrer && !args.some((a) => /^referer:/i.test(a))) args.push('-H', `Referer: ${init.referrer}`);
  if (typeof init.body === 'string') args.push('--data-raw', init.body);
  else if (init.body != null) args.push('--data-raw', JSON.stringify(init.body));
  const req = parseCurlArgs(args);
  if (!init.method) req.method = init.body != null ? 'POST' : 'GET';
  return req;
}

/** Index just past the string literal starting at `start` (quote char at `start`). */
function scanString(s: string, start: number): number {
  const q = s[start]!;
  let i = start + 1;
  while (i < s.length && s[i] !== q) i += s[i] === '\\' ? 2 : 1;
  return i + 1;
}

/** Index just past the bracket that closes the one at `start`, skipping string literals. */
function scanBalanced(s: string, start: number, open: string, close: string): number {
  let depth = 0;
  let i = start;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '"' || c === "'" || c === '`') {
      i = scanString(s, i);
      continue;
    }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return i + 1;
    i++;
  }
  throw new ApsError('ValidationError', `Unbalanced ${open}${close} in the pasted snippet`);
}

/** Decode a JS string literal ("…", '…' or `…` without interpolation). */
function jsString(lit: string): string {
  if (lit.startsWith('"')) {
    try {
      return JSON.parse(lit) as string;
    } catch {
      /* fall through */
    }
  }
  return lit.slice(1, -1).replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/gs, (_, e: string) => {
    if (e[0] === 'u') return String.fromCodePoint(parseInt(e.replace(/[u{}]/g, ''), 16));
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    return ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' } as Record<string, string>)[e] ?? e;
  });
}

/**
 * Parse a JS object literal that is JSON-like: devtools output is JSON, hand-written code may use
 * unquoted keys, single quotes and trailing commas. Values that are not literals (variables,
 * `JSON.stringify(…)` calls) become their source text.
 */
function parseLooseJson(src: string): unknown {
  try {
    return JSON.parse(src);
  } catch {
    /* loose parse below */
  }
  let i = 0;
  const ws = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i]!)) i++;
      if (src.startsWith('//', i)) while (i < src.length && src[i] !== '\n') i++;
      else if (src.startsWith('/*', i)) i = src.indexOf('*/', i) < 0 ? src.length : src.indexOf('*/', i) + 2;
      else return;
    }
  };
  const value = (): unknown => {
    ws();
    const c = src[i];
    if (c === '{') {
      i++;
      const o: Record<string, unknown> = {};
      for (;;) {
        ws();
        if (src[i] === '}') return i++, o;
        let key: string;
        if (src[i] === '"' || src[i] === "'" || src[i] === '`') {
          const e = scanString(src, i);
          key = jsString(src.slice(i, e));
          i = e;
        } else {
          const k = /^[\w$]+/.exec(src.slice(i));
          if (!k) throw new ApsError('ValidationError', 'Could not read the fetch options');
          key = k[0];
          i += key.length;
        }
        ws();
        if (src[i] === ':') {
          i++;
          o[key] = value();
        } else o[key] = key; // shorthand property
        ws();
        if (src[i] === ',') i++;
      }
    }
    if (c === '[') {
      i++;
      const a: unknown[] = [];
      for (;;) {
        ws();
        if (src[i] === ']') return i++, a;
        a.push(value());
        ws();
        if (src[i] === ',') i++;
      }
    }
    if (c === '"' || c === "'" || c === '`') {
      const e = scanString(src, i);
      const s = jsString(src.slice(i, e));
      i = e;
      return s;
    }
    // number / literal / arbitrary expression up to the next top-level , } ]
    const start = i;
    while (i < src.length && !/[,}\]]/.test(src[i]!)) {
      if (src[i] === '(' || src[i] === '{' || src[i] === '[') i = scanBalanced(src, i, src[i]!, src[i] === '(' ? ')' : src[i] === '{' ? '}' : ']');
      else if (src[i] === '"' || src[i] === "'" || src[i] === '`') i = scanString(src, i);
      else i++;
    }
    const raw = src.slice(start, i).trim();
    if (raw === 'null' || raw === 'undefined') return null;
    if (raw === 'true' || raw === 'false') return raw === 'true';
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
    const stringify = /^JSON\.stringify\(([\s\S]*)\)$/.exec(raw);
    if (stringify) {
      try {
        return JSON.stringify(parseLooseJson(stringify[1]!));
      } catch {
        /* keep source */
      }
    }
    return raw;
  };
  return value();
}

// ---------------------------------------------------------------------------------------------
// PowerShell

type PsToken = { kind: 'str' | 'word'; value: string } | { kind: 'hash'; value: Array<[string, string]> };

/** Decode a PowerShell string literal ("…" with backtick escapes, or '…'). */
function psString(lit: string): string {
  if (lit.startsWith("'")) return lit.slice(1, -1).replace(/''/g, "'");
  return lit
    .slice(1, -1)
    .replace(/""/g, '"')
    .replace(/`(.)/gs, (_, c: string) => ({ n: '\n', t: '\t', r: '\r', '0': '\0' } as Record<string, string>)[c] ?? c);
}

/** Index just past the PowerShell string literal starting at `start`. */
function scanPsString(s: string, start: number): number {
  const q = s[start]!;
  let i = start + 1;
  while (i < s.length) {
    if (q === '"' && s[i] === '`') i += 2;
    else if (s[i] === q && s[i + 1] === q) i += 2;
    else if (s[i] === q) return i + 1;
    else i++;
  }
  return i;
}

function psTokens(s: string): PsToken[] {
  const out: PsToken[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) i++;
    else if (c === '"' || c === "'") {
      const e = scanPsString(s, i);
      out.push({ kind: 'str', value: psString(s.slice(i, e)) });
      i = e;
    } else if (c === '@' && s[i + 1] === '{') {
      let j = i + 2;
      const entries: Array<[string, string]> = [];
      let depth = 1;
      const start = j;
      while (j < s.length && depth > 0) {
        if (s[j] === '"' || s[j] === "'") j = scanPsString(s, j);
        else {
          if (s[j] === '{') depth++;
          else if (s[j] === '}') depth--;
          j++;
        }
      }
      const body = s.slice(start, j - 1);
      // entries: key = value, separated by newlines or ';'
      let k = 0;
      let key: string | undefined;
      while (k < body.length) {
        const ch = body[k]!;
        if (/[\s;]/.test(ch)) k++;
        else if (ch === '=') k++;
        else {
          let v: string;
          if (ch === '"' || ch === "'") {
            const e = scanPsString(body, k);
            v = psString(body.slice(k, e));
            k = e;
          } else {
            const m = /^[^\s;=]+/.exec(body.slice(k))!;
            v = m[0];
            k += v.length;
          }
          if (key === undefined) key = v;
          else {
            entries.push([key, v]);
            key = undefined;
          }
        }
      }
      out.push({ kind: 'hash', value: entries });
      i = j;
    } else if (c === '(') {
      // e.g. -Body ([System.Text.Encoding]::UTF8.GetBytes("…")): take the first string inside
      const e = scanBalancedPs(s, i);
      const str = psTokens(s.slice(i + 1, e - 1)).find((t) => t.kind === 'str');
      out.push({ kind: 'str', value: str ? (str.value as string) : s.slice(i, e) });
      i = e;
    } else {
      const m = /^[^\s]+/.exec(s.slice(i))!;
      out.push({ kind: 'word', value: m[0] });
      i += m[0].length;
    }
  }
  return out;
}

function scanBalancedPs(s: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < s.length) {
    if (s[i] === '"' || s[i] === "'") {
      i = scanPsString(s, i);
      continue;
    }
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) return i + 1;
    i++;
  }
  return s.length;
}

/** Parse `Invoke-WebRequest` / `Invoke-RestMethod` as copied from devtools "Copy as PowerShell". */
export function parsePowerShell(text: string): HttpRequestSpec {
  const src = text.replace(/`\r?\n/g, ' ');
  const m = PWSH_RE.exec(src);
  if (!m) throw new ApsError('ValidationError', 'Not an Invoke-WebRequest / Invoke-RestMethod command');
  const tokens = psTokens(src.slice(m.index + m[0].length));
  const args = ['curl'];
  let url = '';
  let hasBody = false;
  const str = (t: PsToken | undefined) => (t && t.kind !== 'hash' ? t.value : '');
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind !== 'word' || !t.value.startsWith('-')) {
      if (!url && t.kind !== 'hash' && /^https?:\/\//i.test(t.value)) url = t.value; // positional -Uri
      continue;
    }
    const name = t.value.slice(1).toLowerCase().replace(/:$/, '');
    const next = tokens[i + 1];
    const takes = next && !(next.kind === 'word' && /^-[a-z]/i.test(next.value));
    switch (name) {
      case 'uri':
        url = str(next);
        break;
      case 'method':
        args.push('-X', str(next).toUpperCase());
        break;
      case 'headers':
        if (next?.kind === 'hash') for (const [k, v] of next.value) if (!isPseudoHeader(k)) args.push('-H', `${k}: ${v}`);
        break;
      case 'contenttype':
        args.push('-H', `Content-Type: ${str(next)}`);
        break;
      case 'useragent':
        args.push('-A', str(next));
        break;
      case 'body':
        args.push('--data-raw', str(next));
        hasBody = true;
        break;
      case 'skipcertificatecheck':
        args.push('-k');
        continue;
      case 'maximumredirection':
        break;
      default:
        if (!takes) continue; // switch parameter such as -UseBasicParsing
    }
    if (takes) i++;
  }
  if (!url) throw new ApsError('ValidationError', 'No -Uri found in the PowerShell command');
  args.splice(1, 0, url);
  // devtools puts the user agent and cookies on a WebRequestSession before the call
  const ua = /\$\w+\.UserAgent\s*=\s*("(?:[^"`]|`.|"")*"|'(?:[^']|'')*')/s.exec(text);
  if (ua && !args.includes('-A')) args.push('-A', psString(ua[1]!));
  const cookies: string[] = [];
  const cookieRe = /New-Object\s+System\.Net\.Cookie\(\s*("(?:[^"`]|`.|"")*"|'(?:[^']|'')*')\s*,\s*("(?:[^"`]|`.|"")*"|'(?:[^']|'')*')/gs;
  for (const c of text.matchAll(cookieRe)) cookies.push(`${psString(c[1]!)}=${psString(c[2]!)}`);
  if (cookies.length) args.push('-b', cookies.join('; '));
  const req = parseCurlArgs(args);
  if (!args.includes('-X')) req.method = hasBody ? 'POST' : 'GET';
  return req;
}
