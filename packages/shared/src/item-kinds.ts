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
export type WatchKind = 'collections' | 'environments' | 'tests' | 'library' | 'mcp' | 'providers' | 'workspace' | 'specs' | 'other';

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
  /** A path of this kind in tests/fixtures/kinds/workspace (the completeness test checks kindOfPath on it). */
  sample?: string;
  capabilities: Capabilities;
}

/* ------------------------------------------------------------------ capability profiles (each one complete) */

const NA_RECORD = 'a record of something that happened: it is kept or cleared, not edited';
const NA_REF = 'addressable only: it has no storage of its own';
const NA_NESTED = 'restored from the collection snapshot by Undo';

/** Everything a stored item of a workspace can have, before the kind's own answers. */
const FILE_ITEM: Capabilities = {
  open: true,
  'open-new-tab': { na: 'it opens in one place, not in editor tabs' },
  link: true,
  container: { na: 'an item, not a folder: it holds nothing' },
  rename: true,
  duplicate: true,
  move: { planned: '0.53' },
  favorite: { na: 'favorites are saved requests (one click away in the sidebar)' },
  delete: true,
  trash: { planned: '0.53' },
  run: { na: 'nothing to run: it is used by what runs' },
  monitor: { na: 'monitors run collections and test files on a schedule' },
  ci: { na: 'CI runs collections and test files' },
  'test-file': { na: 'test files are created from requests, collections and calls' },
  flow: { na: 'integration flows are generated from collections and folders' },
  ai: { planned: '0.59' },
  export: { planned: '0.53' },
  import: { planned: '0.53' },
  uses: { planned: '0.54' },
  versioned: { planned: '0.57' },
  'git-history': { planned: '0.58' },
  'git-discard': { planned: '0.58' },
  'git-stage': { planned: '0.58' },
  'secret-scan': { planned: '0.58' },
  watch: true,
  search: true,
};

const RECORD: Capabilities = {
  open: true,
  'open-new-tab': { na: 'records open in their own view' },
  link: true,
  container: { na: 'a record holds nothing to expand' },
  rename: { na: NA_RECORD },
  duplicate: { na: NA_RECORD },
  move: { na: NA_RECORD },
  favorite: { na: 'favorites are saved requests (one click away in the sidebar)' },
  delete: { na: 'records are cleared from their own view (Delete asks there)' },
  trash: { na: 'records are not kept in Recently deleted' },
  run: { na: NA_RECORD },
  monitor: { na: NA_RECORD },
  ci: { na: NA_RECORD },
  'test-file': { na: NA_RECORD },
  flow: { na: NA_RECORD },
  ai: { planned: '0.59' },
  export: { na: 'records export as reports (HAR, HTML, JUnit), not bundles' },
  import: { na: 'records are made by running, never imported' },
  uses: { na: NA_RECORD },
  versioned: { na: 'records stay out of git (results and local state)' },
  'git-history': { na: 'records stay out of git (results and local state)' },
  'git-discard': { na: 'records stay out of git (results and local state)' },
  'git-stage': { na: 'records stay out of git (results and local state)' },
  'secret-scan': { na: 'records are local, never committed or exported' },
  watch: { na: 'records change on every run: nothing outside the app edits them' },
  search: true,
};

const REF_ONLY: Capabilities = {
  ...RECORD,
  open: true,
  link: true,
  delete: { na: NA_REF },
  trash: { na: NA_REF },
  rename: { na: NA_REF },
  duplicate: { na: NA_REF },
  move: { na: NA_REF },
  run: { na: NA_REF },
  monitor: { na: NA_REF },
  ci: { na: NA_REF },
  'test-file': { na: NA_REF },
  flow: { na: NA_REF },
  ai: { na: NA_REF },
  export: { na: NA_REF },
  import: { na: NA_REF },
  uses: { na: NA_REF },
  versioned: { na: NA_REF },
  'git-history': { na: NA_REF },
  'git-discard': { na: NA_REF },
  'git-stage': { na: NA_REF },
  'secret-scan': { na: NA_REF },
  watch: { na: NA_REF },
  search: { na: 'found through the item that holds it' },
};

/** A saved item of a library (library/<library>.json): folders, rename, duplicate, move to folder, delete with Undo. */
const LIBRARY_ITEM: Capabilities = {
  ...FILE_ITEM,
  'open-new-tab': true,
  move: true,
  trash: { planned: '0.53' },
};

