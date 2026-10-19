/**
 * Every tree and list row's menu, as data (planning/menus-uniform.md §2): the node kinds a menu is built for, what each
 * one can do (its item kind's capabilities from the registry; a section's, a folder's or a category's generated from
 * its kind), and the actions — which group, which LABEL key, which lucide icon, which capability they need, which key
 * runs them. Host-agnostic: the window turns the entries into menu items (apps/desktop/src/lib/node-menu.ts), and
 * `testpion kinds --json`, MCP `list_kinds` and RPC `kinds.list` print the shape of every menu. Nothing here branches
 * on a kind's name where the registry can say it.
 */
import { AI_ACTIONS, type AiActionId } from './ai-actions.js';
import { CAPABILITIES, kindInfoOf, KIND_INFO, liveKinds, type Capabilities, type Capability, type CapabilityState, type ItemKindInfo, type KindId } from './item-kinds.js';

/** The groups of every node menu, in this order everywhere: create · open · tree · run · share · tools · git · edit · danger. */
export const MENU_GROUPS = ['create', 'open', 'tree', 'run', 'share', 'tools', 'git', 'edit', 'danger'] as const;
export type MenuGroup = (typeof MENU_GROUPS)[number];

/** A node of a tree or list: an item kind, a section header, a folder of a kind, a protocol category, Favorites. */
export type NodeKind = KindId | `section:${KindId}` | `folder:${KindId}` | 'category' | 'favorites';

/** The keys of the window's LABEL vocabulary (apps/desktop/src/lib/vocabulary.ts) a menu item can be labelled with. */
export type MenuLabelKey =
  | 'newFolder'
  | 'import'
  | 'open'
  | 'openNewTab'
  | 'revealInSidebar'
  | 'revealFile'
  | 'expandAll'
  | 'collapseAll'
  | 'run'
  | 'runCollection'
  | 'runFolder'
  | 'runNow'
  | 'copyLink'
  | 'copyAs'
  | 'copyPath'
  | 'export'
  | 'exportSubmenu'
  | 'monitor'
  | 'runInCi'
  | 'saveAsTest'
  | 'createTestFileFromCollection'
  | 'createTestFileFromFolder'
  | 'generateFlow'
  | 'generateSecurityTests'
  | 'checkTraffic'
  | 'suggestChecks'
  | 'whyFlaky'
  | 'askAi'
  | 'aiActions'
  | 'writeScriptAi'
  | 'fixScriptAi'
  | 'explainScriptAi'
  | 'settings'
  | 'historyInGit'
  | 'rename'
  | 'renameFolder'
  | 'duplicate'
  | 'moveTo'
  | 'moveToFolder'
  | 'moveToCollection'
  | 'addFavorite'
  | 'removeFavorite'
  | 'delete'
  | 'deleteFolder'
  | 'collectionSettings'
  | 'convertScriptsTp'
  | 'copyGrpcurl'
  | 'copyUrl'
  | 'editFolder'
  | 'connect'
  | 'disconnect'
  | 'copyMcpConfig'
  | 'openMcpInspector'
  | 'lint'
  | 'apiCoverage'
  | 'compareVersions'
  | 'generateTests'
  | 'generateFlows'
  | 'generateSpecTests'
  | 'tidyImport'
  | 'openApiDefinitions'
  | 'preview'
  | 'runWithDataset'
  | 'useInTest'
  | 'generateData'
  | 'edit'
  | 'pause'
  | 'resume'
  | 'runWithData'
  | 'runInEnvironments'
  | 'rerunFailed'
  | 'copyCliCommand'
  | 'copyRunId'
  | 'exposeMcp'
  | 'exportArazzo'
  | 'triageWithAi'
  | 'exportReport'
  | 'openRequest'
  | 'openTrace'
  | 'openRun'
  | 'makeActive'
  | 'recentlyDeleted';

/**
 * What a node's menu knows of its context, without the host's handlers: which actions the view can do (`on`, by action
 * id: a value that is a list means a submenu), which apply but cannot run now, whether the request is a favorite and
 * whether the workspace is a git repository. The window's NodeMenuCtx adds the handlers themselves.
 */
