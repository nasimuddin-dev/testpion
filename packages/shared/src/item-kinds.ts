/**
 * The item-kind registry, static half (planning/master-roadmap.md §1): one entry per kind of thing a user sees in a
 * workspace — what it is called, its icon, how its ItemRef looks, where it is stored, how its folders work, where it
 * opens, which `data.changed` kind a change to it reports, how git merges it, and a complete capability map.
 *
 * Browser-safe data only (no fs, no Node): the window imports it directly (menus read the capabilities with no round
 * trip), the engine adds its facets in packages/core/src/kinds/, and `testpion kinds` / MCP `list_kinds` print it.
 * Every capability is declared: `true` (supported and implemented), `{ na: reason }` (never applies; the reason is
 * shown in docs and reports) or `{ planned: '0.5x' }` (not yet; the completeness test fails once that release is
 * reached). A missing capability is a compile error.
 */
import type { ItemKind, ItemRef, RequestProtocol } from './item-ref.js';
import { KIND_LIST } from './item-kind-list.js';

export type KindId =
  // collections and what they hold
  | 'collection'
  | 'folder'
  | 'request'
  | 'grpc-call'
  | 'ws-connection'
  // workspace files
  | 'environment'
  | 'workspace'
  | 'test'
  | 'flow'
  | 'spec'
  | 'dataset'
  | 'proto'
  | 'script-package'
  | 'mcp-server'
  | 'mcp-mock'
  | 'provider'
  | 'prompt'
  | 'load-test'
  | 'evaluation'
  | 'monitor'
  | 'rag-target'
  | 'metric'
  | 'debugger-rules'
  | 'capture'
  | 'baseline'
  // records (not workspace files)
  | 'run'
  | 'history'
  | 'trace'
  | 'exchange'
  | 'proposal'
  // ref-only (addressable, no storage of their own)
  | 'variable'
  | 'test-case'
  | 'certificate'
  | 'git-file'
  | 'doc'
  | 'mock';

