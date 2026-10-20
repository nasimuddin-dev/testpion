import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { ApsError } from '../errors.js';
import type { RawImportFile } from './inputs.js';

/**
 * A file or a folder on disk as the files an import reads (inputs.ts turns them into what the importers take). A folder
 * is read to a depth of 12 with symbolic links, `node_modules`, `.git` and hidden folders left alone, at most 20,000
 * files and 200 MB, so pointing an import at the wrong folder stops with a message instead of reading a disk.
 */
export function readImportPath(path: string): { files: RawImportFile[]; folderName?: string } {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new ApsError('ValidationError', `${path} is a symbolic link: import the file or folder it points at`, { suggestions: [] });
  if (st.isFile()) return { files: [{ path: basename(path), data: readFileSync(path) }] };
  if (!st.isDirectory()) throw new ApsError('ValidationError', `${path} is not a file or a folder`, { suggestions: [] });
  const files: RawImportFile[] = [];
  let total = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 12) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        // (.resources and .postman hold the definition files of a Postman Git collection)
        if (e.name === 'node_modules' || e.name === '.git' || (e.name.startsWith('.') && e.name !== '.' && e.name !== '.resources' && e.name !== '.postman')) continue;
        walk(p, depth + 1);
      } else if (e.isFile()) {
        // (only the collection's own .env at the top is read; a hidden file elsewhere is not a collection file)
        if (e.name.startsWith('.') && !(e.name === '.env' && dir === path)) continue;
        const size = lstatSync(p).size;
        total += size;
        if (files.length >= 20_000 || total > 200 * 1024 * 1024) throw new ApsError('ValidationError', `${path} holds more than 20,000 files or 200 MB`, { suggestions: ['Import the collection’s own folder, not its parent.'] });
        files.push({ path: relative(path, p).replace(/\\/g, '/'), data: size > 50 * 1024 * 1024 ? '' : readFileSync(p) });
      }
    }
  };
  walk(path, 0);
  return { files, folderName: basename(path) };
}
