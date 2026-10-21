import { ApsError } from '../errors.js';
import { ZIP_LIMITS, readZip as readHardenedZip, type ZipLimits as HardenedLimits, type ZipPolicy } from '../transfer/zip.js';

/**
 * Archives for the import (a Postman data export, a zipped Bruno or OpenCollection folder). There is ONE zip reader in the
 * engine, the hardened one of transfer/zip.ts that bundles and SAZ files use (every check lives there: entry count, sizes,
 * compression ratio, names that leave the archive, links, encryption, zip64, checksums). This file is only the import's
 * policy over it: the limits a data export needs (a bigger entry count and a lower total than a bundle), the macOS and
 * Windows junk files left out, links skipped instead of refusing the archive, backslashes in names taken as separators, and
 * the wording the import dialog shows.
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

/** macOS resource forks and Windows thumbnails are not part of a collection. */
const junk = (name: string): boolean => name.startsWith('__MACOSX/') || name.endsWith('.DS_Store') || name.endsWith('Thumbs.db');

const POLICY: ZipPolicy = {
  ignore: junk,
  skipLinks: true,
  lenientNames: true,
  // the archive says whether its names are utf8 (bit 11); older tools write the DOS code page, read as latin1
  decodeName: (bytes, flags) => bytes.toString(flags & 0x800 ? 'utf8' : 'latin1'),
  fail: (why) => new ApsError('ValidationError', `This archive cannot be imported: ${why}`, { suggestions: ['Unzip it and import the folder, or export the collections one by one.'] }),
};

export function readZip(buf: Buffer, limits: Partial<ZipLimits> = {}): ZipEntry[] {
  const lim = { ...DEFAULT_ZIP_LIMITS, ...limits };
  const hardened: HardenedLimits = { entries: lim.maxEntries, entryBytes: lim.maxEntryBytes, totalBytes: lim.maxBytes, ratio: lim.maxRatio, ratioFloor: ZIP_LIMITS.ratioFloor };
  return readHardenedZip(buf, hardened, 'archive', POLICY).map((e) => ({ path: e.name, data: e.data }));
}
