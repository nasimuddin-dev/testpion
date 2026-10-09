import { readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { Collection, CollectionNode, Environment } from '../model/types.js';
import { assertGitRev, gitLog, gitShow, realFolder, runGit, type GitCommit, type GitFile } from './git.js';
import { requestParts } from './merge.js';
import { flowChanges, flowItemParts, isFlowFile } from './flow-diff.js';

/**
 * Changes said by what they mean (GIT-205): "Payments ▸ Create invoice: URL and 2 headers changed" rather than
 * lines of JSON. Collections are compared request by request (by id), environments variable by variable (values of
 * secret variables are never shown: they are not in the files anyway).
 */
export interface SemanticChange {
  file: string;
  kind: 'collection' | 'environment' | 'test' | 'library' | 'other';
  change: 'added' | 'removed' | 'changed' | 'renamed' | 'conflicted';
  /** What changed, in words: "Payments ▸ Create invoice", "environment Staging". */
  title: string;
  /** Which parts: "URL", "2 headers", "body", "scripts" … */
  details: string[];
  /** The collection and item, so the explorer can mark the row. */
  collectionId?: string;
  itemId?: string;
  /** The item's kind (http, graphql, folder …). */
  itemKind?: string;
}

type Node = CollectionNode & { name?: string; items?: Node[] };

const parse = <T>(text: string | undefined): T | undefined => {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
};

/** Every request and folder of a collection by id, with its path of names. */
function index(nodes: Node[] = [], path: string[] = [], out = new Map<string, { node: Node; path: string[] }>()) {
  for (const n of nodes) {
    out.set(n.id, { node: n, path: [...path, n.name ?? n.id] });
    if (n.kind === 'folder') index(n.items as Node[], [...path, n.name ?? n.id], out);
  }
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Which parts of a request changed, in words. */
function requestDetails(a: Node, b: Node): string[] {
  const out: string[] = [];
  const ra = (a as { request?: Record<string, unknown> }).request ?? {};
  const rb = (b as { request?: Record<string, unknown> }).request ?? {};
  if (a.name !== b.name) out.push('name');
  if (!same(ra.method, rb.method)) out.push('method');
  if (!same(ra.url ?? ra.endpoint, rb.url ?? rb.endpoint)) out.push('URL');
  const count = (x: unknown) => (Array.isArray(x) ? x.length : 0);
  if (!same(ra.params, rb.params)) out.push(`params (${count(ra.params)} → ${count(rb.params)})`);
  if (!same(ra.headers, rb.headers)) out.push(`headers (${count(ra.headers)} → ${count(rb.headers)})`);
  if (!same(ra.body, rb.body) || !same(ra.query, rb.query) || !same(ra.variables, rb.variables)) out.push('body');
  if (!same(ra.auth, rb.auth)) out.push('auth');
  if (!same((a as { preRequestScript?: string }).preRequestScript, (b as { preRequestScript?: string }).preRequestScript) || !same((a as { testScript?: string }).testScript, (b as { testScript?: string }).testScript)) out.push('scripts');
  if (!same((a as { assertions?: unknown }).assertions, (b as { assertions?: unknown }).assertions)) out.push('checks');
  if (!same((a as { examples?: unknown }).examples, (b as { examples?: unknown }).examples)) out.push('examples');
  if (!same((a as { favorite?: unknown }).favorite, (b as { favorite?: unknown }).favorite)) out.push('favorite');
  if (!out.length) out.push('settings');
  return out;
}

function collectionChanges(file: string, before: Collection | undefined, after: Collection | undefined): SemanticChange[] {
  const name = after?.name ?? before?.name ?? file;
  const cid = after?.id ?? before?.id;
  if (!before && after) return [{ file, kind: 'collection', change: 'added', title: `collection ${name}`, details: [`${index(after.items as Node[]).size} items`], collectionId: cid }];
  if (before && !after) return [{ file, kind: 'collection', change: 'removed', title: `collection ${name}`, details: [], collectionId: cid }];
  if (!before || !after) return [];
  const out: SemanticChange[] = [];
  const top: string[] = [];
  if (before.name !== after.name) top.push(`renamed from ${before.name}`);
  if (!same(before.variables, after.variables)) top.push('variables');
  if (!same(before.auth, after.auth)) top.push('auth');
  if (!same((before as { preRequestScript?: string }).preRequestScript, (after as { preRequestScript?: string }).preRequestScript) || !same((before as { testScript?: string }).testScript, (after as { testScript?: string }).testScript)) top.push('scripts');
  if (!same(before.description, after.description)) top.push('description');
  if (top.length) out.push({ file, kind: 'collection', change: 'changed', title: `collection ${name}`, details: top, collectionId: cid });
  const a = index(before.items as Node[]);
  const b = index(after.items as Node[]);
  for (const [id, { node, path }] of b) {
    const was = a.get(id);
    const title = [name, ...path].join(' ▸ ');
    if (!was) out.push({ file, kind: 'collection', change: 'added', title, details: [node.kind === 'folder' ? 'folder' : 'request'], collectionId: cid, itemId: id, itemKind: node.kind });
    else if (node.kind !== 'folder' && !same({ ...node }, { ...was.node })) out.push({ file, kind: 'collection', change: 'changed', title, details: requestDetails(was.node, node), collectionId: cid, itemId: id, itemKind: node.kind });
    else if (node.kind === 'folder' && (was.node.name !== node.name || !same(was.path.slice(0, -1), path.slice(0, -1)))) out.push({ file, kind: 'collection', change: was.node.name !== node.name ? 'renamed' : 'changed', title, details: [was.node.name !== node.name ? `was ${was.node.name}` : 'moved'], collectionId: cid, itemId: id, itemKind: node.kind });
    else if (node.kind !== 'folder' && !same(was.path.slice(0, -1), path.slice(0, -1))) out.push({ file, kind: 'collection', change: 'changed', title, details: ['moved'], collectionId: cid, itemId: id, itemKind: node.kind });
  }
  for (const [id, { node, path }] of a) if (!b.has(id)) out.push({ file, kind: 'collection', change: 'removed', title: [name, ...path].join(' ▸ '), details: [node.kind === 'folder' ? 'folder' : 'request'], collectionId: cid, itemId: id, itemKind: node.kind });
  if (!out.length) out.push({ file, kind: 'collection', change: 'changed', title: `collection ${name}`, details: ['order or formatting'], collectionId: cid });
  return out;
}

function environmentChanges(file: string, before: Environment | undefined, after: Environment | undefined): SemanticChange[] {
  const name = after?.name ?? before?.name ?? file;
  if (!before || !after) return [{ file, kind: 'environment', change: after ? 'added' : 'removed', title: `environment ${name}`, details: after ? [`${after.variables.length} variables`] : [] }];
  const details: string[] = [];
  const av = new Map(before.variables.map((v) => [v.key, v]));
  const bv = new Map(after.variables.map((v) => [v.key, v]));
  const added = [...bv.keys()].filter((k) => !av.has(k));
  const removed = [...av.keys()].filter((k) => !bv.has(k));
  const changed = [...bv.keys()].filter((k) => av.has(k) && !same(av.get(k), bv.get(k)));
  if (before.name !== after.name) details.push(`renamed from ${before.name}`);
  if (added.length) details.push(`added ${added.join(', ')}`);
  if (removed.length) details.push(`removed ${removed.join(', ')}`);
  if (changed.length) details.push(`changed ${changed.join(', ')}`);
  return [{ file, kind: 'environment', change: 'changed', title: `environment ${name}`, details: details.length ? details : ['settings'] }];
}

/** The meaning of each changed file (working folder against the last commit). */
export async function describeGitChanges(ws: string, files: GitFile[]): Promise<SemanticChange[]> {
  const out: SemanticChange[] = [];
  for (const f of files) {
    const read = () => {
      try {
        return f.state === 'deleted' ? undefined : readFileSync(join(ws, f.path), 'utf8');
      } catch {
        return undefined;
      }
    };
    if (f.state === 'conflicted') {
      out.push({ file: f.path, kind: f.path.startsWith('collections/') ? 'collection' : f.path.startsWith('environments/') ? 'environment' : 'other', change: 'conflicted', title: f.path, details: ['changed on both sides'] });
      continue;
    }
    const head = f.state === 'untracked' || f.state === 'added' ? undefined : await gitShow(ws, f.from ?? f.path);
    if (/^collections\/[^/]+\.json$/.test(f.path)) out.push(...collectionChanges(f.path, parse<Collection>(head), parse<Collection>(read())));
    else if (/^environments\/[^/]+\.json$/.test(f.path)) out.push(...environmentChanges(f.path, parse<Environment>(head), parse<Environment>(read())));
    else if (isFlowFile(f.path) && f.state !== 'renamed' && flowChanges(f.path, head, read())) out.push(...flowChanges(f.path, head, read())!);
    else {
      const kind = f.path.startsWith('tests/') ? 'test' : f.path.startsWith('library/') ? 'library' : 'other';
      const change = f.state === 'untracked' || f.state === 'added' ? 'added' : f.state === 'deleted' ? 'removed' : f.state === 'renamed' ? 'renamed' : 'changed';
      out.push({ file: f.path, kind, change, title: f.path, details: f.state === 'renamed' && f.from ? [`was ${f.from}`] : [] });
    }
  }
  return out;
}

/** One item (request or folder) of a collection by id, anywhere in its folders. */
export function findCollectionItem(c: Pick<Collection, 'items'>, id: string): CollectionNode | undefined {
  return index(c.items as Node[]).get(id)?.node;
}

/** The collection with one item replaced (GIT-209: restore a request as it was in a commit); undefined when it is not there. */
export function replaceCollectionItem<C extends Pick<Collection, 'items'>>(c: C, id: string, node: CollectionNode): C | undefined {
  let found = false;
  const walk = (nodes: Node[]): Node[] =>
    nodes.map((n) => {
      if (n.id === id) return (found = true), (node as Node);
      return n.kind === 'folder' ? ({ ...n, items: walk((n.items ?? []) as Node[]) } as Node) : n;
    });
  const items = walk(c.items as Node[]);
  return found ? { ...c, items: items as C['items'] } : undefined;
}

/**
 * The meaning of the changes between two commits (GIT-401 `testpion diff`, the CI pull-request comment): `to`
 * defaults to the working folder when omitted.
 */
export async function describeRevChanges(ws: string, from: string, to?: string): Promise<SemanticChange[]> {
  assertGitRev(from);
  if (to) assertGitRev(to);
  const out = await runGit(ws, ['diff', '--name-status', '-z', '-M', from, ...(to ? [to] : []), '--', '.']);
  const parts = out.split('\0').filter((p) => p !== '');
  const repo = (await runGit(ws, ['rev-parse', '--show-toplevel'])).trim();
  const rel = (p: string) => relative(realFolder(ws), resolve(repo, p)).split(sep).join('/');
  const files: Array<{ path: string; from?: string; status: string }> = [];
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i]!;
    if (status.startsWith('R') || status.startsWith('C')) files.push({ status: 'R', from: rel(parts[++i]!), path: rel(parts[++i]!) });
    else files.push({ status: status[0]!, path: rel(parts[++i]!) });
  }
  const result: SemanticChange[] = [];
  for (const f of files) {
    const before = f.status === 'A' ? undefined : await gitShow(ws, f.from ?? f.path, from);
    const after = f.status === 'D' ? undefined : to ? await gitShow(ws, f.path, to) : readOrUndefined(join(ws, f.path));
    if (/^collections\/[^/]+\.json$/.test(f.path)) result.push(...collectionChanges(f.path, parse<Collection>(before), parse<Collection>(after)));
    else if (/^environments\/[^/]+\.json$/.test(f.path)) result.push(...environmentChanges(f.path, parse<Environment>(before), parse<Environment>(after)));
    else if (isFlowFile(f.path) && f.status !== 'R' && flowChanges(f.path, before, after)) result.push(...flowChanges(f.path, before, after)!);
    else {
      const kind = f.path.startsWith('tests/') ? 'test' : f.path.startsWith('library/') ? 'library' : 'other';
      result.push({ file: f.path, kind, change: f.status === 'A' ? 'added' : f.status === 'D' ? 'removed' : f.status === 'R' ? 'renamed' : 'changed', title: f.path, details: f.from ? [`was ${f.from}`] : [] });
    }
  }
  return result;
}

