import { withCollectionListing } from './listing-cache.js';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Collection, CollectionNode, Environment, LibraryItem } from '../model/types.js';
import { COLLECTION_ITEM_KINDS } from '../runner/collection-realtime.js';
import { collectionFolders, folderByPath, placeCollectionCalls } from '../storage/collection-calls.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { shortId, slugify } from '../util/ids.js';
import { ApsError } from '../errors.js';
import { secretKeys, type SecretStore } from '../storage/secrets.js';
import { detectFormat, importDocument } from './importers.js';
import { legacyResult } from './pipeline.js';
import type { ImportReport } from './report.js';
import { withReceipt, type Created, type ImportReceipt } from './import-receipt.js';
import { importArazzo, resolveArazzoSourcesLocally } from './arazzo.js';
import { scriptCompatibility, type ScriptWarning } from '../scripts/compat.js';
import type { ImportScriptsMode, ImportScriptsSummary } from './import-scripts.js';
import { atomicWrite, renameOwned } from '../storage/fsutil.js';
import { trashSpec } from '../storage/trash.js';
import { workspaceNodeIds } from '../storage/node-ids.js';
import { applyReimport, recordProvenance, type ReimportAction, type ReimportPlan } from './reimport.js';
import { importGlobalsAndCookies } from './globals-cookies.js';
import type { StoredCookie } from '../cookies/cookie-jar.js';

export interface WorkspaceImportResult {
  format: string;
  collection?: Collection;
  environment?: Environment;
  /** Every environment the file had (Insomnia and Bruno exports can hold several). */
  environments?: Environment[];
  /** Secret variables whose values could not be stored (no secret store): set them in the app or as TESTPION_SECRET_* variables. */
  secretsToSet?: string[];
  /** OpenAPI / Swagger imports: where the document was kept (relative to the workspace). */
  specPath?: string;
  /** Keep both (the default): a different document already had the path, so this one was saved beside it (`specPath`); `existing` is untouched. */
  specKeptBoth?: { existing: string };
  /** `specs: 'replace'`: the document that had the path went to Recently deleted (`trashId` restores it). */
  specReplaced?: { path: string; trashId: string };
  /** Requests that got an `openapi` contract check. */
  contractChecks?: number;
  /** Script APIs the sandbox doesn't provide (cheerio, pm.vault …): these requests need a change to run. */
  scriptWarnings?: ScriptWarning[];
  /** What did not come over (an .http file's response handler in a file, a {{$dotenv}} reference …). */
  notes?: string[];
  /** Postman / Insomnia scripts: how many became `tp.*`, and which still use `pm.*` (and why). Absent for formats without such scripts. */
  scripts?: ImportScriptsSummary;
  /** gRPC calls and connections restored from a TestPion collection file, by kind. */
  savedItems?: Record<string, number>;
  /** Arazzo imports: the flow files written (one per workflow), relative to the workspace. */
  flows?: Array<{ path: string; workflowId: string; steps: number }>;
  /** The compatibility report: per item imported fully / with changes / not imported, and why (the notes above stay for compatibility). */
  report?: ImportReport;
  /** What the import created, kept so it can be undone (`undoImport`) and its report opened again (`readImportReport`). */
  receipt?: ImportReceipt;
  /** A file with several collections (an export of a Postman account): each one that was saved. */
  collections?: Array<{ id: string; name: string }>;
  /** `update`: the collections that were updated in place instead of added (replace / new / skip per item). */
  updated?: Array<{ collectionId: string; name: string; applied: { replaced: number; added: number; skipped: number }; plan: ReimportPlan['counts'] }>;
  /** Workspace globals that were set (a Postman globals file). */
  globals?: number;
  /** Cookies added to the cookie jar. */
  cookies?: number;
}

/**
 * Where an import puts what is not a workspace file: the workspace's globals and cookie jar live on this computer (the
 * app's current values and cookie store), so the host that has them lends a way in. Without one, globals become an
 * environment and cookies are reported.
 */
