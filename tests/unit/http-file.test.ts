import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeServices } from '../helpers.js';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { collectionToHttpFile, detectFormat, importAny, importHttpFile, isHttpFile, runTests, type ExecServices, type SavedHttpRequest, type TestCase } from '../../packages/core/src/index.js';

const restClient = `@baseUrl = http://127.0.0.1:PORT
@contentType = application/json

### Log in
# @name login
POST {{baseUrl}}/auth/token
Content-Type: application/x-www-form-urlencoded

username=vet
&password=paws

###

# @name patients
GET {{baseUrl}}/patients
    ?limit=2
Authorization: Bearer {{login.response.body.$.access_token}}
Accept: application/json

### Create a patient
POST {{baseUrl}}/patients HTTP/1.1
Content-Type: {{contentType}}
Authorization: Basic vet paws

{
  "name": "Byron",
  "species": "cat"
}
`;

const jetbrains = `### Health
GET http://127.0.0.1:PORT/health

> {%
  client.test("is healthy", function() {
    client.assert(response.status === 200, "status");
    client.assert(response.body.status === "ok", "body");
  });
  client.global.set("checkedAt", response.body.time);
%}

### Upload
< {%
  request.variables.set("traceId", "t-1");
%}
POST http://127.0.0.1:PORT/upload
Content-Type: application/json

< ./payload.json
`;

let server: Server;
let base = '';
beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (s: number, b: unknown) => (res.writeHead(s, { 'content-type': 'application/json' }), res.end(JSON.stringify(b)));
      if (req.url === '/health') return send(200, { status: 'ok', time: 't0' });
      if (req.url === '/auth/token') return raw.includes('username=vet') ? send(200, { access_token: 'tok-1' }) : send(401, {});
      if (req.url?.startsWith('/patients')) return req.headers.authorization === 'Bearer tok-1' ? send(200, [{ id: 1 }]) : send(403, { got: req.headers.authorization ?? null });
      send(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

const flat = (items: unknown[]) => items as SavedHttpRequest[];
const services = (): ExecServices => fakeServices({ secrets: true });

describe('.http files', () => {
  it('are told apart from other formats', () => {
    expect(isHttpFile(restClient)).toBe(true);
    expect(isHttpFile('GET https://api.example.com/pets')).toBe(true);
    expect(isHttpFile("curl -X GET 'https://x'")).toBe(false);
    expect(isHttpFile('{"openapi": "3.0.0"}')).toBe(false);
    expect(detectFormat(jetbrains)).toBe('http-file');
  });

  it('REST Client: file variables, names, multi-line queries, form and JSON bodies, basic auth', () => {
    const { collection, notes } = importHttpFile(restClient, { name: 'clinic' });
    expect(notes).toEqual([]);
    expect(collection.name).toBe('clinic');
    expect(collection.variables.map((v) => v.key)).toEqual(['baseUrl', 'contentType']);
    const [login, patients, create] = flat(collection.items);
    expect(login).toMatchObject({
      name: 'login',
      request: {
        method: 'POST',
        url: '{{baseUrl}}/auth/token',
        body: {
          type: 'form-urlencoded',
          fields: [
            { key: 'username', value: 'vet' },
            { key: 'password', value: 'paws' },
          ],
        },
      },
    });
    // the request another one reads keeps its response for {{login.response.body…}} (the JSONPath $ dropped)
    expect(login!.testScript).toMatch(/tp\.variables\.set\("login"/);
    expect(patients!.request.url).toBe('{{baseUrl}}/patients?limit=2');
    expect(patients!.request.auth).toEqual({ type: 'bearer', token: '{{login.response.body.access_token}}' });
    expect(patients!.testScript).toBeUndefined();
    expect(create).toMatchObject({ name: 'Create a patient', request: { method: 'POST', auth: { type: 'basic', username: 'vet', password: 'paws' }, body: { type: 'json' } } });
    expect(JSON.parse((create!.request.body as { content: string }).content)).toEqual({ name: 'Byron', species: 'cat' });
  });

  it('JetBrains: handlers and pre-request scripts run through the client / response / request shim', () => {
    const { collection, notes } = importHttpFile(jetbrains);
    const [health, upload] = flat(collection.items);
    expect(health!.testScript).toMatch(/const client = \{ test: \(name, fn\) => tp\.test/);
    expect(health!.testScript).toMatch(/client\.assert\(response\.status === 200, "status"\)/);
    expect(upload!.preRequestScript).toMatch(/request\.variables\.set\("traceId", "t-1"\)/);
    expect(upload!.request.body).toEqual({ type: 'binary', filePath: './payload.json' });
    expect(notes).toEqual(['Upload: the body comes from the file ./payload.json; check the path in TestPion']);
  });

  it('runs: chaining a token from one request to the next, and a JetBrains handler as tests', async () => {
    const { collection } = importHttpFile(restClient.replace('http://127.0.0.1:PORT', base) + '\n' + jetbrains.replaceAll('http://127.0.0.1:PORT', base).split('### Upload')[0]);
    const vars = Object.fromEntries(collection.variables.map((v) => [v.key, v.value]));
    const tests = flat(collection.items)
      .slice(0, 2)
      .concat(flat(collection.items).slice(3, 4))
      .map(
        (r) =>
          ({
            id: r.id,
            name: r.name,
            type: 'http',
            request: r.request,
            testScript: r.testScript,
            preRequestScript: r.preRequestScript,
            assertions: [{ type: 'status', expected: 200 }],
          }) as unknown as TestCase,
      );
    const svc = services();
    svc.vars.setScope('collection', vars);
    const results: any[] = [];
    const summary = await runTests({ name: 'http', runId: 'h1', tests, services: svc, concurrency: 1, onEvent: (e) => e.type === 'test-end' && results.push(e.result) });
    expect(summary.passed, JSON.stringify(results.map((r) => [r.name, r.status, r.checks?.filter((c: any) => !c.passed), r.error]))).toBe(3);
    expect(results[2].checks.map((c: { name: string }) => c.name)).toContain('is healthy');
  });

  it('exports a collection as an .http file that imports back', () => {
    const { collection } = importHttpFile(restClient);
    const { text, notes } = collectionToHttpFile(collection);
    expect(text).toMatch(/^# HTTP requests\n\n@baseUrl = http:\/\/127\.0\.0\.1:PORT\n/);
    expect(text).toMatch(/### Create a patient\n# @name create_a_patient\nPOST \{\{baseUrl\}\}\/patients\nContent-Type: \{\{contentType\}\}\nAuthorization: Basic vet paws\n\n\{/);
    expect(notes).toEqual(["login: scripts aren't written (they use tp.*)"]);
    const again = flat(importHttpFile(text).collection.items);
    expect(again.map((r) => `${r.request.method} ${r.request.url}`)).toEqual(['POST {{baseUrl}}/auth/token', 'GET {{baseUrl}}/patients?limit=2', 'POST {{baseUrl}}/patients']);
    expect(importAny(text, { name: 'api.http' }).collection!.name).toBe('api');
  });
});
