import { describe, expect, it, vi } from 'vitest';
import { NODE_KINDS, baseKind, can, kindsWith, type KindId } from '@testpion/shared';
// the dialogs are opened through the app store, which needs a window: the opener is all this test needs of it
const opened: Array<Record<string, unknown>> = [];
vi.mock('../../apps/desktop/src/store', () => ({ useApp: { getState: () => ({ set: (p: Record<string, unknown>) => opened.push(p) }) } }));
import { buildNodeMenu, type NodeKind, type NodeMenuCtx } from '../../apps/desktop/src/lib/node-menu';
import { transferActions } from '../../apps/desktop/src/lib/transfer';

/**
 * Export… and Import… come to every node through one function (lib/transfer.ts, applied by withRefDefaults): a view
 * supplies nothing for them. The registry's `export` / `import` capabilities decide who shows them.
 */
const labels = (kind: NodeKind, ctx: NodeMenuCtx) => buildNodeMenu(kind, { ...ctx, on: { ...transferActions(kind, ctx), ...ctx.on } }).map((i) => i.label);
const refOf = (kind: KindId): NodeMenuCtx['ref'] => {
  switch (kind) {
    case 'environment':
      return { kind: 'environment', environmentId: 'e' };
    case 'spec':
      return { kind: 'spec', path: 'specs/a.yaml' };
    case 'dataset':
      return { kind: 'dataset', name: 'a.csv' };
    case 'test':
      return { kind: 'test', path: 'a.yaml' };
    case 'mcp-server':
      return { kind: 'mcp-server', serverId: 's' };
    case 'monitor':
      return { kind: 'monitor', monitorId: 'm' };
    case 'provider':
      return { kind: 'provider', providerId: 'p' };
    case 'collection':
      return { kind: 'collection', collectionId: 'c' };
    default:
      return { kind: 'saved', library: 'grpc', itemId: 'g' };
  }
};

describe('Export… and Import… on every node', () => {
  it('a section header of a kind that exports has Export…, and Import… when it imports', () => {
    const sections = NODE_KINDS.filter((k) => k.startsWith('section:'));
    expect(sections.length).toBeGreaterThan(6);
    for (const k of sections) {
      const base = baseKind(k);
      const l = labels(k, { on: {} });
      expect(l.includes('Export…'), `${k} Export…`).toBe(can(base, 'export'));
      expect(l.includes('Import…'), `${k} Import…`).toBe(can(base, 'import'));
    }
  });

  it('an item of a kind that exports has Export… from its ref alone', () => {
    for (const k of kindsWith('export')) {
      if (k.storage.layout === 'record' || k.storage.layout === 'ref-only') continue;
      const l = labels(k.id, { ref: refOf(k.id), name: 'x', on: {} });
      expect(l.includes('Export…'), `${k.id} Export…`).toBe(true);
    }
  });

  it('a kind that does not export shows none, and a view’s own Export (a collection’s submenu of formats) wins', () => {
    // a request and a folder export as a part of their collection (one way: not a submenu)
    expect(labels('request', { ref: { kind: 'request', collectionId: 'c', requestId: 'r' }, on: {} })).toContain('Export…');
    expect(labels('folder', { ref: { kind: 'folder', collectionId: 'c', folderId: 'f' }, name: 'F', on: {} })).toEqual(expect.arrayContaining(['Export…', 'Import here…']));
    expect(labels('collection', { ref: { kind: 'collection', collectionId: 'c' }, name: 'C', on: {} })).toContain('Import here…');
    expect(labels('spec', { ref: { kind: 'spec', path: 'specs/a.yaml' }, name: 'a', on: {} })).not.toContain('Import here…');
    expect(labels('run', { ref: { kind: 'run', runId: 'r' }, on: {} })).not.toContain('Export…');
    const own = buildNodeMenu('collection', { ref: { kind: 'collection', collectionId: 'c' }, on: { export: [{ label: 'Mine', onSelect: () => undefined }] } });
    expect(own.find((i) => i.items)?.label).toBe('Export');
    expect(own.find((i) => i.items)?.items?.[0]?.label).toBe('Mine');
  });

  it('the handlers open the shared dialogs (no per-view code): a section exports its kind, an item itself', () => {
    const section = transferActions('section:dataset', { on: {} });
    expect(Object.keys(section).sort()).toEqual(['export', 'import']);
    (section.export as () => void)();
    (section.import as () => void)();
    const item = transferActions('spec', { ref: refOf('spec'), name: 'a', on: {} });
    expect(Object.keys(item)).toEqual(['export']);
    (item.export as () => void)();
    expect(opened).toEqual([{ exportBundle: { section: 'dataset' } }, { importBundle: { section: 'dataset' } }, { exportBundle: { selection: [{ kind: 'spec', path: 'specs/a.yaml' }], title: 'a' } }]);
    // a folder of a list exports the items in it (a test folder by its path under tests/), a collection or a folder takes a bundle’s requests
    opened.length = 0;
    (transferActions('folder:spec', { name: 'f', on: {} }).export as () => void)();
    (transferActions('folder:test', { name: 'api', folder: 'smoke/api', on: {} }).export as () => void)();
    expect(opened).toEqual([{ exportBundle: { folder: { kind: 'spec', name: 'f' }, title: 'f' } }, { exportBundle: { folder: { kind: 'test', name: 'smoke/api' }, title: 'smoke/api' } }]);
    expect(transferActions('folder:spec', { on: {} })).toEqual({});
    opened.length = 0;
    (transferActions('folder', { ref: { kind: 'folder', collectionId: 'c', folderId: 'f' }, name: 'F', on: {} }).importHere as () => void)();
    expect(opened).toEqual([{ importBundle: { into: { collectionId: 'c', folderId: 'f', name: 'F' } } }]);
  });
});