/* ------------------------------------------------------------------ the kinds */

const kinds: ItemKindInfo[] = [
  {
    id: 'collection',
    ref: 'collection',
    aliases: ['collections'],
    label: 'Collection',
    plural: 'Collections',
    icon: 'folder-tree',
    searchLabel: 'Collection',
    storage: { layout: 'file-per-item', dir: 'collections', ext: ['.json'] },
    folders: 'nodes',
    opens: { view: 'collections' },
    watch: { legacy: 'collections', canonical: 'collection' },
    git: { merge: 'by-id' },
    sample: 'collections/api.json',
    capabilities: {
      ...FILE_ITEM,
      container: true,
      move: { na: 'collections are the top level of the tree' },
      trash: true,
      run: true,
      monitor: true,
      ci: true,
      'test-file': true,
      flow: true,
      export: true,
      versioned: true,
      'git-history': true,
    },
  },
  {
    id: 'folder',
    ref: 'folder',
    aliases: [],
    label: 'Folder',
    plural: 'Folders',
    icon: 'folder',
    storage: { layout: 'nested', in: 'collection' },
    folders: 'nodes',
    parent: 'collection',
    opens: { view: 'collections' },
    watch: { legacy: 'collections', canonical: 'collection' },
    git: { merge: 'by-id' },
    capabilities: {
      ...FILE_ITEM,
      container: true,
      move: true,
      trash: { na: NA_NESTED },
      run: true,
      monitor: true,
      ci: true,
      'test-file': true,
      flow: true,
      export: { planned: '0.53' },
      versioned: { na: 'versioned with its collection file' },
      'git-history': { planned: '0.58' },
      watch: { na: 'watched as its collection file' },
      search: { na: 'found through the requests it holds' },
    },
  },
  {
    id: 'request',
    ref: 'request',
    aliases: ['http', 'soap', 'graphql'],
    label: 'Request',
    plural: 'Requests',
    icon: 'send',
    searchLabel: 'Request',
    storage: { layout: 'nested', in: 'collection' },
    folders: 'none',
    parent: 'collection',
    opens: { view: 'rest' },
    watch: { legacy: 'collections', canonical: 'collection' },
    git: { merge: 'by-id' },
    capabilities: {
      ...FILE_ITEM,
      'open-new-tab': true,
      move: true,
      favorite: true,
      trash: { na: NA_NESTED },
      run: { planned: '0.53' },
      monitor: true,
      ci: { planned: '0.53' },
      'test-file': true,
      flow: { planned: '0.53' },
      export: { planned: '0.53' },
      versioned: { na: 'versioned with its collection file' },
      'git-history': true,
      watch: { na: 'watched as its collection file' },
    },
  },
  {
    id: 'grpc-call',
    ref: 'saved',
    library: 'grpc',
    aliases: ['library:grpc', 'saved:grpc', 'grpc'],
    label: 'gRPC call',
    plural: 'gRPC calls',
    icon: 'radio',
    searchLabel: 'Saved gRPC request',
    storage: { layout: 'library', library: 'grpc' },
    folders: { virtual: 'grpc' },
    parent: 'collection',
    opens: { view: 'grpc' },
    watch: { legacy: 'library', canonical: 'grpc-call' },
    git: { merge: 'by-id' },
    sample: 'library/grpc.json',
    capabilities: { ...LIBRARY_ITEM, 'test-file': true, monitor: { planned: '0.53' } },
  },
  {
    id: 'ws-connection',
    ref: 'saved',
    library: 'websocket',
    aliases: ['library:websocket', 'saved:websocket', 'websocket', 'connection'],
    label: 'Connection',
    plural: 'Connections',
    icon: 'cable',
    searchLabel: 'Saved connection',
    storage: { layout: 'library', library: 'websocket' },
    folders: { virtual: 'websocket' },
    parent: 'collection',
    opens: { view: 'websocket' },
    watch: { legacy: 'library', canonical: 'ws-connection' },
    git: { merge: 'by-id' },
    sample: 'library/websocket.json',
    capabilities: { ...LIBRARY_ITEM, 'test-file': true },
  },
  {
    id: 'environment',
    ref: 'environment',
    aliases: ['environments', 'env'],
    label: 'Environment',
    plural: 'Environments',
    icon: 'globe',
    searchLabel: 'Environment',
    storage: { layout: 'file-per-item', dir: 'environments', ext: ['.json'] },
    folders: 'none',
    opens: { view: 'environments' },
    watch: { legacy: 'environments', canonical: 'environment' },
    git: { merge: 'by-id' },
    sample: 'environments/staging.json',
    capabilities: {
      ...FILE_ITEM,
      run: { na: 'an environment is made active, not run' },
      move: { na: 'environments have no folders' },
      trash: true,
      export: { planned: '0.53' },
      versioned: true,
      'git-history': true,
    },
  },
  {
    id: 'workspace',
    ref: 'environment',
    aliases: ['workspace-variables'],
    label: 'Workspace',
    plural: 'Workspaces',
    icon: 'layers',
    storage: { layout: 'single-file', file: 'workspace.json' },
    folders: 'none',
    opens: { view: 'environments' },
    watch: { legacy: 'workspace', canonical: 'workspace' },
    git: { merge: 'fields' },
    sample: 'workspace.json',
    capabilities: {
      ...FILE_ITEM,
      rename: { na: 'renamed from the workspace menu' },
      duplicate: { na: 'duplicated from the workspace menu' },
      move: { na: 'one per workspace' },
      delete: { na: 'one per workspace' },
      trash: { na: 'one per workspace' },
      export: { na: 'part of every whole-workspace export' },
      import: { na: 'part of every whole-workspace import' },
      search: { na: 'its variables are found by name' },
    },
  },
  {
    id: 'test',
    ref: 'test',
    aliases: ['test-file', 'suite', 'tests'],
    label: 'Test file',
    plural: 'Test files',
    icon: 'file-check-2',
    searchLabel: 'Test file',
    storage: { layout: 'raw-document', dir: 'tests', glob: '**/*.{yaml,yml,json}' },
    folders: 'dirs',
    opens: { view: 'tests' },
    watch: { legacy: 'tests', canonical: 'test' },
    git: { merge: 'text' },
    sample: 'tests/smoke/login.yaml',
    capabilities: {
      ...FILE_ITEM,
      'open-new-tab': true,
      run: true,
      monitor: true,
      ci: true,
      'test-file': { na: 'it is a test file already' },
      flow: { na: 'opened as a flow in the canvas (a flow file)' },
      move: { planned: '0.53' },
      trash: { planned: '0.53' },
      export: true,
      versioned: true,
    },
  },
  {
    id: 'flow',
    ref: 'flow',
    variantOf: 'test',
    aliases: ['flows'],
    label: 'Flow',
    plural: 'Flows',
    icon: 'workflow',
    storage: { layout: 'raw-document', dir: 'tests', glob: '**/*.{yaml,yml,json}' },
    folders: 'dirs',
    opens: { view: 'tests' },
    watch: { legacy: 'tests', canonical: 'test' },
    git: { merge: 'text' },
    capabilities: {
      ...FILE_ITEM,
      'open-new-tab': true,
      run: true,
      monitor: true,
      ci: true,
      'test-file': { na: 'it is a test file already' },
      flow: { na: 'it is a flow already' },
      trash: { planned: '0.53' },
      export: true,
      versioned: true,
      search: { na: 'found as its test file' },
    },
  },
  {
    id: 'dataset',
    ref: 'dataset',
    aliases: ['datasets', 'data'],
    label: 'Dataset',
    plural: 'Datasets',
    icon: 'database',
    searchLabel: 'Dataset',
    storage: { layout: 'raw-document', dir: 'datasets', glob: '**/*.{csv,tsv,json,jsonl,ndjson,md,db,db3,sqlite,sqlite3}', binary: '*.{db,db3,sqlite,sqlite3}' },
    folders: { virtual: 'dataset-folders' },
    opens: { view: 'dataset' },
    watch: { legacy: 'tests', canonical: 'dataset' },
    git: { merge: 'text' },
    size: { gitWarnBytes: 5 * 1024 * 1024, bundleEmbedBytes: 10 * 1024 * 1024, gitLfsBytes: 50 * 1024 * 1024, gitRefuseBytes: 100 * 1024 * 1024 },
    sample: 'datasets/users.csv',
    capabilities: { ...FILE_ITEM, move: true, trash: true, run: true, versioned: true },
  },
  {
    id: 'spec',
    ref: 'spec',
    aliases: ['api-definition', 'openapi', 'asyncapi', 'specs'],
    label: 'API definition',
    plural: 'API definitions',
    icon: 'file-code-2',
    searchLabel: 'API definition',
    storage: { layout: 'raw-document', dir: 'specs', glob: '**/*' },
    folders: { virtual: 'spec-folders' },
    opens: { view: 'apidef' },
    watch: { legacy: 'specs', canonical: 'spec' },
    git: { merge: 'text' },
    sample: 'specs/petstore.yaml',
    capabilities: {
      ...FILE_ITEM,
      duplicate: { planned: '0.53' },
      move: true,
      trash: true,
      'test-file': true,
      flow: true,
      export: { planned: '0.53' },
      versioned: true,
    },
  },
  {
    id: 'proto',
    ref: 'git-file',
    aliases: ['protos'],
    label: 'Proto file',
    plural: 'Proto files',
    icon: 'file-type',
    storage: { layout: 'raw-document', dir: 'protos', glob: '**/*.proto' },
    folders: 'dirs',
    opens: 'none',
    watch: { legacy: 'other', canonical: 'proto' },
    git: { merge: 'text' },
    sample: 'protos/greeter.proto',
    capabilities: {
      ...FILE_ITEM,
      open: { na: 'opened from its gRPC call' },
      link: { na: 'linked through its gRPC call' },
      rename: { na: 'managed from its gRPC call' },
      duplicate: { na: 'managed from its gRPC call' },
      move: { na: 'managed from its gRPC call' },
      delete: { na: 'managed from its gRPC call' },
      search: { na: 'found through its gRPC call' },
    },
  },
  {
    id: 'script-package',
    ref: 'git-file',
    aliases: ['package', 'packages'],
    label: 'Script package',
    plural: 'Script packages',
    icon: 'package',
    storage: { layout: 'raw-document', dir: 'packages', glob: '*.js' },
    folders: 'none',
    opens: { view: 'settings' },
    watch: { legacy: 'other', canonical: 'script-package' },
    git: { merge: 'text' },
    sample: 'packages/helpers.js',
    capabilities: {
      ...FILE_ITEM,
      link: { na: 'used by name in scripts (tp.require)' },
      duplicate: { na: 'one module per name' },
      move: { na: 'packages have no folders' },
      trash: { na: 'deleting a package asks first (scripts may require it)' },
      search: { na: 'found by name in Settings' },
    },
  },
  {
    id: 'mcp-server',
    ref: 'mcp-server',
    aliases: ['mcp', 'server'],
    label: 'MCP server',
    plural: 'MCP servers',
    icon: 'plug',
    searchLabel: 'MCP server',
    storage: { layout: 'items-in-file', file: 'mcp-servers.json', key: 'servers' },
    folders: { virtual: 'mcp-folders' },
    opens: { view: 'mcp' },
    watch: { legacy: 'mcp', canonical: 'mcp-server' },
    git: { merge: 'by-id' },
    sample: 'mcp-servers.json',
    capabilities: { ...FILE_ITEM, 'open-new-tab': true, move: true, trash: true, run: true, 'test-file': { planned: '0.53' }, monitor: { planned: '0.53' } },
  },
  {
    id: 'mcp-mock',
    ref: 'git-file',
    aliases: ['toolset', 'mock-file'],
    label: 'MCP mock',
    plural: 'MCP mocks',
    icon: 'boxes',
    storage: { layout: 'raw-document', dir: 'mocks', glob: '*.mcp-mock.yaml' },
    folders: 'none',
    opens: 'none',
    watch: { legacy: 'other', canonical: 'mcp-mock' },
    git: { merge: 'text' },
    sample: 'mocks/weather.mcp-mock.yaml',
    capabilities: {
      ...FILE_ITEM,
      open: { na: 'opened from its MCP server' },
      link: { na: 'linked through its MCP server' },
      rename: { na: 'managed from its MCP server' },
      duplicate: { na: 'managed from its MCP server' },
      move: { na: 'managed from its MCP server' },
      delete: { na: 'managed from its MCP server' },
      search: { na: 'found through its MCP server' },
    },
  },
  {
    id: 'provider',
    ref: 'provider',
    aliases: ['providers', 'ai-provider'],
    label: 'AI provider',
    plural: 'AI providers',
    icon: 'bot',
    searchLabel: 'AI provider',
    storage: { layout: 'items-in-file', file: 'providers.json', key: 'providers' },
    folders: 'none',
    opens: { view: 'ai' },
    watch: { legacy: 'providers', canonical: 'provider' },
    git: { merge: 'by-id' },
    sample: 'providers.json',
    capabilities: { ...FILE_ITEM, rename: { na: 'renamed in its settings' }, move: { na: 'providers have no folders' } },
  },
  {
    id: 'prompt',
    ref: 'saved',
    library: 'ai-prompts',
    aliases: ['library:ai-prompts', 'saved:ai-prompts', 'prompts'],
    label: 'Prompt',
    plural: 'Prompts',
    icon: 'message-square',
    searchLabel: 'Saved prompt',
    storage: { layout: 'library', library: 'ai-prompts' },
    folders: { virtual: 'ai-prompts' },
    opens: { view: 'ai' },
    watch: { legacy: 'library', canonical: 'prompt' },
    git: { merge: 'by-id' },
    sample: 'library/ai-prompts.json',
    capabilities: { ...LIBRARY_ITEM, 'test-file': { planned: '0.53' } },
  },
  {
    id: 'load-test',
    ref: 'saved',
    library: 'load-tests',
    aliases: ['library:load-tests', 'saved:load-tests', 'load'],
    label: 'Load test',
    plural: 'Load tests',
    icon: 'gauge',
    searchLabel: 'Saved load test',
    storage: { layout: 'library', library: 'load-tests' },
    folders: { virtual: 'load-tests' },
    opens: { view: 'load' },
    watch: { legacy: 'library', canonical: 'load-test' },
    git: { merge: 'by-id' },
    sample: 'library/load-tests.json',
    capabilities: { ...LIBRARY_ITEM, run: true, ci: { planned: '0.53' } },
  },
  {
    id: 'evaluation',
    ref: 'saved',
    library: 'evaluations',
    aliases: ['library:evaluations', 'saved:evaluations', 'evaluations', 'eval'],
    label: 'Evaluation',
    plural: 'Evaluations',
    icon: 'flask-conical',
    searchLabel: 'Saved evaluation',
    storage: { layout: 'library', library: 'evaluations' },
    folders: { virtual: 'evaluations' },
    opens: { view: 'evaluations' },
    watch: { legacy: 'library', canonical: 'evaluation' },
    git: { merge: 'by-id' },
    sample: 'library/evaluations.json',
    capabilities: { ...LIBRARY_ITEM, run: true, ci: { planned: '0.53' }, monitor: { planned: '0.53' } },
  },
  {
    id: 'monitor',
    ref: 'monitor',
    library: 'monitors',
    aliases: ['library:monitors', 'saved:monitors', 'monitors'],
    label: 'Monitor',
    plural: 'Monitors',
    icon: 'alarm-clock',
    searchLabel: 'Monitor',
    storage: { layout: 'library', library: 'monitors' },
    folders: { virtual: 'monitors' },
    opens: { view: 'monitors' },
    watch: { legacy: 'library', canonical: 'monitor' },
    git: { merge: 'by-id' },
    sample: 'library/monitors.json',
    capabilities: { ...LIBRARY_ITEM, run: true },
  },
  {
    id: 'rag-target',
    ref: 'saved',
    library: 'rag-targets',
    aliases: ['library:rag-targets', 'saved:rag-targets'],
    label: 'RAG target',
    plural: 'RAG targets',
    icon: 'library',
    searchLabel: 'RAG target',
    storage: { layout: 'library', library: 'rag-targets' },
    folders: { virtual: 'rag-targets' },
    opens: { view: 'ai' },
    watch: { legacy: 'library', canonical: 'rag-target' },
    git: { merge: 'by-id' },
    since: '0.60',
    capabilities: { ...LIBRARY_ITEM, open: { planned: '0.60' }, link: { planned: '0.60' }, rename: { planned: '0.60' }, duplicate: { planned: '0.60' }, move: { planned: '0.60' }, delete: { planned: '0.60' }, trash: { planned: '0.60' }, run: { planned: '0.60' }, export: { planned: '0.60' }, watch: { planned: '0.60' }, search: { planned: '0.60' }, 'open-new-tab': { planned: '0.60' } },
  },
  {
    id: 'metric',
    aliases: ['metrics', 'custom-metric'],
    label: 'Metric',
    plural: 'Metrics',
    icon: 'ruler',
    storage: { layout: 'raw-document', dir: 'metrics', glob: '*.yaml' },
    folders: 'none',
    opens: { view: 'ai' },
    watch: { legacy: 'other', canonical: 'metric' },
    git: { merge: 'text' },
    since: '0.61',
    sample: 'metrics/politeness.yaml',
    capabilities: { ...FILE_ITEM, open: { planned: '0.61' }, link: { planned: '0.61' }, rename: { planned: '0.61' }, duplicate: { planned: '0.61' }, move: { na: 'metrics have no folders' }, delete: { planned: '0.61' }, trash: { planned: '0.61' }, search: { planned: '0.61' } },
  },
  {
    id: 'debugger-rules',
    ref: 'git-file',
    aliases: ['rules'],
    label: 'Debugger rules',
    plural: 'Debugger rules',
    icon: 'list-filter',
    storage: { layout: 'single-file', file: 'debugger/rules.json' },
    folders: 'none',
    opens: { view: 'debugger' },
    watch: { legacy: 'other', canonical: 'debugger-rules' },
    git: { merge: 'by-id' },
    sample: 'debugger/rules.json',
    capabilities: {
      ...FILE_ITEM,
      link: { na: 'one rule list per workspace' },
      rename: { na: 'one rule list per workspace' },
      duplicate: { na: 'one rule list per workspace' },
      move: { na: 'one rule list per workspace' },
      delete: { na: 'edited in place (each rule has its own Delete)' },
      trash: { na: 'edited in place (each rule has its own Delete)' },
      search: { na: 'one rule list per workspace' },
    },
  },
  {
    id: 'capture',
    ref: 'capture',
    aliases: ['session', 'har'],
    label: 'Capture session',
    plural: 'Capture sessions',
    icon: 'radar',
    storage: { layout: 'raw-document', dir: 'debugger', glob: '*.har' },
    folders: 'none',
    opens: { view: 'debugger' },
    watch: { legacy: 'other', canonical: 'capture' },
    git: { merge: 'text', ignored: true },
    sample: 'debugger/morning capture.har',
    capabilities: {
      ...FILE_ITEM,
      rename: { na: 'saved again under another name from the Debugger' },
      duplicate: { na: 'saved again under another name from the Debugger' },
      move: { na: 'sessions have no folders' },
      delete: { planned: '0.58' },
      trash: { na: 'sessions are local to this computer' },
      export: true,
      versioned: { planned: '0.58' },
      search: { na: 'listed in the Debugger session menu' },
    },
  },
  {
    id: 'baseline',
    aliases: ['baselines'],
    label: 'Baseline',
    plural: 'Baselines',
    icon: 'file-diff',
    storage: { layout: 'raw-document', dir: 'baselines', glob: '*.json' },
    folders: 'none',
    opens: 'none',
    watch: 'none',
    git: { merge: 'none', ignored: true },
    sample: 'baselines/pets.json',
    capabilities: {
      ...RECORD,
      open: { na: 'compared by the check that recorded it' },
      link: { na: 'compared by the check that recorded it' },
      search: { na: 'compared by the check that recorded it' },
      versioned: { na: 'kept out of git by decision (G-1)' },
    },
  },
  { id: 'run', ref: 'run', aliases: ['runs'], label: 'Run', plural: 'Runs', icon: 'play', storage: { layout: 'record', where: 'runs' }, folders: 'none', opens: { view: 'tests' }, watch: 'none', git: { merge: 'none', ignored: true }, capabilities: { ...RECORD, run: true, delete: true } },
  { id: 'history', ref: 'history', aliases: ['history-entry'], label: 'History entry', plural: 'History', icon: 'history', storage: { layout: 'record', where: 'meta' }, folders: 'none', opens: { view: 'history' }, watch: 'none', git: { merge: 'none', ignored: true }, capabilities: { ...RECORD, delete: true, 'test-file': true } },
  { id: 'trace', ref: 'trace', aliases: ['traces'], label: 'Trace', plural: 'Traces', icon: 'activity', storage: { layout: 'record', where: 'traces' }, folders: 'none', opens: { view: 'traces' }, watch: 'none', git: { merge: 'none', ignored: true }, capabilities: RECORD },
  { id: 'exchange', ref: 'exchange', aliases: [], label: 'Captured exchange', plural: 'Captured exchanges', icon: 'arrow-left-right', storage: { layout: 'record', where: 'memory' }, folders: 'none', opens: { view: 'debugger' }, watch: 'none', git: { merge: 'none', ignored: true }, capabilities: { ...RECORD, search: { na: 'filtered in the Debugger grid' } } },
  { id: 'proposal', aliases: ['ai-proposal'], label: 'AI proposal', plural: 'AI proposals', icon: 'sparkles', storage: { layout: 'record', where: 'local' }, folders: 'none', opens: { dialog: 'proposal' }, watch: 'none', git: { merge: 'none', ignored: true }, capabilities: { ...RECORD, link: { na: 'opened from its review dialog' }, delete: { na: 'proposals expire' }, search: { na: 'opened from its review dialog' } } },
  { id: 'variable', ref: 'variable', aliases: ['var'], label: 'Variable', plural: 'Variables', icon: 'braces', searchLabel: 'Variable', storage: { layout: 'ref-only' }, folders: 'none', opens: { view: 'environments' }, watch: 'none', git: { merge: 'none' }, capabilities: { ...REF_ONLY, search: true } },
  { id: 'test-case', ref: 'test-case', aliases: [], label: 'Test', plural: 'Tests', icon: 'check-circle', storage: { layout: 'ref-only' }, folders: 'none', opens: { view: 'tests' }, watch: 'none', git: { merge: 'none' }, capabilities: REF_ONLY },
  { id: 'certificate', ref: 'certificate', aliases: ['cert'], label: 'Certificate', plural: 'Certificates', icon: 'shield-check', storage: { layout: 'ref-only' }, folders: 'none', opens: { view: 'settings' }, watch: 'none', git: { merge: 'none' }, capabilities: REF_ONLY },
  { id: 'git-file', ref: 'git-file', aliases: ['file'], label: 'Changed file', plural: 'Changed files', icon: 'file-diff', storage: { layout: 'ref-only' }, folders: 'none', opens: { view: 'git' }, watch: 'none', git: { merge: 'none' }, capabilities: REF_ONLY },
  { id: 'doc', ref: 'doc', aliases: ['docs'], label: 'Documentation', plural: 'Documentation', icon: 'book-open', storage: { layout: 'ref-only' }, folders: 'none', opens: 'external', watch: 'none', git: { merge: 'none' }, capabilities: REF_ONLY },
  { id: 'mock', ref: 'mock', aliases: ['mock-server'], label: 'Mock server', plural: 'Mock servers', icon: 'server', storage: { layout: 'ref-only' }, folders: 'none', parent: 'collection', opens: { view: 'collections' }, watch: 'none', git: { merge: 'none' }, capabilities: REF_ONLY },
];