function readOrUndefined(p: string): string | undefined {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}

/** The changes as Markdown (a pull-request description or CI comment). */
export function changesMarkdown(changes: SemanticChange[]): string {
  if (!changes.length) return '_No changes to the TestPion workspace._';
  const mark: Record<string, string> = { added: '➕', removed: '➖', changed: '✏️', renamed: '🔀', conflicted: '⚠️' };
  return changes.map((c) => `- ${mark[c.change] ?? ''} **${c.title}**${c.details.length ? `: ${c.details.join(', ')}` : ''}`).join('\n');
}

/**
 * One request's versions in git (GIT-209), newest first: each commit that changed it, with the request as that
 * commit left it. Commits that changed only other parts of the collection are left out.
 */
export async function gitItemHistory(ws: string, file: string, itemId: string, limit = 30): Promise<Array<{ commit: GitCommit; item: CollectionNode }>> {
  const commits = await gitLog(ws, { path: file, limit: limit * 4 });
  const cache = new Map<string, string>();
  /** The item in a commit, as JSON ("null" when not there). */
  const at = async (rev: string) => {
    let json = cache.get(rev);
    if (json === undefined) {
      json = JSON.stringify(findCollectionItem(parse<Collection>(await gitShow(ws, file, rev)) ?? { items: [] }, itemId) ?? null);
      cache.set(rev, json);
    }
    return json;
  };
  const versions: Array<{ commit: GitCommit; item: CollectionNode }> = [];
  for (const commit of commits) {
    const json = await at(commit.hash);
    if (json === 'null') continue;
    // it made a version when the request differs from every parent (a merge that took one side made none)
    const parents = (await runGit(ws, ['rev-parse', `${commit.hash}^@`]).catch(() => '')).split('\n').filter(Boolean);
    let changed = true;
    for (const p of parents) if ((await at(p)) === json) changed = false;
    if (changed) versions.push({ commit, item: JSON.parse(json) as CollectionNode });
    if (versions.length >= limit) break;
  }
  return versions;
}

