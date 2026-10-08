import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeServices } from '../helpers.js';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bruFilesToBrunoExport, collectionToBru, detectFormat, importAny, parseBru, readBrunoFolder, runCollection, runScript, type CollectionFolder, type ExecServices, type SavedHttpRequest, type TestResult } from '../../packages/core/src/index.js';

const LOGIN = `meta {
  name: Log in
  type: http
  seq: 1
}

post {
  url: {{baseUrl}}/login
  body: json
  auth: none
}

headers {
  Content-Type: application/json
  ~X-Debug: 1
}

body:json {
  {
    "user": "vet",
    "password": "{{password}}"
  }
}

vars:post-response {
  token: res.body.token
}

assert {
  res.status: eq 200
  res.body.token: isString
  res.headers['content-type']: contains json
}
`;

const PATIENT = `meta {
  name: Get patient
  type: http
  seq: 2
}

get {
  url: {{baseUrl}}/patients/:id?full=true
  body: none
  auth: bearer
}

params:query {
  full: true
}

params:path {
  id: 7
}

auth:bearer {
  token: {{token}}
}

script:pre-request {
  req.setHeader("X-Visit", bru.getEnvName() || "none");
}

script:post-response {
  bru.setVar("species", res.getBody().species);
}

tests {
  test("found the dog", function () {
    expect(res.getStatus()).to.equal(200);
    expect(res("owner.name")).to.equal("Ada");
    expect(res.body.species).to.equal("dog");
  });
}

docs {
  Reads one patient.
}
`;

let server: Server;
let base = '';
let dir = '';
const seen: Array<{ url: string; auth?: string; visit?: string; trace?: string }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url!, auth: req.headers.authorization, visit: req.headers['x-visit'] as string, trace: req.headers['x-trace'] as string });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/login') res.end(JSON.stringify({ token: 'tok-9' }));
    else res.end(JSON.stringify({ id: 7, species: 'dog', owner: { name: 'Ada' } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  dir = mkdtempSync(join(tmpdir(), 'bruno-'));
  writeFileSync(join(dir, 'bruno.json'), JSON.stringify({ version: '1', name: 'Clinic API', type: 'collection' }));
  writeFileSync(join(dir, 'collection.bru'), 'headers {\n  X-Trace: from-collection\n}\n\nvars:pre-request {\n  api: v1\n}\n\ndocs {\n  The clinic API.\n}\n');
  mkdirSync(join(dir, 'Patients'));
  mkdirSync(join(dir, 'environments'));
  mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(dir, 'Login.bru'), LOGIN);
  writeFileSync(join(dir, 'Patients', 'folder.bru'), 'meta {\n  name: Patients\n  seq: 1\n}\n');
  writeFileSync(join(dir, 'Patients', 'Get patient.bru'), PATIENT);
  writeFileSync(join(dir, 'environments', 'Local.bru'), 'vars {\n  baseUrl: http://localhost:3000\n}\nvars:secret [\n  password\n]\n');
  writeFileSync(join(dir, 'node_modules', 'x', 'junk.bru'), 'meta {\n  name: junk\n}\nget {\n  url: x\n}\n');
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  return new Promise<void>((r) => server.close(() => r()));
});

const services = (): ExecServices => fakeServices({ vars: { baseUrl: base, password: 'pw' }, extra: { environmentName: 'Local' } });

