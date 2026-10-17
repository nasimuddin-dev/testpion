/** Workspaces the AI golden cases share: a shop collection with an Orders folder (create, read, delete) and a Users folder. */
import type { Collection } from '../../packages/core/src/index.js';

export const SECRET = 'sk-live-SECRET-9f8e7d6c5b4a';

export const SHOP: Collection = {
  schemaVersion: '1.0',
  id: 'shop',
  name: 'Shop',
  version: 1,
  variables: [{ key: 'baseUrl', value: 'https://shop.example.com' }],
  auth: { type: 'bearer', token: '{{token}}' },
  updatedAt: '2026-10-16T00:00:00Z',
  items: [
    {
      kind: 'folder',
      id: 'fld-orders',
      name: 'Orders',
      items: [
        {
          kind: 'http',
          id: 'req-create',
          name: 'Create order',
          request: {
            method: 'POST',
            url: '{{baseUrl}}/orders',
            headers: [{ key: 'X-Api-Key', value: SECRET }],
            body: { type: 'json', content: JSON.stringify({ item: 'bookshelf', qty: 1, note: `key ${SECRET}` }) },
          },
          examples: [
            { id: 'ex1', name: 'Created', status: 201, headers: [], body: JSON.stringify({ id: 'ord-1', item: 'bookshelf', status: 'new' }), request: { method: 'POST', url: '{{baseUrl}}/orders' } },
          ],
        },
        {
          kind: 'http',
          id: 'req-get',
          name: 'Get order',
          request: { method: 'GET', url: '{{baseUrl}}/orders/ord-1' },
          examples: [
            { id: 'ex2', name: 'Found', status: 200, headers: [], body: JSON.stringify({ id: 'ord-1', item: 'bookshelf', status: 'new' }) },
            { id: 'ex3', name: 'Missing', status: 404, headers: [], body: JSON.stringify({ error: 'not_found' }), request: { method: 'GET', url: '{{baseUrl}}/orders/nope' } },
          ],
        },
        {
          kind: 'http',
          id: 'req-delete',
          name: 'Delete order',
          request: { method: 'DELETE', url: '{{baseUrl}}/orders/ord-1' },
          examples: [{ id: 'ex4', name: 'Deleted', status: 204, headers: [], body: '' }],
        },
      ],
    },
    { kind: 'folder', id: 'fld-users', name: 'Users', items: [{ kind: 'http', id: 'req-users', name: 'List users', request: { method: 'GET', url: '{{baseUrl}}/users' } }] },
  ],
} as unknown as Collection;
