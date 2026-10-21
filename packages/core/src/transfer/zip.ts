/**
 * A small zip writer and a hardened zip reader for transfer bundles (no dependency: the reader is the part that meets
 * untrusted input, so every check lives here, in one place, and is tested against hostile archives).
 *
 * The reader refuses, with the reason: encryption, zip64, methods other than stored / deflate, symbolic links, names
 * that leave the archive (`..`, absolute, drive, UNC, backslash, NUL), names that differ only in case (they would
 * collide on Windows and macOS), more entries than the limit, and any entry or total that inflates past the limits. The
 * declared sizes are never trusted: the inflater is capped, and the result must match the declared size and CRC.
 */
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { ApsError } from '../errors.js';

export interface ZipLimits {
  /** Most entries in the archive. */
  entries: number;
  /** Largest entry once inflated, in bytes. */
  entryBytes: number;
  /** All entries once inflated, in bytes. */
  totalBytes: number;
  /** An entry above `ratioFrom` bytes that inflates to more than this many times its compressed size is refused (a zip bomb). */
  ratio: number;
  ratioFrom: number;
}

export const ZIP_LIMITS: Readonly<ZipLimits> = {
  entries: 20_000,
  entryBytes: 512 * 1024 * 1024,
  totalBytes: 2 * 1024 * 1024 * 1024,
  ratio: 100,
  ratioFrom: 1024 * 1024,
};

export interface ZipEntry {
  name: string;
  data: Buffer;
}

const bad = (why: string): never => {
  throw new ApsError('ValidationError', `Not a valid TestPion bundle: ${why}`);
};

/* ------------------------------------------------------------------ writer */

// 1980-01-01 00:00: the same files always give the same archive (a bundle can be compared and checksummed)
const DOS_DATE = 0x0021;
const DOS_TIME = 0;

/** Names already compressed (or random) are stored: deflating them costs time and gains nothing. */
const STORED = /\.(zip|gz|png|jpe?g|gif|webp|db|db3|sqlite3?|pdf)$/i;

/** The archive of `entries` (names with `/`, utf8). Text is deflated; already-compressed files are stored. */
export function writeZip(entries: readonly ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const deflated = STORED.test(e.name) || e.data.length < 64 ? undefined : deflateRawSync(e.data, { level: 6 });
    const useDeflate = !!deflated && deflated.length < e.data.length;
    const body = useDeflate ? deflated! : e.data;
    const method = useDeflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: utf8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, body);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by (DOS: no unix mode, so no symlink bit)
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  if (offset + cdBuf.length > 0xfffffff0 || entries.length >= 0xffff)
    throw new ApsError('ValidationError', 'The bundle is too large for one zip (4 GB or 65,535 files): export fewer items, or datasets by reference');
  return Buffer.concat([...parts, cdBuf, end]);
}

/* ------------------------------------------------------------------ reader */

/** Whether the bytes start like a zip archive. */
export const looksLikeZip = (b: Buffer): boolean => b.length >= 22 && b.readUInt32LE(0) === 0x04034b50;

/** An entry name checked the same way on every OS (lexically): the reason it is refused, or undefined. */
export function badEntryName(name: string): string | undefined {
  if (!name) return 'an entry with no name';
  if (name.length > 400) return 'an entry name longer than 400 characters';
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'an entry name with a control character';
  if (name.includes('\\')) return `"${name}" has a backslash`;
  if (name.startsWith('/') || /^[a-z]:/i.test(name)) return `"${name}" is an absolute path`;
  if (name.split('/').some((n) => n === '..' || n === '.')) return `"${name}" leaves the archive`;
  return undefined;
}

/**
 * The offset of the end-of-central-directory record: the last 22 bytes, or before a comment of up to 65,535 bytes (-1 when
 * there is none). The one place that finds it: the import reader (import/zip.ts) shares it.
 */
export function findEndOfDirectory(buf: Buffer): number {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) if (buf.readUInt32LE(i) === 0x06054b50) return i;
  return -1;
}

/** One record of the central directory, as the archive declares it (nothing here is trusted yet). */
export interface ZipRecord {
  madeBy: number;
  flags: number;
  method: number;
  crc: number;
  /** Compressed and uncompressed sizes. */
  csize: number;
  usize: number;
  /** The bytes of the name (the reader decodes them: utf8, or the flag-dependent encoding of the import reader). */
  nameBytes: Buffer;
  external: number;
  /** Offset of the entry's local header. */
  local: number;
  /** Where the next record starts. */
  next: number;
}

