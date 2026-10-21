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
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { ApsError } from '../errors.js';
import { atomicWrite, removeOwned } from '../storage/fsutil.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { shortId } from '../util/ids.js';
import { sha256, type BundleKindId, type BundleVariable } from './format.js';
import type { JournalSink } from './items.js';
import { restoreWorkspaceVariables, variablesSha } from './workspace-section.js';

export interface JournalFile {
  path: string;
  existed: boolean;
  /** Where the old bytes are kept (relative to the import's folder). */
  backup?: string;
  afterSha?: string;
}

interface JournalListItem {
  kind: BundleKindId;
  id: string;
  file: 'mcp-servers' | 'providers' | 'library';
  library?: string;
  /** The item before a Replace; absent for an item the import added. */
  before?: unknown;
}

interface ImportJournal {
  importId: string;
  at: string;
  title: string;
  files: JournalFile[];
  items: JournalListItem[];
  /** The workspace's own variables as they were before the import wrote them, and a checksum of what it wrote. */
  workspaceVariables?: { before: BundleVariable[]; afterSha: string };
  undone?: string;
}

const dirOf = (store: WorkspaceStore, importId: string) => store.path('.local', 'imports', importId);
const validId = (id: string) => /^imp-[a-z0-9]{6,40}$/.test(id);

/** The newest imports that can still be undone; the journals and saved bytes of older ones are deleted (they only grew). */
const KEEP_JOURNALS = 30;

/** What the list of imports shows of one, kept beside its journal so listing them does not read the journals (which hold the old bytes' list and the replaced items). */
interface JournalSummary {
  importId: string;
  at: string;
  title: string;
  files: number;
  items: number;
  undone: boolean;
}
const summaryOf = (j: ImportJournal): JournalSummary => ({ importId: j.importId, at: j.at, title: j.title, files: j.files.length, items: j.files.length + j.items.length, undone: !!j.undone });
const writeSummary = (dir: string, j: ImportJournal) => atomicWrite(`${dir}/summary.json`, JSON.stringify(summaryOf(j)));

/** Delete the journals past the newest `KEEP_JOURNALS` (by the time the journal was written; nothing is read). */
function pruneJournals(store: WorkspaceStore): void {
  const root = store.path('.local', 'imports');
  try {
    const all = readdirSync(root)
      .filter(validId)
      .map((id) => {
        let at = 0;
        try {
          at = statSync(`${root}/${id}/journal.json`).mtimeMs;
        } catch {
          /* no journal (an import that stopped): the oldest */
        }
        return { id, at };
      })
      .sort((a, b) => b.at - a.at);
    for (const old of all.slice(KEEP_JOURNALS)) rmSync(`${root}/${old.id}`, { recursive: true, force: true });
  } catch {
    /* nothing to prune, or a disk that does not let us: the next import tries again */
  }
}

export class JournalWriter implements JournalSink {
  readonly journal: ImportJournal;
  private readonly dir: string;
  constructor(
    private readonly store: WorkspaceStore,
    title: string,
  ) {
    const importId = `imp-${shortId('')
      .slice(0, 12)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, 'x')}`;
    this.journal = { importId, at: new Date().toISOString(), title, files: [], items: [] };
    this.dir = dirOf(store, importId);
  }
  /** The journal's files by path (a lookup, not a scan: an import can write thousands). */
  private readonly byPath = new Map<string, JournalFile>();
  before(rel: string): void {
    if (this.byPath.has(rel)) return;
    const abs = this.store.safePath(rel);
    const existed = existsSync(abs) && lstatSync(abs).isFile();
    const rec: JournalFile = { path: rel, existed };
    if (existed) {
      rec.backup = `before/${this.journal.files.length}`;
      mkdirSync(dirname(`${this.dir}/${rec.backup}`), { recursive: true });
      copyFileSync(abs, `${this.dir}/${rec.backup}`);
    }
    this.journal.files.push(rec);
    this.byPath.set(rel, rec);
  }
  after(rel: string): void {
    const rec = this.byPath.get(rel);
    if (rec) rec.afterSha = sha256(readFileSync(this.store.safePath(rel)));
  }
  listItem(e: JournalListItem): void {
    this.journal.items.push(e);
  }
  /** The workspace's variables are about to be changed (`before`) and now hold what the import wrote. */
  workspaceVariables(before: BundleVariable[]): void {
    this.journal.workspaceVariables = { before, afterSha: '' };
  }
  save(): void {
    const w = this.journal.workspaceVariables;
    if (w) w.afterSha = variablesSha(this.store);
    mkdirSync(this.dir, { recursive: true });
    atomicWrite(`${this.dir}/journal.json`, JSON.stringify(this.journal, null, 2));
    writeSummary(this.dir, this.journal);
    pruneJournals(this.store);
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
  if (!validId(importId))
    throw new ApsError('ValidationError', `"${String(importId).slice(0, 40)}" is not an import id`, { suggestions: ['`testpion import --list` prints the imports that can be undone'] });
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
  // Each list kept in one file is read once, gets all its items taken back, and is saved once (an import of 2,500 saved items
  // used to read and write the whole file 2,500 times on Undo).
  const lists = new Map<string, { items: Array<{ id: string }>; save: (items: any[]) => void }>();
  const listFor = (it: JournalListItem) => {
    const key = it.file === 'library' ? `library:${it.library}` : it.file;
    let l = lists.get(key);
    if (!l) {
      if (it.file === 'mcp-servers') l = { items: store.getMcpServers(), save: (items) => store.saveMcpServers(items) };
      else if (it.file === 'providers') l = { items: store.getProviders(), save: (items) => store.saveProviders(items) };
      else if (it.library) {
        const lib = store.getLibrary(it.library);
        const library = it.library;
        l = { items: lib.items, save: (items) => void store.saveLibrary(library, { folders: lib.folders, items }) };
      } else return undefined;
      lists.set(key, l);
    }
    return l;
  };
  for (const it of [...j.items].reverse()) {
    const l = listFor(it);
    if (!l) continue;
    const at = l.items.findIndex((x) => x.id === it.id);
    if (it.before === undefined) {
      if (at >= 0) {
        out.removed++;
        l.items.splice(at, 1);
      }
      continue;
    }
    out.restored++;
    if (at >= 0) l.items[at] = it.before as { id: string };
    else l.items.push(it.before as { id: string });
  }
  for (const l of lists.values()) l.save(l.items);
  if (j.workspaceVariables) {
    // on a failed import the checksum is not written yet: the variables are put back when they are what the import left
    const saved = { before: j.workspaceVariables.before, afterSha: j.workspaceVariables.afterSha || variablesSha(store) };
    if (restoreWorkspaceVariables(store, saved)) out.restored++;
    else out.keptChanged.push('the workspace variables');
  }
  const undone = { ...j, undone: new Date().toISOString() };
  atomicWrite(`${dir}/journal.json`, JSON.stringify(undone, null, 2));
  writeSummary(dir, undone);
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
      // the summary beside the journal; the journal itself for an import made before summaries were kept
      let sum: JournalSummary | undefined;
      try {
        sum = JSON.parse(readFileSync(`${dirOf(store, d)}/summary.json`, 'utf8')) as JournalSummary;
      } catch {
        sum = summaryOf(readJournal(store, d));
      }
      out.push(sum);
    } catch {
      /* a folder that is not a journal */
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}
