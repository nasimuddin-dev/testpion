import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { readJson, writeJson, copyOwned } from './fsutil.js';
import { collectNodeIds, ensureUniqueIds, type IdNode } from './node-ids.js';
import { moveToTrash } from './trash.js';
import type { WorkspaceStore } from './workspace.js';

/**
 * New content of a workspace template (the examples that ship with the app) for a copy installed earlier: what the
 * template has gained since is added to the copy, and nothing the user has is changed, overwritten or brought back.
 *
 * Every piece of the template has a key (a file, a collection item, an environment variable, an MCP server, a
 * provider, a saved gRPC call or connection). The keys the copy was offered are kept in `.template-offered.json`:
 * a key is added once, so an example the user deleted stays deleted. JSON documents are merged by id (collections
 * recursively, by folder), any other file is copied when the copy has none. Suites and other text files that
 * exist in both are left as they are.
 */
export const OFFERED_FILE = '.template-offered.json';

/** Folders of a workspace that hold the user's results, never template content. */
const SKIP_TOP = new Set(['runs', 'traces', 'payloads', 'reports', 'baselines', 'trash', '.local']);
const SKIP_FILE = /^(database\.sqlite.*|metadata\.jsonl|\.template-offered\.json)$/;

interface Node {
  id?: string;
  kind?: string;
  items?: Node[];
}

function files(root: string, dir = root): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = relative(root, p).replace(/\\/g, '/');
    if (SKIP_TOP.has(rel.split('/')[0]!) || SKIP_FILE.test(name)) continue;
    if (statSync(p).isDirectory()) out.push(...files(root, p));
    else out.push(rel);
  }
  return out;
}

/** How each JSON document of a workspace is merged: its list of things with ids. */
function mergeKind(rel: string): 'collection' | 'environment' | 'mcp' | 'providers' | 'library' | undefined {
  if (/^collections\/[^/]+\.json$/.test(rel)) return 'collection';
  if (/^environments\/[^/]+\.json$/.test(rel)) return 'environment';
  if (rel === 'mcp-servers.json') return 'mcp';
  if (rel === 'providers.json') return 'providers';
  if (/^library\/[^/]+\.json$/.test(rel)) return 'library';
  return undefined;
}

/** Keys of everything a template offers (for a fresh copy: all of it was offered). */
export function templateKeys(templateDir: string): string[] {
  const keys: string[] = [];
  for (const rel of files(templateDir)) {
    keys.push(`file:${rel}`);
    const kind = mergeKind(rel);
    if (!kind) continue;
    const doc = readJson<Record<string, unknown>>(join(templateDir, rel));
    for (const k of docKeys(kind, rel, doc)) keys.push(k);
  }
  return keys;
}

function docKeys(kind: NonNullable<ReturnType<typeof mergeKind>>, rel: string, doc: Record<string, unknown>): string[] {
  const keys: string[] = [];
  if (kind === 'collection') {
    const walk = (nodes: Node[] = []) => {
      for (const n of nodes) {
        if (n.id) keys.push(`item:${rel}#${n.id}`);
        if (n.items) walk(n.items);
      }
    };
    walk(doc.items as Node[]);
  } else if (kind === 'environment') for (const v of (doc.variables as Array<{ key: string }>) ?? []) keys.push(`var:${rel}#${v.key}`);
  else if (kind === 'mcp') for (const s of (doc.servers as Node[]) ?? []) keys.push(`mcp:${s.id}`);
  else if (kind === 'providers') for (const p of (doc.providers as Node[]) ?? []) keys.push(`provider:${p.id}`);
  else for (const i of (doc.items as Node[]) ?? []) keys.push(`lib:${rel}#${i.id}`);
  return keys;
}

/** Record that a fresh copy of the template was offered everything in it. */
export function markTemplateInstalled(templateDir: string, dest: string): void {
  writeJson(join(dest, OFFERED_FILE), { keys: templateKeys(templateDir) });
}

