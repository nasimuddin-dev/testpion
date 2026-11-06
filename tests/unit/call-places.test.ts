import { describe, expect, it } from 'vitest';
import { AT_START, interleave, placeBefore, repointAfter, shownOrder, siblingBefore } from '../../packages/shared/src/collection-calls';
import { dropBefore, followersOf } from '../../apps/desktop/src/lib/call-places';
import { buildTreeRows, folderOpenKey, type ExtraGroup, type TreeRow } from '../../apps/desktop/src/lib/tree-rows';
import type { Collection, CollectionNode } from '../../apps/desktop/src/types';

// gRPC calls and connections keep their place among a folder's requests (`after`) when a sibling is deleted, moved or
// dropped among them; the tree's rows count a folder's calls in one pass.

type Call = { id: string; name: string; after?: string; folderId?: string };
const call = (id: string, after?: string, folderId?: string): Call => ({ id, name: id, ...(after ? { after } : {}), ...(folderId ? { folderId } : {}) });
const req = (id: string): CollectionNode => ({ kind: 'http', id, name: id, request: { method: 'GET', url: `https://x/${id}`, headers: [], params: [] } }) as unknown as CollectionNode;
const folder = (id: string, items: CollectionNode[]): CollectionNode => ({ kind: 'folder', id, name: id, items }) as CollectionNode;
const collection = (id: string, items: CollectionNode[]) => ({ schemaVersion: '1.0', id, name: id, version: 1, variables: [], updatedAt: '', items }) as unknown as Collection;
/** The order shown once the changes are made: the calls with their new `after`, the moved item at its place. */
const applied = (calls: Call[], after: Map<string, string>) => calls.map((c) => (after.has(c.id) ? { ...c, after: after.get(c.id) } : c));

describe('the calls that followed an item that is gone', () => {
  const nodes = [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }];

  it('follow what it followed, so they keep their place instead of falling to the end', () => {
    const calls = [call('g1', 'r2'), call('g2', 'g1'), call('loose')];
    expect(shownOrder(nodes, calls)).toEqual(['r1', 'r2', 'g1', 'g2', 'r3', 'loose']);
    // r2 deleted without re-pointing: its calls fall to the end
    const without = nodes.filter((n) => n.id !== 'r2');
    expect(shownOrder(without, calls)).toEqual(['r1', 'r3', 'g1', 'g2', 'loose']);
    // re-pointed to what r2 followed: they stay where they were
    const moved = repointAfter(calls, 'r2', siblingBefore(nodes, calls, 'r2'));
    expect(moved.find((c) => c.id === 'g1')!.after).toBe('r1');
    expect(shownOrder(without, moved)).toEqual(['r1', 'g1', 'g2', 'r3', 'loose']);
    // the calls that did not follow it are the same objects
    expect(moved[1]).toBe(calls[1]);
    expect(moved[2]).toBe(calls[2]);
  });

  it('the first item of a folder gone: its calls are the first now', () => {
    const calls = [call('g1', 'r1')];
    expect(siblingBefore(nodes, calls, 'r1')).toBeUndefined();
    const moved = repointAfter(calls, 'r1', undefined);
    expect(moved[0]!.after).toBe(AT_START);
    expect(shownOrder(nodes.slice(1), moved)).toEqual(['g1', 'r2', 'r3']);
  });

  it('a call gone: the calls after it follow the sibling before it (a request or another call)', () => {
    const calls = [call('g1', 'r1'), call('g2', 'g1'), call('g3', 'g2')];
    const rest = repointAfter(calls, 'g2', siblingBefore(nodes, calls, 'g2')).filter((c) => c.id !== 'g2');
    expect(shownOrder(nodes, rest)).toEqual(['r1', 'g1', 'g3', 'r2', 'r3']);
    // a call never follows itself
    expect(repointAfter([call('g1', 'g1')], 'g1', 'r1')[0]!.after).toBe('g1');
  });

  it('in a collection: only the calls of its folder, by where it is shown', () => {
    const c = collection('shop', [folder('pay', [req('list'), req('refund')]), req('health')]);
    const calls = [call('g-pay', 'refund', 'pay'), call('g-list', 'list', 'pay'), call('g-top', 'health'), call('g-lost', 'refund', 'gone')];
    expect([...followersOf(c, calls, 'refund')]).toEqual([['g-pay', 'g-list']]);
    expect([...followersOf(c, calls, 'list')]).toEqual([['g-list', AT_START]]);
    expect([...followersOf(c, calls, 'pay')]).toEqual([]);
    expect([...followersOf(c, calls, 'nowhere')]).toEqual([]);
  });
});