export const CAPABILITIES = [
  'open',
  'open-new-tab',
  'link',
  'container',
  'rename',
  'duplicate',
  'move',
  'favorite',
  'delete',
  'trash',
  'run',
  'monitor',
  'ci',
  'test-file',
  'flow',
  'ai',
  'export',
  'import',
  'uses',
  'versioned',
  'git-history',
  'git-discard',
  'git-stage',
  'secret-scan',
  'watch',
  'search',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** true = supported and implemented; na = never applies (the reason is shown in docs and the report); planned = not yet, fails CI from that release on. */
export type CapabilityState = true | { na: string } | { planned: `0.${number}` };
export type Capabilities = Readonly<Record<Capability, CapabilityState>>;

export type KindStorage =
  | { layout: 'file-per-item'; dir: string; ext: readonly string[] }
  | { layout: 'nested'; in: KindId }
  | { layout: 'items-in-file'; file: string; key: string }
  | { layout: 'library'; library: string }
  | { layout: 'raw-document'; dir: string; glob: string; binary?: string }
  | { layout: 'single-file'; file: string }
  | { layout: 'record'; where: 'meta' | 'runs' | 'traces' | 'local' | 'memory' }
  | { layout: 'ref-only' };

/** The `data.changed` / folder-watcher kinds of today (`kinds` of the event); 0.57 adds the canonical kind beside them. */
export type WatchKind = 'collections' | 'environments' | 'tests' | 'datasets' | 'library' | 'mcp' | 'providers' | 'workspace' | 'specs' | 'other';

export interface ItemKindInfo {
  id: KindId;
  /** The ItemRef kind ('saved' for library kinds); absent: the kind has no ItemRef (yet). */
  ref?: ItemKind;
  /** For ref 'saved' and library storage: 'grpc', 'ai-prompts' … */
  library?: string;
  /** flow → test */
  variantOf?: KindId;
  /** Other names accepted as input (CLI flags, bundle manifests, MCP): 'library:grpc', 'saved:grpc', 'test-file' … */
  aliases: readonly string[];
  label: string;
  plural: string;
  /** A lucide icon name (the window maps it). */
  icon: string;
  /** The subtitle of a search hit (search.ts). */
  searchLabel?: string;
  storage: KindStorage;
  /** virtual: the library holding the folder names (spec-folders …). */
  folders: 'nodes' | 'dirs' | { virtual: string } | 'none';
  parent?: KindId;
  opens: { view: string } | { dialog: string } | 'external' | 'none';
  watch: { legacy: WatchKind; canonical: string } | 'none';
  git: { merge: 'by-id' | 'fields' | 'text' | 'binary-ours' | 'none'; ignored?: boolean; textconv?: boolean };
  size?: { gitWarnBytes?: number; bundleEmbedBytes?: number; gitLfsBytes?: number; gitRefuseBytes?: number };
  /** Registered ahead of its release (rag-target, metric): left out of every derived table until then. */
  since?: `0.${number}`;
  /** The id kindOfPath finds in a path is the ItemRef's own id (refOfWorkspacePath makes the ref from the path). */
  pathRef?: boolean;
  /**
   * What kindOfPath takes as the id of a raw document: the path inside the kind's folder (default), the whole workspace
   * path (`path`: an API definition's `specs/x.yaml`), or the file name without its extension (`stem`: a package, a
   * capture session).
   */
  pathId?: 'path' | 'stem';
  /** Every file in the kind's folder is one (the glob only says what opens): kindOfPath names any path under it. */
  anyFile?: true;
  /** Shown as a list (or tree) of its own in a view, with a section header that has a menu (New …, Expand all …). */
  listed?: true;
  /** A path of this kind in tests/fixtures/kinds/workspace (the completeness test checks kindOfPath on it). */
  sample?: string;
  capabilities: Capabilities;
}

const kinds = KIND_LIST;
export const KIND_INFO: Readonly<Record<KindId, ItemKindInfo>> = Object.freeze(Object.fromEntries(kinds.map((k) => [k.id, Object.freeze(k)])) as Record<KindId, ItemKindInfo>);
export const KIND_IDS = kinds.map((k) => k.id) as readonly KindId[];

/** Kinds that are live in this version (not registered ahead of their release). */
export const liveKinds = (): ItemKindInfo[] => kinds.filter((k) => !k.since);

/** The kind with this id, or undefined for any other string (a node kind, a name): no cast needed at the call site. */
export const kindInfoOf = (id: string): ItemKindInfo | undefined => (KIND_INFO as Record<string, ItemKindInfo | undefined>)[id];

/** Whether a capability is supported and implemented (`true`), never a `na` or a `planned`. */
export const can = (kind: KindId, cap: Capability): boolean => KIND_INFO[kind]?.capabilities[cap] === true;

/** The live kinds with a capability. */
export const kindsWith = (cap: Capability): ItemKindInfo[] => liveKinds().filter((k) => k.capabilities[cap] === true);

/** A kind by its id or one of its aliases (`library:grpc`, `test-file`, `history-entry` …); undefined for an unknown name. */
export function kindByName(name: string): ItemKindInfo | undefined {
  const n = String(name ?? '')
    .trim()
    .toLowerCase();
  return kindInfoOf(n) ?? kinds.find((k) => k.aliases.includes(n));
}

/** The kind of a library's items (grpc → grpc-call, monitors → monitor); live kinds only. */
export const kindOfLibrary = (library: string): ItemKindInfo | undefined => liveKinds().find((k) => k.library === library);

/** The registry kind of an ItemRef ('saved' by its library); undefined for a library this version doesn't know. */
export function kindOfRef(ref: Pick<ItemRef, 'kind'> & { library?: string }): ItemKindInfo | undefined {
  if (ref.kind === 'saved') return kinds.find((k) => k.library === ref.library && (k.ref === 'saved' || k.ref === 'monitor'));
  return kindInfoOf(ref.kind);
}

/** The label of a ref kind that names no single kind (a library item of an unknown library). */
export const SAVED_ITEM_LABEL = 'Saved item';

/** The editor of each request protocol (SOAP is edited as HTTP). */
export const REQUEST_PROTOCOL_VIEW: Readonly<Record<RequestProtocol, string>> = { http: 'rest', soap: 'rest', graphql: 'graphql', grpc: 'grpc', websocket: 'websocket' };

/** The view a kind opens in, or undefined (a dialog, a page outside the app, opened from something else). */
export const viewOfKind = (kind: KindId): string | undefined => {
  const o = KIND_INFO[kind]?.opens;
  return o && typeof o === 'object' && 'view' in o ? o.view : undefined;
};

/* ------------------------------------------------------------------ paths (lexical: the same answer on every OS) */

/** A path from the workspace root with `/` and no leading `./` (a `\` path from Windows counts the same). */
const normal = (path: string) =>
  String(path ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '');

/** The library of a `library/<name>.json` path (also folder libraries and libraries this version doesn't know). */
export function libraryOfPath(path: string, opts: { raw?: boolean } = {}): string | undefined {
  const p = opts.raw ? path : normal(path);
  return /^library\/([a-z0-9-]+)\.json$/.exec(p)?.[1];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A storage glob (`**\/*.{yaml,yml}`, `*.js`, `**\/*`) as a regular expression over a path inside the kind's folder. */
function globRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*' && glob[i + 2] === '/') {
      re += '(?:.*/)?';
      i += 2;
    } else if (c === '*') re += '[^/]*';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      re += `(?:${glob
        .slice(i + 1, end)
        .split(',')
        .map(escapeRe)
        .join('|')})`;
      i = end;
    } else re += escapeRe(c);
  }
  return new RegExp(`^${re}$`, 'i');
}
const globs = new Map<KindId, RegExp>();
const globOf = (k: ItemKindInfo, glob: string): RegExp => {
  let re = globs.get(k.id);
  if (!re) globs.set(k.id, (re = globRegExp(glob)));
  return re;
};