export const KIND_INFO: Readonly<Record<KindId, ItemKindInfo>> = Object.freeze(Object.fromEntries(kinds.map((k) => [k.id, Object.freeze(k)])) as Record<KindId, ItemKindInfo>);
export const KIND_IDS = kinds.map((k) => k.id) as readonly KindId[];

/** Kinds that are live in this version (not registered ahead of their release). */
export const liveKinds = (): ItemKindInfo[] => kinds.filter((k) => !k.since);

/** Whether a capability is supported and implemented (`true`), never a `na` or a `planned`. */
export const can = (kind: KindId, cap: Capability): boolean => KIND_INFO[kind]?.capabilities[cap] === true;

/** The live kinds with a capability. */
export const kindsWith = (cap: Capability): ItemKindInfo[] => liveKinds().filter((k) => k.capabilities[cap] === true);

/** A kind by its id or one of its aliases (`library:grpc`, `test-file`, `history-entry` …); undefined for an unknown name. */
export function kindByName(name: string): ItemKindInfo | undefined {
  const n = String(name ?? '').trim().toLowerCase();
  return (KIND_INFO as Record<string, ItemKindInfo>)[n] ?? kinds.find((k) => k.aliases.includes(n));
}

/** The kind of a library's items (grpc → grpc-call, monitors → monitor); live kinds only. */
export const kindOfLibrary = (library: string): ItemKindInfo | undefined => liveKinds().find((k) => k.library === library);