export interface NodeMenuContext {
  on: Partial<Record<string, unknown>>;
  /** Actions that apply but cannot run now: id → why (the item is shown disabled, the reason as its tooltip). */
  disabled?: Partial<Record<string, string>>;
  /** The request is a favorite (Add to / Remove from favorites). */
  favorite?: boolean;
  /** The workspace is a git repository (the git group shows). */
  repo?: boolean;
  /** Settings hides every AI action: the AI items (ai-actions.ts) are left out of the menu. */
  aiHidden?: boolean;
}

export interface ActionDef {
  id: string;
  group: MenuGroup;
  /** The LABEL key of its text, or a function of the context and node kind giving one. */
  label: MenuLabelKey | ((c: NodeMenuContext, kind: NodeKind) => MenuLabelKey);
  /** A lucide icon name, as ItemKindInfo.icon (the window maps it). */
  icon?: string;
  /** The capability of the item kind the action needs (`true` in the registry); a node kind's own capabilities are generated. */
  cap?: Capability;
  danger?: boolean;
  /** Only for these node kinds (kind-specific actions). */
  kinds?: readonly NodeKind[];
  /** Only when the context says so (the git group needs a repository). */
  when?: (c: NodeMenuContext) => boolean;
  /** An AI action (from ai-actions.ts, the one table): Settings ▸ "Hide all AI actions" removes it. */
  ai?: true;
  /** Only for the node kinds this says (an action without a capability of its own: Copy as, Reveal file …). */
  appliesTo?: (kind: NodeKind) => boolean;
  /** Offered only by some views (Reveal in sidebar: outside the sidebar), so a kind's shape leaves it out. */
  contextual?: boolean;
  /** After the kind's own actions of its group (Export… ends the share group, Settings… the tools group). */
  last?: boolean;
  /** The key that runs it on a focused row (shown beside the item; the menu itself opens with Shift+F10). */
  shortcut?: string;
}

/* ------------------------------------------------------------------ node kinds */

/** The item kind a node kind is about: a section's or folder's kind; a category's and Favorites' requests. */
export function baseKind(kind: NodeKind): KindId {
  if (kind === 'category' || kind === 'favorites') return 'request';
  const i = kind.indexOf(':');
  return (i < 0 ? kind : kind.slice(i + 1)) as KindId;
}

const isFolderNode = (k: NodeKind) => k.startsWith('folder:');
const isSectionNode = (k: NodeKind) => k.startsWith('section:');

/**
 * Whether a kind's list has folders of its own that are nodes with a menu: virtual folders (API definitions, datasets,
 * MCP servers, library items), or the folders of a tree of files that opens (test files; not protos, which open from
 * their gRPC call, and not a variant such as flows, stored as its base kind).
 */
export const hasFolderNodes = (k: ItemKindInfo): boolean => typeof k.folders === 'object' || (k.folders === 'dirs' && !k.variantOf && k.opens !== 'none');

/** The kinds with a folder node, and those with a section node (`listed` in the registry), live ones only. */
export const folderNodeKinds = (): ItemKindInfo[] => liveKinds().filter(hasFolderNodes);
export const sectionNodeKinds = (): ItemKindInfo[] => liveKinds().filter((k) => k.listed);

/** Every node kind a menu is built for (the tests, the docs table, `testpion kinds --json`). */
export const NODE_KINDS: readonly NodeKind[] = [
  ...liveKinds().map((k) => k.id),
  ...sectionNodeKinds().map((k) => `section:${k.id}` as const),
  ...folderNodeKinds().map((k) => `folder:${k.id}` as const),
  'category',
  'favorites',
];

/* ------------------------------------------------------------------ registry predicates (no kind names) */