export interface ImportSinks {
  globals?: { set(vars: Array<{ key: string; value: string; secret?: boolean }>): void | Promise<void>; remove?(keys: string[]): void };
  cookies?: { add(cookies: StoredCookie[]): void; remove?(cookies: Array<{ name: string; domain: string; path: string }>): void };
}

/**
 * Where an import keeps the API definitions it came from (relative to the workspace): an OpenAPI / Swagger / AsyncAPI
 * document is kept as it was read, a GraphQL schema or an Insomnia design document comes with its own path.
 */
export function plannedSpecs(r: { format: string; collection?: Collection; specFile?: { path: string; text: string } }, text: string): Array<{ stem: string; suffix: string; text: string }> {
  const ext = text.trimStart().startsWith('{') ? 'json' : 'yaml';
  const out: Array<{ stem: string; suffix: string; text: string }> = [];
  if (r.collection && (r.format === 'openapi' || r.format === 'swagger')) out.push({ stem: `specs/${slugify(r.collection.name) || 'api'}`, suffix: `.${r.format}.${ext}`, text });
  if (r.collection && r.format === 'asyncapi') out.push({ stem: `specs/asyncapi/${slugify(r.collection.name) || 'events'}`, suffix: `.${ext}`, text });
  const m = r.specFile ? /^(.*?)(\.openapi\.(?:json|yaml)|\.graphql)$/.exec(r.specFile.path) : null;
  if (r.specFile && m) out.push({ stem: m[1]!, suffix: m[2]!, text: r.specFile.text });
  return out;
}

/**
 * An Arazzo document's workflows as flow files under tests/arazzo/ (never replacing a file: a clash gets -2, -3 …).
 * Its OpenAPI sources are looked up in the workspace (and `baseDir`, the Arazzo file's folder); `sources` gives
 * documents the caller already has (fetched with permission).
 */
export function importArazzoIntoWorkspace(store: WorkspaceStore, text: string, opts: { baseDir?: string; sources?: Record<string, string> } = {}): WorkspaceImportResult {
  const local = resolveArazzoSourcesLocally(text, { workspace: store.root, baseDir: opts.baseDir }).sources;
  const r = importArazzo(text, { sources: { ...local, ...(opts.sources ?? {}) } });
  const flows: NonNullable<WorkspaceImportResult['flows']> = [];
  for (const f of r.flows) {
    let rel = f.path;
    for (let i = 2; existsSync(store.safePath(rel)); i++) rel = f.path.replace(/\.yaml$/, `-${i}.yaml`);
    const file = store.safePath(rel);
    mkdirSync(dirname(file), { recursive: true });
    atomicWrite(file, f.text);
    flows.push({ path: rel, workflowId: f.workflowId, steps: f.steps });
  }
  return { format: 'arazzo', flows, ...(r.notes.length ? { notes: r.notes } : {}) };
}

/**
 * Put a collection file's `savedItems` (gRPC calls, connections) into the workspace library, shown in the
 * imported collection. An item whose id the workspace already uses gets a new one, so nothing is replaced.
 */
function savedItemsOf(text: string): unknown {
  try {
    return (JSON.parse(text) as { savedItems?: unknown }).savedItems;
  } catch {
    return undefined;
  }
}