/** One part of an item in two versions (GIT-205's side-by-side view). */
export interface PartChange {
  part: string;
  before?: string;
  after?: string;
  differs: boolean;
}

/**
 * One changed item side by side (GIT-205): a request or folder of a collection file (`itemId`), a step of a test or
 * flow file (`itemId` is the step id; without it the file's settings and steps), the collection's own
 * settings (no `itemId`), or an environment (its variables; secret values never appear, they live in the OS store).
 * `rev` is the version to compare with (the last commit by default); the other side is the file in the working folder.
 */
export async function describeItemDiff(ws: string, file: string, itemId?: string, rev = 'HEAD'): Promise<{ title: string; parts: PartChange[] }> {
  const before = await gitShow(ws, file, rev);
  let after: string | undefined;
  try {
    after = readFileSync(join(ws, file), 'utf8');
  } catch {
    after = undefined;
  }
  const rows = (b: Record<string, string> | undefined, a: Record<string, string> | undefined): PartChange[] =>
    [...new Set([...Object.keys(b ?? {}), ...Object.keys(a ?? {})])].map((part) => {
      const x = b ? (b[part] ?? '') : undefined;
      const y = a ? (a[part] ?? '') : undefined;
      return { part, before: x, after: y, differs: x !== y };
    });
  if (/^collections\/[^/]+\.json$/.test(file)) {
    const bc = parse<Collection>(before);
    const ac = parse<Collection>(after);
    if (itemId) {
      const find = (items: Node[] | undefined): Node | undefined => {
        for (const n of items ?? []) {
          if (n.id === itemId) return n;
          const inner = find(n.items as Node[] | undefined);
          if (inner) return inner;
        }
        return undefined;
      };
      const bn = find(bc?.items as Node[] | undefined);
      const an = find(ac?.items as Node[] | undefined);
      const name = String((an ?? bn)?.name ?? itemId);
      return { title: `${ac?.name ?? bc?.name ?? file} ▸ ${name}`, parts: rows(bn && requestParts(bn), an && requestParts(an)) };
    }
    const settings = (c: Collection | undefined) =>
      c && { Name: c.name, Description: c.description ?? '', Auth: c.auth ? JSON.stringify(c.auth, null, 2) : '', Variables: (c.variables ?? []).map((v) => `${v.enabled === false ? '// ' : ''}${v.key}: ${v.value}`).join('\n'), 'Pre-request script': c.preRequestScript ?? '', 'Test script': c.testScript ?? '' };
    return { title: `collection ${ac?.name ?? bc?.name ?? file}`, parts: rows(settings(bc), settings(ac)) };
  }
  if (/^environments\/[^/]+\.json$/.test(file)) {
    const be = parse<Environment>(before);
    const ae = parse<Environment>(after);
    const vars = (e: Environment | undefined) =>
      e && {
        Name: e.name,
        Production: e.isProduction ? 'yes' : 'no',
        ...Object.fromEntries(e.variables.map((v) => [`{{${v.key}}}`, `${v.enabled === false ? '(off) ' : ''}${v.secret ? '•••• (secret, in the OS store)' : v.value}`])),
      };
    return { title: `environment ${ae?.name ?? be?.name ?? file}`, parts: rows(vars(be), vars(ae)) };
  }
  // a test or flow file: one step part by part (itemId is its id), or the file's own settings and steps
  if (isFlowFile(file)) {
    const b = flowItemParts(file, before, itemId);
    const a = flowItemParts(file, after, itemId);
    if ((b || before === undefined || itemId) && (a || after === undefined || itemId) && (a || b)) return { title: itemId ? `${file} ▸ ${itemId}` : file, parts: rows(b, a) };
  }
  // any other file: the text as one part
  return { title: file, parts: rows(before === undefined ? undefined : { Text: before }, after === undefined ? undefined : { Text: after }) };
}
