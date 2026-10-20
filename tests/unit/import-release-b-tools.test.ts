import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { detectFormat, importDocument, type CollectionFolder, type CollectionNode, type SavedHttpRequest } from '../../packages/core/src/index.js';

// Import compatibility, release B: Thunder Client, Yaak, HTTPie and Apidog through the import document model.

const fx = (p: string) => readFileSync(resolve(__dirname, '..', 'fixtures', 'import', p), 'utf8');
const flat = (nodes: CollectionNode[]): CollectionNode[] => nodes.flatMap((n) => (n.kind === 'folder' ? [n, ...flat(n.items)] : [n]));
const named = (nodes: CollectionNode[], name: string) => flat(nodes).find((n) => n.name === name)!;
const http = (nodes: CollectionNode[], name: string) => named(nodes, name) as SavedHttpRequest;

describe('Thunder Client', () => {
  const { document: doc, report } = importDocument(fx('thunder/clinic.collection.json'));
  const items = doc.collections[0]!.items;
  it('is detected by content and keeps the folder tree in sortNum order', () => {
    expect(detectFormat(fx('thunder/clinic.collection.json'))).toBe('thunder');
    expect(doc.collections[0]!.name).toBe('Vet Clinic');
    expect(items.map((n) => n.name)).toEqual(['Login', 'Patients', 'Patient query']);
    const patients = named(items, 'Patients') as CollectionFolder;
    expect(patients.items.map((n) => n.name)).toEqual(['List patients', 'Get patient', 'Admin']);
    expect(patients.headers).toEqual([{ key: 'X-Clinic', value: '{{clinic}}', enabled: true }]);
    expect(patients.auth).toEqual({ type: 'bearer', token: '{{token}}' });
  });
  it('maps generators, params, path params, bodies and auth', () => {
    const login = http(items, 'Login');
    expect(login.request.body).toMatchObject({ type: 'json' });
    expect((login.request.body as { content: string }).content).toContain('{{$guid}}');
    expect(login.request.auth).toEqual({ type: 'basic', username: '{{user}}', password: '{{pass}}' });
    const list = http(items, 'List patients');
    expect(list.request.url).toBe('{{host}}/patients');
    expect(list.request.params).toEqual([
      { key: 'limit', value: '10', enabled: true },
      { key: 'page', value: '{{$randomInt(1,5)}}', enabled: false },
    ]);
    expect(list.request.headers).toEqual([
      { key: 'Accept', value: 'application/json', enabled: true },
      { key: 'X-Debug', value: '1', enabled: false },
    ]);
    expect(http(items, 'Get patient').request.pathVariables).toEqual([{ key: 'id', value: '{{firstId}}' }]);
    const up = http(items, 'Upload photo').request;
    expect(up.body).toMatchObject({ type: 'multipart' });
    expect(up.auth).toMatchObject({ type: 'oauth2', grantType: 'client_credentials', clientId: 'clinic' });
  });
  it('turns the GUI tests into assertions and a test script, and tc.* scripts into tp.*', () => {
    const login = http(items, 'Login');
    expect(login.assertions).toEqual([{ type: 'status', expected: 200 }, { type: 'latency', max: 800 }, { type: 'header', header: 'content-type', expected: 'json' }]);
    expect(login.testScript).toContain('tp.environment.set("token", tp.response.json()?.token)');
    expect(login.testScript).toContain('tp.expect(tp.response.json()?.token).to.be.a("string")');
    expect(http(items, 'List patients').assertions).toEqual([{ type: 'contains', expected: 'Rex' }]);
    const list = http(items, 'List patients').testScript!;
    expect(list).toContain("tp.environment.set('firstId', tp.response.json()[0].id)");
    expect(list).toContain('tp.expect(tp.response.code).to.equal(200)');
    expect(list).not.toMatch(/\btc\./);
  });
  it('never inherits an auth it cannot map, and says so', () => {
    const gql = named(items, 'Patient query');
    expect(gql.kind).toBe('graphql');
    expect((gql as { request: { auth: unknown } }).request.auth).toEqual({ type: 'none' });
    expect(report.findings.some((f) => f.code === 'AUTH_UNSUPPORTED' && /kerberos/.test(f.message))).toBe(true);
  });
  it('imports an environment export', () => {
    const { document: env } = importDocument(fx('thunder/staging.environment.json'));
    expect(env.format).toBe('thunder');
    expect(env.environments[0]).toMatchObject({ name: 'Staging' });
    expect(env.environments[0]!.variables).toEqual([
      { key: 'host', value: 'https://staging.example.test', enabled: true },
      { key: 'user', value: 'vet', enabled: true },
      { key: 'stamp', value: '{{$timestamp}}', enabled: true },
      { key: 'off', value: 'x', enabled: false },
    ]);
  });
});