/** The folders of a TestPion collection file as it was exported, by the ids they have in the file. */
function sourceFoldersOf(text: string): ReturnType<typeof collectionFolders> | undefined {
  try {
    const items = (JSON.parse(text) as { items?: unknown }).items;
    return Array.isArray(items) ? collectionFolders({ items: items as CollectionNode[] }) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `collection`: the imported collection as it was saved. A call keeps its folder: by `folderId` when the collection has
 * that folder, else (its folders got new ids on the way in) the folder with the same path of names as in the file
 * (`sourceFolders`), else by its folder text, which `placeCollectionCalls` turns into a folder afterwards.
 */
function restoreSavedItems(store: WorkspaceStore, saved: unknown, collection: Collection, made?: Created['library'], sourceFolders?: ReturnType<typeof collectionFolders>): Record<string, number> | undefined {
  if (!saved || typeof saved !== 'object') return undefined;
  const collectionId = collection.id;
  const folderIds = new Set(collectionFolders(collection).keys());
  const folderIdOf = (it: LibraryItem): string | undefined => {
    if (typeof it.folderId !== 'string') return undefined;
    if (folderIds.has(it.folderId)) return it.folderId;
    const path = sourceFolders?.get(it.folderId)?.path;
    return path ? folderByPath(collection, path)?.id : undefined;
  };
  const counts: Record<string, number> = {};
  for (const kind of COLLECTION_ITEM_KINDS) {
    const items = (saved as Record<string, unknown>)[kind];
    if (!Array.isArray(items) || !items.length) continue;
    const lib = store.getLibrary(kind);
    const taken = new Set(lib.items.map((i) => i.id));
    const added: LibraryItem[] = [];
    for (const raw of items) {
      if (!raw || typeof raw !== 'object' || typeof (raw as LibraryItem).name !== 'string' || !(raw as LibraryItem).data) continue;
      const it = raw as LibraryItem;
      const id = it.id && !taken.has(it.id) ? it.id : shortId('lib-');
      taken.add(id);
      const folderId = folderIdOf(it);
      // (the folder text is kept only for a call that has no folder yet: it is what places it)
      added.push({ id, name: it.name, ...(folderId ? { folderId } : typeof it.folder === 'string' ? { folder: it.folder } : {}), collectionId, ...(typeof it.after === 'string' ? { after: it.after } : {}), data: it.data, updatedAt: new Date().toISOString() });
    }
    if (!added.length) continue;
    store.saveLibrary(kind, { folders: lib.folders, items: [...lib.items, ...added] });
    counts[kind] = added.length;
    made?.push({ kind, ids: added.map((i) => i.id) });
  }
  return Object.keys(counts).length ? counts : undefined;
}

/**
 * Import an API definition, collection, environment or HAR file into a workspace (the app's Import,
 * `testpion import`). An OpenAPI / Swagger document is also kept in `specs/`, and every request made
 * from it gets an `openapi` check, so the new collection tests its own contract.
 * The result carries the compatibility `report` and a `receipt` of what was created (`undoImport` takes it back).
 */
export function importIntoWorkspace(
  realStore: WorkspaceStore,
  text: string,
  /** `scripts: 'keep'` leaves Postman's `pm.*` in imported scripts; the default rewrites them to `tp.*`. */
  /** `specs`: an API definition whose path holds a different document is kept beside it (`keep-both`, the default: x-2.yaml) or replaces it (the old one goes to the trash). */
  opts: {
    contractChecks?: boolean;
    name?: string;
    secrets?: SecretStore;
    scripts?: ImportScriptsMode;
    arazzo?: { baseDir?: string; sources?: Record<string, string> };
    specs?: SpecConflict;
    /** Simple tests (`pm.test` of a status, a header, a JSON field …) become assertions. */
    liftTests?: boolean;
    /** Re-import: update the collection that came from the same source (item by item: replace / new / skip) instead of adding another. */
    update?: boolean | { decisions?: Record<string, ReimportAction> };
    sinks?: ImportSinks;
  } = {},
): WorkspaceImportResult {
  // the collections of the workspace are read once for this import (its node ids, its taken ids, an update's target)
  const store = withCollectionListing(realStore);
  if (detectFormat(text) === 'arazzo') return withReceipt(store, importArazzoIntoWorkspace(store, text, opts.arazzo), text);
  // node ids never repeat across the workspace's collections: colliding ones are renamed (with a note)
  const { document, report } = importDocument(text, { name: opts.name, scripts: opts.scripts, takenIds: workspaceNodeIds(store.listCollections()), liftTests: opts.liftTests });
  const r = legacyResult(document, { globalsAsEnvironment: false });
  const out: WorkspaceImportResult = { format: r.format, ...(r.scripts ? { scripts: r.scripts } : {}), report };
  const made: Created = { collections: [], environments: [], specs: [], flows: [], library: [], secrets: [], updated: [], envUpdated: [], globals: [], cookies: [] };
  const taken = new Set(store.listCollections().map((c) => c.id));
  // gRPC calls and connections that name a collection the workspace does not have (a collection in Recently deleted,
  // deleted by an older version, left its calls in the library): a new collection with that id would show them as its own
  for (const kind of COLLECTION_ITEM_KINDS)
    try {
      for (const i of store.getLibrary(kind).items) if (i.collectionId) taken.add(i.collectionId);
    } catch {
      /* an unreadable library: nothing of it is known */
    }
  const saveOne = (c: Collection): Collection => {
    // a re-import of the same source updates the collection that came from it, item by item
    if (opts.update) {
      const u = applyReimport(store, document, c, typeof opts.update === 'object' ? opts.update.decisions : {});
      if (u) {
        made.updated!.push({ id: u.collection.id, name: u.collection.name, version: u.collection.version, before: u.before });
        (out.updated ??= []).push({ collectionId: u.collection.id, name: u.collection.name, applied: u.applied, plan: u.plan.counts });
        return u.collection;
      }
    }
    // an import never replaces a collection the workspace already has (a file exported from it, imported again)
    const clash = taken.has(c.id) || taken.has(slugify(c.id));
    const saved = store.saveCollection(clash ? { ...c, id: `${slugify(c.name) || 'collection'}-${shortId().slice(-4)}` } : c);
    taken.add(saved.id);
    made.collections.push({ id: saved.id, name: saved.name, version: saved.version });
    recordProvenance(store, document, c, saved);
    return saved;
  };
  let collection = r.collection;
  const specs = plannedSpecs(r, text);
  if (collection && (r.format === 'openapi' || r.format === 'swagger')) {
    const rel = keepSpec(store, specs[0]!.stem, specs[0]!.suffix, text, opts.specs, out, made);
    if (opts.contractChecks !== false) {
      let added = 0;
      const withCheck = (nodes: CollectionNode[]): CollectionNode[] =>
        nodes.map((n) => {
          if (n.kind === 'folder') return { ...n, items: withCheck(n.items) };
          if (n.kind !== 'http' || n.assertions?.some((a) => a.type === 'openapi')) return n;
          added++;
          return { ...n, assertions: [...(n.assertions ?? []), { type: 'openapi', spec: rel }] };
        });
      collection = { ...collection, items: withCheck(collection.items) };
      out.contractChecks = added;
    }
  }
  // an AsyncAPI document is kept for the asyncapi check and tests-from-spec (in specs/asyncapi/, apart from the OpenAPI ones)
  if (collection && r.format === 'asyncapi') keepSpec(store, specs[0]!.stem, specs[0]!.suffix, text, opts.specs, out, made);
  // a GraphQL schema (SDL) or a design document is kept in specs/ (graphql: specs/graphql/<name>.graphql)
  if (r.specFile) keepSpec(store, specs.at(-1)!.stem, specs.at(-1)!.suffix, r.specFile.text, opts.specs, out, made);
  if (collection) {
    out.collection = saveOne(collection);
    // a TestPion collection file (or an Insomnia export) can carry the collection's gRPC calls and connections
    const saved = r.format === 'aps-collection' ? savedItemsOf(text) : r.savedItems;
    if (saved) out.savedItems = restoreSavedItems(store, saved, out.collection, made.library, r.format === 'aps-collection' ? sourceFoldersOf(text) : undefined);
    // any kind of request in any folder: calls that came with a folder path (Insomnia, Bruno, an older export) go into that
    // folder of the imported collection (only its calls: the rest of the workspace is not this import's to change)
    if (out.savedItems && placeCollectionCalls(store, { collectionId: out.collection.id })) {
      // folders made for them saved the collection once more: the receipt keeps the version it has now (Undo compares
      // with it and would refuse with "was edited after the import"), and the caller gets the collection as it is
      const placed = store.getCollection(out.collection.id);
      for (const m of [...made.collections, ...(made.updated ?? [])]) if (m.id === placed.id) m.version = placed.version;
      out.collection = placed;
    }
    const warnings = scriptCompatibility(collection, (name) => store.readScriptPackage(name) !== undefined);
    if (warnings.length) out.scriptWarnings = warnings;
    if (r.notes?.length) out.notes = [...r.notes, ...(out.notes ?? [])];
  }
  // more collections in the file (an export of a Postman account): each is saved as its own
  if (r.collections && r.collections.length > 1) {
    out.collections = [out.collection!, ...r.collections.slice(1).map(saveOne)].map((c) => ({ id: c.id, name: c.name }));
  } else if (!collection && r.notes?.length) out.notes = [...r.notes, ...(out.notes ?? [])];
  // an import never replaces an environment the workspace already has: a clash gets a new id and name
  // (an update adds the variables an existing environment of the same name lacks, and keeps its values)
  const existingEnvs = store.listEnvironments();
  const updatedEnvs = new Set<string>();
  if (opts.update) {
    for (const e of r.environments ?? (r.environment ? [r.environment] : [])) {
      const ex = existingEnvs.find((x) => !x.problem && x.name.toLowerCase() === e.name.toLowerCase());
      if (!ex) continue;
      const have = new Set(ex.variables.map((v) => v.key));
      const add = e.variables.filter((v) => !have.has(v.key));
      updatedEnvs.add(e.id);
      if (!add.length) continue;
      const savedEnv = store.saveEnvironment({ ...ex, variables: [...ex.variables, ...add] });
      // what was added, as it was written (a secret's value is not in the file): Undo takes back exactly these, and only while they are unchanged
      const addedKeys = new Set(add.map((v) => v.key));
      made.envUpdated!.push({ id: ex.id, name: ex.name, before: JSON.parse(JSON.stringify(ex)) as Environment, added: savedEnv.variables.filter((v) => addedKeys.has(v.key)).map((v) => ({ key: v.key, value: String(v.value ?? '') })) });
      (out.notes ??= []).push(`Environment "${ex.name}": ${add.length} variable${add.length === 1 ? '' : 's'} added (${add.map((v) => v.key).slice(0, 5).join(', ')}${add.length > 5 ? ' …' : ''}); its values are kept`);
    }
  }
  const envs = (r.environments ?? (r.environment ? [r.environment] : [])).filter((e) => !updatedEnvs.has(e.id)).map((e) => {
    const taken = store.listEnvironments();
    const clash = taken.some((x) => x.id === e.id || x.name.toLowerCase() === e.name.toLowerCase());
    if (!clash) return e;
    let name = `${e.name} (imported)`;
    for (let i = 2; taken.some((x) => x.name.toLowerCase() === name.toLowerCase()); i++) name = `${e.name} (imported ${i})`;
    return { ...e, id: `${slugify(name)}-${shortId().slice(-4)}`, name, originalId: e.id };
  });
  for (const raw of envs) {
    const { originalId, ...e } = raw as Environment & { originalId?: string };
    store.saveEnvironment(e);
    made.environments.push({ id: e.id, name: e.name });
    // secret values (from a .env file) go to the secret store; without one they are reported, never written
    const values = r.secretValues?.[originalId ?? e.id] ?? {};
    for (const [k, v] of Object.entries(values)) {
      if (opts.secrets) {
        void opts.secrets.set(secretKeys.envVar(e.id, k), v);
        made.secrets.push({ environment: e.id, key: k });
      } else (out.secretsToSet ??= []).push(`${e.name} › ${k}`);
    }
  }
  if (envs.length) {
    out.environment = envs[0];
    out.environments = envs;
  }
  importGlobalsAndCookies(store, document, opts.sinks, out, made);
  return withReceipt(store, out, text, made);
}

/** What an import does when an API definition's path already holds a different document. */
export type SpecConflict = 'keep-both' | 'replace';

/**
 * EX-G3: keep an imported API definition at `<stem><suffix>` without ever overwriting another document. The same text
 * there already is reused; a different one is kept and the import goes to `<stem>-2<suffix>` (-3 …), unless `replace`:
 * then the old document goes to Recently deleted (undoable) first. Notes say which happened.
 * `made` (the receipt) gets the path only when this import wrote the file: a document that was there already (the same
 * text, kept by an earlier import whose contract checks name it) is not this import's to take back. A replaced
 * document's trash entry is kept there too, so Undo puts it back.
 */
function keepSpec(store: WorkspaceStore, stem: string, suffix: string, text: string, mode: SpecConflict = 'keep-both', out: WorkspaceImportResult, made?: Created): string {
  const wanted = `${stem}${suffix}`;
  const same = (rel: string) => {
    try {
      return readFileSync(store.safePath(rel), 'utf8') === text;
    } catch {
      return false;
    }
  };
  let rel = wanted;
  if (existsSync(store.safePath(wanted)) && !same(wanted)) {
    if (mode === 'replace') {
      out.specReplaced = { path: wanted, trashId: trashSpec(store, wanted) };
      (made && (made.specsReplaced ??= []))?.push(out.specReplaced);
      (out.notes ??= []).push(`Replaced ${wanted}; the earlier document is in Recently deleted (restorable for 30 days).`);
    } else {
      for (let i = 2; existsSync(store.safePath(rel)) && !same(rel); i++) rel = `${stem}-${i}${suffix}`;
      if (rel !== wanted) {
        out.specKeptBoth = { existing: wanted };
        (out.notes ??= []).push(`Saved as ${rel}: ${wanted} holds a different document and was kept. Replace instead to use this one there (the earlier one goes to Recently deleted).`);
      }
    }
  }
  if (!same(rel)) {
    const file = store.safePath(rel);
    mkdirSync(dirname(file), { recursive: true });
    atomicWrite(file, text);
    if (made && !made.specs.includes(rel)) made.specs.push(rel);
  }
  out.specPath = rel;
  return rel;
}

/**
 * "Replace instead" after Keep both: the document saved as `kept` (specs/x-2.yaml) takes the place of `original`
 * (specs/x.yaml), which goes to Recently deleted; the contract checks of `collectionId` that named `kept` name `original`.
 */
export function replaceSpecWithImported(store: WorkspaceStore, o: { kept: string; original: string; collectionId?: string }): { specPath: string; trashId?: string; contractChecks: number } {
  const kept = store.safePath(o.kept);
  const original = store.safePath(o.original);
  if (!store.isInside(kept, 'specs') || !store.isInside(original, 'specs')) throw new ApsError('ValidationError', 'Both paths must be API definitions in specs/', { suggestions: [] });
  if (!existsSync(kept)) throw new ApsError('ConfigurationError', `No API definition ${o.kept}`, { suggestions: [] });
  const trashId = existsSync(original) ? trashSpec(store, o.original) : undefined;
  renameOwned(kept, original);
  let contractChecks = 0;
  const c = o.collectionId ? store.listCollections().find((x) => x.id === o.collectionId && !x.problem) : undefined;
  if (c) {
    const fix = (nodes: CollectionNode[]): CollectionNode[] =>
      nodes.map((n) => {
        if (n.kind === 'folder') return { ...n, items: fix(n.items) };
        if (!n.assertions?.some((a) => (a as { spec?: string }).spec === o.kept)) return n;
        contractChecks++;
        return { ...n, assertions: n.assertions.map((a) => ((a as { spec?: string }).spec === o.kept ? { ...a, spec: o.original } : a)) } as CollectionNode;
      });
    const items = fix(c.items);
    if (contractChecks) store.saveCollection({ ...c, items });
  }
  return { specPath: o.original, trashId, contractChecks };
}
