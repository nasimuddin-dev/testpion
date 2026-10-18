import { fullMenuContext, nodeMenuEntries, type ActionId, type MenuLabelKey, type NodeKind } from '@testpion/shared';
import type { MenuItem } from '../components/ui';
import { icon, type Act, type NodeMenuCtx } from './node-menu-actions';
import { LABEL } from './vocabulary';

export { MENU_GROUPS, NODE_KINDS, baseKind, nodeCapabilities } from '@testpion/shared';
export type { Act, ActionDef, ActionId, NodeKind, NodeMenuCtx } from './node-menu-actions';

/**
 * Every tree and list row's menu, built by one function (planning/menus-uniform.md §2): the groups create · open · tree
 * · run · share · tools · git · edit · danger, in that order, separated; the entries come from @testpion/shared
 * (packages/shared/src/node-menu.ts: the item kind's capabilities and the action tables), so the CLI and MCP see the
 * same shapes. An item the kind doesn't have, or the view can't do, is left out; one that applies but can't run now is
 * disabled with the reason. Pure (no React state, no RPC): the menu is built only while it is open.
 */

/** No menu has more items than this (a submenu counts as one): longer menus fold into submenus (Copy as ▸, New request ▸). */
export const MAX_MENU_ITEMS = 18;

/** The text of a label key (a key the vocabulary lacks is a compile error). */
const text = (key: MenuLabelKey): string => LABEL[key];

/** A node's menu group by group (empty groups included), in MENU_GROUPS order. */
export function nodeMenuGroups(kind: NodeKind, ctx: NodeMenuCtx): Array<{ group: MenuGroup; items: MenuItem[] }> {
  return nodeMenuEntries(kind, ctx).map(({ group, entries }) => {
    const items: MenuItem[] = group === 'create' ? [...(ctx.create ?? [])] : [];
    for (const e of entries) {
      const act = ctx.on[e.def.id as ActionId] as Act;
      items.push({
        label: text(e.label),
        icon: icon(e.def.icon),
        ...(e.def.danger ? { danger: true } : {}),
        ...(e.shortcut ? { shortcut: e.shortcut } : {}),
        onSelect: typeof act === 'function' ? () => void act() : () => undefined,
        ...(Array.isArray(act) ? { items: act } : {}),
        ...(e.disabled ? { disabled: true, title: e.disabled } : {}),
      });
    }
    return { group, items };
  });
}
type MenuGroup = ReturnType<typeof nodeMenuEntries>[number]['group'];

/** Build a node's menu (call it only while the menu is open): its groups, each after a separator. */
export function buildNodeMenu(kind: NodeKind, ctx: NodeMenuCtx): MenuItem[] {
  const groups = nodeMenuGroups(kind, ctx).map((g) => g.items);
  const out = groups.filter((g) => g.length).flatMap((g, i) => g.map((it, j) => ({ ...it, separator: i > 0 && j === 0 })));
  if (out.length > MAX_MENU_ITEMS && import.meta.env?.DEV) console.error(`The ${kind} menu has ${out.length} items (at most ${MAX_MENU_ITEMS}): fold some into a submenu`);
  return out;
}

/** A context that offers every action (the shape of a kind's menu: what it can show at most). */
export function fullCtx(kind: NodeKind): NodeMenuCtx {
  const { on, creates, ...rest } = fullMenuContext(kind);
  const noop = () => undefined;
  const handlers: Partial<Record<ActionId, Act>> = {};
  for (const [id, v] of Object.entries(on)) (handlers as Record<string, Act>)[id] = Array.isArray(v) ? [] : noop;
  return { ...rest, on: handlers, create: creates ? [{ label: 'New …', onSelect: noop }] : [] };
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
