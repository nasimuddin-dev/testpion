import { bruFilesToBrunoExport } from './bru.js';
import { handOff } from './parsed.js';
import { detectFormat } from './detect.js';
import { ocFilesToBundle } from './opencollection-import.js';
import { looksLikePostmanV3 } from './postman-versions.js';
import { yaakFilesToExport } from './yaak-import.js';
import { parseYaml } from '../util/lazy-yaml.js';
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

/** An assembled folder as the text the importers read; the object itself is handed to the importer, which would parse the text again (parsed.ts). */
const handOffJson = (value: unknown): string => handOff(JSON.stringify(value), value);

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
  const roots = new Map<string, 'bruno' | 'opencollection' | 'postman-v3' | 'yaak'>();
  for (const f of flat) {
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    if (base(f.path) === 'bruno.json') roots.set(dir, 'bruno');
    else if (/^opencollection\.ya?ml$/.test(base(f.path))) roots.set(dir, 'opencollection');
    else if (/^yaak\..+\.ya?ml$/.test(base(f.path)) && !roots.has(dir)) roots.set(dir, 'yaak');
  }
  // Postman v3 (Git integration): a folder whose definition.yaml says $kind: collection, or that holds *.request.yaml files
  const v3 = new Map<string, string>();
  for (const f of flat) {
    if (!/(^|\/)(\.resources\/)?definition\.ya?ml$/i.test(f.path) || typeof f.data !== 'string' && f.data.length > 1_000_000) continue;
    try {
      const y = parseYaml(toText(f.data)) as Record<string, unknown> | undefined;
      if (/^collection$/i.test(String(y?.$kind ?? y?.type ?? ''))) v3.set(f.path.replace(/\/?(\.resources\/)?definition\.ya?ml$/i, ''), String(y?.id ?? ''));
    } catch {
      /* not YAML */
    }
  }
  for (const dir of v3.keys()) if (!roots.has(dir)) roots.set(dir, 'postman-v3');
  if (!v3.size) {
    const requestDirs = flat.filter((f) => /\.request\.ya?ml$/i.test(f.path)).map((f) => (f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''));
    if (requestDirs.length) {
      // the folder all the requests share is the collection
      let common = requestDirs[0]!.split('/');
      for (const d of requestDirs) {
        const parts = d.split('/');
        let i = 0;
        while (i < common.length && i < parts.length && common[i] === parts[i]) i++;
        common = common.slice(0, i);
      }
      const dir = common.join('/');
      if (!roots.has(dir)) roots.set(dir, 'postman-v3');
    }
  }
  // Native Git: .postman/resources.yaml maps local collections to their ids in the cloud (what re-import matches on)
  const cloudIds = new Map<string, string>();
  for (const f of flat)
    if (/(^|\/)\.postman\/resources\.ya?ml$/i.test(f.path)) {
      try {
        const y = parseYaml(toText(f.data)) as { cloudResources?: { collections?: Record<string, string> } } | undefined;
        for (const [local, id] of Object.entries(y?.cloudResources?.collections ?? {})) cloudIds.set(String(local).replace(/^(\.\.\/|\.\/)+/, '').replace(/\/$/, ''), String(id));
      } catch {
        /* not YAML */
      }
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
    const kind0 = roots.get(root);
    const wanted = kind0 === 'bruno' ? ext(rel) === 'bru' || rel === 'bruno.json' || rel === '.env' : kind0 === 'yaak' ? /^yaak\..+\.ya?ml$/.test(base(rel)) : /\.ya?ml$/.test(rel) || rel === '.env';
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
    let text: string;
    if (kind === 'bruno') text = handOffJson(bruFilesToBrunoExport(list, list.some((x) => x.path === 'bruno.json') ? undefined : name));
    else if (kind === 'yaak') text = handOffJson(yaakFilesToExport(list));
    else if (kind === 'postman-v3') {
      if (!looksLikePostmanV3(list)) {
        skipped.push({ path: root || name, why: 'not a Postman collection folder' });
        continue;
      }
      const key = v3.get(root) || cloudIds.get(root) || undefined;
      text = handOffJson({ postmanV3: 1, name, ...(key ? { key } : {}), files: list });
    } else text = handOffJson(ocFilesToBundle(list, name));
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
    let text = toText(f.data);
    if (!text.trim()) {
      skipped.push({ path: f.path, why: 'empty' });
      continue;
    }
    // Postman's globals file (workspace.globals.yaml): its values are globals, not an environment
    if (/\.globals\.ya?ml$/i.test(f.path)) {
      try {
        const y = parseYaml(text) as Record<string, unknown>;
        if (y && Array.isArray(y.values)) text = JSON.stringify({ ...y, name: y.name ?? 'Globals', _postman_variable_scope: 'globals' });
      } catch {
        /* the importer reports it */
      }
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
