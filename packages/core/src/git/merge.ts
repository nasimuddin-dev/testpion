import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { collectionFileContent } from '../storage/workspace.js';
import type { Collection } from '../model/types.js';

/**
 * Merging collection files by meaning (GIT-301): two people who change different requests of one collection never
 * get a conflict, whatever lines of JSON that touches. Requests and folders are matched by id; a conflict is only
 * the same request (or the same collection setting) changed differently on both sides. Then "ours" is kept in the
 * file, and the conflict is reported for the user to settle (Keep mine / Take theirs).
 */

type Obj = Record<string, unknown>;
type Node = Obj & { id: string; kind?: string; items?: Node[] };

export interface MergeResult {
  /** The merged collection file (valid JSON, in the git-friendly form). */
  text: string;
  /** What changed on both sides, in words ("API ▸ Login: changed on both sides"); empty when it merged cleanly. */
  conflicts: string[];
  /** The same conflicts with the three versions, for a side-by-side view and a choice per conflict (GIT-302). */
  items: MergeConflict[];
}

/**
 * One conflict: a request (or folder) changed on both sides, changed on one side and deleted on the other, or one
 * setting (of the collection or a folder) changed differently. `key` names it in `resolutions`.
 */
export interface MergeConflict {
  key: string;
  /** Where it is, in words: "API ▸ Login", "collection API: auth". */
  where: string;
  kind: 'changed-both' | 'deleted-theirs' | 'deleted-ours' | 'setting';
  base?: unknown;
  ours?: unknown;
  theirs?: unknown;
}

/** A choice per conflict key; a conflict without one keeps the default side. */
export type MergeResolutions = Record<string, 'ours' | 'theirs'>;

