import { CAPABILITIES, KIND_IDS, KIND_INFO, type Capabilities, type Capability, type CapabilityState, type KindId } from '@testpion/shared';
import type { MenuItem } from '../components/ui';
import { icon, STANDARD_ACTIONS, type ActionDef, type NodeKind, type NodeMenuCtx } from './node-menu-actions';
import { KIND_ACTIONS } from './node-menu-kinds';
import { MENU_GROUPS, type MenuGroup } from './vocabulary';

export { MENU_GROUPS } from './vocabulary';
export type { Act, ActionDef, NodeKind, NodeMenuCtx } from './node-menu-actions';

/**
 * Every tree and list row's menu, built by one function (planning/menus-uniform.md §2): the groups create · open · tree
 * · run · share · tools · git · edit · danger, in that order, separated; the shared items come from the item kind's
 * capabilities (packages/shared/src/item-kinds.ts), the kind's own ones from lib/node-menu-kinds. An item the kind
 * doesn't have, or the view can't do, is left out; one that applies but can't run now is disabled with the reason.
 * Pure (no React state, no RPC): the menu is built only while it is open.
 */

/** No menu has more items than this (a submenu counts as one): longer menus fold into submenus (Copy as ▸, New request ▸). */
export const MAX_MENU_ITEMS = 18;

const NA = (why: string): CapabilityState => ({ na: why });
const all = (state: CapabilityState) => Object.fromEntries(CAPABILITIES.map((c) => [c, state])) as Record<Capability, CapabilityState>;

/** The item kind a node kind is about: a section's or folder's kind; a category's and Favorites' requests. */
export function baseKind(kind: NodeKind): KindId {
  if (kind === 'category' || kind === 'favorites') return 'request';
  const i = kind.indexOf(':');
  return (i < 0 ? kind : kind.slice(i + 1)) as KindId;
}

/** The capabilities of a node: an item kind's from the registry; a section's, a folder's or a category's generated from its kind. */
export function nodeCapabilities(kind: NodeKind): Capabilities {
  if ((KIND_INFO as Record<string, unknown>)[kind]) return KIND_INFO[kind as KindId].capabilities;
  const base = KIND_INFO[baseKind(kind)].capabilities;
  if (kind.startsWith('section:'))
    return {
      ...all(NA('a section header holds a list, it is not an item')),
      // a list of folders, or a tree, expands; a flat list (environments, providers) has nothing to expand
      container: KIND_INFO[baseKind(kind)].folders !== 'none' ? true : NA('a flat list: nothing to expand or collapse'),
      import: base.import,
      ci: base.ci === true ? true : NA('its items do not run in CI'),
    };
  if (kind.startsWith('folder:'))
    return {
      ...all(NA('a folder of a list, not an item')),
      container: true,
      rename: true,
      delete: true,
      duplicate: { planned: '0.53' },
      move: { planned: '0.53' },
      // a folder of test files runs (and runs in CI) as one; a library's folder is a way to sort its items
      run: base.run === true && KIND_INFO[baseKind(kind)].folders === 'dirs' ? true : NA('its items run one by one'),
      ci: base.ci === true && KIND_INFO[baseKind(kind)].folders === 'dirs' ? true : NA('its items run in CI one by one'),
      export: { planned: '0.53' },
    };
  if (kind === 'category') return { ...all(NA('a group of one protocol’s requests in a collection')), container: true, run: true };
  return { ...all(NA('favorites gather requests from every collection')), container: true };
}

/**
 * Whether New folder applies: an item that holds folders (a collection, a folder: `nodes`), or a section whose list
 * keeps virtual folders (MCP servers, API definitions, datasets, library items). Those folders are one level deep, and a
 * test file's folder is made by its path (New test file here), so a list's folder has no New folder of its own.
 */
function hasFolders(kind: NodeKind): boolean {
  if (kind === 'category' || kind === 'favorites' || kind.startsWith('folder:')) return false;
  const f = KIND_INFO[baseKind(kind)].folders;
  return kind.startsWith('section:') ? typeof f === 'object' : f === 'nodes';
}

/** The actions of a node kind: the shared ones, then the kind's own ones, each group in this order. */
function actionsOf(kind: NodeKind): ActionDef[] {
  const own = KIND_ACTIONS.filter((a) => a.kinds?.includes(kind));
  return [...STANDARD_ACTIONS.filter((a) => !a.last), ...own, ...STANDARD_ACTIONS.filter((a) => a.last)];
}

