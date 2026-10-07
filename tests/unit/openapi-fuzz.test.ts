import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parse } from 'yaml';
import { fuzzCases, fuzzFindingsToTests, fuzzMarkdown, lintTestFile, runFuzz } from '../../packages/core/src/index.js';

const spec = `openapi: 3.0.3
info: { title: Clinic, version: '1' }
servers: [{ url: 'https://api.clinic.example' }]
paths:
  /patients:
    get:
      parameters:
        - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 100 } }
      responses: { '200': { description: ok }, '400': { description: bad } }
    post:
      security: [{ bearer: [] }]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [name, species]
              properties:
                name: { type: string, maxLength: 20 }
                species: { type: string, enum: [cat, dog] }
                email: { type: string, format: email }
      responses: { '201': { description: created }, '400': { description: bad } }
  /patients/{id}:
    get:
      parameters: [{ name: id, in: path, required: true, schema: { type: integer } }]
      responses: { '200': { description: ok }, '404': { description: gone } }
    delete:
      parameters: [{ name: id, in: path, required: true, schema: { type: integer } }]
      responses: { '204': { description: gone } }
components:
  securitySchemes:
    bearer: { type: http, scheme: bearer }
`;

// A clinic API with bugs: a missing name crashes it, it never checks the species, a non-numeric id crashes it,
// and it answers 422 (not documented) for a long name.
const seen: Array<{ method: string; url: string; auth?: string }> = [];
let server: Server;
let base = '';
beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization });
      const send = (status: number, body: unknown = {}) => (res.writeHead(status, { 'content-type': 'application/json' }), res.end(JSON.stringify(body)));
      const u = new URL(req.url!, 'http://x');
      if (req.method === 'GET' && u.pathname === '/patients') return Number(u.searchParams.get('limit') ?? 1) > 100 ? send(400) : send(200, []);
      if (req.method === 'POST' && u.pathname === '/patients') {
        let b: any;
        try {
          b = JSON.parse(raw);
        } catch {
          return send(400);
        }
        if (typeof b !== 'object' || Array.isArray(b) || b === null) return send(400);
        if (b.name === undefined) return send(500, { error: 'Cannot read properties of undefined' });
        if (typeof b.name !== 'string') return send(400);
        if (b.name.length > 20) return send(422);
        return send(201, { id: 1 });
      }
      const m = /^\/patients\/(.+)$/.exec(u.pathname);
      if (m && req.method === 'GET') return /^\d+$/.test(m[1]!) ? send(200, { id: Number(m[1]) }) : send(500, { error: 'NaN' });
      send(404);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

describe('API fuzzing', () => {
  it('makes a valid example and one broken rule at a time, leaving DELETE out', () => {
    const { cases, operations } = fuzzCases(spec, { baseUrl: 'http://localhost:1' });
    expect(operations).toBe(3);
    const post = cases.filter((c) => c.operation === 'POST /patients').map((c) => c.name);
    expect(post).toEqual([
      'the valid example',
      'a body that is not JSON',
      'no body',
      'body "name" left out',
      'body "species" left out',
      'body "name" of the wrong type',
      'body "name" longer than maxLength 20',
      'body "species" of the wrong type',
      'body "species" outside its enum',
      'body "email" of the wrong type',
      'body "email" not a valid email',
    ]);
    expect(cases.filter((c) => c.operation === 'GET /patients').map((c) => c.name)).toEqual([
      'the valid example',
      'query "limit" of the wrong type',
      'query "limit" above maximum 100',
      'query "limit" below minimum 1',
    ]);
    expect(cases.find((c) => c.name === 'path {id} not a number')!.request.url).toBe('http://localhost:1/patients/not-a-number');
    expect(cases.some((c) => c.operation.startsWith('DELETE'))).toBe(false);
    expect(fuzzCases(spec, { includeDelete: true }).operations).toBe(4);
    expect(cases.find((c) => c.operation === 'POST /patients')!.request.auth).toEqual({ type: 'bearer', token: '{{accessToken}}' });
  });

  it('finds server errors, invalid input accepted and undocumented statuses', async () => {
    const { cases } = fuzzCases(spec, { baseUrl: base });
    const done: number[] = [];
    const r = await runFuzz(spec, cases, { resolve: (q) => JSON.parse(JSON.stringify(q).replace('{{accessToken}}', 't0k')), onResult: (_x, n) => done.push(n) });
    expect(done.at(-1)).toBe(cases.length);
    const by = (v: string) => r.results.filter((x) => x.verdict === v).map((x) => `${x.case.operation} · ${x.case.name}`);
    expect(by('server-error')).toEqual(['POST /patients · body "name" left out', 'GET /patients/{id} · path {id} not a number']);
    expect(by('accepted-invalid')).toEqual([
      'GET /patients · query "limit" of the wrong type',
      'GET /patients · query "limit" below minimum 1',
      'POST /patients · body "species" left out',
      'POST /patients · body "species" of the wrong type',
      'POST /patients · body "species" outside its enum',
      'POST /patients · body "email" of the wrong type',
      'POST /patients · body "email" not a valid email',
    ]);
    expect(by('undocumented-status')).toEqual(['POST /patients · body "name" longer than maxLength 20']);
    expect(r.serverErrors).toBe(2);
    expect(seen.find((s) => s.method === 'POST')!.auth).toBe('Bearer t0k');
    expect(fuzzMarkdown(r)).toMatch(/\*\*2 server errors\*\*/);
    // the findings as regression tests that expect a 4xx, the base URL as {{baseUrl}}
    const t = fuzzFindingsToTests(r, { baseUrl: base });
    expect(t.tests).toBe(9);
    expect(lintTestFile(t.yaml).filter((p) => p.severity === 'error')).toEqual([]);
    const doc = parse(t.yaml) as { tests: Array<Record<string, any>> };
    expect(doc.tests[0]).toMatchObject({ url: '{{baseUrl}}/patients?limit=not-a-number'.split('?')[0], assertions: [{ type: 'status', expected: '4xx' }] });
  });

  it('refuses remote hosts unless allowed, and URLs with unset variables', async () => {
    await expect(runFuzz(spec, fuzzCases(spec).cases)).rejects.toThrow(/Fuzzing the remote host "api\.clinic\.example" needs explicit opt-in/);
    await expect(runFuzz(spec, fuzzCases(spec, { baseUrl: '{{baseUrl}}' }).cases)).rejects.toThrow(/still has a \{\{variable\}\}/);
  });
});
