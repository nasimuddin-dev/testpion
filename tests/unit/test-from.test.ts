import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeServices } from '../helpers.js';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parse } from 'yaml';
import { normalizeTest, runTests, testFromRequest, type TestResult } from '../../packages/core/src/index.js';

let server: Server;
let base = '';
beforeAll(async () => {
  server = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ method: req.method, auth: req.headers.authorization, body: b ? JSON.parse(b) : null })));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('Save as test', () => {
  it('turns a REST request into a runnable YAML test (secrets stay variables)', async () => {
    const t = testFromRequest('Create patient', {
      kind: 'http',
      request: { method: 'POST', url: '{{baseUrl}}/patients', headers: [{ key: 'X-Off', value: '1', enabled: false }, { key: 'Accept', value: 'application/json' }], auth: { type: 'bearer', token: '{{token}}' }, body: { type: 'json', content: '{"name":"Rex"}' } },
      testScript: "pm.test('created', () => pm.response.to.have.status(201));",
      status: 201,
    });
    expect(t.path).toBe('rest/create-patient.yaml');
    expect(t.yaml).toContain('{{token}}');
    const test = normalizeTest(parse(t.yaml), t.path);
    const results: TestResult[] = [];
    await runTests({ name: 't', runId: 'r', tests: [test], services: fakeServices({ vars: { baseUrl: base, token: 't0k' } }), concurrency: 1, onEvent: (e) => e.type === 'test-end' && results.push(e.result) });
    expect(results[0]!.checks.map((c) => [c.name, c.passed]).sort()).toEqual([
      ['created', true],
      ['status', true],
    ]);
  });

  it('GraphQL, gRPC and realtime tests load as their test types', () => {
    const g = testFromRequest('Patient query', { kind: 'graphql', endpoint: '{{gql}}', query: '{ patient(id: 1) { name } }', variables: {}, headers: [] });
    expect(normalizeTest(parse(g.yaml), g.path)).toMatchObject({ type: 'graphql', endpoint: '{{gql}}', assertions: [{ type: 'graphql-no-errors' }] });
    const r = testFromRequest('Get pet', { kind: 'grpc', target: 'localhost:50051', method: 'vet.v1.PetService/GetPet', message: { id: '1' } });
    expect(normalizeTest(parse(r.yaml), r.path)).toMatchObject({ type: 'grpc', method: 'vet.v1.PetService/GetPet', protos: [], assertions: [{ type: 'grpc-status', expected: 'OK' }] });
    const m = testFromRequest('Vitals', { kind: 'websocket', mode: 'mqtt', url: 'mqtt://localhost:1883', subscribe: ['clinic/#'], send: [{ topic: 'clinic/7/commands', payload: '{}' }], password: 'typed-secret', username: 'vet' });
    expect(m.yaml).not.toContain('typed-secret');
    expect(normalizeTest(parse(m.yaml), m.path)).toMatchObject({ type: 'websocket', mode: 'mqtt', subscribe: ['clinic/#'] });
  });
});