describe('an item dropped just before a sibling', () => {
  const nodes = [{ id: 'r1' }, { id: 'r2' }];
  // shown: r1, g1, r2, then the calls without a sibling by name
  const calls = [call('g1', 'r1'), call('zed'), call('alpha')];

  it('a call before another call: it follows what that call followed, and that call follows it', () => {
    expect(shownOrder(nodes, calls)).toEqual(['r1', 'g1', 'r2', 'alpha', 'zed']);
    const p = placeBefore(nodes, calls, { id: 'zed' }, 'g1');
    expect(Object.fromEntries(p.after)).toEqual({ zed: 'r1', g1: 'zed' });
    expect(p.beforeNode).toBeUndefined();
    expect(shownOrder(nodes, applied(calls, p.after))).toEqual(['r1', 'zed', 'g1', 'r2', 'alpha']);
  });

  it('a call before a request, and before the first item of the folder', () => {
    const p = placeBefore(nodes, calls, { id: 'alpha' }, 'r2');
    expect(shownOrder(nodes, applied(calls, p.after))).toEqual(['r1', 'g1', 'alpha', 'r2', 'zed']);
    const first = placeBefore(nodes, calls, { id: 'alpha' }, 'r1');
    expect(first.after.get('alpha')).toBe(AT_START);
    expect(shownOrder(nodes, applied(calls, first.after))).toEqual(['alpha', 'r1', 'g1', 'r2', 'zed']);
  });

  it('a call reordered takes no other call with it: the calls that followed it follow what it followed', () => {
    const chain = [call('g1', 'r1'), call('g2', 'g1'), call('g3', 'r2')];
    const p = placeBefore(nodes, chain, { id: 'g1' }, 'g3');
    expect(shownOrder(nodes, applied(chain, p.after))).toEqual(['r1', 'g2', 'r2', 'g1', 'g3']);
    // its own place is always said, also when it is the one it had
    expect(placeBefore(nodes, chain, { id: 'g2' }, 'r2').after.get('g2')).toBe('g1');
  });

  it('a call from another folder lands before the sibling', () => {
    const p = placeBefore(nodes, calls, { id: 'new' }, 'alpha');
    expect(shownOrder(nodes, applied([...calls, call('new')], p.after))).toEqual(['r1', 'g1', 'r2', 'new', 'alpha', 'zed']);
  });

  it('a request before a call: among the requests where the call is shown, and the calls from there on follow it', () => {
    // before a call in the middle
    const mid = placeBefore(nodes, calls, { id: 'r9', node: true }, 'g1');
    expect(mid.beforeNode).toBe('r2');
    expect(shownOrder([{ id: 'r1' }, { id: 'r9' }, { id: 'r2' }], applied(calls, mid.after))).toEqual(['r1', 'r9', 'g1', 'r2', 'alpha', 'zed']);
    // before a call at the end of the folder: the calls shown before it stay before it
    const end = placeBefore(nodes, calls, { id: 'r9', node: true }, 'zed');
    expect(end.beforeNode).toBeUndefined();
    expect(shownOrder([...nodes, { id: 'r9' }], applied(calls, end.after))).toEqual(['r1', 'g1', 'r2', 'alpha', 'r9', 'zed']);
    // a request of the folder itself, moved down before a call
    const own = placeBefore(nodes, calls, { id: 'r1', node: true }, 'zed');
    expect(shownOrder([{ id: 'r2' }, { id: 'r1' }], applied(calls, own.after))).toEqual(['g1', 'r2', 'alpha', 'r1', 'zed']);
  });

  it('a sibling that is not there changes nothing', () => {
    expect(placeBefore(nodes, calls, { id: 'zed' }, 'nowhere')).toEqual({ after: new Map() });
    expect(placeBefore(nodes, calls, { id: 'zed' }, 'zed').after.size).toBe(0);
  });

  it('in a collection: the folder of the sibling, a call or a request', () => {
    const c = collection('shop', [folder('pay', [req('list'), req('refund')]), req('health')]);
    const placed = [call('g-pay', 'list', 'pay'), call('g-top', 'health')];
    const inFolder = dropBefore(c, placed, { id: 'g-top' }, 'g-pay')!;
    expect(inFolder.folderId).toBe('pay');
    expect(Object.fromEntries(inFolder.after)).toEqual({ 'g-top': 'list', 'g-pay': 'g-top' });
    const top = dropBefore(c, placed, { id: 'g-pay' }, 'health')!;
    expect(top.folderId).toBeUndefined();
    expect(top.after.get('g-pay')).toBe('pay');
    const node = dropBefore(c, placed, { id: 'health', node: true }, 'g-pay')!;
    expect(node).toMatchObject({ folderId: 'pay', beforeNode: 'refund' });
    expect(node.after.get('g-pay')).toBe('health');
    expect(dropBefore(c, placed, { id: 'g-pay' }, 'nowhere')).toBeUndefined();
  });
});