/**
 * Add what the template gained since `dest` was copied from it. Returns a short description of each addition
 * (e.g. `collection "Public REST APIs"`, `MCP server "Context7"`), empty when there was nothing new.
 */
export function addTemplateAdditions(templateDir: string, dest: string): string[] {
  const ledgerFile = join(dest, OFFERED_FILE);
  const offered = new Set<string>(existsSync(ledgerFile) ? (readJson<{ keys?: string[] }>(ledgerFile).keys ?? []) : []);
  // an older version could leave a second copy of an example collection (a save wrote `<id>.json` beside the
  // template's file): merge it back first, so the additions below go into the one copy
  const added: string[] = repairTemplateDuplicates(templateDir, dest);
  const isNew = (key: string) => !offered.has(key);
  const offer = (key: string) => offered.add(key);
  // the copy's collections: a template collection whose file is missing may live in another file (same collection
  // id), and nodes added from the template never take an id another collection already has
  const mine = destCollections(dest);

  for (const rel of files(templateDir)) {
    const src = join(templateDir, rel);
    const kind = mergeKind(rel);
    const fileKey = `file:${rel}`;
    let target = join(dest, rel);
    if (kind === 'collection' && !existsSync(target)) {
      const id = templateCollectionId(src);
      const home = id === undefined ? undefined : mine.find((m) => m.doc.id === id);
      if (home) target = home.file;
    }
    if (!existsSync(target)) {
      // a file the copy never had (or the user deleted: then it was offered before and stays deleted)
      if (isNew(fileKey)) {
        mkdirSync(dirname(target), { recursive: true });
        const free = kind === 'collection' ? withFreeIds(readJson<CollectionDoc>(src), takenIds(mine)) : undefined;
        // the file as it ships, unless some of its ids are taken in the copy: then with fresh ones for those
        if (free?.changed) writeJson(target, free.doc);
        else copyOwned(src, target);
        if (free) mine.push({ rel, file: target, doc: free.doc });
        added.push(describeFile(rel, kind, src));
      }
      offer(fileKey);
      if (kind) for (const k of docKeys(kind, rel, readJson(src))) offer(k);
      continue;
    }
    offer(fileKey);
    if (!kind) continue;
    const from = readJson<Record<string, unknown>>(src);
    let into: Record<string, unknown>;
    try {
      into = readJson<Record<string, unknown>>(target);
    } catch {
      continue; // the user's file is not valid JSON: leave it alone
    }
    const before = added.length;
    if (kind === 'collection') {
      // ids the new nodes must not take: every other collection's, and every one this collection already has
      const others = mine.filter((m) => m.file !== target);
      const taken = takenIds(others);
      collectNodeIds((into.items ?? []) as IdNode[]).forEach((id) => taken.add(id));
      mergeNodes(from.items as Node[], (into.items ??= []) as Node[], rel, isNew, offer, added, String(into.name ?? rel), taken);
    } else if (kind === 'environment') {
      const list = (into.variables ??= []) as Array<{ key: string }>;
      for (const v of (from.variables as Array<{ key: string }>) ?? []) {
        const key = `var:${rel}#${v.key}`;
        if (isNew(key) && !list.some((x) => x.key === v.key)) {
          list.push(v);
          added.push(`variable {{${v.key}}} in "${String(into.name ?? rel)}"`);
        }
        offer(key);
      }
    } else {
      const field = kind === 'mcp' ? 'servers' : kind === 'providers' ? 'providers' : 'items';
      const prefix = kind === 'mcp' ? 'mcp:' : kind === 'providers' ? 'provider:' : `lib:${rel}#`;
      const list = (into[field] ??= []) as Array<Node & { name?: string; folder?: string }>;
      for (const x of (from[field] as Array<Node & { name?: string; folder?: string }>) ?? []) {
        const key = `${prefix}${x.id}`;
        if (isNew(key) && !list.some((y) => y.id === x.id)) {
          list.push(x);
          added.push(kind === 'mcp' ? `MCP server "${x.name}"` : kind === 'providers' ? `provider "${x.name}"` : `"${x.name}"`);
          // a saved item goes into its folder: make sure the folder exists
          if (kind === 'library' && x.folder) {
            const folders = (into.folders ??= []) as string[];
            if (!folders.includes(x.folder)) folders.push(x.folder);
          }
        }
        offer(key);
      }
    }
    if (added.length > before) writeJson(target, into);
  }
  writeJson(ledgerFile, { keys: [...offered].sort() });
  return added;
}

