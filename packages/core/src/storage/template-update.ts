import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { readJson, writeJson, copyOwned } from './fsutil.js';

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
  const added: string[] = [];
  const isNew = (key: string) => !offered.has(key);
  const offer = (key: string) => offered.add(key);

  for (const rel of files(templateDir)) {
    const src = join(templateDir, rel);
    const target = join(dest, rel);
    const kind = mergeKind(rel);
    const fileKey = `file:${rel}`;
    if (!existsSync(target)) {
      // a file the copy never had (or the user deleted: then it was offered before and stays deleted)
      if (isNew(fileKey)) {
        mkdirSync(dirname(target), { recursive: true });
        copyOwned(src, target);
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
    if (kind === 'collection') mergeNodes(from.items as Node[], (into.items ??= []) as Node[], rel, isNew, offer, added, String(into.name ?? rel));
    else if (kind === 'environment') {
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
function mergeNodes(from: Node[] = [], into: Node[], rel: string, isNew: (k: string) => boolean, offer: (k: string) => void, added: string[], where: string) {
  for (const n of from) {
    if (!n.id) continue;
    const key = `item:${rel}#${n.id}`;
    const mine = into.find((x) => x.id === n.id);
    if (mine) {
      offer(key);
      if (n.items && mine.items) mergeNodes(n.items, mine.items, rel, isNew, offer, added, where);
      continue;
    }
    if (isNew(key)) {
      into.push(n);
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