describe('Yaak', () => {
  const { document: doc, report } = importDocument(fx('yaak/clinic.json'));
  const c = doc.collections[0]!;
  it('is detected and builds the tree, workspace headers and folder auth', () => {
    expect(detectFormat(fx('yaak/clinic.json'))).toBe('yaak');
    expect(c.name).toBe('Vet Clinic');
    expect(c.headers).toEqual([{ key: 'X-Team', value: 'vets', enabled: true }]);
    expect(c.items.map((n) => n.name)).toEqual(['Patients', 'Use token', 'Form', 'Gql']);
    expect((named(c.items, 'Patients') as CollectionFolder).auth).toEqual({ type: 'bearer', token: '{{token}}' });
  });
  it('converts ${[ ]} templates and keeps what it cannot convert visible', () => {
    const list = http(c.items, 'List patients');
    expect(list.request.url).toBe('{{host}}/{{apiVersion}}/patients');
    expect(list.request.params).toEqual([
      { key: 'limit', value: '10', enabled: true },
      { key: 'page', value: '2', enabled: false },
    ]);
    expect((http(c.items, 'Create patient').request.body as { content: string }).content).toContain('{{$guid}}');
    expect(http(c.items, 'Create patient').request.auth).toEqual({ type: 'basic', username: 'vet', password: '{{password}}' });
    expect(http(c.items, 'Use token').request.headers![0]!.value).toContain("response.body.path(request='rq_9'");
    expect(report.findings.some((f) => f.code === 'TEMPLATE_TAG_UNSUPPORTED' && /another request's response/.test(f.message))).toBe(true);
    expect(http(c.items, 'Use token').request.auth).toEqual({ type: 'none' });
  });
  it('merges the base environment into the others and maps gRPC / WebSocket to library items', () => {
    expect(doc.environments).toHaveLength(1);
    expect(doc.environments[0]).toMatchObject({ name: 'Staging' });
    expect(doc.environments[0]!.variables).toEqual([
      { key: 'apiVersion', value: 'v1', enabled: true },
      { key: 'host', value: 'https://staging.example.test', enabled: true },
    ]);
    const saved = doc.savedItems as { grpc: unknown[]; websocket: unknown[] };
    expect(saved.grpc).toHaveLength(1);
    expect(saved.websocket).toHaveLength(1);
  });
  it('reports an auth plugin TestPion has instead of inheriting', () => {
    expect((named(c.items, 'Gql') as { request: { auth: unknown } }).request.auth).toEqual({ type: 'none' });
    expect(report.findings.some((f) => f.code === 'AUTH_UNSUPPORTED' && /kerberos/i.test(f.message))).toBe(true);
  });
});

describe('HTTPie', () => {
  const { document: doc, report } = importDocument(fx('httpie/clinic.json'));
  const c = doc.collections[0]!;
  it('is detected; folders, auth inheritance, bodies and docs map', () => {
    expect(detectFormat(fx('httpie/clinic.json'))).toBe('httpie');
    expect(c.auth).toEqual({ type: 'bearer', token: '{{token}}' });
    expect(c.description).toBe('The clinic API');
    expect(c.items.map((n) => n.name)).toEqual(['Photos', 'List patients', 'Create patient']);
    const list = http(c.items, 'List patients');
    expect(list.request.url).toBe('{{host}}/patients');
    expect(list.request.params).toEqual([
      { key: 'limit', value: '10', enabled: true },
      { key: 'page', value: '2', enabled: false },
    ]);
    expect(list.request.auth).toEqual({ type: 'inherit' });
    const create = http(c.items, 'Create patient');
    expect(create.request.body).toEqual({ type: 'json', content: '{"name":"Rex"}' });
    expect(create.description).toBe('Adds a patient');
    const up = http(c.items, 'Upload');
    expect(up.request.body).toMatchObject({ type: 'multipart' });
    expect(up.request.auth).toEqual({ type: 'none' });
  });
  it('reports an auth it does not have', () => {
    expect(http(c.items, 'Odd auth').request.auth).toEqual({ type: 'none' });
    expect(report.findings.some((f) => f.code === 'AUTH_UNSUPPORTED')).toBe(true);
  });
  it('imports an environment export', () => {
    const { document: env } = importDocument(fx('httpie/staging.environment.json'));
    expect(env.environments[0]).toMatchObject({ name: 'Staging', variables: [{ key: 'host', value: 'https://staging.example.test' }, { key: 'token', value: 't0k' }] });
  });
});

describe('Apidog', () => {
  const { document: doc, report } = importDocument(fx('apidog/clinic.json'));
  const c = doc.collections[0]!;
  it('is detected; endpoints become requests under {{baseUrl}} with examples from the design', () => {
    expect(detectFormat(fx('apidog/clinic.json'))).toBe('apidog');
    expect(c.items.map((n) => n.name)).toEqual(['Patients']);
    const list = http(c.items, 'List patients');
    expect(list.request.url).toBe('{{baseUrl}}/patients');
    expect(list.request.params).toEqual([
      { key: 'limit', value: '10', enabled: true },
      { key: 'page', value: '1', enabled: false },
    ]);
    expect(list.examples![0]).toMatchObject({ name: 'Two patients', status: 200 });
    const create = http(c.items, 'Create patient');
    expect(create.request.url).toBe('{{baseUrl}}/patients/:kind');
    expect(create.request.pathVariables).toEqual([{ key: 'kind', value: 'dog' }]);
    expect(JSON.parse((create.request.body as { content: string }).content)).toEqual({ id: 1, name: 'Rex' });
    expect(create.examples![0]).toMatchObject({ status: 201 });
    expect(create.preRequestScript).toContain("pm.environment.set('stamp'");
    expect(http(c.items, 'Upload').request.url).toBe('https://files.example.test/up');
  });
  it('merges environments and global variables, and reports the operations it skipped', () => {
    expect(c.variables).toEqual([{ key: 'baseUrl', value: '', enabled: true }]);
    expect(doc.environments[0]!.variables.map((v) => v.key)).toEqual(['baseUrl', 'token', 'locale']);
    expect(report.findings.some((f) => /database/.test(f.message))).toBe(true);
  });
});