/** What the merge works with: the conflicts found, the choices made, the side a conflict keeps by default. */
interface Ctx {
  conflicts: string[];
  items: MergeConflict[];
  resolutions: MergeResolutions;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The three-way choice for one value: whoever changed it wins; both changed it differently → a conflict, settled by its resolution (ours by default). */
function pick<T>(base: T | undefined, ours: T | undefined, theirs: T | undefined, ctx: Ctx, conflict: Omit<MergeConflict, 'base' | 'ours' | 'theirs'>, words: string): T | undefined {
  if (same(ours, theirs)) return ours;
  if (same(base, ours)) return theirs;
  if (same(base, theirs)) return ours;
  ctx.conflicts.push(words);
  ctx.items.push({ ...conflict, base, ours, theirs });
  return ctx.resolutions[conflict.key] === 'theirs' ? theirs : ours;
}

/** The fields of an object other than `items`, merged key by key. */
function mergeFields(base: Obj | undefined, ours: Obj, theirs: Obj, where: string, owner: string, ctx: Ctx): Obj {
  const out: Obj = {};
  const keys = [...new Set([...Object.keys(ours), ...Object.keys(theirs)])].filter((k) => k !== 'items');
  for (const k of keys) {
    const v = pick(base?.[k], ours[k], theirs[k], ctx, { key: `setting:${owner}:${k}`, where: `${where}: ${k}`, kind: 'setting' }, `${where}: ${k} changed on both sides`);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function mergeItems(base: Node[] = [], ours: Node[] = [], theirs: Node[] = [], path: string, ctx: Ctx): Node[] {
  const b = new Map(base.map((n) => [n.id, n]));
  const o = new Map(ours.map((n) => [n.id, n]));
  const t = new Map(theirs.map((n) => [n.id, n]));
  // order: ours, with what only theirs added placed after its predecessor in theirs
  const order = ours.map((n) => n.id);
  theirs.forEach((n, i) => {
    if (o.has(n.id) || b.has(n.id)) return;
    const prev = theirs
      .slice(0, i)
      .reverse()
      .find((p) => order.includes(p.id));
    order.splice(prev ? order.indexOf(prev.id) + 1 : 0, 0, n.id);
  });
  // what ours deleted but theirs changed comes back (nothing is lost): at its place in theirs
  for (const n of theirs) if (!order.includes(n.id) && b.has(n.id) && !o.has(n.id) && !same(b.get(n.id), n)) order.push(n.id);
  const out: Node[] = [];
  for (const id of order) {
    const bn = b.get(id);
    const on = o.get(id);
    const tn = t.get(id);
    const name = String((on ?? tn ?? bn)?.name ?? id);
    const where = path ? `${path} ▸ ${name}` : name;
    const key = `item:${id}`;
    if (on && tn) {
      if (on.kind === 'folder' && tn.kind === 'folder') {
        out.push({ ...mergeFields(bn, on, tn, where, id, ctx), items: mergeItems(bn?.items, on.items, tn.items, where, ctx) } as Node);
      } else out.push(pick(bn, on, tn, ctx, { key, where, kind: 'changed-both' }, `${where}: changed on both sides`)!);
    } else if (on) {
      // theirs deleted it (or it is new in ours): kept unless the choice is theirs (deleted)
      if (!bn) out.push(on);
      else if (!same(bn, on)) {
        ctx.conflicts.push(`${where}: changed here, deleted on the other side`);
        ctx.items.push({ key, where, kind: 'deleted-theirs', base: bn, ours: on });
        if (ctx.resolutions[key] !== 'theirs') out.push(on);
      }
    } else if (tn) {
      // ours deleted it, theirs changed it: it comes back (nothing is lost) unless the choice is ours (deleted)
      if (!bn) out.push(tn);
      else if (!same(bn, tn)) {
        ctx.conflicts.push(`${where}: deleted here, changed on the other side`);
        ctx.items.push({ key, where, kind: 'deleted-ours', base: bn, theirs: tn });
        if (ctx.resolutions[key] !== 'ours') out.push(tn);
      }
    }
  }
  return out;
}

const parseObj = (s: string): Obj | undefined => {
  if (!s.trim()) return {};
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * An environment merged by variable (GIT-301 for environments): a variable added, changed or removed on one side is
 * taken; the same variable changed differently on both sides is a conflict (`var:<key>`); the environment's own
 * fields (name, production, colour) merge one by one. Secret values are empty in the files, so they never conflict.
 */
export function mergeEnvironmentTexts(baseText: string, oursText: string, theirsText: string, resolutions: MergeResolutions = {}): MergeResult | undefined {
  const [base, ours, theirs] = [parseObj(baseText), parseObj(oursText), parseObj(theirsText)];
  if (!base || !ours || !theirs || !Array.isArray(ours.variables) || !Array.isArray(theirs.variables) || 'items' in ours) return undefined;
  // the by-id merge keys a conflict item:<id>; a variable's id is var:<key>, and its conflict is reported as var:<key>
  const byItemKey = Object.fromEntries(Object.entries(resolutions).map(([k, v]) => [k.startsWith('var:') ? `item:${k}` : k, v]));
  const ctx: Ctx = { conflicts: [], items: [], resolutions: byItemKey };
  const name = String(ours.name ?? theirs.name ?? 'environment');
  // variables as items keyed by their name, so the by-id merge applies (and comes back to plain variables after)
  const asNodes = (vars: unknown) => ((vars as Array<Obj & { key: string }> | undefined) ?? []).map((v) => ({ ...v, id: `var:${v.key}`, name: `{{${v.key}}}` }) as unknown as Node);
  const variables = mergeItems(asNodes(base.variables), asNodes(ours.variables), asNodes(theirs.variables), `environment ${name}`, ctx).map((n) => {
    const { id: _i, name: _n, ...v } = n as Obj;
    void _i;
    void _n;
    return v;
  });
  for (const c of ctx.items) c.key = c.key.replace(/^item:/, '');
  const fields = mergeFields(without(base, 'variables'), without(ours, 'variables'), without(theirs, 'variables'), `environment ${name}`, 'environment', ctx);
  return { text: JSON.stringify({ ...fields, variables }, null, 2) + '\n', conflicts: ctx.conflicts, items: ctx.items };
}

/** An object without some keys (merged separately). */
const without = (o: Obj, ...keys: string[]): Obj => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

/**
 * A library file (saved gRPC calls, WebSocket connections, AI prompts …) merged by item id; its folders are the
 * union of both sides less the ones a side removed, plus every folder an item is in (as the store writes them).
 */
export function mergeLibraryTexts(baseText: string, oursText: string, theirsText: string, resolutions: MergeResolutions = {}): MergeResult | undefined {
  const [base, ours, theirs] = [parseObj(baseText), parseObj(oursText), parseObj(theirsText)];
  if (!base || !ours || !theirs || !Array.isArray(ours.items) || !Array.isArray(theirs.items) || !Array.isArray(ours.folders)) return undefined;
  const ctx: Ctx = { conflicts: [], items: [], resolutions };
  const items = mergeItems(base.items as Node[], ours.items as Node[], theirs.items as Node[], 'library', ctx);
  const set = (x: unknown) => new Set(((x as string[] | undefined) ?? []).filter((f) => typeof f === 'string'));
  const [bf, of, tf] = [set(base.folders), set(ours.folders), set(theirs.folders)];
  // a folder stays unless one side removed it; every folder an item is in is there (as the store writes them)
  const folders = new Set([...of, ...tf].filter((f) => !(bf.has(f) && (!of.has(f) || !tf.has(f)))));
  for (const i of items) if (typeof (i as Obj).folder === 'string' && (i as Obj).folder) folders.add((i as Obj).folder as string);
  const fields = mergeFields(without(base, 'folders'), without(ours, 'folders'), without(theirs, 'folders'), 'library', 'library', ctx);
  return { text: JSON.stringify({ ...fields, folders: [...folders].sort((a, b) => a.localeCompare(b)), items }, null, 2) + '\n', conflicts: ctx.conflicts, items: ctx.items };
}

/** Any workspace file TestPion merges by meaning: a collection, an environment or a library file (undefined: git merges lines). */
export function mergeWorkspaceTexts(baseText: string, oursText: string, theirsText: string, resolutions: MergeResolutions = {}): MergeResult | undefined {
  const ours = parseObj(oursText);
  if (!ours) return undefined;
  if (Array.isArray(ours.variables) && !Array.isArray(ours.items)) return mergeEnvironmentTexts(baseText, oursText, theirsText, resolutions);
  // a library file has a folders list (a collection's folders are items)
  if (Array.isArray(ours.folders) && Array.isArray(ours.items)) return mergeLibraryTexts(baseText, oursText, theirsText, resolutions);
  return mergeCollectionTexts(baseText, oursText, theirsText, resolutions);
}

/**
 * Merge three versions of a collection file; undefined when one of them is not a collection (git merges lines then).
 * `resolutions` settles conflicts one by one (from a previous run's `items`); without one, a conflict keeps ours.
 */
export function mergeCollectionTexts(baseText: string, oursText: string, theirsText: string, resolutions: MergeResolutions = {}): MergeResult | undefined {
  const parse = (s: string): Obj | undefined => {
    if (!s.trim()) return {};
    try {
      const v = JSON.parse(s) as unknown;
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined;
    } catch {
      return undefined;
    }
  };
  const base = parse(baseText);
  const ours = parse(oursText);
  const theirs = parse(theirsText);
  if (!base || !ours || !theirs || !Array.isArray(ours.items) || !Array.isArray(theirs.items)) return undefined;
  const ctx: Ctx = { conflicts: [], items: [], resolutions };
  const name = String(ours.name ?? theirs.name ?? 'collection');
  const merged = { ...mergeFields(base, ours, theirs, `collection ${name}`, 'collection', ctx), items: mergeItems(base.items as Node[], ours.items as Node[], theirs.items as Node[], name, ctx) };
  return { text: JSON.stringify(collectionFileContent(merged as unknown as Collection), null, 2) + '\n', conflicts: ctx.conflicts, items: ctx.items };
}

/**
 * The git merge driver (`%O %A %B`): merges into the "ours" file and returns git's exit code: 0 merged, 1 conflicts
 * (the file holds ours plus every change that did not conflict). Not a collection: git's own line merge.
 */
export function runMergeDriver(baseFile: string, oursFile: string, theirsFile: string, log: (s: string) => void = () => undefined): number {
  const r = mergeWorkspaceTexts(readFileSync(baseFile, 'utf8'), readFileSync(oursFile, 'utf8'), readFileSync(theirsFile, 'utf8'));
  if (!r) return lineMerge(baseFile, oursFile, theirsFile);
  writeFileSync(oursFile, r.text);
  for (const c of r.conflicts) log(`TestPion: ${c}`);
  return r.conflicts.length ? 1 : 0;
}

/** git merge-file: the usual line merge with conflict markers. */
function lineMerge(base: string, ours: string, theirs: string): number {
  const r = spawnSync('git', ['merge-file', ours, base, theirs], { windowsHide: true });
  return r.status === 0 ? 0 : 1;
}

/** The parts of a request (or any item) as short text, for comparing three versions side by side. */
export function requestParts(node: unknown): Record<string, string> {
  if (!node || typeof node !== 'object') return {};
  const n = node as Obj & { request?: Obj };
  const r = (n.request ?? {}) as Obj;
  const kv = (list: unknown) =>
    Array.isArray(list)
      ? list
          .map((x) => x as { key?: string; value?: string; enabled?: boolean })
          .map((x) => `${x.enabled === false ? '// ' : ''}${x.key ?? ''}: ${x.value ?? ''}`)
          .join('\n')
      : '';
  const json = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  const body = r.body as { type?: string; content?: string } | undefined;
  const parts: Record<string, string> = {
    Name: String(n.name ?? ''),
    Request: [r.method, r.url ?? r.endpoint].filter(Boolean).join(' '),
    Params: kv(r.params),
    Headers: kv(r.headers),
    Auth: json(r.auth),
    Body: body ? `${body.type ?? ''}${body.content ? `\n${body.content}` : ''}` : r.query ? String(r.query) : '',
    'Pre-request script': String(n.preRequestScript ?? ''),
    'Test script': String(n.testScript ?? ''),
    Checks: json(n.assertions),
    Description: String(n.description ?? ''),
  };
  // a library item (a saved gRPC call, a connection, a prompt …): its data as JSON
  if ('data' in n) return Object.fromEntries(Object.entries({ Name: String(n.name ?? ''), Folder: String(n.folder ?? ''), Data: json(n.data) }).filter(([, v]) => v !== ''));
  // an environment variable (merged as an item keyed by its name)
  if (typeof n.key === 'string' && !('request' in n)) return { Value: n.secret ? '•••• (secret, in the OS store)' : String(n.value ?? ''), Enabled: n.enabled === false ? 'no' : 'yes', Secret: n.secret ? 'yes' : 'no' };
  if (n.kind === 'folder') return { Name: parts.Name!, Auth: json(n.auth), Variables: kv(n.variables), 'Pre-request script': parts['Pre-request script']!, 'Test script': parts['Test script']! };
  return Object.fromEntries(Object.entries(parts).filter(([, v]) => v !== ''));
}