/** A node's menu group by group (empty groups included), in MENU_GROUPS order. */
export function nodeMenuGroups(kind: NodeKind, ctx: NodeMenuCtx): Array<{ group: MenuGroup; items: MenuItem[] }> {
  const caps = nodeCapabilities(kind);
  const defs = actionsOf(kind);
  return MENU_GROUPS.map((group) => {
    const items: MenuItem[] = group === 'create' ? [...(ctx.create ?? [])] : [];
    for (const def of defs) {
      if (def.group !== group) continue;
      if (def.cap && caps[def.cap] !== true) continue;
      if (def.id === 'newFolder' && !hasFolders(kind)) continue;
      if (def.when && !def.when(ctx)) continue;
      if (def.appliesTo && !def.appliesTo(kind)) continue;
      const act = ctx.on[def.id];
      if (!act) continue;
      const why = ctx.disabled?.[def.id];
      items.push({
        label: typeof def.label === 'function' ? def.label(ctx, kind) : def.label,
        icon: icon(def.icon),
        ...(def.danger ? { danger: true } : {}),
        onSelect: typeof act === 'function' ? () => void act() : () => undefined,
        ...(Array.isArray(act) ? { items: act } : {}),
        ...(why ? { disabled: true, title: why } : {}),
      });
    }
    return { group, items };
  });
}

/** Build a node's menu (call it only while the menu is open): its groups, each after a separator. */
export function buildNodeMenu(kind: NodeKind, ctx: NodeMenuCtx): MenuItem[] {
  const groups = nodeMenuGroups(kind, ctx).map((g) => g.items);
  const out = groups.filter((g) => g.length).flatMap((g, i) => g.map((it, j) => ({ ...it, separator: i > 0 && j === 0 })));
  if (out.length > MAX_MENU_ITEMS && import.meta.env?.DEV) console.error(`The ${kind} menu has ${out.length} items (at most ${MAX_MENU_ITEMS}): fold some into a submenu`);
  return out;
}

/** Every node kind a menu is built for (the tests and the docs table; a CLI and MCP view of the shapes comes in 0.53). */
export const NODE_KINDS: readonly NodeKind[] = [
  ...KIND_IDS.filter((k) => !KIND_INFO[k].since),
  ...(['collection', 'mcp-server', 'spec', 'dataset', 'test', 'prompt', 'load-test', 'evaluation', 'monitor', 'environment', 'provider'] as const).map((k) => `section:${k}` as const),
  ...(['mcp-server', 'spec', 'dataset', 'grpc-call', 'ws-connection', 'test', 'prompt', 'load-test', 'evaluation', 'monitor'] as const).map((k) => `folder:${k}` as const),
  'category',
  'favorites',
];

/**
 * Whether a node offers New … items: a section, or a container — not Favorites, and not a folder of gRPC calls or
 * connections (those are made in their editor, in a collection).
 */
const createsHere = (kind: NodeKind) =>
  kind.startsWith('section:') || (nodeCapabilities(kind).container === true && kind !== 'favorites' && !(kind.startsWith('folder:') && KIND_INFO[baseKind(kind)].parent === 'collection'));

/** A context that offers every action (the shape of a kind's menu: what it can show at most). */
export function fullCtx(kind: NodeKind): NodeMenuCtx {
  const on: Record<string, NodeMenuCtx['on'][string]> = {};
  const noop = () => undefined;
  for (const def of actionsOf(kind)) if (!def.contextual) on[def.id] = noop;
  // submenus as the views give them: a list's folders and a gRPC call's collections (Move to), a request's code forms
  // (Copy as), a collection's export choices (Export)
  const info = KIND_INFO[baseKind(kind)];
  if (typeof info.folders === 'object' || kind === 'grpc-call' || kind === 'ws-connection') on.move = [];
  if (on.copyAs) on.copyAs = [];
  if (kind === 'collection') on.export = [];
  return { on, repo: true, create: createsHere(kind) ? [{ label: 'New …', onSelect: noop }] : [] };
}

/** The labels of a kind's menu, group by group, with every action offered (tests, the docs table). */
export function nodeMenuShape(kind: NodeKind): string[][] {
  const items = buildNodeMenu(kind, fullCtx(kind));
  const groups: string[][] = [];
  for (const it of items) {
    if (it.separator || !groups.length) groups.push([]);
    groups.at(-1)!.push(it.items ? `${it.label} ▸` : it.label);
  }
  return groups;
}
