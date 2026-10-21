/**
 * What an item adapter is (one per kind a bundle holds) and the helpers they share. The adapters themselves are in
 * items-json.ts (collections, environments, MCP servers, providers, saved items: JSON the workspace keeps in its own
 * files) and items-files.ts (tests, API definitions, datasets, protos, mocks, script packages: files kept as they are).
 * export.ts, preview.ts and apply.ts talk to them only through this interface, so a new kind is one adapter.
 */
import type { WorkspaceStore } from '../storage/workspace.js';
import type { SecretStripper } from '../storage/bundle-secrets.js';
import { slugify } from '../util/ids.js';
import { sha256, type BundleItem, type BundleKindId } from './format.js';

/** An item the workspace holds. */
export interface Listed {
  id: string;
  name: string;
  size?: number;
}

/** An item as an export holds it: its bytes (secrets already replaced), a summary for the manifest. */
export interface Snapshot extends Listed {
  data: Buffer;
  summary?: Record<string, string | number>;
  /** The bytes went out as they are: no scan of them for secrets was possible (a binary file, a dataset that does not parse). */
  unscanned?: boolean;
}

/** Where an incoming item ends up: its id and name in this workspace after the conflict choice. */
export interface Target {
  id: string;
  name: string;
}

/** One write an adapter performs: the incoming item with its final target, and whether it replaces what is there. */
export interface CommitWrite {
  incoming: BundleItem;
  data: Buffer;
  target: Target;
  op: 'created' | 'replaced';
}

/** Who records what a commit overwrote or made, so one Undo takes it back (journal.ts). */
export interface JournalSink {
  /** The file at `rel` (workspace-relative, `/`) is about to be written or deleted: keep what is there. */
  before(rel: string): void;
  /** The file at `rel` was written: note its checksum (Undo leaves a file that changed since). */
  after(rel: string): void;
  /** An item of a list kept in one file (MCP servers, providers, a library) was added (`before` absent) or replaced. */
  listItem(entry: { kind: BundleKindId; id: string; file: 'mcp-servers' | 'providers' | 'library'; library?: string; before?: unknown }): void;
}

/** The ids that changed on the way in, for the references that point at them (rewrite.ts applies them). */
export interface Remap {
  collection: Map<string, string>;
  /** Workspace paths of file kinds (`specs/a.yaml` → `specs/a-2.yaml`), all folders in one map. */
  path: Map<string, string>;
  /** MCP servers: old name and old id → new name / id. */
  serverName: Map<string, string>;
  serverId: Map<string, string>;
}

export interface ItemAdapter {
  kind: BundleKindId;
  label: string;
  /** Everything of the kind in the workspace (a cheap listing: the items are read only when asked for). */
  list(store: WorkspaceStore): Listed[];
  /** One item for export, secrets replaced; undefined when it is not there. */
  snapshot(store: WorkspaceStore, id: string, strip: SecretStripper): Snapshot | undefined;
  /** Why an incoming item cannot be imported (its content is not the kind's shape, its id cannot be used); undefined when it can. */
  check(item: BundleItem, data: Buffer): string | undefined;
  /** What to look at before running the item (a script, a program an MCP server starts, a production environment). */
  review(item: BundleItem, data: Buffer): string[];
  /** The workspace's counterpart of an incoming item: the same id, or (kinds with unique names) the same name. */
  match(existing: readonly Listed[], incoming: { id: string; name: string }): Listed | undefined;
  /** A free id and name for "Keep both" (`taken`: ids and names already used, extended with the answer). */
  fresh(existing: readonly Listed[], incoming: { id: string; name: string }, taken: { ids: Set<string>; names: Set<string> }): Target;
  /** The item's bytes with the references to items that changed id or path rewritten. */
  rewrite(item: BundleItem, data: Buffer, remap: Remap): Buffer;
  /** Write the items (all of the kind at once, so a list kept in one file is written once). */
  commit(store: WorkspaceStore, writes: CommitWrite[], journal: JournalSink): void;
}

/**
 * JSON with keys in sorted order at every depth: the same item always gives the same bytes (and the same checksum).
 * One pass: a part whose keys are in order already is used as it is, not copied (a big collection is mostly that).
 */
export function canonicalJson(value: unknown): Buffer {
  const own = (o: Record<string, unknown>, k: string, v: unknown) => (k === '__proto__' ? void Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true }) : void (o[k] = v));
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      let out: unknown[] | undefined;
      for (let i = 0; i < v.length; i++) {
        const x = v[i];
        const y = x && typeof x === 'object' ? sort(x) : x;
        if (out) out.push(y);
        else if (y !== x) (out = v.slice(0, i)), out.push(y);
      }
      return out ?? v;
    }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o);
      let ordered = true;
      for (let i = 1; i < keys.length; i++)
        if (keys[i - 1]! > keys[i]!) {
          ordered = false;
          break;
        }
      if (!ordered) keys.sort();
      let out: Record<string, unknown> | undefined = ordered ? undefined : {};
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i]!;
        const x = o[k];
        const y = x && typeof x === 'object' ? sort(x) : x;
        if (out) own(out, k, y);
        else if (y !== x) {
          out = {};
          for (let j = 0; j < i; j++) own(out, keys[j]!, o[keys[j]!]);
          own(out, k, y);
        }
      }
      return out ?? v;
    }
    return v;
  };
  return Buffer.from(JSON.stringify(sort(value), null, 2) + '\n', 'utf8');
}

