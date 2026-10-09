import { describe, expect, it } from 'vitest';
import { collectionVariableFlow, type Collection } from '@testpion/core';

const col = {
  schemaVersion: '1.0',
  id: 'c',
  name: 'Shop',
  version: 0,
  variables: [{ key: 'region', value: 'eu', enabled: true }],
  preRequestScript: "pm.collectionVariables.set('requestedAt', Date.now())",
  updatedAt: '',
  items: [
    { kind: 'http', id: 'r1', name: 'Get cart', request: { method: 'GET', url: '{{baseUrl}}/carts/{{cartId}}', headers: [{ key: 'x-region', value: '{{region}}' }] } },
    { kind: 'http', id: 'r2', name: 'Log in', request: { method: 'POST', url: '{{baseUrl}}/login' }, testScript: "pm.environment.set('token', pm.response.json().token); tp.environment.set(\"cartId\", 7); pm.variables.set(`leftover`, 1)" },
    {
      kind: 'folder',
      id: 'f',
      name: 'Orders',
      items: [{ kind: 'http', id: 'r3', name: 'Place order', request: { method: 'POST', url: '{{baseUrl}}/orders', auth: { type: 'bearer', token: '{{token}}' }, body: { type: 'json', content: '{"at": "{{requestedAt}}", "id": "{{$guid}}", "note": "{{nowhere}}"}' } } }],
    },
  ],
} as unknown as Collection;

describe('variable flow', () => {
  const flows = Object.fromEntries(collectionVariableFlow(col, ['baseUrl']).map((f) => [f.name, f]));

  it('finds who sets each variable and who uses it, in run order', () => {
    expect(flows.token!.setBy.map((p) => p.name)).toEqual(['Log in']);
    expect(flows.token!.usedBy.map((p) => p.name)).toEqual(['Place order']);
    expect(flows.token!.issue).toBeUndefined();
    expect(flows.requestedAt!.setBy).toEqual([{ name: 'Shop', index: -1, path: [] }]);
    expect(flows.baseUrl).toMatchObject({ defined: true, setBy: [] });
    expect(flows.baseUrl!.issue).toBeUndefined();
    expect(flows.region).toMatchObject({ defined: true });
    expect(flows.$guid).toBeUndefined();
  });

  it('flags a variable used before any request sets it, never set, or never used', () => {
    expect(flows.cartId!.issue).toBe('used-before-set');
    expect(flows.nowhere!.issue).toBe('never-set');
    expect(flows.leftover!.issue).toBe('unused');
  });
});