describe('Bruno .bru files', () => {
  it('parses blocks: key/value entries (~ = disabled), text blocks and lists', () => {
    const b = parseBru(LOGIN);
    expect(b.map((x) => x.name)).toEqual(['meta', 'post', 'headers', 'body:json', 'vars:post-response', 'assert']);
    expect(b[2]!.entries).toEqual([
      { key: 'Content-Type', value: 'application/json', enabled: true },
      { key: 'X-Debug', value: '1', enabled: false },
    ]);
    expect(JSON.parse(b[3]!.text)).toEqual({ user: 'vet', password: '{{password}}' });
    expect(parseBru('vars:secret [\n  a,\n  b\n]\n')[0]!.list).toEqual(['a', 'b']);
  });

  it('imports a Bruno collection folder: folders, order, params, auth, environments, docs', () => {
    const text = readBrunoFolder(dir);
    expect(detectFormat(text)).toBe('bruno');
    const r = importAny(text);
    const c = r.collection!;
    expect(c.name).toBe('Clinic API');
    expect(c.description).toBe('The clinic API.');
    expect(c.variables).toEqual([{ key: 'api', value: 'v1', enabled: true }]);
    expect(c.items.map((n) => n.name)).toEqual(['Log in', 'Patients']);
    const login = c.items[0] as SavedHttpRequest;
    expect(login.request).toMatchObject({ method: 'POST', url: '{{baseUrl}}/login', body: { type: 'json' }, auth: { type: 'none' } });
    // disabled headers stay disabled; collection headers are added to every request
    expect(login.request.headers).toEqual([
      { key: 'Content-Type', value: 'application/json', enabled: true },
      { key: 'X-Debug', value: '1', enabled: false },
      { key: 'X-Trace', value: 'from-collection', enabled: true },
    ]);
    expect(login.assertions).toEqual([{ type: 'status', expected: 200 }]);
    expect(login.testScript).toContain('bru.setVar("token", res.body.token);');
    const get = (c.items[1] as CollectionFolder).items[0] as SavedHttpRequest;
    expect(get.request).toMatchObject({ url: '{{baseUrl}}/patients/:id', params: [{ key: 'full', value: 'true', enabled: true }], pathVariables: [{ key: 'id', value: '7', enabled: true }], auth: { type: 'bearer', token: '{{token}}' } });
    expect(get.description).toBe('Reads one patient.');
    expect(r.environments).toEqual([{ id: 'local', name: 'Local', variables: [{ key: 'baseUrl', value: 'http://localhost:3000', enabled: true }, { key: 'password', value: '', enabled: true, secret: true }] }]);
    // node_modules is skipped
    expect(text).not.toContain('junk');
  });

  it('imports a single .bru request file', () => {
    expect(detectFormat(PATIENT)).toBe('bruno');
    const r = importAny(PATIENT);
    expect((r.collection!.items[0] as SavedHttpRequest).name).toBe('Get patient');
  });

  it("runs the imported scripts with Bruno's bru / req / res API and the converted assertions", async () => {
    seen.length = 0;
    const results: TestResult[] = [];
    const summary = await runCollection({ name: 'bruno', collection: importAny(readBrunoFolder(dir)).collection!, services: services(), onEvent: (e) => void (e.type === 'test-end' && results.push(e.result)) });
    const failed = results.flatMap((r) => r.checks.filter((c) => !c.passed).map((c) => `${r.name}: ${c.name} ${c.message}`));
    expect(failed).toEqual([]);
    expect(summary.passed).toBe(2);
    // the token from the login response (vars:post-response) authorizes the next request
    expect(seen[1]).toMatchObject({ url: '/patients/7?full=true', auth: 'Bearer tok-9', visit: 'Local', trace: 'from-collection' });
    const names = results.flatMap((r) => r.checks.map((c) => c.name));
    expect(names).toEqual(expect.arrayContaining(['res.body.token: isString', "res.headers['content-type']: contains json", 'found the dog']));
  });

  it('exports back to a Bruno folder that imports the same (and still runs)', async () => {
    const first = importAny(readBrunoFolder(dir));
    const files = collectionToBru(first.collection!, first.environments ?? []);
    expect(files.map((f) => f.path).sort()).toEqual(['Log in.bru', 'Patients/Get patient.bru', 'Patients/folder.bru', 'bruno.json', 'collection.bru', 'environments/Local.bru']);
    expect(files.find((f) => f.path === 'environments/Local.bru')!.text).toContain('vars:secret [\n  password\n]');
    expect(files.find((f) => f.path === 'Log in.bru')!.text).toContain('res.status: eq 200');
    const again = importAny(JSON.stringify(bruFilesToBrunoExport(files)));
    const shape = (c: typeof first.collection) => JSON.stringify(c!.items, (k, v) => (k === 'id' ? undefined : v));
    expect(again.collection!.name).toBe('Clinic API');
    expect(shape(again.collection)).toBe(shape(first.collection));
    seen.length = 0;
    const results: TestResult[] = [];
    await runCollection({ name: 'again', collection: again.collection!, services: services(), onEvent: (e) => void (e.type === 'test-end' && results.push(e.result)) });
    expect(results.flatMap((r) => r.checks.filter((c) => !c.passed))).toEqual([]);
  });

  it('reports a failing Bruno assertion', async () => {
    const out = await runScript("// Bruno script\ntest(\"res.status: eq 201\", function () { expect(res.status).to.eql(201); });", {
      request: { method: 'GET', url: 'http://x', headers: [] },
      response: { status: 200, headers: [['content-type', 'application/json']], body: '{}', time: 5 },
      vars: {},
    } as never);
    expect(out.tests).toEqual([expect.objectContaining({ name: 'res.status: eq 201', passed: false })]);
  });
});
