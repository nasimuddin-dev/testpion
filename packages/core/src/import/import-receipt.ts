import { sha1Hex } from '../util/hash.js';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Collection, Environment } from '../model/types.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { atomicWrite } from '../storage/fsutil.js';
import { shortId } from '../util/ids.js';
import { ApsError } from '../errors.js';
import { removeItem } from '../kinds/ops.js';
import { restoreFromTrash } from '../storage/trash.js';
import { findingFromNote, newDocument } from './model.js';
import { buildReport, type ImportReport } from './report.js';
import type { ImportSinks, WorkspaceImportResult } from './workspace-import.js';

/**
 * What an import created, so it can be taken back (the app's Undo after an import, `testpion import-undo`) and its report
 * opened again. Both are kept per computer in `.local/import-reports/<id>.json` (git ignores `.local`).
 * Undo moves the collections, environments and API definitions the import wrote to Recently deleted (`removeItem`:
 * restorable) and removes the flow files; it refuses while an imported collection or flow was edited since. An imported
 * collection's gRPC calls and connections go to Recently deleted with it (in its trash entry: restoring the collection
 * brings them back); only calls the import added to a collection that stays (a re-import) are removed from the library.
 * An API definition the import replaced comes back from Recently deleted; one it found there already is left alone.
 */

export interface Created {
  collections: Array<{ id: string; name: string; version: number }>;
  environments: Array<{ id: string; name: string }>;
  /** Paths relative to the workspace (specs/…): the API definitions this import wrote (not one that was there already with the same text). */
  specs: string[];
  /** `specs: 'replace'`: the documents that had the path before, now in Recently deleted. Undo puts them back. */
  specsReplaced?: Array<{ path: string; trashId: string }>;
  flows: Array<{ path: string; hash: string }>;
  library: Array<{ kind: string; ids: string[] }>;
  /** Secret values written to the secret store (kept there on undo: a restored environment still has them). */
  secrets: Array<{ environment: string; key: string }>;
  /** Collections an import updated in place (re-import): the collection as it was, and the version the update saved. Undo puts it back. */
  updated?: Array<{ id: string; name: string; version: number; before: Collection }>;
  /**
   * Environments an import added variables to (re-import): the environment as it was, and the variables added as they
   * were written (`added`; absent in a receipt of an older version). Undo removes those that are still as written.
   */
  envUpdated?: Array<{ id: string; name: string; before: Environment; added?: Array<{ key: string; value: string }> }>;
  /** Names of the workspace globals the import set (a Postman globals file). */
  globals?: string[];
  /** Cookies the import added to the cookie jar (Insomnia's jar). */
  cookies?: Array<{ name: string; domain: string; path: string }>;
}

export interface ImportReceipt extends Created {
  id: string;
  at: string;
  format: string;
}

const dir = (store: WorkspaceStore) => join(store.root, '.local', 'import-reports');
const KEEP = 30;
const INDEX_FILE = 'index.json';

/** What the list of imports shows of one: kept in `index.json`, so listing them never reads a receipt (each can hold whole collections). */
interface IndexEntry {
  id: string;
  at: string;
  format: string;
  collections: string[];
  environments: string[];
  summary: ImportReport['summary'];
}
const entryOf = (receipt: ImportReceipt, report: ImportReport): IndexEntry => ({
  id: receipt.id,
  at: receipt.at,
  format: receipt.format,
  collections: receipt.collections.map((c) => c.name),
  environments: receipt.environments.map((e) => e.name),
  summary: report.summary,
});

/**
 * The index of the stored imports, newest first, matched against the files: an import whose file is gone is dropped, and a
 * file the index does not know (an older version's, or one copied in) is read once and added. `skip` is an import just written
 * whose entry the caller adds itself. Otherwise no receipt is read.
 */
function readIndex(store: WorkspaceStore, skip?: string): IndexEntry[] {
  if (!existsSync(dir(store))) return [];
  const ids = new Set(readdirSync(dir(store)).filter((f) => f.endsWith('.json') && f !== INDEX_FILE).map((f) => f.slice(0, -'.json'.length)));
  let entries: IndexEntry[] = [];
  try {
    const raw = JSON.parse(readFileSync(join(dir(store), INDEX_FILE), 'utf8')) as { receipts?: IndexEntry[] };
    entries = Array.isArray(raw.receipts) ? raw.receipts : [];
  } catch {
    /* no index yet (or a damaged one): made from the files below */
  }
  const before = entries.length;
  entries = entries.filter((e) => ids.has(e.id));
  let changed = entries.length !== before;
  const known = new Set(entries.map((e) => e.id));
  for (const id of ids) {
    if (known.has(id) || id === skip) continue;
    try {
      const { receipt, report } = JSON.parse(readFileSync(join(dir(store), `${id}.json`), 'utf8')) as { receipt: ImportReceipt; report: ImportReport };
      entries.push(entryOf(receipt, report));
      changed = true;
    } catch {
      /* not a receipt */
    }
  }
  entries.sort((a, b) => b.at.localeCompare(a.at));
  if (changed && skip === undefined) writeIndex(store, entries);
  return entries;
}

