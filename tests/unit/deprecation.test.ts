import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore, deprecatedOperationCalls, deprecationOf, forgetDeprecation, listDeprecations, recordDeprecation, workspaceAttention } from '../../packages/core/src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'tp-deprecation-'));
const store = WorkspaceStore.create(join(dir, 'ws'), 'Deprecation');
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
const now = Date.parse('2026-11-01T12:00:00Z');

describe('an endpoint that says it is going away', () => {
  it('reads Deprecation (true or a date), Sunset (HTTP-date or @epoch), a Link rel=deprecation|sunset and Warning 299, as one line', () => {
    expect(deprecationOf([['content-type', 'application/json']])).toBeUndefined();
    expect(deprecationOf([['Deprecation', 'true']], now)).toEqual({ deprecation: true, text: 'Deprecated' });
    const full = deprecationOf(
      [
        ['Deprecation', '@1735689600'],
        ['Sunset', 'Sat, 01 Jan 2027 00:00:00 GMT'],
        ['Link', '<https://api.example.com/docs/v2>; rel="deprecation"; type="text/html", <https://x>; rel="next"'],
        ['Warning', '299 - "Use /v2/users instead"'],
      ],
      now,
    );
    expect(full).toEqual({ deprecation: '2025-01-01', sunset: '2027-01-01', sunsetInDays: 60, link: 'https://api.example.com/docs/v2', warning: 'Use /v2/users instead', text: 'Deprecated since 2025-01-01; sunset 2027-01-01 (in 60 days); Use /v2/users instead' });
    expect(deprecationOf({ sunset: '2026-10-01' }, now)).toMatchObject({ sunset: '2026-10-01', sunsetInDays: -32, text: 'Going away; sunset 2026-10-01 (32 days ago)' });
    expect(deprecationOf({ warning: ['299 - "Slow"', '110 stale'] }, now)).toMatchObject({ warning: 'Slow', text: 'The server warns; Slow' });
  });

  it('records one entry per method and URL (query dropped), lists the soonest sunset first, and Needs attention names the saved request that calls it', async () => {
    store.saveCollection({
      schemaVersion: '1.0',
      id: 'api',
      name: 'API',
      version: 0,
      variables: [],
      updatedAt: '',
      items: [{ kind: 'http', id: 'users', name: 'List users', request: { method: 'GET', url: '{{baseUrl}}/v1/users', headers: [], params: [] } }],
    } as never);
    recordDeprecation(store, 'get', 'https://api.example.com/v1/users?page=2', deprecationOf([['Sunset', '2026-11-20']], now), now);
    recordDeprecation(store, 'GET', 'https://api.example.com/v1/users?page=3', deprecationOf([['Sunset', '2026-11-20']], now), now + 1000);
    recordDeprecation(store, 'DELETE', 'https://api.example.com/v1/old', deprecationOf([['Deprecation', 'true']], now), now);
    recordDeprecation(store, 'GET', 'https://api.example.com/fine', undefined, now);
    const list = listDeprecations(store, now);
    expect(list.map((d) => [d.method, d.url, d.sunset, d.sunsetInDays])).toEqual([
      ['GET', 'https://api.example.com/v1/users', '2026-11-20', 18],
      ['DELETE', 'https://api.example.com/v1/old', undefined, undefined],
    ]);
    const items = (await workspaceAttention(store)).filter((i) => i.kind === 'deprecation');
    // the DELETE has no saved request and no history entry: nothing to open, so it is not listed
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ severity: 'high', group: 'Endpoints going away', type: 'warning', ref: { kind: 'request', collectionId: 'api', requestId: 'users' } });
    expect(items[0]!.message).toBe('API › List users calls an endpoint that is going away: sunset 2026-11-20 (in 18 days)');
    // the API definition itself marks an operation deprecated: the saved request that calls it is listed too, without any response
    mkdirSync(store.path('specs'), { recursive: true });
    writeFileSync(store.path('specs', 'api.yaml'), ['openapi: 3.0.3', 'info: { title: Pets, version: 1.0.0 }', 'servers: [{ url: https://api.example.com/v1 }]', 'paths:', '  /users:', '    get: { responses: { "200": { description: ok } } }', '  /old:', '    get: { deprecated: true, summary: The old way, responses: { "200": { description: ok } } }', ''].join('\n'));
    store.saveCollection({ ...store.getCollection('api'), items: [...store.getCollection('api').items, { kind: 'http', id: 'old', name: 'Old way', request: { method: 'GET', url: '{{baseUrl}}/old', headers: [], params: [] } }] } as never);
    const calls = deprecatedOperationCalls(store);
    expect(calls.map((c) => [c.spec, c.requestName, c.method, c.path, c.summary])).toEqual([['specs/api.yaml', 'Old way', 'GET', '/old', 'The old way']]);
    const fromSpec = (await workspaceAttention(store)).filter((i) => i.kind === 'deprecation' && /API definition/.test(i.message));
    expect(fromSpec).toHaveLength(1);
    expect(fromSpec[0]).toMatchObject({ severity: 'medium', group: 'Endpoints going away', ref: { kind: 'request', collectionId: 'api', requestId: 'old' } });
    expect(fromSpec[0]!.message).toBe('API › Old way calls GET /old, which the API definition specs/api.yaml marks deprecated (The old way)');
    expect(forgetDeprecation(store, 'GET', 'https://api.example.com/v1/users')).toBe(true);
    expect(forgetDeprecation(store, 'GET', 'https://api.example.com/v1/users')).toBe(false);
    expect(listDeprecations(store, now)).toHaveLength(1);
  });
});
