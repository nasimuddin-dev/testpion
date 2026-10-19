import { bruFilesToBrunoExport } from './bru.js';
import { detectFormat } from './detect.js';
import { ocFilesToBundle } from './opencollection-import.js';
import { isZip, readZip } from './zip.js';
import { ApsError } from '../errors.js';
import { IMPORT_FILE_EXTENSIONS } from '@testpion/shared';

/**
 * What a user hands to an import is files: one file, several, a folder, a ZIP, or a drop of any of those. This turns them
 * into the texts the importers read: a Bruno or OpenCollection folder becomes one input (all its files together), a ZIP
 * (a Postman data export, a zipped collection folder) is opened, and every other file is one input when its content is
 * a format TestPion reads. A file that is not (a picture next to the collection, `package.json`) is listed as skipped,
 * with the reason: nothing is dropped silently.
 */

export interface RawImportFile {
  /** Path inside the picked folder / archive, or the file name. */
  path: string;
  data: Buffer | string;
}

export interface ImportInput {
  /** A name for the input (the file or folder name). */
  name: string;
  text: string;
  /** The file or folder it came from, for the report. */
  source: string;
  /** How many files it was assembled from (a folder has many). */
  fileCount: number;
}

export interface SkippedFile {
  path: string;
  why: string;
}

const MAX_FILE = 50 * 1024 * 1024;
const MAX_FILES = 20_000;
const EXT = new Set(IMPORT_FILE_EXTENSIONS.map((e) => e.toLowerCase()));

const toText = (d: Buffer | string): string => (typeof d === 'string' ? d : d.toString('utf8').replace(/^﻿/, ''));
const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');
const ext = (p: string) => (/\.([A-Za-z0-9]+)$/.exec(p)?.[1] ?? '').toLowerCase();
const base = (p: string) => p.split('/').at(-1)!;
const stem = (p: string) => base(p).replace(/\.[^.]+$/, '');

/** Files (and archives) → inputs. */
export function expandImportFiles(files: RawImportFile[], opts: { folderName?: string } = {}): { inputs: ImportInput[]; skipped: SkippedFile[] } {
  const skipped: SkippedFile[] = [];
  const flat: Array<{ path: string; data: Buffer | string }> = [];
  for (const f of files) {
    const path = norm(f.path);
    const buf = typeof f.data === 'string' ? undefined : f.data;
    if (buf && isZip(buf)) {
      for (const e of readZip(buf)) flat.push({ path: `${path.replace(/\.zip$/i, '')}/${e.path}`, data: e.data });
    } else {
      // a path from a picker or a drop: refuse what leaves the folder
      if (path.split('/').includes('..')) {
        skipped.push({ path, why: 'the path leaves the folder' });
        continue;
      }
      flat.push({ path, data: f.data });
    }
    if (flat.length > MAX_FILES) throw new ApsError('ValidationError', `More than ${MAX_FILES} files: import a smaller folder`, { suggestions: [] });
  }

  // collection folders: where a bruno.json or opencollection.yml is, everything below it belongs to that collection
  const roots = new Map<string, 'bruno' | 'opencollection'>();
  for (const f of flat) {
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    if (base(f.path) === 'bruno.json') roots.set(dir, 'bruno');
    else if (/^opencollection\.ya?ml$/.test(base(f.path))) roots.set(dir, 'opencollection');
  }
  // a picked folder of .bru files without bruno.json is a Bruno collection too
  if (!roots.size && flat.some((f) => ext(f.path) === 'bru') && flat.filter((f) => ext(f.path) === 'bru').length > 1) roots.set('', 'bruno');
  const rootOf = (path: string): string | undefined => {
    let best: string | undefined;
    for (const r of roots.keys()) if ((r === '' || path.startsWith(r + '/')) && (best === undefined || r.length > best.length)) best = r;
    return best;
  };
  const inputs: ImportInput[] = [];
  const grouped = new Map<string, Array<{ path: string; text: string }>>();
  for (const f of flat) {
    const root = rootOf(f.path);
    if (root === undefined) continue;
    const rel = root ? f.path.slice(root.length + 1) : f.path;
    const wanted = roots.get(root) === 'bruno' ? ext(rel) === 'bru' || rel === 'bruno.json' || rel === '.env' : /\.ya?ml$/.test(rel) || rel === '.env';
    if (!wanted) {
      skipped.push({ path: f.path, why: 'not part of the collection' });
      continue;
    }
    if (typeof f.data !== 'string' && f.data.length > MAX_FILE) {
      skipped.push({ path: f.path, why: 'larger than 50 MB' });
      continue;
    }
    (grouped.get(root) ?? grouped.set(root, []).get(root)!).push({ path: rel, text: toText(f.data) });
  }
  for (const [root, list] of grouped) {
    const name = (root ? base(root) : opts.folderName) ?? (inputs.length ? `Collection ${inputs.length + 1}` : 'Collection');
    const kind = roots.get(root)!;
    const text = kind === 'bruno' ? JSON.stringify(bruFilesToBrunoExport(list, list.some((x) => x.path === 'bruno.json') ? undefined : name)) : JSON.stringify(ocFilesToBundle(list, name));
    inputs.push({ name, text, source: root || opts.folderName || name, fileCount: list.length });
  }

  // every other file on its own
  for (const f of flat) {
    if (rootOf(f.path) !== undefined) continue;
    const name = base(f.path);
    const e = ext(f.path);
    if (name.startsWith('.') && name !== '.env' && !name.startsWith('.env.')) {
      skipped.push({ path: f.path, why: 'a hidden file' });
      continue;
    }
    if (e && !EXT.has(e)) {
      skipped.push({ path: f.path, why: `a .${e} file is not an import format` });
      continue;
    }
    if (f.data.length > MAX_FILE) {
      skipped.push({ path: f.path, why: 'larger than 50 MB' });
      continue;
    }
    if (typeof f.data !== 'string' && f.data.subarray(0, 8192).includes(0)) {
      skipped.push({ path: f.path, why: 'a binary file' });
      continue;
    }
    const text = toText(f.data);
    if (!text.trim()) {
      skipped.push({ path: f.path, why: 'empty' });
      continue;
    }
    // (a copied cURL command saved to a file is handled by the caller, which knows the snippet formats)
    const format = detectFormat(text);
    if (format === 'unknown' && !/^\s*(curl|fetch|Invoke-|http\s)/i.test(text)) {
      skipped.push({ path: f.path, why: 'not a format TestPion imports' });
      continue;
    }
    inputs.push({ name: stem(f.path), text, source: f.path, fileCount: 1 });
  }
  return { inputs, skipped };
}
