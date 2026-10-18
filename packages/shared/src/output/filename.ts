/**
 * File names for saved outputs, the same on Windows, macOS and Linux: `GET-patients-2026-10-17-1405-200.json`.
 * Pure string work (no path module): the name is never a path, whatever the platform.
 */

const RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\..*)?$/i;
const MAX_BASE_BYTES = 120;
const MAX_NAME_BYTES = 200;

const utf8Length = (s: string) => new TextEncoder().encode(s).length;

/** Cut a string to at most `max` UTF-8 bytes without splitting a character. */
function cutBytes(s: string, max: number): string {
  if (utf8Length(s) <= max) return s;
  let out = '';
  for (const ch of s) {
    if (utf8Length(out + ch) > max) break;
    out += ch;
  }
  return out;
}

/**
 * A safe file name: no path separators, reserved characters or control characters (each run becomes one `-`), no
 * leading / trailing spaces or dots (Windows drops a trailing dot), Windows' reserved device names prefixed with `_`,
 * NFC-normalised, the base at most 120 UTF-8 bytes and the whole name at most 200 (the extension is always kept).
 */
export function sanitizeFileName(name: string, fallback = 'output'): string {
  let s = String(name ?? '').normalize('NFC');
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[<>:"/\\|?*\u0000-\u001F\u007F]+/g, '-');
  s = s.replace(/\s+/g, ' ').replace(/-{2,}/g, '-');
  s = s.replace(/^[\s.-]+|[\s.]+$/g, '');
  if (!s) s = fallback;
  const dot = s.lastIndexOf('.');
  let base = dot > 0 ? s.slice(0, dot) : s;
  let ext = dot > 0 ? s.slice(dot + 1) : '';
  if (utf8Length(ext) > 16) {
    base = s;
    ext = '';
  }
  base = cutBytes(base, Math.min(MAX_BASE_BYTES, MAX_NAME_BYTES - (ext ? utf8Length(ext) + 1 : 0))).replace(/[\s.]+$/g, '') || fallback;
  let out = ext ? `${base}.${ext}` : base;
  if (RESERVED.test(out) || RESERVED.test(base)) out = `_${out}`;
  return out;
}

/** Local time as `yyyy-mm-dd-HHMM` (sortable, no seconds). */
export function fileStamp(when: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())}-${p(when.getHours())}${p(when.getMinutes())}`;
}

/** The last path segment of a URL (or the host), for a name: `https://x/api/patients?x=1` → `patients`. */
export function urlNamePart(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const noQuery = url.replace(/[?#].*$/, '').replace(/\/+$/, '');
  const seg = noQuery.split('/').filter(Boolean).pop();
  if (!seg || /^[a-z]+:$/i.test(seg)) return undefined;
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/**
 * `<METHOD>-<name>-<yyyy-mm-dd-HHMM>-<status>.<ext>`, each part optional, sanitised. `name` may be a URL (its last
 * segment is used).
 */
export function outputFileName(parts: { method?: string; name?: string; url?: string; status?: string | number; when?: Date; ext: string; stamp?: boolean }): string {
  const name = parts.name ?? urlNamePart(parts.url);
  const bits = [parts.method?.toUpperCase(), name, parts.stamp === false ? undefined : fileStamp(parts.when), parts.status === undefined || parts.status === '' ? undefined : String(parts.status)]
    .filter((b): b is string => !!b && !!String(b).trim())
    .map((b) => b.replace(/[\s/\\]+/g, '-'));
  const ext = parts.ext.replace(/^\.+/, '');
  return sanitizeFileName(`${bits.join('-') || 'output'}${ext ? `.${ext}` : ''}`);
}

/** The file name a server suggests in Content-Disposition (RFC 6266: `filename*=UTF-8''…` first), sanitised; undefined when none. */
export function fileNameFromContentDisposition(header: string | undefined | null): string | undefined {
  if (!header) return undefined;
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (star) {
    try {
      return sanitizeFileName(decodeURIComponent(star[2]!.trim().replace(/^"|"$/g, '')));
    } catch {
      // a broken encoding: fall back to the plain parameter
    }
  }
  const plain = /filename\s*=\s*("((?:[^"\\]|\\.)*)"|[^;]+)/i.exec(header);
  if (!plain) return undefined;
  const v = plain[2] !== undefined ? plain[2].replace(/\\(.)/g, '$1') : plain[1]!.trim();
  return v ? sanitizeFileName(v) : undefined;
}

const MIME_EXT: Record<string, string> = {
  'application/json': 'json',
  'application/problem+json': 'json',
  'application/ld+json': 'json',
  'application/x-ndjson': 'jsonl',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'application/soap+xml': 'xml',
  'text/html': 'html',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/tab-separated-values': 'tsv',
  'text/markdown': 'md',
  'text/event-stream': 'txt',
  'text/css': 'css',
  'text/javascript': 'js',
  'application/javascript': 'js',
  'application/yaml': 'yaml',
  'application/x-yaml': 'yaml',
  'text/yaml': 'yaml',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/gzip': 'gz',
  'application/graphql': 'graphql',
  'application/grpc': 'bin',
  'application/octet-stream': 'bin',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/avif': 'avif',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'font/woff2': 'woff2',
};

/** The usual extension for a Content-Type (`application/json; charset=utf-8` → json); `bin` when unknown. */
export function extensionForMime(contentType: string | undefined): string {
  const m = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (MIME_EXT[m]) return MIME_EXT[m]!;
  if (/\+json$/.test(m)) return 'json';
  if (/\+xml$/.test(m)) return 'xml';
  if (m.startsWith('text/')) return 'txt';
  return 'bin';
}

/** `name.ext`, or `name-2.ext`, `name-3.ext` … when `taken` says the name is used (where no dialog asks before replacing). */
export function uniqueFileName(name: string, taken: (n: string) => boolean): string {
  if (!taken(name)) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; i < 10_000; i++) {
    const n = `${base}-${i}${ext}`;
    if (!taken(n)) return n;
  }
  return `${base}-${Date.now()}${ext}`;
}
