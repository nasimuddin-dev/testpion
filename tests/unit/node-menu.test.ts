import { describe, expect, it } from 'vitest';
import { KIND_ACTIONS, KIND_INFO, STANDARD_ACTIONS, folderNodeKinds, liveKinds, nodeMenuShapeOf, nodeMenusOf, sectionNodeKinds, type Capability, type KindId } from '@testpion/shared';
import { MAX_MENU_ITEMS, MENU_GROUPS, NODE_KINDS, baseKind, buildNodeMenu, fullCtx, nodeCapabilities, nodeMenuGroups, nodeMenuShape, type NodeKind } from '../../apps/desktop/src/lib/node-menu';
import { ACTION_ICONS } from '../../apps/desktop/src/lib/node-menu-actions';
import { LABEL } from '../../apps/desktop/src/lib/vocabulary';

/**
 * MENU-1 (planning/menus-uniform.md §4 Tests): one function builds every tree and list node menu, in one group order;
 * the shared items come from the kind's capabilities, so a gap (a container without Expand all, a deletable kind without
 * Delete…) cannot come back. The shape snapshot makes any change to a menu show in review.
 */

const labels = new Set<string>(Object.values(LABEL));
const flat = (kind: NodeKind) => buildNodeMenu(kind, fullCtx(kind));

/** The item each menu capability implies (master-roadmap §1.9). */
const IMPLIES: Partial<Record<Capability, RegExp>> = {
  rename: /^Rename/,
  duplicate: /^Duplicate/,
  move: /^Move to/,
  delete: /^Delete/,
  container: /^Expand all$/,
  run: /^Run( collection| folder| now)?$/,
  monitor: /^Monitor on a schedule…$/,
  ci: /^Run in CI…$/,
  'test-file': /^(Save as test…|Create test file from (collection|folder)…)$/,
  flow: /^Generate integration flow with AI…$/,
  favorite: /^(Add to|Remove from) favorites$/,
  link: /^Copy link$/,
  export: /^Export/,
  'git-history': /^Git$/,
};

