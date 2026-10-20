/** A collection as a HAR or Postman import leaves it: generic names, a host and a token typed into every request, an id typed into paths, analytics noise, a duplicate. */
import type { Collection } from '../../packages/core/src/index.js';

export const TOKEN = 'tok-abc-1234567890';
const HOST = 'https://api.shop.example.com';
const AUTH = [{ key: 'Authorization', value: `Bearer ${TOKEN}` }];

export const IMPORTED: Collection = {
  schemaVersion: '1.0',
  id: 'imp',
  name: 'HAR import 2026-10-19',
  version: 1,
  variables: [],
  updatedAt: '2026-10-19T00:00:00Z',
  items: [
    {
      kind: 'http',
      id: 'r-create',
      name: `${HOST}/orders`,
      request: { method: 'POST', url: `${HOST}/orders`, headers: [...AUTH, { key: 'Content-Type', value: 'application/json' }], body: { type: 'json', content: '{"item":"bookshelf"}' } },
      examples: [{ id: 'e1', name: 'Captured 201', status: 201, headers: [], body: JSON.stringify({ id: 'ord-77', item: 'bookshelf', status: 'new' }) }],
    },
    {
      kind: 'http',
      id: 'r-get',
      name: 'GET /orders/ord-77',
      request: { method: 'GET', url: `${HOST}/orders/ord-77`, headers: AUTH },
      examples: [{ id: 'e2', name: 'Captured 200', status: 200, headers: [], body: JSON.stringify({ id: 'ord-77', status: 'new' }) }],
    },
    { kind: 'http', id: 'r-ga', name: 'https://www.google-analytics.com/collect?v=1', request: { method: 'GET', url: 'https://www.google-analytics.com/collect', params: [{ key: 'v', value: '1' }] } },
    { kind: 'http', id: 'r-js', name: 'GET /static/app.js', request: { method: 'GET', url: 'https://cdn.shop.example.com/static/app.js' } },
    { kind: 'http', id: 'r-get2', name: 'GET /orders/ord-77', request: { method: 'GET', url: `${HOST}/orders/ord-77`, headers: AUTH } },
    { kind: 'http', id: 'r-delete', name: 'DELETE /orders/ord-77', request: { method: 'DELETE', url: `${HOST}/orders/ord-77`, headers: AUTH } },
    { kind: 'http', id: 'r-users', name: 'GET /users', request: { method: 'GET', url: `${HOST}/users` } },
    { kind: 'http', id: 'r-user', name: 'GET /users/u-5', request: { method: 'GET', url: `${HOST}/users/u-5` } },
  ],
} as unknown as Collection;

/** The plan a model would answer: names, folders, a variable name, one confirmed chain (named), an invented request, a drop that is not noise. */
export const TIDY_PLAN = JSON.stringify({
  summary: 'Orders get names and a folder; the host and token become variables; the order id is chained.',
  assumptions: ['The order id is returned by Create order in $.id'],
  requests: [
    { id: 'r-create', name: 'Create order', folder: 'Orders' },
    { id: 'r-get', name: 'Get order', folder: 'Orders' },
    { id: 'r-delete', name: 'Delete order', folder: 'Orders' },
    { id: 'r-users', name: 'List users', folder: 'Users' },
    { id: 'r-ghost', name: 'Invented', folder: 'Nowhere' },
  ],
  hosts: [{ origin: 'https://api.shop.example.com', variable: 'apiUrl' }],
  chains: [
    { variable: 'orderId', from: 'r-create', path: '$.id', literal: 'ord-77' },
    // not confirmed by any saved example: opt in
    { variable: 'userId', from: 'r-users', path: '$.items[0].id', literal: 'u-5' },
    // a path the engine cannot turn into a script
    { variable: 'badId', from: 'r-create', path: '$..id', literal: 'ord-77' },
  ],
  drop: [{ id: 'r-users', reason: 'looks like noise to me' }, { id: 'r-ga', reason: 'analytics' }, { id: 'r-missing' }],
});