/** The kinds a path is matched against, in the registry's order: a variant (a flow) is stored as its base kind. */
const storedKinds = kinds.filter((k) => !k.variantOf);

/**
 * The kind of a workspace path, lexically (no file is read, `/` and `\` alike), from what each kind's `storage`
 * declares: `id` when the path names one item, as its ItemRef names it (a collection's id, a test file's path inside
 * tests/, a spec's workspace path, a dataset's name under datasets/). Undefined for a path that belongs to no kind.
 * `raw`: the path is already relative with `/` (the folder watcher's), so it is taken as it is. The records without a
 * storage folder of their own (runs, traces, AI proposals) are the explicit tail.
 */
export function kindOfPath(path: string, opts: { raw?: boolean } = {}): { kind: KindId; id?: string } | undefined {
  const p = opts.raw ? path : normal(path);
  const withId = (kind: KindId, id: string | undefined) => (id ? { kind, id } : { kind });
  // one file: the workspace file, a list kept in one file (MCP servers, providers), the Debugger rules
  for (const k of storedKinds) {
    const s = k.storage;
    if ((s.layout === 'single-file' || s.layout === 'items-in-file') && p === s.file) return { kind: k.id };
  }
  const lib = libraryOfPath(p, { raw: true });
  if (lib) {
    const k = kinds.find((x) => x.storage.layout === 'library' && x.storage.library === lib);
    return k ? { kind: k.id } : undefined;
  }
  const slash = p.indexOf('/');
  if (slash < 0) return undefined;
  const top = p.slice(0, slash);
  const rest = p.slice(slash + 1);
  for (const k of storedKinds) {
    const s = k.storage;
    if (s.layout === 'file-per-item' && s.dir === top) {
      // one item per file directly in the folder, named by its id
      const ext = rest.includes('/') ? undefined : s.ext.find((e) => rest.endsWith(e));
      return withId(k.id, ext ? rest.slice(0, -ext.length) : undefined);
    }
    if (s.layout === 'raw-document' && s.dir === top) {
      if (!rest || (!k.anyFile && !globOf(k, s.glob).test(rest))) return { kind: k.id };
      return withId(k.id, k.pathId === 'path' ? p : k.pathId === 'stem' ? rest.replace(/\.[^./]+$/, '') : rest);
    }
  }
  switch (top) {
    case 'runs':
      return withId('run', /^([^/]+)/.exec(rest)?.[1]);
    case 'traces':
      return withId('trace', rest || undefined);
    case '.local':
      return /^ai\/proposals\//.test(rest) ? withId('proposal', /^ai\/proposals\/([^/]+)\.json$/.exec(rest)?.[1]) : undefined;
    default:
      return undefined;
  }
}

/**
 * How a workspace file merges by meaning (git merge driver, conflict screen): a collection, an environment, or a library
 * file (library/<name>.json), the list of MCP servers or of AI providers (by id); undefined for a file git merges line by
 * line. The Debugger rules and the workspace file join later (planning/master-roadmap.md §1.7 row 10).
 */
export function mergeModeOfPath(path: string): 'collection' | 'environment' | 'library' | 'servers' | 'providers' | 'workspace' | 'debugger-rules' | undefined {
  const k = kindOfPath(path, { raw: true });
  if (k?.kind === 'workspace') return 'workspace';
  if (k?.kind === 'debugger-rules') return 'debugger-rules';
  if (k?.id && k.kind === 'collection') return 'collection';
  if (k?.id && k.kind === 'environment') return 'environment';
  if (k?.kind === 'mcp-server') return 'servers';
  if (k?.kind === 'provider') return 'providers';
  if (libraryOfPath(path, { raw: true })) return 'library';
  return undefined;
}

/** The `data.changed` kind (today's strings) of a changed workspace file; the folder watcher sorts changes with it. */
export function watchKindOfPath(path: string, opts: { raw?: boolean } = {}): WatchKind {
  const k = kindOfPath(path, opts);
  const w = k ? KIND_INFO[k.kind].watch : undefined;
  if (w && w !== 'none') return w.legacy;
  return libraryOfPath(path, opts) || (opts.raw ? path : normal(path)).startsWith('library/') ? 'library' : 'other';
}