/** A gRPC call or a connection: a library item that belongs to a collection (Move to ▸ the collections). */
export const movesBetweenCollections = (kind: NodeKind): boolean => {
  const i = kindInfoOf(kind);
  return !!i && i.parent === 'collection' && i.storage.layout === 'library';
};
/** A request: nested in a collection and opens in an editor (Copy as ▸ its code forms). */
const isRequest = (kind: NodeKind): boolean => {
  const i = kindInfoOf(kind);
  return !!i && i.storage.layout === 'nested' && i.capabilities.open === true;
};
/** An item kept as a list in one workspace file (MCP servers, AI providers): its Settings… page. */
const isListItem = (kind: NodeKind): boolean => kindInfoOf(kind)?.storage.layout === 'items-in-file';
/** A file the user keeps in the workspace's folders (a test file, an API definition, a dataset): Reveal file, Copy path. */
const isDocument = (kind: NodeKind): boolean => {
  const i = kindInfoOf(kind);
  return !!i && i.storage.layout === 'raw-document' && i.capabilities.open === true;
};
/** A container that exports in several ways (a collection: Export ▸ its formats). */
export const exportsAsSubmenu = (kind: NodeKind): boolean => {
  const i = kindInfoOf(kind);
  return !!i && i.capabilities.export === true && i.capabilities.container === true;
};

/* ------------------------------------------------------------------ capabilities of a node */

const NA = (why: string): CapabilityState => ({ na: why });
const all = (state: CapabilityState) => Object.fromEntries(CAPABILITIES.map((c) => [c, state])) as Record<Capability, CapabilityState>;
const CAPS = new Map<NodeKind, Capabilities>();

/** The capabilities of a node: an item kind's from the registry; a section's, a folder's or a category's generated from its kind. */
export function nodeCapabilities(kind: NodeKind): Capabilities {
  const hit = CAPS.get(kind);
  if (hit) return hit;
  const caps = computeCapabilities(kind);
  CAPS.set(kind, caps);
  return caps;
}

function computeCapabilities(kind: NodeKind): Capabilities {
  const own = kindInfoOf(kind);
  if (own) return own.capabilities;
  const info = KIND_INFO[baseKind(kind)];
  const base = info.capabilities;
  if (isSectionNode(kind))
    return {
      ...all(NA('a section header holds a list, it is not an item')),
      // a list of folders, or a tree, expands; a flat list (environments, providers) has nothing to expand
      container: info.folders !== 'none' ? true : NA('a flat list: nothing to expand or collapse'),
      import: base.import,
      ci: base.ci === true ? true : NA('its items do not run in CI'),
    };
  if (isFolderNode(kind))
    return {
      ...all(NA('a folder of a list, not an item')),
      container: true,
      rename: true,
      delete: true,
      duplicate: { planned: '0.54' },
      move: { planned: '0.54' },
      // a folder of test files runs (and runs in CI) as one; a library's folder is a way to sort its items
      run: base.run === true && info.folders === 'dirs' ? true : NA('its items run one by one'),
      ci: base.ci === true && info.folders === 'dirs' ? true : NA('its items run in CI one by one'),
      export: { planned: '0.54' },
    };
  if (kind === 'category') return { ...all(NA('a group of one protocol’s requests in a collection')), container: true, run: true };
  return { ...all(NA('favorites gather requests from every collection')), container: true };
}

/**
 * Whether New folder applies: an item that holds folders (a collection, a folder: `nodes`), or a section whose list
 * keeps virtual folders (MCP servers, API definitions, datasets, library items). Those folders are one level deep, and a
 * test file's folder is made by its path (New test file here), so a list's folder has no New folder of its own.
 */
export function hasFolders(kind: NodeKind): boolean {
  if (kind === 'category' || kind === 'favorites' || isFolderNode(kind)) return false;
  const f = KIND_INFO[baseKind(kind)].folders;
  return isSectionNode(kind) ? typeof f === 'object' : f === 'nodes';
}

/**
 * Whether a node offers New … items: a section, or a container — not Favorites, and not a folder of gRPC calls or
 * connections (those are made in their editor, in a collection).
 */
export const createsHere = (kind: NodeKind): boolean =>
  isSectionNode(kind) || (nodeCapabilities(kind).container === true && kind !== 'favorites' && !(isFolderNode(kind) && KIND_INFO[baseKind(kind)].parent === 'collection'));

