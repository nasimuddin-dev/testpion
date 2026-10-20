import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkspaceStore } from '../storage/workspace.js';
import { atomicWrite } from '../storage/fsutil.js';
import { shortId } from '../util/ids.js';
import { ApsError } from '../errors.js';
import { removeItem } from '../kinds/ops.js';
import { findingFromNote, newDocument } from './model.js';
import { buildReport, type ImportReport } from './report.js';
import type { WorkspaceImportResult } from './workspace-import.js';

/**
 * What an import created, so it can be taken back (the app's Undo after an import, `testpion import-undo`) and its report
 * opened again. Both are kept per computer in `.local/import-reports/<id>.json` (git ignores `.local`).
 * Undo moves the collections, environments and API definitions to Recently deleted (`removeItem`: restorable), and
 * removes the flow files and library items the import wrote; it refuses while an imported collection or flow was edited since.
 */

export interface Created {
  collections: Array<{ id: string; name: string; version: number }>;
  environments: Array<{ id: string; name: string }>;
  /** Paths relative to the workspace (specs/…). */
  specs: string[];
  flows: Array<{ path: string; hash: string }>;
  library: Array<{ kind: string; ids: string[] }>;
  /** Secret values written to the secret store (kept there on undo: a restored environment still has them). */
  secrets: Array<{ environment: string; key: string }>;
}

export interface ImportReceipt extends Created {
  id: string;
  at: string;
  format: string;
}

const dir = (store: WorkspaceStore) => join(store.root, '.local', 'import-reports');
const KEEP = 30;

const hashOf = (text: string) => createHash('sha1').update(text).digest('hex');

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
    // (ids are random: the oldest are found by their time)
    const files = stored(store);
    for (const old of files.slice(KEEP)) rmSync(join(dir(store), `${old.receipt.id}.json`), { force: true });
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

/** Every stored import, newest first. */
function stored(store: WorkspaceStore): Array<{ receipt: ImportReceipt; report: ImportReport }> {
  if (!existsSync(dir(store))) return [];
  return readdirSync(dir(store))
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      try {
        return [JSON.parse(readFileSync(join(dir(store), f), 'utf8')) as { receipt: ImportReceipt; report: ImportReport }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.receipt.at.localeCompare(a.receipt.at));
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
  return stored(store).map(({ receipt, report }) => ({ id: receipt.id, at: receipt.at, format: receipt.format, collections: receipt.collections.map((c) => c.name), environments: receipt.environments.map((e) => e.name), summary: report.summary }));
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
export function undoImportReceipt(store: WorkspaceStore, id: string, opts: { force?: boolean } = {}): UndoResult {
  const { receipt } = readImportReport(store, id);
  const refused: string[] = [];
  if (!opts.force) {
    for (const c of receipt.collections) {
      const now = store.listCollections().find((x) => x.id === c.id);
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
  for (const c of receipt.collections) trash({ kind: 'collection', collectionId: c.id }, 'collection', c.name);
  for (const e of receipt.environments) trash({ kind: 'environment', environmentId: e.id }, 'environment', e.name);
  for (const p of receipt.specs) if (existsSync(store.safePath(p))) trash({ kind: 'spec', path: p }, 'spec', p);
  for (const f of receipt.flows) {
    if (!existsSync(store.safePath(f.path))) continue;
    rmSync(store.safePath(f.path), { force: true });
    removed.push(f.path);
  }
  for (const l of receipt.library) {
    const lib = store.getLibrary(l.kind);
    const keep = lib.items.filter((i) => !l.ids.includes(i.id));
    if (keep.length !== lib.items.length) {
      store.saveLibrary(l.kind, { folders: lib.folders, items: keep });
      removed.push(`${l.ids.length} ${l.kind} item${l.ids.length === 1 ? '' : 's'}`);
    }
  }
  rmSync(join(dir(store), `${id}.json`), { force: true });
  return { id, trashed, removed };
}