/** Template nodes the copy lacks go in at the same place (into the folder with the same id, else at the end). */
function mergeNodes(from: Node[] = [], into: Node[], rel: string, isNew: (k: string) => boolean, offer: (k: string) => void, added: string[], where: string, taken: Set<string>) {
  for (const n of from) {
    if (!n.id) continue;
    const key = `item:${rel}#${n.id}`;
    const mine = into.find((x) => x.id === n.id);
    if (mine) {
      offer(key);
      if (n.items && mine.items) mergeNodes(n.items, mine.items, rel, isNew, offer, added, where, taken);
      continue;
    }
    if (isNew(key)) {
      // an id another collection (or another folder of this one) already has: the added copy gets a fresh one
      const [free] = ensureUniqueIds({ items: [n as IdNode] }, taken).collection.items;
      collectNodeIds([free!]).forEach((id) => taken.add(id));
      into.push(free as Node);
      added.push(`${n.kind === 'folder' ? 'folder' : 'request'} "${(n as { name?: string }).name}" in "${where}"`);
    }
    // the node and everything inside it count as offered
    const mark = (x: Node) => {
      if (x.id) offer(`item:${rel}#${x.id}`);
      x.items?.forEach(mark);
    };
    mark(n);
  }
}

function describeFile(rel: string, kind: ReturnType<typeof mergeKind>, src: string): string {
  if (kind === 'collection') return `collection "${String(readJson<{ name?: string }>(src).name ?? rel)}"`;
  if (kind === 'environment') return `environment "${String(readJson<{ name?: string }>(src).name ?? rel)}"`;
  return rel;
}

/* One copy of every example collection, and ids that stay unique across the copy's collections */

type CollectionDoc = Record<string, unknown> & { id?: unknown; name?: unknown; items?: Node[] };
interface DestCollection {
  /** `collections/<file>.json` */
  rel: string;
  file: string;
  doc: CollectionDoc;
}

/** The copy's collection files that read as JSON, in file-name order (the order the workspace lists them). */
function destCollections(dest: string): DestCollection[] {
  const dir = join(dest, 'collections');
  if (!existsSync(dir)) return [];
  const out: DestCollection[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    try {
      const doc = readJson<CollectionDoc>(join(dir, name));
      if (doc && typeof doc === 'object') out.push({ rel: `collections/${name}`, file: join(dir, name), doc });
    } catch {
      /* not valid JSON: the user's to fix, never merged */
    }
  }
  return out;
}

function templateCollectionId(src: string): string | undefined {
  try {
    const id = readJson<CollectionDoc>(src).id;
    return typeof id === 'string' && id ? id : undefined;
  } catch {
    return undefined;
  }
}

const takenIds = (collections: DestCollection[]): Set<string> => {
  const out = new Set<string>();
  for (const c of collections) for (const id of collectNodeIds(c.doc.items as IdNode[] | undefined)) out.add(id);
  return out;
};

/** A template collection with fresh ids for the nodes whose id the copy already uses elsewhere. */
function withFreeIds(doc: CollectionDoc, taken: Set<string>): { doc: CollectionDoc; changed: boolean } {
  const r = ensureUniqueIds({ ...doc, items: (doc.items ?? []) as IdNode[] }, taken);
  return { doc: r.collection as CollectionDoc, changed: r.collection.items !== doc.items };
}