/* ------------------------------------------------------------------ the actions */

/** The test-file action's label by what it saves (WF-07). */
const testFileLabel = (_c: NodeMenuContext, k: NodeKind): MenuLabelKey => (k === 'folder' ? 'createTestFileFromFolder' : k === 'collection' ? 'createTestFileFromCollection' : 'saveAsTest');

/** The shared actions, in their order inside each group (kind actions follow the shared ones of their group). */
export const STANDARD_ACTIONS = [
  { id: 'newFolder', group: 'create', label: 'newFolder', icon: 'folder-plus', cap: 'container' },
  // Import… on a section's create group (per container in 0.54, EX-A2)
  { id: 'import', group: 'create', label: 'import', icon: 'upload', cap: 'import', appliesTo: isSectionNode },
  { id: 'open', group: 'open', label: 'open', icon: 'external-link', cap: 'open', shortcut: 'Enter' },
  { id: 'openNewTab', group: 'open', label: 'openNewTab', icon: 'square-arrow-out-up-right', cap: 'open-new-tab' },
  { id: 'revealInSidebar', group: 'open', label: 'revealInSidebar', icon: 'locate-fixed', cap: 'open', contextual: true },
  { id: 'revealFile', group: 'open', label: 'revealFile', icon: 'folder-open', appliesTo: isDocument },
  { id: 'expandAll', group: 'tree', label: 'expandAll', icon: 'chevrons-up-down', cap: 'container', shortcut: '*' },
  { id: 'collapseAll', group: 'tree', label: 'collapseAll', icon: 'chevrons-down-up', cap: 'container' },
  {
    id: 'run',
    group: 'run',
    label: (_c, k) => (k === 'collection' || k === 'category' ? 'runCollection' : k === 'folder' || isFolderNode(k) ? 'runFolder' : k === 'monitor' ? 'runNow' : 'run'),
    icon: 'play',
    cap: 'run',
  },
  { id: 'copyLink', group: 'share', label: 'copyLink', icon: 'link-2', cap: 'link' },
  { id: 'copyAs', group: 'share', label: 'copyAs', icon: 'copy', appliesTo: isRequest },
  { id: 'copyPath', group: 'share', label: 'copyPath', icon: 'file-code-2', appliesTo: isDocument },
  { id: 'export', group: 'share', label: (c) => (Array.isArray(c.on.export) ? 'exportSubmenu' : 'export'), icon: 'download', cap: 'export', last: true },
  { id: 'monitor', group: 'tools', label: 'monitor', icon: 'alarm-clock', cap: 'monitor' },
  { id: 'ci', group: 'tools', label: 'runInCi', icon: 'workflow', cap: 'ci' },
  { id: 'testFile', group: 'tools', label: testFileLabel, icon: 'file-check-2', cap: 'test-file' },
  { id: 'settings', group: 'tools', label: 'settings', icon: 'settings-2', appliesTo: isListItem, last: true },
  { id: 'historyInGit', group: 'git', label: 'historyInGit', icon: 'history', cap: 'git-history', when: (c) => !!c.repo },
  { id: 'rename', group: 'edit', label: (_c, k) => (isFolderNode(k) ? 'renameFolder' : 'rename'), icon: 'pencil', cap: 'rename', shortcut: 'F2' },
  { id: 'duplicate', group: 'edit', label: 'duplicate', icon: 'copy-plus', cap: 'duplicate' },
  // a dialog (Move to…), or a submenu of the list's folders, or of the collections a gRPC call or connection can be in
  {
    id: 'move',
    group: 'edit',
    label: (c, k) => (!Array.isArray(c.on.move) ? 'moveTo' : movesBetweenCollections(k) ? 'moveToCollection' : 'moveToFolder'),
    icon: 'folder-input',
    cap: 'move',
  },
  { id: 'favorite', group: 'edit', label: (c) => (c.favorite ? 'removeFavorite' : 'addFavorite'), icon: 'star', cap: 'favorite' },
  { id: 'delete', group: 'danger', label: (_c, k) => (isFolderNode(k) ? 'deleteFolder' : 'delete'), icon: 'trash-2', cap: 'delete', danger: true, shortcut: 'Del' },
] as const satisfies readonly ActionDef[];