/** The central-directory record at `pos`, or undefined when the bytes there are not one (the directory is damaged or cut off). */
export function readRecord(buf: Buffer, pos: number): ZipRecord | undefined {
  if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) return undefined;
  const nameLen = buf.readUInt16LE(pos + 28);
  const extraLen = buf.readUInt16LE(pos + 30);
  const commentLen = buf.readUInt16LE(pos + 32);
  const nameEnd = pos + 46 + nameLen;
  if (nameEnd > buf.length) return undefined;
  return {
    madeBy: buf.readUInt16LE(pos + 4),
    flags: buf.readUInt16LE(pos + 8),
    method: buf.readUInt16LE(pos + 10),
    crc: buf.readUInt32LE(pos + 16),
    csize: buf.readUInt32LE(pos + 20),
    usize: buf.readUInt32LE(pos + 24),
    nameBytes: buf.subarray(pos + 46, nameEnd),
    external: buf.readUInt32LE(pos + 38),
    local: buf.readUInt32LE(pos + 42),
    next: nameEnd + extraLen + commentLen,
  };
}

/** Where a record's data starts (after its local header), or -1 when the local header is not there. */
export function dataStart(buf: Buffer, rec: Pick<ZipRecord, 'local'>): number {
  const { local } = rec;
  if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) return -1;
  return local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
}

/** Read every file of the archive, or throw with what is wrong (see the module comment for what is refused). */
export function readZip(buf: Buffer, limits: ZipLimits = ZIP_LIMITS): ZipEntry[] {
  if (!looksLikeZip(buf)) bad('it is not a zip archive');
  const eocd = findEndOfDirectory(buf);
  if (eocd < 0) bad('the zip directory is missing (a damaged or cut-off file)');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) bad('zip64 archives are not supported');
  if (count > limits.entries) bad(`it holds ${count} files (at most ${limits.entries})`);
  if (cdOffset + cdSize > eocd) bad('the zip directory is damaged');

  const out: ZipEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  let pos = cdOffset;
  for (let n = 0; n < count; n++) {
    const rec = readRecord(buf, pos);
    if (!rec) return bad('the zip directory is damaged');
    const { madeBy, flags, method, crc, csize, usize, external } = rec;
    const name = rec.nameBytes.toString('utf8');
    pos = rec.next;

    const isDir = name.endsWith('/');
    const why = badEntryName(isDir ? name.slice(0, -1) : name);
    if (why) bad(why);
    if (isDir) continue;
    if (flags & 1) bad(`"${name}" is encrypted`);
    if (method !== 0 && method !== 8) bad(`"${name}" uses a compression method this version does not read (${method})`);
    // unix attributes (host 3): a symbolic link, device or pipe is never part of a bundle
    if (madeBy >> 8 === 3) {
      const mode = (external >>> 16) & 0o170000;
      if (mode !== 0 && mode !== 0o100000) bad(`"${name}" is a link or a special file, not a plain file`);
    }
    const key = name.toLowerCase();
    if (seen.has(key)) bad(`"${name}" appears twice (names are compared without case, as Windows and macOS do)`);
    seen.add(key);
    if (usize > limits.entryBytes) bad(`"${name}" is ${usize} bytes inflated (at most ${limits.entryBytes})`);
    if (usize > limits.ratioFrom && csize > 0 && usize / csize > limits.ratio) bad(`"${name}" inflates ${Math.round(usize / csize)} times its size (a zip bomb)`);
    total += usize;
    if (total > limits.totalBytes) bad(`the files inflate to more than ${limits.totalBytes} bytes`);

    const start = dataStart(buf, rec);
    if (start < 0) bad(`"${name}" has a damaged header`);
    if (start + csize > buf.length) bad(`"${name}" is cut off`);
    const raw = buf.subarray(start, start + csize);
    let data: Buffer;
    try {
      data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) });
    } catch {
      return bad(`"${name}" does not inflate to its declared size`);
    }
    if (data.length !== usize) bad(`"${name}" does not inflate to its declared size`);
    if (crc32(data) !== crc) bad(`"${name}" is damaged (its checksum does not match)`);
    out.push({ name, data });
  }
  return out;
}
