import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  WorkspaceStore,
  detectFormat,
  expandImportFiles,
  importDocument,
  importIntoWorkspace,
  planImport,
  readImportPath,
  undoImportReceipt,
  liftTests,
  type CollectionFolder,
  type CollectionNode,
  type SavedHttpRequest,
} from '../../packages/core/src/index.js';

// Import compatibility, release B: Postman v1 / v3 / Native Git, globals, re-import that updates, tests lifted into assertions.

const fixtures = resolve(__dirname, '..', 'fixtures', 'import');
const fx = (p: string) => readFileSync(join(fixtures, p), 'utf8');
const flat = (nodes: CollectionNode[]): CollectionNode[] => nodes.flatMap((n) => (n.kind === 'folder' ? [n, ...flat(n.items)] : [n]));
const named = (nodes: CollectionNode[], name: string) => flat(nodes).find((n) => n.name === name)!;
const http = (nodes: CollectionNode[], name: string) => named(nodes, name) as SavedHttpRequest;
const dirs: string[] = [];
const open: WorkspaceStore[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});
const workspace = () => {
  const d = mkdtempSync(join(tmpdir(), 'tp-relb-'));
  dirs.push(d);
  const s = WorkspaceStore.create(d, 'Release B');
  open.push(s);
  return s;
};

describe('Postman collection v1', () => {
  const { document: doc, report } = importDocument(fx('postman/v1-clinic.json'));
  const c = doc.collections[0]!;
  it('is detected and converted: folders, ordered requests, headers, bodies, helper auth, scripts', () => {
    expect(detectFormat(fx('postman/v1-clinic.json'))).toBe('postman-v1');
    expect(doc.format).toBe('postman-v1');
    expect(c.name).toBe('Clinic (v1)');
    expect(c.items.map((n) => n.name)).toEqual(['Patients', 'Health']);
    const list = http(c.items, 'List patients');
    expect(list.request.url).toBe('{{host}}/patients');
    expect(list.request.params).toEqual([{ key: 'limit', value: '10', enabled: true }]);
    expect(list.request.headers).toEqual([
      { key: 'Accept', value: 'application/json', enabled: true },
      { key: 'X-Trace', value: '1', enabled: true },
    ]);
    expect(list.request.auth).toEqual({ type: 'basic', username: 'vet', password: '{{password}}' });
    expect(list.testScript).toContain('tp.test("Status code is 200"');
    expect(list.preRequestScript).toContain("tp.environment.set('stamp'");
    expect(http(c.items, 'Create patient').request.body).toEqual({ type: 'json', content: '{"name":"Rex"}' });
    expect(http(c.items, 'Health').request.body).toMatchObject({ type: 'form-urlencoded' });
  });
  it('an auth helper TestPion has not is none and reported, never inherited', () => {
    expect(http(c.items, 'Health').request.auth).toEqual({ type: 'none' });
    expect(report.findings.some((f) => f.code === 'AUTH_UNSUPPORTED')).toBe(true);
  });
});

describe('Postman collection v3 (Git integration)', () => {
  const read = readImportPath(join(fixtures, 'postman', 'v3', 'Clinic'));
  const { inputs } = expandImportFiles(read.files, { folderName: read.folderName });
  it('a folder of *.request.yaml files is one collection', () => {
    expect(inputs).toHaveLength(1);
    expect(detectFormat(inputs[0]!.text)).toBe('postman-v3');
  });
  const { document: doc, report } = importDocument(inputs[0]!.text);
  const c = doc.collections[0]!;
  it('reads the definition, folders in order, requests, auth, scripts and examples', () => {
    expect(doc.format).toBe('postman-v3');
    expect(c.name).toBe('Clinic (v3)');
    expect(c.auth).toEqual({ type: 'bearer', token: '{{token}}' });
    expect(c.variables).toEqual([{ key: 'host', value: 'https://api.example.test', enabled: true }]);
    expect(c.preRequestScript).toContain("tp.variables.set('startedAt'");
    expect(c.items.map((n) => n.name)).toEqual(['Health', 'Patients']);
    const health = http(c.items, 'Health');
    expect(health.request.auth).toEqual({ type: 'none' });
    expect(health.testScript).toContain('tp.test(');
    expect(health.examples![0]).toMatchObject({ name: 'Healthy', status: 200, body: '{"status":"up"}' });
    const patients = named(c.items, 'Patients') as CollectionFolder;
    expect(patients.description).toBe('Patient endpoints');
    expect(patients.items.map((n) => n.name)).toEqual(['List patients', 'Create patient']);
    expect(http(c.items, 'List patients').request.auth).toEqual({ type: 'basic', username: 'vet', password: '{{password}}' });
    const create = http(c.items, 'Create patient');
    expect(create.request.params).toEqual([{ key: 'dryRun', value: 'true', enabled: false }]);
    expect(create.request.body).toMatchObject({ type: 'json' });
  });
  it('a field it does not read is a finding, not a silent drop', () => {
    expect(report.findings.some((f) => /mystery/.test(f.message))).toBe(true);
  });
});