/** The registry kind of an ItemRef ('saved' by its library); undefined for a library this version doesn't know. */
export function kindOfRef(ref: Pick<ItemRef, 'kind'> & { library?: string }): ItemKindInfo | undefined {
  if (ref.kind === 'saved') return kinds.find((k) => k.library === ref.library && (k.ref === 'saved' || k.ref === 'monitor'));
  return (KIND_INFO as Record<string, ItemKindInfo>)[ref.kind];
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
const normal = (path: string) => String(path ?? '').replace(/\\/g, '/').replace(/^\.?\//, '');

/** The library of a `library/<name>.json` path (also folder libraries and libraries this version doesn't know). */
export function libraryOfPath(path: string, opts: { raw?: boolean } = {}): string | undefined {
  const p = opts.raw ? path : normal(path);
  return /^library\/([a-z0-9-]+)\.json$/.exec(p)?.[1];
}

/**
 * The kind of a workspace path, lexically (no file is read, `/` and `\` alike): `id` when the path names one item, as
 * its ItemRef names it (a collection's id, a test file's path inside tests/, a spec's workspace path, a dataset's name
 * under datasets/). Undefined for a path that belongs to no kind. `raw`: the path is already relative with `/` (the
 * folder watcher's), so it is taken as it is.
 */
export function kindOfPath(path: string, opts: { raw?: boolean } = {}): { kind: KindId; id?: string } | undefined {
  const p = opts.raw ? path : normal(path);
  if (p === 'workspace.json') return { kind: 'workspace' };
  if (p === 'mcp-servers.json') return { kind: 'mcp-server' };
  if (p === 'providers.json') return { kind: 'provider' };
  if (p === 'debugger/rules.json') return { kind: 'debugger-rules' };
  const lib = libraryOfPath(p, { raw: true });
  if (lib) {
    const k = kinds.find((x) => x.storage.layout === 'library' && x.storage.library === lib);
    return k ? { kind: k.id } : undefined;
  }
  const slash = p.indexOf('/');
  if (slash < 0) return undefined;
  const top = p.slice(0, slash);
  const rest = p.slice(slash + 1);
  const withId = (kind: KindId, id: string | undefined) => (id ? { kind, id } : { kind });
  switch (top) {
    case 'collections':
      return withId('collection', /^([^/]+)\.json$/.exec(rest)?.[1]);
    case 'environments':
      return withId('environment', /^([^/]+)\.json$/.exec(rest)?.[1]);
    case 'tests':
      return withId('test', rest && /\.(ya?ml|json)$/i.test(rest) ? rest : undefined);
    case 'datasets':
      return withId('dataset', rest || undefined);
    case 'specs':
      return withId('spec', rest ? p : undefined);
    case 'protos':
      return withId('proto', rest || undefined);
    case 'packages':
      return withId('script-package', /^[^/]+\.js$/.test(rest) ? rest.slice(0, -3) : undefined);
    case 'mocks':
      return withId('mcp-mock', /^[^/]+\.mcp-mock\.ya?ml$/i.test(rest) ? rest : undefined);
    case 'metrics':
      return withId('metric', /^[^/]+\.ya?ml$/i.test(rest) ? rest.replace(/\.ya?ml$/i, '') : undefined);
    case 'debugger':
      return withId('capture', /^[^/]+\.har$/i.test(rest) ? rest.slice(0, -4) : undefined);
    case 'baselines':
      return withId('baseline', rest || undefined);
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

/** The `data.changed` kind (today's strings) of a changed workspace file; the folder watcher sorts changes with it. */
export function watchKindOfPath(path: string, opts: { raw?: boolean } = {}): WatchKind {
  const k = kindOfPath(path, opts);
  const w = k ? KIND_INFO[k.kind].watch : undefined;
  if (w && w !== 'none') return w.legacy;
  return libraryOfPath(path, opts) || (opts.raw ? path : normal(path)).startsWith('library/') ? 'library' : 'other';
}