describe("the tree's rows with calls", () => {
  const shape = (rows: TreeRow[]) =>
    rows.map((r) =>
      r.t === 'col'
        ? `col ${r.c.id}`
        : r.t === 'folder'
          ? `${'  '.repeat(r.depth)}folder ${r.n.id}${r.calls ? ` (${r.calls} calls)` : ''}`
          : r.t === 'req'
            ? `${'  '.repeat(r.depth)}${r.n.kind} ${r.n.id}`
            : r.t === 'xitem'
              ? `${'  '.repeat(r.depth)}${r.g.cat} ${r.i.id}`
              : r.t,
    );
  const shop = collection('shop', [folder('a', [req('a1'), folder('b', [folder('c', [req('c1')]), folder('d', [])]), folder('e', [])]), folder('f', []), req('top')]);
  const groups = (): ExtraGroup[] => [
    {
      cat: 'grpc',
      kind: 'grpc-call',
      onOpen: () => undefined,
      items: [call('g-a', 'a1', 'a'), call('g-c1', undefined, 'c'), call('g-c2', 'g-c1', 'c'), call('g-top'), call('g-gone', undefined, 'deleted')],
    },
    { cat: 'websocket', kind: 'ws-connection', onOpen: () => undefined, items: [call('w-b', undefined, 'b'), call('w-f', undefined, 'f')] },
  ];
  const everyFolder = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => [folderOpenKey('shop', id), true]));

  it('every folder counts its calls and those of the folders inside it', () => {
    expect(shape(buildTreeRows({ collections: [shop], open: { shop: true, ...everyFolder }, extraGroups: groups }))).toEqual([
      'col shop',
      '  folder a (4 calls)',
      '    http a1',
      '    grpc g-a',
      '    folder b (3 calls)',
      '      folder c (2 calls)',
      '        http c1',
      '        grpc g-c1',
      '        grpc g-c2',
      '      folder d',
      '      websocket w-b',
      '    folder e',
      '  folder f (1 calls)',
      '    websocket w-f',
      '  http top',
      '  grpc g-gone',
      '  grpc g-top',
    ]);
    // folded: the counts are the same
    expect(shape(buildTreeRows({ collections: [shop], open: { shop: true }, extraGroups: groups }))).toEqual([
      'col shop',
      '  folder a (4 calls)',
      '  folder f (1 calls)',
      '  http top',
      '  grpc g-gone',
      '  grpc g-top',
    ]);
  });

  it('a tree that is given the calls shows them, the explorer or not; a call row knows its collection', () => {
    const rows = buildTreeRows({ collections: [shop], open: { shop: true }, explorer: true, extraGroups: groups });
    expect(rows.filter((r) => r.t === 'xitem').map((r) => r.t === 'xitem' && r.c.id)).toEqual(['shop', 'shop']);
    expect(shape(buildTreeRows({ collections: [shop], open: { shop: true } }))).toEqual(['col shop', '  folder a', '  folder f', '  http top']);
  });

  it('only favourites: no call shows (a call cannot be a favourite), as no request that is not one', () => {
    const fav = collection('shop', [folder('a', [{ ...req('a1'), favorite: true } as CollectionNode, req('a2')])]);
    expect(shape(buildTreeRows({ collections: [fav], open: { shop: true, [folderOpenKey('shop', 'a')]: true }, favoritesOnly: true, extraGroups: groups }))).toEqual([
      'col shop',
      '  folder a (1 calls)',
      '    http a1',
    ]);
  });

  it('3,000 folders build fast, with no calls and with calls', () => {
    // 30 folders of 99 folders each, every one open and holding a request
    const many = collection(
      'big',
      Array.from({ length: 30 }, (_, i) =>
        folder(
          `f${i}`,
          Array.from({ length: 99 }, (_, j) => folder(`f${i}-${j}`, [req(`r${i}-${j}`)])),
        ),
      ),
    );
    const open: Record<string, boolean> = { big: true };
    for (let i = 0; i < 30; i++) {
      open[folderOpenKey('big', `f${i}`)] = true;
      for (let j = 0; j < 99; j++) open[folderOpenKey('big', `f${i}-${j}`)] = true;
    }
    const timed = (extraGroups?: (c: Collection) => ExtraGroup[]) => {
      const start = performance.now();
      const rows = buildTreeRows({ collections: [many], open, explorer: true, extraGroups });
      return { rows, ms: performance.now() - start };
    };
    const plain = timed();
    expect(plain.rows.length).toBe(1 + 3000 + 2970);
    expect(plain.rows.some((r) => r.t === 'folder' && r.calls)).toBe(false);
    expect(plain.ms).toBeLessThan(500);
    // 3,000 calls, one in every innermost folder and 30 in the first one
    const items = [...Array.from({ length: 2970 }, (_, k) => call(`g${k}`, undefined, `f${Math.floor(k / 99)}-${k % 99}`)), ...Array.from({ length: 30 }, (_, k) => call(`h${k}`, undefined, 'f0'))];
    const withCalls = timed(() => [{ cat: 'grpc', kind: 'grpc-call', onOpen: () => undefined, items }]);
    expect(withCalls.rows.length).toBe(1 + 3000 + 2970 + 3000);
    const first = withCalls.rows.find((r) => r.t === 'folder' && r.n.id === 'f0');
    expect(first).toMatchObject({ calls: 99 + 30 });
    expect(withCalls.ms).toBeLessThan(500);
  });

  it('interleave is the order of the rows', () => {
    expect(interleave([{ id: 'r1' }], [call('g1', 'r1')]).map((x) => ('node' in x ? x.node.id : x.call.id))).toEqual(shownOrder([{ id: 'r1' }], [call('g1', 'r1')]));
  });
});
