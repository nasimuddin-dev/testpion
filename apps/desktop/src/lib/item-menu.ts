import { kindOfRef, type ItemRef, type KindId } from '@testpion/shared';
import type { MenuItem } from '../components/ui';
import { withRefDefaults } from '../components/TreeParts';
import { buildNodeMenu, type NodeMenuCtx } from './node-menu';
import { openRef, revealInSidebar } from './open-ref';

/**
 * The ⋯ of an open item's editor (its breadcrumb, or the toolbar's MoreMenu where there is no breadcrumb): the item's
 * node menu, built by lib/node-menu.ts like its row's in the tree, so Delete… (LABEL.delete, the kind's undo or confirm
 * policy), Rename, Duplicate, Export…, the git items and Copy link are the same in the editor as in the sidebar. Open
 * is left out (this page is it); Open in new tab and Reveal in sidebar are offered by default. The view says what else
 * it can do (`on`: delete, duplicate, rename …) and the kind's own actions it has (run, pause …).
 */
/** A node menu context that names its item (the editor's ⋯ needs the ref for Open in new tab, Copy link and the git items). */
export type OpenItemCtx = NodeMenuCtx & { ref: ItemRef };

export function openItemMenu(kind: KindId, ctx: OpenItemCtx): MenuItem[] {
  const ref = ctx.ref;
  const info = kindOfRef(ref as ItemRef & { library?: string });
  const on: NodeMenuCtx['on'] = {
    openNewTab: () => void openRef(ref, { newTab: true }),
    // what the explorer shows (collections, their requests and calls, API definitions, datasets, MCP servers) is revealed there
    ...(info?.parent === 'collection' || info?.id === 'collection' || info?.id === 'spec' || info?.id === 'dataset' || info?.id === 'mcp-server'
      ? { revealInSidebar: () => revealInSidebar(ref) }
      : {}),
    ...ctx.on,
  };
  const { open: _open, ...rest } = on;
  return buildNodeMenu(kind, withRefDefaults({ ...ctx, on: rest }, kind));
}
