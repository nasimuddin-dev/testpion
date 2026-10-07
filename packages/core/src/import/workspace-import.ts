import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Collection, CollectionNode, Environment, LibraryItem } from '../model/types.js';
import { COLLECTION_ITEM_KINDS } from '../runner/collection-realtime.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { shortId, slugify } from '../util/ids.js';
import { secretKeys, type SecretStore } from '../storage/secrets.js';
import { importAny } from './importers.js';
import { scriptCompatibility, type ScriptWarning } from '../scripts/compat.js';

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
  /** Requests that got an `openapi` contract check. */
  contractChecks?: number;
  /** Script APIs the sandbox doesn't provide (cheerio, pm.vault …): these requests need a change to run. */
  scriptWarnings?: ScriptWarning[];
  /** What did not come over (an .http file's response handler in a file, a {{$dotenv}} reference …). */
  notes?: string[];
  /** gRPC calls and connections restored from a TestPion collection file, by kind. */
  savedItems?: Record<string, number>;
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

function restoreSavedItems(store: WorkspaceStore, saved: unknown, collectionId: string): Record<string, number> | undefined {
  if (!saved || typeof saved !== 'object') return undefined;
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
      added.push({ id, name: it.name, folder: typeof it.folder === 'string' ? it.folder : undefined, collectionId, data: it.data, updatedAt: new Date().toISOString() });
    }
    if (!added.length) continue;
    store.saveLibrary(kind, { folders: lib.folders, items: [...lib.items, ...added] });
    counts[kind] = added.length;
  }
  return Object.keys(counts).length ? counts : undefined;
}

/**
 * Import an API definition, collection, environment or HAR file into a workspace (the app's Import,
 * `testpion import`). An OpenAPI / Swagger document is also kept in `specs/`, and every request made
 * from it gets an `openapi` check, so the new collection tests its own contract.
 */
export function importIntoWorkspace(store: WorkspaceStore, text: string, opts: { contractChecks?: boolean; name?: string; secrets?: SecretStore } = {}): WorkspaceImportResult {
  const r = importAny(text, { name: opts.name });
  const out: WorkspaceImportResult = { format: r.format };
  let collection = r.collection;
  if (collection && (r.format === 'openapi' || r.format === 'swagger')) {
    const ext = text.trimStart().startsWith('{') ? 'json' : 'yaml';
    const rel = `specs/${slugify(collection.name) || 'api'}.${r.format}.${ext}`;
    const file = store.safePath(rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    out.specPath = rel;
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
  if (collection && r.format === 'asyncapi') {
    const ext = text.trimStart().startsWith('{') ? 'json' : 'yaml';
    const rel = `specs/asyncapi/${slugify(collection.name) || 'events'}.${ext}`;
    const file = store.safePath(rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    out.specPath = rel;
  }
  if (collection) {
    // an import never replaces a collection the workspace already has (a file exported from it, imported again)
    const ids = new Set(store.listCollections().map((c) => c.id));
    if (ids.has(collection.id) || ids.has(slugify(collection.id))) collection = { ...collection, id: `${slugify(collection.name) || 'collection'}-${shortId().slice(-4)}` };
    out.collection = store.saveCollection(collection);
    // a TestPion collection file (or an Insomnia export) can carry the collection's gRPC calls and connections
    const saved = r.format === 'aps-collection' ? savedItemsOf(text) : r.savedItems;
    if (saved) out.savedItems = restoreSavedItems(store, saved, out.collection.id);
    const warnings = scriptCompatibility(collection, (name) => store.readScriptPackage(name) !== undefined);
    if (warnings.length) out.scriptWarnings = warnings;
    if (r.notes?.length) out.notes = r.notes;
  }
  // an import never replaces an environment the workspace already has: a clash gets a new id and name
  const envs = (r.environments ?? (r.environment ? [r.environment] : [])).map((e) => {
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
    // secret values (from a .env file) go to the secret store; without one they are reported, never written
    const values = r.secretValues?.[originalId ?? e.id] ?? {};
    for (const [k, v] of Object.entries(values)) {
      if (opts.secrets) void opts.secrets.set(secretKeys.envVar(e.id, k), v);
      else (out.secretsToSet ??= []).push(`${e.name} › ${k}`);
    }
  }
  if (envs.length) {
    out.environment = envs[0];
    out.environments = envs;
  }
  return out;
}