describe('Postman Native Git (collections, environments and globals in one repository)', () => {
  const read = readImportPath(join(fixtures, 'postman', 'native-git'));
  const { inputs } = expandImportFiles(read.files, { folderName: read.folderName });
  it('finds the collection, the environment and the globals', () => {
    const formats = inputs.map((i) => detectFormat(i.text)).sort();
    expect(formats).toEqual(['postman-env', 'postman-env', 'postman-v3']);
  });
  it('the cloud id of the collection is its source key; the globals file is globals; secret values are needed', () => {
    const col = importDocument(inputs.find((i) => detectFormat(i.text) === 'postman-v3')!.text).document;
    expect(col.sourceKey).toBe('12345678-aaaa-4bbb-8ccc-1234567890ab');
    const docs = inputs.filter((i) => detectFormat(i.text) === 'postman-env').map((i) => importDocument(i.text));
    const globals = docs.find((d) => d.document.globals)!;
    expect(globals.document.globals).toEqual([
      { key: 'locale', value: 'en' },
      { key: 'debug', value: '1' },
    ]);
    const env = docs.find((d) => d.document.environments.length)!;
    expect(env.document.environments[0]!.variables.map((v) => v.key)).toEqual(['host', 'apiKey']);
    expect(env.report.findings.some((f) => f.code === 'VALUE_NEEDED')).toBe(true);
  });
});

describe('Postman globals as workspace globals', () => {
  const globals = JSON.stringify({ id: 'g', name: 'Workspace Globals', values: [{ key: 'locale', value: 'en', enabled: true }, { key: 'token', value: 'abc', type: 'secret', enabled: true }, { key: 'off', value: 'x', enabled: false }], _postman_variable_scope: 'globals' });
  it('go to the globals sink of the host, secrets flagged; undo removes them', () => {
    const store = workspace();
    const set: unknown[] = [];
    const removed: string[][] = [];
    const sinks = { globals: { set: (v: unknown) => void set.push(v), remove: (k: string[]) => void removed.push(k) } };
    const r = importIntoWorkspace(store, globals, { sinks });
    expect(r.globals).toBe(2);
    expect(set[0]).toEqual([
      { key: 'locale', value: 'en' },
      { key: 'token', value: 'abc', secret: true },
    ]);
    expect(store.listEnvironments().map((e) => e.name)).toEqual(['Development']);
    undoImportReceipt(store, r.receipt!.id, { sinks });
    expect(removed[0]).toEqual(['locale', 'token']);
  });
  it('without a sink (the CLI) they come over as an environment, so nothing is lost', () => {
    const store = workspace();
    const r = importIntoWorkspace(store, globals);
    expect(store.listEnvironments().map((e) => e.name)).toEqual(['Development', 'Postman globals']);
    expect(r.notes!.join(' ')).toMatch(/no workspace globals store/);
  });
});