/** The actions of the Collections tree's own kinds (collection, its folders, requests, gRPC calls, connections). */
const COLLECTION_ACTIONS = [
  { id: 'collectionSettings', group: 'tools', label: 'collectionSettings', icon: 'settings-2', kinds: ['collection'] },
  { id: 'convertScripts', group: 'tools', label: 'convertScriptsTp', icon: 'wand-2', kinds: ['collection'] },
  { id: 'copyGrpcurl', group: 'share', label: 'copyGrpcurl', icon: 'terminal', kinds: ['grpc-call'] },
  { id: 'copyUrl', group: 'share', label: 'copyUrl', icon: 'link-2', kinds: ['ws-connection'] },
  { id: 'editFolder', group: 'tools', label: 'editFolder', icon: 'folder-cog', kinds: ['folder'] },
] as const satisfies readonly ActionDef[];

/** The actions of the explorer's workspace kinds: MCP servers, API definitions, datasets, and their sections. */
const EXPLORER_ACTIONS = [
  // MCP servers
  { id: 'connect', group: 'run', label: 'connect', icon: 'plug', kinds: ['mcp-server'] },
  { id: 'disconnect', group: 'run', label: 'disconnect', icon: 'unplug', kinds: ['mcp-server'] },
  { id: 'copyMcpConfig', group: 'share', label: 'copyMcpConfig', icon: 'braces', kinds: ['mcp-server'] },
  { id: 'openMcpInspector', group: 'open', label: 'openMcpInspector', icon: 'square-arrow-out-up-right', kinds: ['section:mcp-server'] },
  // API definitions
  { id: 'lint', group: 'run', label: 'lint', icon: 'list-checks', kinds: ['spec'] },
  { id: 'apiCoverage', group: 'run', label: 'apiCoverage', icon: 'scan-search', kinds: ['spec'] },
  { id: 'compareVersions', group: 'run', label: 'compareVersions', icon: 'git-compare', kinds: ['spec'] },
  { id: 'generateTests', group: 'tools', label: 'generateTests', icon: 'file-check-2', kinds: ['spec'] },
  { id: 'generateFlows', group: 'tools', label: 'generateFlows', icon: 'workflow', kinds: ['spec'] },
  { id: 'openApiDefinitions', group: 'open', label: 'openApiDefinitions', icon: 'square-arrow-out-up-right', kinds: ['section:spec'] },
  // datasets
  { id: 'preview', group: 'open', label: 'preview', icon: 'eye', kinds: ['dataset'] },
  { id: 'runWithDataset', group: 'run', label: 'runWithDataset', icon: 'play', kinds: ['dataset'] },
  { id: 'useInTest', group: 'tools', label: 'useInTest', icon: 'wand-2', kinds: ['dataset'] },
  { id: 'generateData', group: 'create', label: 'generateData', icon: 'sparkles', kinds: ['section:dataset'] },
] as const satisfies readonly ActionDef[];