/**
 * Merge stray second copies of the template's collections back into the copy's own file, and move the stray file to
 * the trash (restorable for 30 days: nothing is lost). A stray copy is a collection file the template does not ship
 * that holds the same collection id as a template collection, or as the copy's file of it. Older versions, saving such
 * a collection, wrote `collections/<id>.json` beside the file it came from (`streams.json` holds `live-streams`), and
 * the workspace then listed it twice, with the same request ids in both. Requests only the stray copy has are kept
 * (added at the same place); for a request in both, the copy saved last wins. The merged collection keeps the
 * template's id. Returns a note for each merge (empty when there is nothing to repair, so it can run every time).
 */
export function repairTemplateDuplicates(templateDir: string, dest: string): string[] {
  const tplDir = join(templateDir, 'collections');
  if (!existsSync(tplDir)) return [];
  const shipped = readdirSync(tplDir).filter((f) => f.endsWith('.json'));
  const shippedRel = new Set(shipped.map((f) => `collections/${f}`));
  let mine = destCollections(dest);
  const notes: string[] = [];
  for (const f of shipped) {
    const id = templateCollectionId(join(tplDir, f));
    const home = mine.find((m) => m.rel === `collections/${f}`);
    if (!id || !home) continue;
    const homeId = typeof home.doc.id === 'string' ? home.doc.id : undefined;
    const strays = mine.filter((m) => m !== home && !shippedRel.has(m.rel) && (m.doc.id === id || (homeId !== undefined && m.doc.id === homeId)));
    if (!strays.length) continue;
    let items = (home.doc.items ?? []) as IdNode[];
    for (const s of strays) items = unionNodes(items, (s.doc.items ?? []) as IdNode[], mtime(s.file) > mtime(home.file));
    const merged: CollectionDoc = { ...home.doc, id, items: items as Node[] };
    writeJson(home.file, merged);
    // the trash only needs the workspace's folder (store.path); restoring brings the stray copy back as it was
    const store = { path: (...p: string[]) => join(dest, ...p) } as unknown as WorkspaceStore;
    for (const s of strays) {
      moveToTrash(store, 'collection', s.file);
      notes.push(`merged the second copy of "${String(home.doc.name ?? id)}" (${s.rel}) into ${home.rel}; the copy is in Recently deleted`);
    }
    home.doc = merged;
    mine = mine.filter((m) => !strays.includes(m));
  }
  return notes;
}

const mtime = (file: string): number => {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};

/**
 * `base` with what `other` adds: a node only `other` has goes in at the same place (into the folder with its id, else
 * at the end); a request both have is `other`'s when `preferOther`; folders merge recursively. A node `base` has
 * anywhere in its tree is never added a second time.
 */
function unionNodes(base: IdNode[], other: IdNode[], preferOther: boolean, all = new Set(collectNodeIds(base))): IdNode[] {
  const out = [...base];
  for (const o of other) {
    const at = out.findIndex((b) => b.id === o.id);
    if (at >= 0) {
      const b = out[at]!;
      if (b.items && o.items) out[at] = { ...b, items: unionNodes(b.items, o.items, preferOther, all) };
      else if (preferOther && !b.items && !o.items) out[at] = o;
      continue;
    }
    if (all.has(o.id)) continue; // moved elsewhere in base: base's place wins
    const pruned = prune(o, all);
    if (!pruned) continue;
    collectNodeIds([pruned]).forEach((id) => all.add(id));
    out.push(pruned);
  }
  return out;
}

/** The node without the parts whose ids are already taken (undefined when the node itself is). */
function prune(n: IdNode, taken: Set<string>): IdNode | undefined {
  if (taken.has(n.id)) return undefined;
  if (!n.items) return n;
  return { ...n, items: n.items.map((x) => prune(x, taken)).filter((x): x is IdNode => !!x) };
}
