import { inflateRawSync } from 'node:zlib';
import { ApsError } from '../errors.js';
import { dataStart, findEndOfDirectory, readRecord } from '../transfer/zip.js';

/**
 * A small, defensive ZIP reader for imports (a Postman data export, a zipped Bruno or OpenCollection folder). It reads
 * the central directory, inflates entries (stored or deflate) and refuses what a hostile archive does: too many entries,
 * too much data, an absurd compression ratio (a zip bomb), entry names that leave the archive (`../x`, absolute paths,
 * drive letters, NUL bytes) and encrypted or multi-disk archives. Directories and symlinks are skipped. The structure
 * (the end-of-directory record, the records, the local headers) is read by the one parser of transfer/zip.ts, the hardened
 * reader of bundles; this file keeps the import's own limits, name rules and messages.
 */

export interface ZipEntry {
  /** `/` separated, never starting with `/` and never containing `..`. */
  path: string;
  data: Buffer;
}

export interface ZipLimits {
  maxEntries: number;
  /** Total uncompressed bytes. */
  maxBytes: number;
  /** Largest one entry may be. */
  maxEntryBytes: number;
  /** Uncompressed / compressed size of an entry (a bomb is 1000+). */
  maxRatio: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxEntries: 20_000, maxBytes: 200 * 1024 * 1024, maxEntryBytes: 50 * 1024 * 1024, maxRatio: 200 };

/** Is this the start of a ZIP file? */
export const isZip = (b: Buffer): boolean => b.length > 22 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5);

const bad = (why: string) => new ApsError('ValidationError', `This archive cannot be imported: ${why}`, { suggestions: ['Unzip it and import the folder, or export the collections one by one.'] });

/** An entry name made safe, or undefined when it must be skipped (a directory) or refused (it throws). */
export function safeEntryPath(name: string): string | undefined {
  if (name.includes('\0')) throw bad('an entry name contains a NUL byte');
  const p = name.replace(/\\/g, '/');
  if (p.endsWith('/')) return undefined;
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p) || p.split('/').some((s) => s === '..')) throw bad(`the entry "${name.slice(0, 80)}" points outside the archive`);
  // macOS resource forks and Windows thumbnails are not part of a collection
  if (p.startsWith('__MACOSX/') || p.split('/').at(-1) === '.DS_Store' || p.split('/').at(-1) === 'Thumbs.db') return undefined;
  return p.replace(/^\.\//, '');
}

export function readZip(buf: Buffer, limits: Partial<ZipLimits> = {}): ZipEntry[] {
  const lim = { ...DEFAULT_ZIP_LIMITS, ...limits };
  const eocd = findEndOfDirectory(buf);
  if (eocd < 0) throw bad('it is not a ZIP file (or is damaged)');
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  let off = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt16LE(eocd + 4) !== 0 || total === 0xffff || off === 0xffffffff || cdSize === 0xffffffff) throw bad('multi-part and ZIP64 archives are not supported');
  if (total > lim.maxEntries) throw bad(`it has ${total} entries (at most ${lim.maxEntries})`);
  const out: ZipEntry[] = [];
  let bytes = 0;
  for (let n = 0; n < total; n++) {
    const rec = readRecord(buf, off);
    if (!rec) throw bad('its directory is damaged');
    const { flags, method, csize, usize } = rec;
    const name = rec.nameBytes.toString(flags & 0x800 ? 'utf8' : 'latin1');
    off = rec.next;
    const path = safeEntryPath(name);
    // a symlink (Unix mode 0120000 in the high attribute bits) is not followed
    if (!path || ((rec.external >>> 16) & 0xf000) === 0xa000) continue;
    if (flags & 1) throw bad('it is encrypted');
    if (usize > lim.maxEntryBytes) throw bad(`the entry "${path}" is larger than ${Math.round(lim.maxEntryBytes / 1048576)} MB`);
    if (csize > 0 && usize / csize > lim.maxRatio) throw bad(`the entry "${path}" compresses ${Math.round(usize / csize)} times (a zip bomb?)`);
    bytes += usize;
    if (bytes > lim.maxBytes) throw bad(`it holds more than ${Math.round(lim.maxBytes / 1048576)} MB`);
    const start = dataStart(buf, rec);
    if (start < 0) throw bad('its directory is damaged');
    const raw = buf.subarray(start, start + csize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      // (maxOutputLength: the declared size is not trusted)
      try {
        data = inflateRawSync(raw, { maxOutputLength: usize + 1 });
      } catch {
        throw bad(`the entry "${path}" is damaged or larger than it says`);
      }
    } else throw bad(`the entry "${path}" uses compression method ${method}`);
    out.push({ path, data });
  }
  return out;
}