/**
 * "X (imported)", then "X (imported 2)" … until the name is free (compared without case); the name is added to `names`.
 * `names` holds lowercase names (a set lookup per try, not a scan of the whole set).
 */
export function importedName(names: Set<string>, name: string): string {
  let out = `${name} (imported)`;
  for (let i = 2; names.has(out.toLowerCase()); i++) out = `${name} (imported ${i})`;
  names.add(out.toLowerCase());
  return out;
}

/** The ids and names of a kind's items, found by key: a linear build once per list, then a lookup per incoming item. */
interface ListIndex {
  byId: Map<string, Listed>;
  /** By id once slugified: an item with the very same id is in here under the same key, so this is "same id or same slug". */
  bySlug: Map<string, Listed>;
  byName: Map<string, Listed>;
  byLowerId: Map<string, Listed>;
}
const indexes = new WeakMap<readonly Listed[], ListIndex>();
/** The list must not change after this is asked (a listing is made once per run and only read). */
export function listIndex(existing: readonly Listed[]): ListIndex {
  let ix = indexes.get(existing);
  if (ix) return ix;
  const made: ListIndex = { byId: new Map(), bySlug: new Map(), byName: new Map(), byLowerId: new Map() };
  // the first of equals wins, as `find` did
  const first = <K>(m: Map<K, Listed>, k: K, e: Listed) => void (m.has(k) || m.set(k, e));
  for (const e of existing) {
    first(made.byId, e.id, e);
    first(made.bySlug, slugify(e.id), e);
    first(made.byName, e.name.toLowerCase(), e);
    first(made.byLowerId, e.id.toLowerCase(), e);
  }
  indexes.set(existing, (ix = made));
  return ix;
}

/** Whether a set of taken ids has been given the items already there (once per set: "Keep both" asks for each conflict). */
const seeded = new WeakSet<object>();
export function seedOnce(taken: object, seed: () => void): void {
  if (seeded.has(taken)) return;
  seeded.add(taken);
  seed();
}

/** The checksum of what is in the workspace now, as an export would write it: equal to the bundle's, the item is already here. */
export const fingerprint = (s: Snapshot | undefined): string | undefined => (s ? sha256(s.data) : undefined);

/** `a/b-2.yaml` for `a/b.yaml`: the number goes before the first dot of the file name (`x.openapi.json` → `x-2.openapi.json`). */
export function numberedPath(path: string, n: number): string {
  const slash = path.lastIndexOf('/');
  const dir = path.slice(0, slash + 1);
  const base = path.slice(slash + 1);
  const dot = base.indexOf('.', 1);
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return `${dir}${stem.replace(/-\d+$/, '')}-${n}${dot > 0 ? base.slice(dot) : ''}`;
}

/** Every string value of a JSON value, replaced by `f` (deep; keys and structure stay). */
export function mapStrings(v: unknown, f: (s: string, key: string | undefined) => string, key?: string): unknown {
  if (typeof v === 'string') return f(v, key);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, f, key));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, mapStrings(x, f, k)]));
  return v;
}

/** The pairs of a path map, longest path first (sorted once per map: an import asks for every string of every item). */
interface PathPairs {
  size: number;
  pairs: Array<[string, string]>;
  /** A pair's place in the order of `pairs`, by its old path. */
  rank: Map<string, number>;
  /** The distinct lengths of the old paths (none of them empty), or undefined when one is empty (then every position matches). */
  lengths?: number[];
}
const longestFirst = new WeakMap<Map<string, string>, PathPairs>();

/**
 * Replace each old workspace path by its new one wherever it appears in a text (longest paths first, one after the other:
 * a replacement can make a later path appear). The map is not changed while this is called.
 */
export function replacePaths(text: string, paths: Map<string, string>): string {
  if (!paths.size) return text;
  let known = longestFirst.get(paths);
  if (!known || known.size !== paths.size) {
    const pairs = [...paths].filter(([from, to]) => from !== to).sort((a, b) => b[0].length - a[0].length);
    const rank = new Map(pairs.map(([from], i) => [from, i]));
    known = { size: paths.size, pairs, rank, ...(pairs.some(([from]) => !from) ? {} : { lengths: [...new Set(pairs.map(([from]) => from.length))] }) };
    longestFirst.set(paths, known);
  }
  let out = text;
  const { pairs, rank, lengths } = known;
  // a short text against many paths (an id, a name): look up the text's own pieces instead of asking about every path
  if (lengths && out.length * lengths.length <= pairs.length) {
    for (let at = -1; ; ) {
      // the first path, in the order above and after the one just done, that is in the text now
      let next = -1;
      for (const n of lengths)
        for (let i = 0; i + n <= out.length; i++) {
          const r = rank.get(out.slice(i, i + n));
          if (r !== undefined && r > at && (next < 0 || r < next)) next = r;
        }
      if (next < 0) return out;
      out = out.split(pairs[next]![0]).join(pairs[next]![1]);
      at = next;
    }
  }
  // a path longer than the text cannot be in it
  for (const [from, to] of pairs) if (from.length <= out.length && out.includes(from)) out = out.split(from).join(to);
  return out;
}

/** A kind's label inside a sentence: "API definition", "MCP server", "gRPC call", "collection". */
export const noun = (label: string): string => (/^[A-Z]{2}|^g[A-Z]/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1));