function writeIndex(store: WorkspaceStore, entries: IndexEntry[]): void {
  try {
    atomicWrite(join(dir(store), INDEX_FILE), JSON.stringify({ receipts: entries }));
  } catch {
    /* read-only disk: the next listing makes it again */
  }
}

const hashOf = sha1Hex;

/** The result with its receipt (written to `.local/import-reports/`) and a report (built from the notes for formats that have no document, like Arazzo). */
export function withReceipt(store: WorkspaceStore, out: WorkspaceImportResult, text: string, made?: Created): WorkspaceImportResult {
  const created: Created = made ?? { collections: [], environments: [], specs: [], flows: [], library: [], secrets: [] };
  if (!made)
    created.flows = (out.flows ?? []).map((f) => ({ path: f.path, hash: safeHash(store, f.path) }));
  const receipt: ImportReceipt = { id: shortId('imp-'), at: new Date().toISOString(), format: out.format, ...created };
  const report: ImportReport =
    out.report ?? buildReport(newDocument(out.format, text, { findings: (out.notes ?? []).map((n) => findingFromNote(n)), flows: (out.flows ?? []) as never }));
  // the files of flows are hashed after they were written
  receipt.flows = receipt.flows.map((f) => ({ path: f.path, hash: f.hash || safeHash(store, f.path) }));
  try {
    mkdirSync(dir(store), { recursive: true });
    atomicWrite(join(dir(store), `${receipt.id}.json`), JSON.stringify({ receipt, report }));
    // the newest KEEP are kept (ids are random: the oldest are found by their time, from the index, not from the receipts)
    const entries = [entryOf(receipt, report), ...readIndex(store, receipt.id)].sort((a, b) => b.at.localeCompare(a.at));
    for (const old of entries.slice(KEEP)) rmSync(join(dir(store), `${old.id}.json`), { force: true });
    writeIndex(store, entries.slice(0, KEEP));
  } catch {
    /* a workspace on a read-only disk still imports; it just cannot be undone */
  }
  return { ...out, report, receipt };
}

function safeHash(store: WorkspaceStore, rel: string): string {
  try {
    return hashOf(readFileSync(store.safePath(rel), 'utf8'));
  } catch {
    return '';
  }
}