describe('node menus', () => {
  it('every node kind lists only known groups, in MENU_GROUPS order, with no empty separators', () => {
    expect(MENU_GROUPS).toEqual(['create', 'open', 'tree', 'run', 'share', 'tools', 'git', 'edit', 'danger']);
    for (const kind of NODE_KINDS) {
      const groups = nodeMenuGroups(kind, fullCtx(kind));
      expect(
        groups.map((g) => g.group),
        kind,
      ).toEqual([...MENU_GROUPS]);
      const items = flat(kind);
      expect(items[0]?.separator ?? false, `${kind}: leading separator`).toBe(false);
      // a separator only where a group starts
      const starts = groups.filter((g) => g.items.length).map((g) => g.items[0]!.label);
      expect(
        items.filter((i) => i.separator).map((i) => i.label),
        kind,
      ).toEqual(starts.slice(1));
    }
  });

  it('every capability a kind has shows its item (no gap can come back)', () => {
    for (const k of liveKinds()) {
      const shown = flat(k.id).map((i) => i.label);
      for (const [cap, re] of Object.entries(IMPLIES) as Array<[Capability, RegExp]>) {
        if (k.capabilities[cap] !== true) continue;
        expect(
          shown.some((l) => re.test(l)),
          `${k.id} has ${cap} but its menu has no ${re}: ${shown.join(' | ')}`,
        ).toBe(true);
      }
    }
  });

  it('every container — item, section, folder, category — has Expand all and Collapse all, before Run', () => {
    for (const kind of NODE_KINDS) {
      if (nodeCapabilities(kind).container !== true) continue;
      const shown = flat(kind).map((i) => i.label);
      expect(shown, kind).toContain(LABEL.expandAll);
      expect(shown, kind).toContain(LABEL.collapseAll);
      const run = shown.findIndex((l) => /^Run/.test(l));
      if (run >= 0) expect(shown.indexOf(LABEL.collapseAll), kind).toBeLessThan(run);
    }
  });

  it('Delete… is always last, and a folder of a list says Delete folder…', () => {
    for (const kind of NODE_KINDS) {
      const items = flat(kind);
      const del = items.findIndex((i) => /^Delete/.test(i.label));
      if (del < 0) continue;
      expect(del, kind).toBe(items.length - 1);
      expect(items[del]!.danger, kind).toBe(true);
      expect(items[del]!.label, kind).toBe(kind.startsWith('folder:') ? LABEL.deleteFolder : LABEL.delete);
    }
  });

  it('labels come from LABEL (the vocabulary), and no menu is longer than 18 items', () => {
    for (const kind of NODE_KINDS) {
      const items = flat(kind).filter((i) => i.label !== 'New …');
      for (const i of items) expect(labels.has(i.label), `${kind}: "${i.label}" is not in LABEL`).toBe(true);
      expect(flat(kind).length, kind).toBeLessThanOrEqual(MAX_MENU_ITEMS);
    }
  });

  it('an action the kind does not have is left out, whatever the view offers', () => {
    const on = { rename: () => undefined, favorite: () => undefined, move: () => undefined, run: () => undefined };
    expect(buildNodeMenu('trace', { on }).map((i) => i.label)).toEqual([]);
    expect(buildNodeMenu('request', { on }).map((i) => i.label)).toEqual([LABEL.rename, LABEL.moveTo, LABEL.addFavorite]);
    expect(buildNodeMenu('request', { on, favorite: true }).map((i) => i.label)).toContain(LABEL.removeFavorite);
  });

  it('an action that applies but cannot run now is disabled with the reason', () => {
    const items = buildNodeMenu('run', { on: { open: () => undefined, rerunFailed: () => undefined }, disabled: { rerunFailed: 'Nothing failed in this run' } });
    expect(items.find((i) => i.label === LABEL.rerunFailed)).toMatchObject({ disabled: true, title: 'Nothing failed in this run' });
  });

  it('the git group needs a repository; Copy as and Move to folder are submenus', () => {
    expect(buildNodeMenu('collection', { on: { gitMenu: [] } })).toEqual([]);
    expect(buildNodeMenu('collection', { on: { gitMenu: [] }, repo: true }).map((i) => i.label)).toEqual([LABEL.gitMenu]);
    const sub = [{ label: 'cURL (bash)', onSelect: () => undefined }];
    expect(buildNodeMenu('request', { on: { copyAs: sub } })[0]).toMatchObject({ label: LABEL.copyAs, items: sub });
    expect(buildNodeMenu('prompt', { on: { move: [] } })[0]!.label).toBe(LABEL.moveToFolder);
    expect(buildNodeMenu('grpc-call', { on: { move: [] } })[0]!.label).toBe(LABEL.moveToCollection);
  });

  it('the collection menu keeps its items (apart from order), adds Copy link, and moves pm.* under Export ▸ For Postman', () => {
    const items = buildNodeMenu('collection', {
      ref: { kind: 'collection', collectionId: 'c' },
      repo: true,
      create: [
        { label: 'New HTTP request', onSelect: () => undefined },
        { label: LABEL.newRequest, onSelect: () => undefined, items: [] },
      ],
      on: Object.fromEntries(
        ['newFolder', 'expandAll', 'collapseAll', 'run', 'copyLink', 'monitor', 'ci', 'testFile', 'flow', 'collectionSettings', 'convertScripts', 'gitMenu', 'rename', 'duplicate', 'delete'].map(
          (id) => [id, () => undefined],
        ),
      ),
    });
    expect(items.map((i) => (i.separator ? `| ${i.label}` : i.label))).toEqual([
      'New HTTP request',
      LABEL.newRequest,
      LABEL.newFolder,
      `| ${LABEL.expandAll}`,
      LABEL.collapseAll,
      `| ${LABEL.runCollection}`,
      `| ${LABEL.copyLink}`,
      `| ${LABEL.monitor}`,
      LABEL.runInCi,
      LABEL.createTestFileFromCollection,
      LABEL.generateFlow,
      LABEL.collectionSettings,
      LABEL.convertScriptsTp,
      `| ${LABEL.gitMenu}`,
      `| ${LABEL.rename}`,
      LABEL.duplicate,
      `| ${LABEL.delete}`,
    ]);
    const withExport = buildNodeMenu('collection', { on: { export: [{ label: LABEL.forPostman, onSelect: () => undefined }] } });
    expect(withExport[0]).toMatchObject({ label: LABEL.exportSubmenu, items: [{ label: LABEL.forPostman }] });
  });

  it('section, folder and category nodes are generated from their kind', () => {
    expect(baseKind('section:mcp-server')).toBe('mcp-server');
    expect(baseKind('folder:spec')).toBe('spec');
    expect(baseKind('category')).toBe('request');
    // New folder only where the kind has folders
    expect(flat('section:mcp-server').map((i) => i.label)).toContain(LABEL.newFolder);
    expect(flat('section:environment').map((i) => i.label)).not.toContain(LABEL.newFolder);
    for (const k of ['mcp-server', 'spec', 'dataset'] as KindId[]) expect(KIND_INFO[k].folders, k).not.toBe('none');
  });

  it('a shape per kind (any change to a menu shows here)', () => {
    expect(Object.fromEntries(NODE_KINDS.map((k) => [k, nodeMenuShape(k)]))).toMatchSnapshot();
  });

  it('section and folder nodes come from the registry: every live kind with folders has a folder node, every listed kind a section node', () => {
    // today's ten folder kinds and eleven section kinds, derived, not listed
    expect(folderNodeKinds().map((k) => k.id)).toEqual(['grpc-call', 'ws-connection', 'test', 'dataset', 'spec', 'mcp-server', 'prompt', 'load-test', 'evaluation', 'monitor']);
    expect(sectionNodeKinds().map((k) => k.id)).toEqual(['collection', 'environment', 'test', 'dataset', 'spec', 'mcp-server', 'provider', 'prompt', 'load-test', 'evaluation', 'monitor']);
    for (const k of liveKinds()) {
      const folders = typeof k.folders === 'object' || (k.folders === 'dirs' && !k.variantOf && k.opens !== 'none');
      expect(NODE_KINDS.includes(`folder:${k.id}`), `folder:${k.id}`).toBe(folders);
      expect(NODE_KINDS.includes(`section:${k.id}`), `section:${k.id}`).toBe(!!k.listed);
      // a listed kind with virtual folders or a tree has both nodes
      if (k.listed && (typeof k.folders === 'object' || k.folders === 'dirs') && !k.variantOf) expect(NODE_KINDS, k.id).toEqual(expect.arrayContaining([`folder:${k.id}`, `section:${k.id}`]));
    }
    // nothing registered ahead of its release
    expect(NODE_KINDS.filter((n) => KIND_INFO[baseKind(n)].since)).toEqual([]);
  });

  it('the action tables are complete for the window: every label key is in LABEL, every icon name has a component, every id is unique', () => {
    const ids = new Set<string>();
    for (const a of [...STANDARD_ACTIONS, ...KIND_ACTIONS]) {
      expect(ids.has(a.id), `${a.id} twice`).toBe(false);
      ids.add(a.id);
      if (a.icon) expect(ACTION_ICONS[a.icon], `${a.id}: no icon ${a.icon}`).toBeTruthy();
      if (typeof a.label === 'string') expect(LABEL[a.label], `${a.id}: no LABEL.${a.label}`).toBeTruthy();
    }
    // the label functions too, over every node kind and context
    for (const kind of NODE_KINDS)
      for (const g of nodeMenuGroups(kind, fullCtx(kind)))
        for (const i of g.items) expect(labels.has(i.label) || i.label === 'New …', `${kind}: ${i.label}`).toBe(true);
  });

  it('the keys that run an item are declared once and shown beside it (Enter, F2, Del, *), in the window and for agents', () => {
    const shortcuts = Object.fromEntries(STANDARD_ACTIONS.filter((a) => 'shortcut' in a).map((a) => [a.id, a.shortcut]));
    expect(shortcuts).toEqual({ open: 'Enter', expandAll: '*', rename: 'F2', delete: 'Del' });
    const items = flat('request');
    expect(items.find((i) => i.label === LABEL.open)?.shortcut).toBe('Enter');
    expect(items.find((i) => i.label === LABEL.rename)?.shortcut).toBe('F2');
    expect(items.find((i) => i.label === LABEL.delete)?.shortcut).toBe('Del');
    expect(flat('collection').find((i) => i.label === LABEL.expandAll)?.shortcut).toBe('*');
    const shape = nodeMenuShapeOf('request');
    expect(shape.groups.find((g) => g.group === 'danger')?.actions).toEqual([{ id: 'delete', label: 'delete', shortcut: 'Del' }]);
  });

  it('the menu shape for agents (list_kinds nodes) mirrors the window’s menu, with label keys and submenus', () => {
    for (const kind of NODE_KINDS) {
      const shape = nodeMenuShapeOf(kind);
      const groups = nodeMenuGroups(kind, fullCtx(kind)).filter((g) => g.items.some((i) => i.label !== 'New …'));
      expect(shape.groups.map((g) => g.group), kind).toEqual(groups.map((g) => g.group));
      for (const [i, g] of shape.groups.entries()) expect(g.actions.map((a) => `${LABEL[a.label]}${a.submenu ? ' ▸' : ''}`), `${kind} ${g.group}`).toEqual(groups[i]!.items.filter((it) => it.label !== 'New …').map((it) => `${it.label}${it.items ? ' ▸' : ''}`));
      expect(shape.creates, kind).toBe(nodeMenuGroups(kind, fullCtx(kind))[0]!.items.some((i) => i.label === 'New …'));
    }
    expect(nodeMenusOf('request').map((n) => n.node)).toEqual(['request', 'category', 'favorites']);
    expect(nodeMenusOf('mcp-server').map((n) => n.node)).toEqual(['mcp-server', 'section:mcp-server', 'folder:mcp-server']);
  });

  it('builds a menu in well under a millisecond per kind', () => {
    const ctxs = NODE_KINDS.map((k) => [k, fullCtx(k)] as const);
    // the best of five batches (never one sample of the wall clock)
    let best = Infinity;
    for (let b = 0; b < 5; b++) {
      const t0 = performance.now();
      for (let i = 0; i < 20; i++) for (const [k, c] of ctxs) buildNodeMenu(k, c);
      best = Math.min(best, (performance.now() - t0) / (20 * ctxs.length));
    }
    expect(best).toBeLessThan(1);
  });
});
