import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeServices } from '../helpers.js';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { collectionRequests, runCollection, VariableScope, type Collection, type ExecServices, type RunEvent, type TestResult } from '../../packages/core/src/index.js';

let server: Server;
let base: string;
const seen: Array<{ url: string; auth?: string }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url!, auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/token') res.end(JSON.stringify({ access_token: 'tok-123' }));
    else if (req.url === '/graphql') res.end(JSON.stringify({ data: { trace: req.headers['x-trace'] ?? null, auth: req.headers.authorization ?? null } }));
    else res.end(JSON.stringify({ path: req.url, auth: req.headers.authorization ?? null }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const services = (vars?: VariableScope): ExecServices => fakeServices({ scope: vars, vars: { baseUrl: base }, timeoutMs: 5000 });

const collection = (): Collection => ({
  schemaVersion: '1.0',
  id: 'c1',
  name: 'Demo',
  version: 1,
  variables: [],
  auth: { type: 'bearer', token: '{{accessToken}}' },
  testScript: "pm.test('collection test', () => pm.expect(pm.response.code).to.equal(200));",
  updatedAt: new Date(0).toISOString(),
  items: [
    {
      kind: 'folder',
      id: 'f-auth',
      name: 'Auth',
      items: [
        {
          kind: 'http',
          id: 'r-token',
          name: 'Token',
          request: { method: 'GET', url: '{{baseUrl}}/token', auth: { type: 'none' } },
          testScript: "pm.environment.set('accessToken', pm.response.json().access_token);",
        },
      ],
    },
    {
      kind: 'folder',
      id: 'f-pets',
      name: 'Pets',
      items: [
        { kind: 'http', id: 'r-pet', name: 'Get pet', request: { method: 'GET', url: '{{baseUrl}}/pets/{{petId}}', auth: { type: 'inherit' } }, testScript: "pm.test('uses row', () => pm.expect(pm.response.json().path).to.equal('/pets/' + pm.iterationData.get('petId')));" },
        { kind: 'http', id: 'r-skip', name: 'Skipped', request: { method: 'GET', url: '{{baseUrl}}/never' }, preRequestScript: 'pm.execution.skipRequest();' },
      ],
    },
  ],
});

describe('collection runner', () => {
  it('lists requests in order with folder paths and inherited auth', () => {
    const refs = collectionRequests(collection());
    expect(refs.map((r) => [r.path.join('/'), r.name])).toEqual([
      ['Auth', 'Token'],
      ['Pets', 'Get pet'],
      ['Pets', 'Skipped'],
    ]);
    expect(refs[0]!.auth).toEqual({ type: 'none' });
    expect(refs[1]!.auth).toEqual({ type: 'bearer', token: '{{accessToken}}' });
    expect(collectionRequests(collection(), ['f-pets']).map((r) => r.id)).toEqual(['r-pet', 'r-skip']);
    expect(collectionRequests(collection(), ['r-token']).map((r) => r.id)).toEqual(['r-token']);
  });

  it('runs iterations with data rows, carries variables and honours skipRequest', async () => {
    seen.length = 0;
    const results: TestResult[] = [];
    const summary = await runCollection({
      name: 'Demo',
      collection: collection(),
      data: [{ petId: 'a1' }, { petId: 'b2' }],
      services: services(),
      onEvent: (e: RunEvent) => void (e.type === 'test-end' && results.push(e.result)),
    });
    expect(summary.total).toBe(6);
    expect(summary.passed).toBe(4);
    expect(summary.skipped).toBe(2);
    expect(results.map((r) => r.name)).toEqual(['#1 Auth / Token', '#1 Pets / Get pet', '#1 Pets / Skipped', '#2 Auth / Token', '#2 Pets / Get pet', '#2 Pets / Skipped']);
    expect(seen.map((s) => s.url)).toEqual(['/token', '/pets/a1', '/token', '/pets/b2']);
    // the token set by the first request's script is sent by the next one through inherited auth
    expect(seen[1]!.auth).toBe('Bearer tok-123');
    expect(results[1]!.checks.map((c) => c.name)).toEqual(['collection test', 'uses row']);
  });

  it('follows setNextRequest and stops on null', async () => {
    seen.length = 0;
    const c = collection();
    c.testScript = undefined;
    // Token loops back to itself twice, then setNextRequest(null) ends the iteration before "Get pet"
    (c.items[0] as any).items[0].testScript = "const n = (pm.environment.get('n') || 0) + 1; pm.environment.set('n', n); postman.setNextRequest(n < 3 ? 'Token' : null);";
    const summary = await runCollection({ name: 'loop', collection: c, services: services() });
    expect(summary.total).toBe(3);
    expect(seen.map((s) => s.url)).toEqual(['/token', '/token', '/token']);
  });

  it('stops runaway setNextRequest loops', async () => {
    const c = collection();
    (c.items[0] as any).items[0].testScript = "pm.execution.setNextRequest('r-token');";
    await expect(runCollection({ name: 'runaway', collection: c, services: services(), maxRequestsPerIteration: 5 })).rejects.toThrow(/setNextRequest loop/);
  });

  it('gives scripts the request name and its location (pm.info.requestName, pm.execution.location)', async () => {
    const c = collection();
    c.testScript = undefined;
    (c.items[0] as any).items[0].testScript =
      "pm.test('location', () => { pm.expect(pm.info.requestName).to.equal('Token'); pm.expect([...pm.execution.location]).to.eql(['Demo', 'Auth', 'Token']); pm.expect(pm.execution.location.current).to.equal('Token'); });";
    const results: TestResult[] = [];
    await runCollection({ name: 'loc', collection: c, selection: ['r-token'], services: services(), onEvent: (e: RunEvent) => void (e.type === 'test-end' && results.push(e.result)) });
    expect(results[0]!.checks.filter((x) => !x.passed)).toEqual([]);
    expect(results[0]!.checks.map((x) => x.name)).toContain('location');
  });

  it('runs collection, folder and request scripts for GraphQL requests too', async () => {
    seen.length = 0;
    const c: Collection = {
      ...collection(),
      testScript: undefined,
      preRequestScript: "pm.request.headers.upsert({ key: 'X-Trace', value: 'from-collection' });",
      items: [
        {
          kind: 'folder',
          id: 'f-g',
          name: 'GraphQL',
          testScript: "pm.test('folder sees data', () => pm.expect(pm.response.json().data).to.be.an('object'));",
          items: [
            {
              kind: 'graphql',
              id: 'g1',
              name: 'Who',
              request: { endpoint: '{{baseUrl}}/graphql', query: '{ trace }', auth: { type: 'bearer', token: 'gql-tok' } },
              preRequestScript: "pm.environment.set('seenUrl', pm.request.url.toString());",
              testScript: "pm.test('header from the collection script', () => pm.expect(pm.response.json().data.trace).to.equal('from-collection'));\npm.environment.set('gqlAuth', pm.response.json().data.auth);",
            },
          ],
        },
      ],
    };
    const svc = services();
    const results: TestResult[] = [];
    const summary = await runCollection({ name: 'gql', collection: c, services: svc, onEvent: (e: RunEvent) => void (e.type === 'test-end' && results.push(e.result)) });
    expect(summary).toMatchObject({ total: 1, passed: 1 });
    expect(results[0]!.checks.map((x) => [x.name, x.passed])).toEqual([
      ['folder sees data', true],
      ['header from the collection script', true],
      ['graphql-no-errors', true],
    ]);
    expect(svc.vars.get('seenUrl')).toBe('{{baseUrl}}/graphql');
    expect(svc.vars.get('gqlAuth')).toBe('Bearer gql-tok');
  });
});
