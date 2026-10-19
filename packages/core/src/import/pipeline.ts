import type { Collection, CollectionNode, Environment } from '../model/types.js';
import { collectNodeIds, ensureUniqueIds } from '../storage/node-ids.js';
import type { ArazzoFlowFile } from './arazzo.js';
import type { ImportScriptsMode, ImportScriptsSummary } from './import-scripts.js';
import { convertDocumentScripts } from './script-pass.js';
import type { ImportDocument } from './model.js';

/**
 * The part of an import every format shares, after its parser: scripts in `tp.*`, node ids unique (against the
 * workspace's other collections and within the file), findings on their items. Pure: nothing is written.
 */
export function finishDocument(doc: ImportDocument, opts: { scripts?: ImportScriptsMode; takenIds?: Iterable<string> } = {}): ImportDocument {
  convertDocumentScripts(doc, opts.scripts);
  // a finding that names an item by its name alone gets the item's path when exactly one item has that name
  const paths = new Map<string, string[] | null>();
  const index = (nodes: CollectionNode[], path: string[]) => {
    for (const n of nodes) {
      const p = [...path, n.name];
      paths.set(n.name, paths.has(n.name) ? null : p);
      if (n.kind === 'folder') index(n.items, p);
    }
  };
  for (const c of doc.collections) index(c.items, []);
  for (const f of doc.findings) if (f.where.length === 1) f.where = paths.get(f.where[0]!) ?? f.where;

  // node ids never repeat across the workspace's collections: colliding ones are renamed (with a note)
  const taken = new Set(opts.takenIds ?? []);
  let renamed = 0;
  doc.collections = doc.collections.map((c) => {
    const r = ensureUniqueIds(c, taken);
    renamed += r.renamed.size;
    for (const id of collectNodeIds(r.collection.items)) taken.add(id);
    return r.collection;
  });
  if (renamed)
    doc.findings.push({ code: 'IDS_RENAMED', severity: 'info', where: [], message: `${renamed} request and folder id${renamed === 1 ? ' was' : 's were'} renamed because another collection of the workspace (or the file itself) uses them` });
  return doc;
}

/** What `importAny` returns (its shape predates the import document: the CLI, the app, MCP and the tests read it). */
export interface ImportAnyResult {
  format: string;
  collection?: Collection;
  environment?: Environment;
  environments?: Environment[];
  secretValues?: Record<string, Record<string, string>>;
  savedItems?: unknown;
  /** Everything that did not map one to one (unsupported auth, template tags, script APIs, values needed …), naming the item. */
  notes?: string[];
  scripts?: ImportScriptsSummary;
  flows?: ArazzoFlowFile[];
  /** A schema or definition to keep in the workspace (a GraphQL SDL: specs/graphql/<name>.graphql), relative to the workspace. */
  specFile?: { path: string; text: string };
  /** Every collection of the file (an archive of a Postman account holds many); `collection` is the first. */
  collections?: Collection[];
}

/** The document as the result `importAny` has always returned. */
export function legacyResult(doc: ImportDocument): ImportAnyResult {
  const notes = doc.findings.filter((f) => !f.reportOnly).map((f) => f.message);
  return {
    format: doc.format,
    ...(doc.collections.length ? { collection: doc.collections[0] } : {}),
    ...(doc.collections.length > 1 ? { collections: doc.collections } : {}),
    ...(doc.environments.length ? { environment: doc.environments[0], environments: doc.environments } : {}),
    ...(doc.secretValues ? { secretValues: doc.secretValues } : {}),
    ...(doc.savedItems ? { savedItems: doc.savedItems } : {}),
    ...(notes.length ? { notes } : {}),
    ...(doc.scripts ? { scripts: doc.scripts } : {}),
    ...(doc.flows ? { flows: doc.flows } : {}),
    ...(doc.specFile ? { specFile: doc.specFile } : {}),
  };
}
