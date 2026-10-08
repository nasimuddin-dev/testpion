import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeServices } from '../helpers.js';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { VariableScope, collectionLoadTarget, runLoadTest, type Collection, type ExecServices } from '../../packages/core/src/index.js';

let server: Server;
let base: string;
const hits: Record<string, number> = {};
beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url!.split('?')[0]!;
    hits[path] = (hits[path] ?? 0) + 1;
    res.setHeader('content-type', 'application/json');
    if (path === '/login') return res.end(JSON.stringify({ token: 'tok-9' }));
    if (path === '/graphql') return res.end(JSON.stringify({ data: { ok: true } }));
    if (req.headers.authorization !== 'Bearer tok-9') return res.writeHead(401).end('{}');
    res.end(JSON.stringify({ items: [] }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const services = (vars?: VariableScope): ExecServices => fakeServices({ scope: vars, vars: { baseUrl: base }, timeoutMs: 5000 });

const collection = (): Collection => ({
  schemaVersion: '1.0',
  id: 'c',
  name: 'Shop',
  version: 1,
  variables: [],
  updatedAt: new Date(0).toISOString(),
  auth: { type: 'bearer', token: '{{token}}' },
  items: [
    { kind: 'http', id: 'login', name: 'Login', request: { method: 'POST', url: '{{baseUrl}}/login', auth: { type: 'none' } }, testScript: "pm.environment.set('token', pm.response.json().token);" },
    { kind: 'folder', id: 'f', name: 'Catalog', items: [{ kind: 'http', id: 'items', name: 'Items', request: { method: 'GET', url: '{{baseUrl}}/items' } }] },
    { kind: 'graphql', id: 'g', name: 'Stock', request: { endpoint: '{{baseUrl}}/graphql', query: '{ ok }' } },
  ],
});

describe('load-testing a collection', () => {
  it('warms up with scripts, then runs the requests in order under load', async () => {
    const svc = services();
    const { target, warmUp, unresolved } = await collectionLoadTarget({ collection: collection(), services: svc, warmUp: true });
    expect(warmUp).toMatchObject({ total: 3, passed: 3 });
    expect(unresolved).toEqual([]);
    expect(target.requests.map((r) => r.name)).toEqual(['Login', 'Catalog / Items', 'Stock']);
    // the token the warm-up script set is in the inherited auth
    expect(target.requests[1]!.request.auth).toEqual({ type: 'bearer', token: 'tok-9' });
    expect(target.requests[2]!.request).toMatchObject({ method: 'POST', url: `${base}/graphql` });

    // long enough for several iterations even when the test machine is busy (1.2 s was flaky under a full parallel run)
    const snap = await runLoadTest({ target, virtualUsers: 2, durationSec: 2.5 }, {});
    expect(snap.iterations).toBeGreaterThan(1);
    expect(snap.errors).toBe(0);
    expect(snap.perRequest!.map((p) => p.name)).toEqual(['Login', 'Catalog / Items', 'Stock']);
    for (const p of snap.perRequest!) expect(p.requests).toBeGreaterThan(1);
    expect(snap.requests).toBe(snap.perRequest!.reduce((n, p) => n + p.requests, 0));
    expect(snap.statusCodes['401']).toBeUndefined();
    // two virtual users keep their connections: most are reused (some may come from the warm-up), and the server
    // time is measured; a request still in flight when the run stops may have no connection figures yet
    const seen = snap.http!.newConnections + snap.http!.reused;
    expect(seen).toBeLessThanOrEqual(snap.requests);
    expect(seen).toBeGreaterThanOrEqual(snap.requests - 2);
    expect(snap.http!.reused).toBeGreaterThan(snap.http!.newConnections);
    expect(snap.http!.ttfb.p50).toBeGreaterThanOrEqual(0);
  });

  it('without a warm-up the variable stays unresolved, and remote hosts need opt-in', async () => {
    const { unresolved, target } = await collectionLoadTarget({ collection: collection(), services: services(), selection: ['f'] });
    expect(unresolved).toEqual(['token']);
    expect(target.requests.map((r) => r.name)).toEqual(['Catalog / Items']);
    const remote = { kind: 'sequence' as const, requests: [{ name: 'x', request: { method: 'GET', url: 'https://example.com/' } }] };
    await expect(runLoadTest({ target: remote, virtualUsers: 1, durationSec: 1 }, {})).rejects.toThrow(/requires explicit opt-in/);
  });
});