/** The actions of the library views (monitors, load tests, evaluations, prompts), the Tests tree and the record lists. */
const LIST_ACTIONS = [
  // monitors
  { id: 'edit', group: 'open', label: 'edit', icon: 'pencil', kinds: ['monitor'] },
  { id: 'pause', group: 'run', label: 'pause', icon: 'pause', kinds: ['monitor'] },
  { id: 'resume', group: 'run', label: 'resume', icon: 'play', kinds: ['monitor'] },
  // test files and runs
  { id: 'runWithData', group: 'run', label: 'runWithData', icon: 'play', kinds: ['test'] },
  { id: 'runInEnvironments', group: 'run', label: 'runInEnvironments', icon: 'play', kinds: ['test'] },
  { id: 'rerunFailed', group: 'run', label: 'rerunFailed', icon: 'rotate-ccw', kinds: ['run'] },
  { id: 'copyCli', group: 'share', label: 'copyCliCommand', icon: 'terminal', kinds: ['test', 'run'] },
  { id: 'copyRunId', group: 'share', label: 'copyRunId', icon: 'copy', kinds: ['run'] },
  { id: 'exposeMcp', group: 'tools', label: 'exposeMcp', icon: 'bot', kinds: ['test'] },
  { id: 'exportArazzo', group: 'share', label: 'exportArazzo', icon: 'workflow', kinds: ['test'] },
  { id: 'exportReport', group: 'share', label: 'exportReport', icon: 'download', kinds: ['run'] },
  // history, traces, environments
  { id: 'openRequest', group: 'open', label: 'openRequest', icon: 'external-link', kinds: ['history'] },
  { id: 'openTrace', group: 'open', label: 'openTrace', icon: 'file-text', kinds: ['history'] },
  { id: 'openRun', group: 'open', label: 'openRun', icon: 'external-link', kinds: ['trace'] },
  { id: 'makeActive', group: 'run', label: 'makeActive', icon: 'check-circle-2', kinds: ['environment'] },
  { id: 'recentlyDeleted', group: 'open', label: 'recentlyDeleted', icon: 'archive-restore', kinds: ['section:environment', 'section:collection'] },
] as const satisfies readonly ActionDef[];

/** Every kind's own actions; the shared groups come from the capabilities. */
export const KIND_ACTIONS = [...COLLECTION_ACTIONS, ...EXPLORER_ACTIONS, ...LIST_ACTIONS] as const satisfies readonly ActionDef[];

/**
 * Every AI item of every menu, made from the one table (ai-actions.ts): the label, icon, group and the kinds are its. A
 * kind's `ai` capability and the unit test that lists the window's views keep the table and the menus honest.
 */
export const AI_MENU_ACTIONS: readonly ActionDef[] = AI_ACTIONS.map(
  (a): ActionDef => ({ id: a.id, group: a.group, label: a.label, icon: a.icon, ai: true, ...('cap' in a ? { cap: a.cap } : {}), ...('kinds' in a ? { kinds: a.kinds } : {}) }),
);

/** The id of an action a view can handle (`on`): a typo is a compile error, not an item silently left out. */
export type ActionId = (typeof STANDARD_ACTIONS)[number]['id'] | (typeof KIND_ACTIONS)[number]['id'] | AiActionId;

const ACTIONS = new Map<NodeKind, readonly ActionDef[]>();

/** The actions of a node kind: the shared ones, then the kind's own ones (the AI ones among them), each group in this order. */
export function actionsOf(kind: NodeKind): readonly ActionDef[] {
  const hit = ACTIONS.get(kind);
  if (hit) return hit;
  const own = KIND_ACTIONS.filter((a) => (a.kinds as readonly NodeKind[]).includes(kind));
  // an AI action of a capability (Generate integration flow: every container that can) sits among the shared ones; the others after the kind's own
  const aiShared = AI_MENU_ACTIONS.filter((a) => a.cap);
  const aiOwn = AI_MENU_ACTIONS.filter((a) => a.kinds?.includes(kind));
  const defs: readonly ActionDef[] = [...STANDARD_ACTIONS.filter((a) => !('last' in a)), ...aiShared, ...own, ...aiOwn, ...STANDARD_ACTIONS.filter((a) => 'last' in a)];
  ACTIONS.set(kind, defs);
  return defs;
}

/* ------------------------------------------------------------------ the entries of a menu */

/** One item of a node's menu before the host renders it: the action, its label key, its key, why it is disabled. */
export interface NodeMenuEntry {
  def: ActionDef;
  label: MenuLabelKey;
  shortcut?: string;
  /** The view gave a list: the item is a submenu. */
  submenu: boolean;
  disabled?: string;
}

/**
 * A node's menu group by group (empty groups included), in MENU_GROUPS order: the actions the node kind has and the
 * view can do (`ctx.on`); the create group's own items (New …) are the host's.
 */
