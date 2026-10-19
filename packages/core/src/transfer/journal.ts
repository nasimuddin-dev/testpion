/**
 * The import journal: what one import wrote, so one Undo takes it all back. It lives in `.local/imports/<id>/` (local
 * state, never committed): `journal.json` and, for each file the import overwrote, the bytes that were there.
 *
 * - A file the import made is deleted by Undo; one it replaced gets its old bytes back. A file that changed after the
 *   import (its checksum is not the one the import wrote) is left alone and named in the answer: Undo never throws away
 *   work done since.
 * - An item of a list kept in one file (MCP servers, providers, a library) is removed, or put back as it was, by id, so
 *   the rest of the list (edited since) is untouched.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ApsError } from '../errors.js';
import { atomicWrite, removeOwned } from '../storage/fsutil.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { shortId } from '../util/ids.js';
import { sha256, type BundleKindId } from './format.js';
import type { JournalSink } from './items.js';

export interface JournalFile {
  path: string;
  existed: boolean;
  /** Where the old bytes are kept (relative to the import's folder). */
  backup?: string;
  afterSha?: string;
}

export interface JournalListItem {
  kind: BundleKindId;
  id: string;
  file: 'mcp-servers' | 'providers' | 'library';
  library?: string;
  /** The item before a Replace; absent for an item the import added. */
  before?: unknown;
}

export interface ImportJournal {
  importId: string;
  at: string;
  title: string;
  files: JournalFile[];
  items: JournalListItem[];
  undone?: string;
}

const dirOf = (store: WorkspaceStore, importId: string) => store.path('.local', 'imports', importId);
const validId = (id: string) => /^imp-[a-z0-9]{6,40}$/.test(id);

export class JournalWriter implements JournalSink {
  readonly journal: ImportJournal;
  private readonly dir: string;
  constructor(private readonly store: WorkspaceStore, title: string) {
    const importId = `imp-${shortId('').slice(0, 12).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
    this.journal = { importId, at: new Date().toISOString(), title, files: [], items: [] };
    this.dir = dirOf(store, importId);
  }
  before(rel: string): void {
    if (this.journal.files.some((f) => f.path === rel)) return;
    const abs = this.store.safePath(rel);
    const existed = existsSync(abs) && lstatSync(abs).isFile();
    const rec: JournalFile = { path: rel, existed };
    if (existed) {
      rec.backup = `before/${this.journal.files.length}`;
      mkdirSync(dirname(`${this.dir}/${rec.backup}`), { recursive: true });
      copyFileSync(abs, `${this.dir}/${rec.backup}`);
    }
    this.journal.files.push(rec);
  }
  after(rel: string): void {
    const rec = this.journal.files.find((f) => f.path === rel);
    if (rec) rec.afterSha = sha256(readFileSync(this.store.safePath(rel)));
  }
  listItem(e: JournalListItem): void {
    this.journal.items.push(e);
  }
  save(): void {
    mkdirSync(this.dir, { recursive: true });
    atomicWrite(`${this.dir}/journal.json`, JSON.stringify(this.journal, null, 2));
  }
}

export interface UndoResult {
  importId: string;
  removed: number;
  restored: number;
  /** Files that changed after the import and were left as they are. */
  keptChanged: string[];
}

function readJournal(store: WorkspaceStore, importId: string): ImportJournal {
  if (!validId(importId)) throw new ApsError('ValidationError', `"${String(importId).slice(0, 40)}" is not an import id`, { suggestions: ['`testpion import --list` prints the imports that can be undone'] });
  const f = `${dirOf(store, importId)}/journal.json`;
  if (!existsSync(f)) throw new ApsError('ValidationError', `No import ${importId} in this workspace`, { suggestions: ['`testpion import --list` prints the imports that can be undone'] });
  return JSON.parse(readFileSync(f, 'utf8')) as ImportJournal;
}

/** Take back an import: what it made is removed, what it replaced is put back, as one step. */
export function undoImport(store: WorkspaceStore, importId: string, journal?: ImportJournal): UndoResult {
  const j = journal ?? readJournal(store, importId);
  if (j.undone) throw new ApsError('ValidationError', `Import ${importId} was already undone (${j.undone})`);
  const out: UndoResult = { importId, removed: 0, restored: 0, keptChanged: [] };
  const dir = dirOf(store, j.importId);
  for (const f of [...j.files].reverse()) {
    const abs = store.safePath(f.path);
    const here = existsSync(abs) && lstatSync(abs).isFile();
    if (here && f.afterSha && sha256(readFileSync(abs)) !== f.afterSha) {
      out.keptChanged.push(f.path);
      continue;
    }
    if (f.existed && f.backup) {
      mkdirSync(dirname(abs), { recursive: true });
      atomicWrite(abs, readFileSync(`${dir}/${f.backup}`));
      out.restored++;
    } else if (here) {
      removeOwned(abs);
      out.removed++;
    }
  }
  for (const it of [...j.items].reverse()) {
    const put = <T extends { id: string }>(list: T[]): T[] => {
      const at = list.findIndex((x) => x.id === it.id);
      if (it.before === undefined) {
        if (at >= 0) {
          out.removed++;
          return list.filter((_, i) => i !== at);
        }
        return list;
      }
      out.restored++;
      return at >= 0 ? list.map((x, i) => (i === at ? (it.before as T) : x)) : [...list, it.before as T];
    };
    if (it.file === 'mcp-servers') store.saveMcpServers(put(store.getMcpServers()));
    else if (it.file === 'providers') store.saveProviders(put(store.getProviders()));
    else if (it.library) {
      const lib = store.getLibrary(it.library);
      store.saveLibrary(it.library, { folders: lib.folders, items: put(lib.items) });
    }
  }
  atomicWrite(`${dir}/journal.json`, JSON.stringify({ ...j, undone: new Date().toISOString() }, null, 2));
  return out;
}

/** The imports of this workspace that can still be undone, newest first. */
export function listImports(store: WorkspaceStore): Array<{ importId: string; at: string; title: string; files: number; items: number; undone: boolean }> {
  const root = store.path('.local', 'imports');
  if (!existsSync(root)) return [];
  const out: ReturnType<typeof listImports> = [];
  for (const d of readdirSync(root)) {
    if (!validId(d)) continue;
    try {
      const j = readJournal(store, d);
      out.push({ importId: j.importId, at: j.at, title: j.title, files: j.files.length, items: j.files.length + j.items.length, undone: !!j.undone });
    } catch {
      /* a folder that is not a journal */
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}