/** A stored import: its receipt and report. */
export function readImportReport(store: WorkspaceStore, id: string): { receipt: ImportReceipt; report: ImportReport } {
  if (!/^imp-[\w-]+$/.test(id)) throw new ApsError('ValidationError', `Not an import id: ${id}`, { suggestions: ['`testpion import-report` lists the imports of the workspace.'] });
  const file = join(dir(store), `${id}.json`);
  if (!existsSync(file)) throw new ApsError('ValidationError', `No import ${id} in this workspace`, { suggestions: ['`testpion import-report` lists the imports of the workspace (the last 30 are kept).'] });
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** The imports of the workspace, newest first. */
export function listImportReceipts(store: WorkspaceStore): Array<{ id: string; at: string; format: string; collections: string[]; environments: string[]; summary: ImportReport['summary'] }> {
  return readIndex(store).map(({ id, at, format, collections, environments, summary }) => ({ id, at, format, collections, environments, summary }));
}

export interface UndoResult {
  id: string;
  /** Trash entries (`item.restore` / `testpion trash restore` puts one back). */
  trashed: Array<{ kind: string; name: string; trashId: string }>;
  /** Flow files and library items removed. */
  removed: string[];
  /** Why nothing was undone: an imported collection or flow was edited since (`force` undoes it anyway). */
  refused?: string[];
}

/** Take an import back. Nothing is changed when something was edited since, unless `force`. */
export function undoImportReceipt(store: WorkspaceStore, id: string, opts: { force?: boolean; sinks?: ImportSinks } = {}): UndoResult {
  const { receipt } = readImportReport(store, id);
  const refused: string[] = [];
  if (!opts.force) {
    // the collections are read once, not once for each collection the import made
    const live = new Map(store.listCollections().map((x) => [x.id, x]));
    for (const u of receipt.updated ?? []) {
      const now = live.get(u.id);
      if (now && now.version !== u.version) refused.push(`Collection "${u.name}" was edited after the import`);
    }
    for (const c of receipt.collections) {
      const now = live.get(c.id);
      if (now && now.version !== c.version) refused.push(`Collection "${c.name}" was edited after the import`);
    }
    for (const f of receipt.flows) if (existsSync(store.safePath(f.path)) && f.hash && safeHash(store, f.path) !== f.hash) refused.push(`Flow ${f.path} was edited after the import`);
  }
  if (refused.length) return { id, trashed: [], removed: [], refused };
  const trashed: UndoResult['trashed'] = [];
  const removed: string[] = [];
  const trash = (ref: Record<string, unknown>, kind: string, name: string) => {
    try {
      trashed.push({ kind, name, trashId: removeItem(store, ref).trashId });
    } catch {
      /* already gone (deleted by hand since) */
    }
  };
  // an update of a collection (re-import) is taken back by saving the collection as it was
  for (const u of receipt.updated ?? []) {
    try {
      store.saveCollection(u.before);
      removed.push(`the update of collection "${u.name}"`);
    } catch {
      /* gone since */
    }
  }
  // variables added to an environment are taken out one by one, and only while they are as the import wrote them: the
  // environment as it was is not saved back (that would lose every edit made to it since)
  for (const e of receipt.envUpdated ?? []) {
    try {
      if (!e.added) {
        removed.push(`(the variables added to environment "${e.name}" stay: this import was made by an older version; remove them in Environments)`);
        continue;
      }
      const now = store.listEnvironments().find((x) => x.id === e.id && !x.problem);
      if (!now) continue; // gone since
      const written = new Map(e.added.map((a) => [a.key, a.value]));
      const variables = now.variables.filter((v) => !(written.has(v.key) && String(v.value ?? '') === written.get(v.key)));
      const taken = now.variables.length - variables.length;
      if (taken) store.saveEnvironment({ ...now, variables });
      const kept = e.added.length - taken;
      if (taken) removed.push(`${taken} added variable${taken === 1 ? '' : 's'} of environment "${e.name}"`);
      if (kept) removed.push(`(${kept} variable${kept === 1 ? '' : 's'} added to environment "${e.name}" stay${kept === 1 ? 's' : ''}: changed or removed since the import)`);
    } catch {
      /* gone since */
    }
  }
  if (receipt.globals?.length) {
    if (opts.sinks?.globals?.remove) {
      opts.sinks.globals.remove(receipt.globals);
      removed.push(`${receipt.globals.length} global${receipt.globals.length === 1 ? '' : 's'}`);
    } else removed.push(`(the globals ${receipt.globals.join(', ')} stay: remove them in Globals)`);
  }
  if (receipt.cookies?.length && opts.sinks?.cookies?.remove) {
    opts.sinks.cookies.remove(receipt.cookies);
    removed.push(`${receipt.cookies.length} cookie${receipt.cookies.length === 1 ? '' : 's'}`);
  }
  for (const c of receipt.collections) trash({ kind: 'collection', collectionId: c.id }, 'collection', c.name);
  for (const e of receipt.environments) trash({ kind: 'environment', environmentId: e.id }, 'environment', e.name);
  for (const p of receipt.specs) if (existsSync(store.safePath(p))) trash({ kind: 'spec', path: p }, 'spec', p);
  // a document the import replaced goes back to its path (free again: the import's own went to the trash just above)
  for (const s of receipt.specsReplaced ?? []) {
    try {
      const back = restoreFromTrash(store, s.trashId);
      removed.push(`(${back.id} is back as it was before the import)`);
    } catch {
      /* no longer in Recently deleted (restored or purged by hand since) */
    }
  }
  for (const f of receipt.flows) {
    if (!existsSync(store.safePath(f.path))) continue;
    rmSync(store.safePath(f.path), { force: true });
    removed.push(f.path);
  }
  // the calls of a collection that went to Recently deleted above went with it (in its trash entry: they come back when
  // it is restored). What is still in the library was added to a collection that stays (a re-import): those are removed
  for (const l of receipt.library) {
    const lib = store.getLibrary(l.kind);
    const gone = new Set(l.ids);
    const keep = lib.items.filter((i) => !gone.has(i.id));
    const n = lib.items.length - keep.length;
    if (n) {
      store.saveLibrary(l.kind, { folders: lib.folders, items: keep });
      removed.push(`${n} ${l.kind} item${n === 1 ? '' : 's'}`);
    }
  }
  rmSync(join(dir(store), `${id}.json`), { force: true });
  readIndex(store); // the import is no longer there: the index drops it
  return { id, trashed, removed };
}
