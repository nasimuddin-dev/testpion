/**
 * What an item adapter is (one per kind a bundle holds) and the helpers they share. The adapters themselves are in
 * items-json.ts (collections, environments, MCP servers, providers, saved items: JSON the workspace keeps in its own
 * files) and items-files.ts (tests, API definitions, datasets, protos, mocks, script packages: files kept as they are).
 * export.ts, preview.ts and apply.ts talk to them only through this interface, so a new kind is one adapter.
 */
import type { WorkspaceStore } from '../storage/workspace.js';
import type { SecretStripper } from '../storage/bundle-secrets.js';
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

/** JSON with keys in sorted order at every depth: the same item always gives the same bytes (and the same checksum). */
export function canonicalJson(value: unknown): Buffer {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.keys(v as object)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    return v;
  };
  return Buffer.from(JSON.stringify(sort(value), null, 2) + '\n', 'utf8');
}

/** "X (imported)", then "X (imported 2)" … until the name is free (compared without case); the name is added to `names`. */
export function importedName(names: Set<string>, name: string): string {
  const has = (n: string) => [...names].some((x) => x.toLowerCase() === n.toLowerCase());
  let out = `${name} (imported)`;
  for (let i = 2; has(out); i++) out = `${name} (imported ${i})`;
  names.add(out);
  return out;
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

/** Replace each old workspace path by its new one wherever it appears in a text (longest paths first). */
export function replacePaths(text: string, paths: Map<string, string>): string {
  if (!paths.size) return text;
  let out = text;
  for (const [from, to] of [...paths].sort((a, b) => b[0].length - a[0].length)) if (from !== to && out.includes(from)) out = out.split(from).join(to);
  return out;
}

/** A kind's label inside a sentence: "API definition", "MCP server", "gRPC call", "collection". */
export const noun = (label: string): string => (/^[A-Z]{2}|^g[A-Z]/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1));
