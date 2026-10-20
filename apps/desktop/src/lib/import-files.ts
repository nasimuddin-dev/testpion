/**
 * The files an Import reads, from every way the window gets them: the file picker (several files at once), the folder
 * picker and a drop (files, folders, a link). Works in the desktop app and in a browser / cloud host alike: the files
 * go to the backend as text (or base64 for a ZIP) and the backend decides what each one is.
 */
import type { ImportSource } from '../types';

const MAX_TOTAL = 200 * 1024 * 1024;
const MAX_FILES = 20_000;
const SKIP_DIR = /(^|\/)(node_modules|\.git|\.[^/]+)\//;

type PickedFile = NonNullable<ImportSource['files']>[number];

async function read(f: File, path: string): Promise<PickedFile> {
  if (/\.zip$/i.test(f.name)) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { path, base64: btoa(bin) };
  }
  return { path, text: await f.text() };
}

async function readAll(list: Array<{ file: File; path: string }>): Promise<PickedFile[]> {
  if (list.length > MAX_FILES) throw new Error(`More than ${MAX_FILES} files: choose a smaller folder`);
  if (list.reduce((n, x) => n + x.file.size, 0) > MAX_TOTAL) throw new Error(`The files are larger than ${MAX_TOTAL / 1024 / 1024} MB`);
  return Promise.all(list.map((x) => read(x.file, x.path)));
}

/** Several files at once. */
export function pickImportFiles(accept: string): Promise<ImportSource | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = `${accept},.zip,.yml,.yaml`;
    input.onchange = () => {
      const list = [...(input.files ?? [])];
      if (!list.length) return resolve(null);
      readAll(list.map((file) => ({ file, path: file.name }))).then((files) => resolve({ files }), reject);
    };
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/** A folder: any collection folder (Bruno, OpenCollection) or a folder of files. */
export function pickImportFolder(): Promise<ImportSource | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;
    input.onchange = () => {
      const list = [...(input.files ?? [])];
      if (!list.length) return resolve(null);
      const folderName = list[0]!.webkitRelativePath.split('/')[0] ?? 'Folder';
      const rel = (f: File) => f.webkitRelativePath.split('/').slice(1).join('/');
      // (the collection's own .env at the top is read; other hidden files and folders are not)
      const wanted = list.filter((f) => !SKIP_DIR.test(rel(f)) && (!rel(f).split('/').pop()!.startsWith('.') || rel(f) === '.env'));
      readAll(wanted.map((file) => ({ file, path: rel(file) }))).then((files) => resolve({ files, folderName }), reject);
    };
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/** Does a drag carry something an import can read (files, a folder, a link)? Decided on dragover, before the drop. */
export function dragHasImportable(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  const types = [...(dt.types ?? [])];
  return types.includes('Files') || types.includes('text/uri-list');
}

async function entryFiles(entry: FileSystemEntry, prefix: string, out: Array<{ file: File; path: string }>): Promise<void> {
  if (out.length > MAX_FILES) return;
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    out.push({ file, path: prefix + entry.name });
  } else if (entry.isDirectory) {
    if (SKIP_DIR.test(`${prefix}${entry.name}/`) && prefix) return;
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries answers in batches until it returns an empty list
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const e of batch) await entryFiles(e, `${prefix}${entry.name}/`, out);
    }
  }
}

/** What was dropped: files and folders (a dropped folder keeps its name as the root of the paths) or a link. */
export async function readDrop(dt: DataTransfer): Promise<ImportSource | null> {
  // (everything the event carries is read before the first await: a DataTransfer is empty once the handler returns)
  const link = (dt.getData('text/uri-list') || dt.getData('text/plain') || '').split(/\r?\n/).find((l) => /^https?:\/\/\S+$/i.test(l.trim()))?.trim();
  const direct = [...(dt.files ?? [])];
  const entries = [...(dt.items ?? [])].filter((i) => i.kind === 'file').map((i) => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e);
  if (entries.length) {
    try {
      const list: Array<{ file: File; path: string }> = [];
      let folderName: string | undefined;
      if (entries.length === 1 && entries[0]!.isDirectory) {
        // the dropped folder is the root: paths inside it (bruno.json, requests/…)
        folderName = entries[0]!.name;
        const inner: Array<{ file: File; path: string }> = [];
        await entryFiles(entries[0]!, '', inner);
        for (const x of inner) list.push({ file: x.file, path: x.path.split('/').slice(1).join('/') });
      } else for (const e of entries) await entryFiles(e, '', list);
      const wanted = list.filter((x) => x.path && !SKIP_DIR.test(x.path) && (!x.path.split('/').pop()!.startsWith('.') || x.path === '.env'));
      if (wanted.length) return { files: await readAll(wanted), ...(folderName ? { folderName } : {}) };
    } catch {
      /* the entries cannot be read (a drag from another process): the plain files are tried */
    }
  }
  if (direct.length) return { files: await readAll(direct.map((file) => ({ file, path: file.name }))) };
  return link ? { url: link } : null;
}