export function nodeMenuEntries(kind: NodeKind, ctx: NodeMenuContext): Array<{ group: MenuGroup; entries: NodeMenuEntry[] }> {
  const caps = nodeCapabilities(kind);
  const defs = actionsOf(kind);
  return MENU_GROUPS.map((group) => {
    const entries: NodeMenuEntry[] = [];
    for (const def of defs) {
      if (def.group !== group) continue;
      if (def.cap && caps[def.cap] !== true) continue;
      if (def.ai && ctx.aiHidden) continue;
      if (def.id === 'newFolder' && !hasFolders(kind)) continue;
      if (def.when && !def.when(ctx)) continue;
      if (def.appliesTo && !def.appliesTo(kind)) continue;
      const act = ctx.on[def.id];
      if (!act) continue;
      const why = ctx.disabled?.[def.id];
      entries.push({
        def,
        label: typeof def.label === 'function' ? def.label(ctx, kind) : def.label,
        ...(def.shortcut ? { shortcut: def.shortcut } : {}),
        submenu: Array.isArray(act),
        ...(why ? { disabled: why } : {}),
      });
    }
    return { group, entries };
  });
}

/** A context that offers every action (the shape of a kind's menu: what it can show at most); `creates`: it has New … items. */
export function fullMenuContext(kind: NodeKind): NodeMenuContext & { creates: boolean } {
  const on: Record<string, unknown> = {};
  for (const def of actionsOf(kind)) if (!def.contextual) on[def.id] = true;
  // submenus as the views give them: a list's folders and a gRPC call's collections (Move to), a request's code forms
  // (Copy as), a collection's export choices (Export)
  if (typeof KIND_INFO[baseKind(kind)].folders === 'object' || movesBetweenCollections(kind)) on.move = [];
  if (on.copyAs) on.copyAs = [];
  if (exportsAsSubmenu(kind)) on.export = [];
  return { on, repo: true, creates: createsHere(kind) };
}

/** One action of a menu shape: its id, label key and key; an AI one is marked, and a node's AI actions are the `items` of one `ai` submenu. */
export interface NodeMenuShapeAction {
  id: string;
  label: MenuLabelKey;
  shortcut?: string;
  submenu?: true;
  ai?: true;
  items?: NodeMenuShapeAction[];
}

/** The shape of one node's menu as agents and scripts read it: its groups (empty ones left out), each action with its label key and key. */
export interface NodeMenuShape {
  node: NodeKind;
  /** The node offers New … items of its kind first (the view names them). */
  creates: boolean;
  groups: Array<{ group: MenuGroup; actions: NodeMenuShapeAction[] }>;
}

/** A node with several AI items keeps them in one "AI ▸" submenu (a single AI item stays where it is): the window and the shape follow this one rule. */
export const foldsAiItems = (entries: ReadonlyArray<{ def: ActionDef }>): boolean => entries.filter((e) => e.def.ai).length > 1;

export function nodeMenuShapeOf(kind: NodeKind): NodeMenuShape {
  const ctx = fullMenuContext(kind);
  const action = (e: NodeMenuEntry): NodeMenuShapeAction => ({ id: e.def.id, label: e.label, ...(e.shortcut ? { shortcut: e.shortcut } : {}), ...(e.submenu ? { submenu: true as const } : {}), ...(e.def.ai ? { ai: true as const } : {}) });
  const groups = nodeMenuEntries(kind, ctx)
    .filter((g) => g.entries.length)
    .map((g) => {
      const fold = foldsAiItems(g.entries);
      const actions: NodeMenuShapeAction[] = [];
      for (const e of g.entries) {
        if (fold && e.def.ai) {
          if (e === g.entries.find((x) => x.def.ai)) actions.push({ id: 'ai', label: 'aiActions', submenu: true, ai: true, items: g.entries.filter((x) => x.def.ai).map(action) });
          continue;
        }
        actions.push(action(e));
      }
      return { group: g.group, actions };
    });
  return { node: kind, creates: ctx.creates, groups };
}

/** The menus of every node about an item kind: the item's, its section's and its folder's; a request's also the category's and Favorites'. */
export const nodeMenusOf = (kind: KindId): NodeMenuShape[] => NODE_KINDS.filter((n) => baseKind(n) === kind).map(nodeMenuShapeOf);