describe('re-import updates by source ids', () => {
  const v1 = (extra: Record<string, unknown> = {}, name = 'List') =>
    JSON.stringify({
      info: { name: 'Orders', _postman_id: 'col-1', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      variable: [{ key: 'host', value: 'https://a.test' }],
      item: [
        { id: 'i-list', name, request: { method: 'GET', url: 'https://a.test/orders' }, ...extra },
        { id: 'i-folder', name: 'Admin', item: [{ id: 'i-purge', name: 'Purge', request: { method: 'DELETE', url: 'https://a.test/orders' } }] },
      ],
    });
  it('replace what changed in the source, add what is new, skip what you edited, keep ids', () => {
    const store = workspace();
    const first = importIntoWorkspace(store, v1());
    const col = store.listCollections().find((c) => c.id === first.collection!.id)!;
    const listId = http(col.items, 'List').id;
    // the user edits Purge locally
    const purge = http(col.items, 'Purge');
    store.saveCollection({ ...col, items: col.items.map((n) => (n.kind === 'folder' ? { ...n, items: n.items.map((c) => (c.id === purge.id ? { ...c, description: 'my note' } : c)) } : n)) as CollectionNode[] });
    // the source changes List (a new header) and Purge, and adds Archive
    const text = JSON.stringify({
      info: { name: 'Orders', _postman_id: 'col-1', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      variable: [{ key: 'host', value: 'https://a.test' }],
      item: [
        { id: 'i-list', name: 'List', request: { method: 'GET', url: 'https://a.test/orders', header: [{ key: 'X-New', value: '1' }] } },
        { id: 'i-folder', name: 'Admin', item: [{ id: 'i-purge', name: 'Purge', request: { method: 'DELETE', url: 'https://a.test/orders/all' } }, { id: 'i-archive', name: 'Archive', request: { method: 'POST', url: 'https://a.test/archive' } }] },
      ],
    });
    const plan = planImport(store, text);
    expect(plan.reimport).toHaveLength(1);
    const actions = Object.fromEntries(plan.reimport![0]!.items.map((i) => [i.path.join(' / '), i.action]));
    expect(actions).toEqual({ List: 'replace', Admin: 'skip', 'Admin / Purge': 'skip', 'Admin / Archive': 'new' });
    expect(plan.reimport![0]!.items.find((i) => i.path.at(-1) === 'Purge')!.conflict).toBe(true);
    const r = importIntoWorkspace(store, text, { update: true });
    expect(r.updated![0]!.applied).toEqual({ replaced: 1, added: 1, skipped: 2 });
    expect(store.listCollections().filter((c) => !c.problem)).toHaveLength(1);
    const now = store.listCollections()[0]!;
    expect(http(now.items, 'List').id).toBe(listId);
    expect(http(now.items, 'List').request.headers).toEqual([{ key: 'X-New', value: '1', enabled: true }]);
    expect(http(now.items, 'Purge').description).toBe('my note');
    expect(http(now.items, 'Archive').request.method).toBe('POST');
    // choosing Replace for the conflict takes the source version
    const r2 = importIntoWorkspace(store, text, { update: { decisions: { 'i-purge': 'replace' } } });
    expect(r2.updated![0]!.applied.replaced).toBe(1);
    expect(http(store.listCollections()[0]!.items, 'Purge').request.url).toBe('https://a.test/orders/all');
    expect(http(store.listCollections()[0]!.items, 'Purge').description).toBeUndefined();
  });
  it('an update is one undo step', () => {
    const store = workspace();
    importIntoWorkspace(store, v1());
    const r = importIntoWorkspace(store, v1({ response: [] }, 'List'), { update: true });
    expect(r.updated).toHaveLength(1);
    const text2 = v1({ request: { method: 'GET', url: 'https://a.test/v2' } });
    const r3 = importIntoWorkspace(store, text2, { update: true });
    expect(http(store.listCollections()[0]!.items, 'List').request.url).toBe('https://a.test/v2');
    const u = undoImportReceipt(store, r3.receipt!.id);
    expect(u.refused).toBeUndefined();
    expect(http(store.listCollections()[0]!.items, 'List').request.url).toBe('https://a.test/orders');
  });
  it('without update an import still adds a second collection', () => {
    const store = workspace();
    importIntoWorkspace(store, v1());
    importIntoWorkspace(store, v1());
    expect(store.listCollections()).toHaveLength(2);
  });
  it('an environment of the same name gets only its missing variables', () => {
    const store = workspace();
    const env = (vars: Array<[string, string]>) => JSON.stringify({ name: 'Dev', values: vars.map(([key, value]) => ({ key, value, enabled: true })), _postman_variable_scope: 'environment' });
    importIntoWorkspace(store, env([['a', '1']]));
    const r = importIntoWorkspace(store, env([['a', '2'], ['b', '3']]), { update: true });
    const dev = () => store.listEnvironments().filter((e) => e.name === 'Dev');
    expect(dev()).toHaveLength(1);
    expect(dev()[0]!.variables).toEqual([
      { key: 'a', value: '1', enabled: true, secret: false },
      { key: 'b', value: '3', enabled: true, secret: false },
    ]);
    expect(r.notes!.join(' ')).toMatch(/1 variable added/);
    undoImportReceipt(store, r.receipt!.id);
    expect(dev()[0]!.variables.map((v) => v.key)).toEqual(['a']);
  });
});

describe('simple tests lifted into assertions', () => {
  const cases: Array<[string, unknown]> = [
    ['pm.test("s", function () { pm.response.to.have.status(200); });', { type: 'status', expected: 200, name: 's' }],
    ['tp.test("s", () => { tp.expect(tp.response.code).to.eql(201); });', { type: 'status', expected: 201, name: 's' }],
    ['tp.test("s", () => tp.expect(tp.response.code).to.be.oneOf([200, 204]));', { type: 'status', expected: [200, 204], name: 's' }],
    ['tp.test("s", () => { tp.expect(tp.response.responseTime).to.be.below(300); });', { type: 'latency', max: 300, name: 's' }],
    ['tp.test("s", () => { tp.response.to.have.header("Content-Type"); });', { type: 'header', header: 'Content-Type', name: 's' }],
    ['tp.test("s", () => { tp.expect(tp.response.headers.get("X-A")).to.eql("b"); });', { type: 'header', header: 'X-A', expected: 'b', name: 's' }],
    ['tp.test("s", () => { tp.response.to.be.json; });', { type: 'is-json', name: 's' }],
    ['tp.test("s", () => { const json = tp.response.json(); tp.expect(json.name).to.eql("Rex"); });', { type: 'equals', path: '$.name', expected: 'Rex', name: 's' }],
    ['tp.test("s", () => { tp.expect(tp.response.json().items).to.have.lengthOf(3); });', { type: 'length', path: '$.items', expected: 3, name: 's' }],
    ['tp.test("s", () => { var j = tp.response.json(); tp.expect(j.id).to.be.a("number"); });', { type: 'type', path: '$.id', expected: 'number', name: 's' }],
    ['tp.test("s", () => { tp.expect(tp.response.json().a.b[0]).to.be.above(2); });', { type: 'greater-than', path: '$.a.b[0]', expected: 2, name: 's' }],
    ['tp.test("s", () => { tp.expect(tp.response.json()).to.have.property("id"); });', undefined],
    ['tp.test("s", () => { tp.expect(tp.response.json().id).to.exist; });', { type: 'exists', path: '$.id', name: 's' }],
    ['tp.test("s", () => { tp.expect(tp.response.text()).to.include("ok"); });', { type: 'contains', expected: 'ok', name: 's' }],
    ['tp.test("s", () => { tp.expect(tp.response.json().tags).to.include("new"); });', { type: 'contains', path: '$.tags', expected: 'new', name: 's' }],
    ['tp.test("s", () => { tp.response.to.have.jsonSchema({ type: "object" }); });', { type: 'json-schema', schema: { type: 'object' }, name: 's' }],
  ];
  for (const [code, want] of cases)
    it(code.slice(0, 80), () => {
      const r = liftTests(code);
      if (want === undefined) {
        expect(r.lifted).toBe(0);
        expect(r.code).toBe(code);
      } else {
        expect(r.assertions).toEqual([want]);
        expect(r.code.trim()).toBe('');
      }
    });
  it('keeps what it cannot lift and everything around it', () => {
    const code = 'tp.variables.set("a", 1);\ntp.test("keep", () => { tp.expect(foo()).to.eql(1); });\ntp.test("lift", () => { tp.response.to.have.status(200); });\nconsole.log("x");';
    const r = liftTests(code);
    expect(r.lifted).toBe(1);
    expect(r.code).toContain('tp.test("keep"');
    expect(r.code).toContain('tp.variables.set("a", 1);');
    expect(r.code).toContain('console.log("x");');
    expect(r.code).not.toContain('"lift"');
  });
  it('an import counts them for the report and lifts them on request', () => {
    const text = JSON.stringify({ info: { name: 'T', _postman_id: 't', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [{ name: 'A', request: { method: 'GET', url: 'https://a.test' }, event: [{ listen: 'test', script: { exec: ['pm.test("ok", function () { pm.response.to.have.status(200); });', 'pm.test("fast", function () { pm.expect(pm.response.responseTime).to.be.below(500); });'] } }] }] });
    const plain = importDocument(text);
    expect(plain.report.findings.find((f) => f.code === 'TESTS_LIFTABLE')!.message).toMatch(/^2 simple tests/);
    expect(http(plain.document.collections[0]!.items, 'A').assertions).toBeUndefined();
    const lifted = importDocument(text, { liftTests: true });
    const a = http(lifted.document.collections[0]!.items, 'A');
    expect(a.assertions).toEqual([{ type: 'status', expected: 200, name: 'ok' }, { type: 'latency', max: 500, name: 'fast' }]);
    expect(a.testScript).toBeUndefined();
    expect(lifted.report.findings.some((f) => f.code === 'TESTS_LIFTED')).toBe(true);
  });
});
