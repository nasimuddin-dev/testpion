import { describe, expect, it } from 'vitest';
import { buildTreeRows, folderOpenKey, type ExtraGroup, type TreeRow } from '../../apps/desktop/src/lib/tree-rows';
import type { Collection, CollectionNode } from '../../apps/desktop/src/types';

// Any kind of request in any folder: in the explorer, a collection's folders hold its REST, SOAP and GraphQL requests
// and its gRPC calls and connections (kept in the library, placed by folderId / after).

const req = (id: string): CollectionNode => ({ kind: 'http', id, name: id, request: { method: 'GET', url: `https://x/${id}`, headers: [], params: [] } }) as unknown as CollectionNode;
const gql = (id: string): CollectionNode => ({ kind: 'graphql', id, name: id, request: { endpoint: 'https://x/graphql', query: '{ a }', headers: [] } }) as unknown as CollectionNode;
const folder = (id: string, items: CollectionNode[]): CollectionNode => ({ kind: 'folder', id, name: id, items }) as CollectionNode;
const shop = { schemaVersion: '1.0', id: 'shop', name: 'Shop', version: 1, variables: [], updatedAt: '', items: [folder('pay', [req('list'), gql('graph'), folder('refunds', [req('refund')])]), req('health')] } as unknown as Collection;
const groups = (): ExtraGroup[] => [
  { cat: 'grpc', kind: 'grpc-call', onOpen: () => undefined, items: [{ id: 'g-pay', name: 'Pay', folderId: 'pay', after: 'list' }, { id: 'g-top', name: 'Ping' }, { id: 'g-gone', name: 'Old', folderId: 'deleted' }] },
  { cat: 'websocket', kind: 'ws-connection', onOpen: () => undefined, items: [{ id: 'w-feed', name: 'Feed', folderId: 'refunds', badge: 'WS' }] },
];
const open = { shop: true, [folderOpenKey('shop', 'pay')]: true, [folderOpenKey('shop', 'refunds')]: true };
const shape = (rows: TreeRow[]) => rows.map((r) => (r.t === 'col' ? `col ${r.c.id}` : r.t === 'folder' ? `${'  '.repeat(r.depth)}folder ${r.n.id}${r.calls ? ` (${r.calls} calls)` : ''}` : r.t === 'req' ? `${'  '.repeat(r.depth)}${r.n.kind} ${r.n.id}` : r.t === 'xitem' ? `${'  '.repeat(r.depth)}${r.g.cat} ${r.i.id}` : r.t));

describe('every kind of request in the same folder', () => {
  it('draws the calls inside their folders, at their place among the requests; a call whose folder is gone at the top level', () => {
    expect(shape(buildTreeRows({ collections: [shop], open, explorer: true, extraGroups: groups }))).toEqual([
      'col shop',
      '  folder pay (2 calls)',
      '    http list',
      '    grpc g-pay',
      '    graphql graph',
      '    folder refunds (1 calls)',
      '      http refund',
      '      websocket w-feed',
      '  http health',
      '  grpc g-gone',
      '  grpc g-top',
    ]);
  });

  it('a filter shows a folder that holds a matching call, and opens it', () => {
    expect(shape(buildTreeRows({ collections: [shop], open: { shop: true }, filter: 'feed', explorer: true, extraGroups: groups }))).toEqual(['col shop', '  folder pay (2 calls)', '    folder refunds (1 calls)', '      websocket w-feed']);
  });

});
