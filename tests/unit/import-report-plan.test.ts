import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import {
  WorkspaceStore,
  importDocument,
  importIntoWorkspace,
  planImport,
  planInputs,
  importInputs,
  undoMany,
  undoImportReceipt,
  readImportReport,
  listImportReceipts,
  restoreItem,
  reportMarkdown,
  expandImportFiles,
  readZip,
  collectionRequestToTest,
  exportPostmanCollection,
  importPostman,
  type Collection,
  type CollectionFolder,
  type SavedHttpRequest,
} from '../../packages/core/src/index.js';

const dirs: string[] = [];
const open: WorkspaceStore[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});
const workspace = () => {
  const d = mkdtempSync(join(tmpdir(), 'tp-plan-'));
  dirs.push(d);
  const s = WorkspaceStore.create(d, 'Import plan');
  open.push(s);
  return s;
};
const files = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));

const SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
const postman = JSON.stringify({
  info: { _postman_id: 'p1', name: 'Vet clinic', schema: SCHEMA, description: 'Clinic API' },
  protocolProfileBehavior: { maxRedirects: 3 },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] },
  item: [
    {
      name: 'Patients',
      description: { content: 'Everything about patients', type: 'text/markdown' },
      protocolProfileBehavior: { disableCookies: true, followOriginalHttpMethod: true },
      item: [
        {
          name: 'List',
          request: { method: 'GET', url: 'https://clinic.test/patients', auth: { type: 'asap', asap: [] } },
          protocolProfileBehavior: { disableUrlEncoding: true, strictSSL: false, insecureHTTPParser: true, tlsDisabledProtocols: ['TLSv1', 'TLSv1.1'] },
          event: [{ listen: 'test', script: { exec: ["pm.test('ok', () => pm.response.to.have.status(200));", 'pm.datasets.get("x");'] } }],
        },
        { name: 'Create', request: { method: 'POST', url: 'https://clinic.test/patients', body: { mode: 'raw', raw: '{}', disabled: true }, header: [{ key: 'X-Vault', value: '{{vault:clinic-key}}' }] } },
      ],
    },
    { name: 'Health', request: { method: 'GET', url: 'https://clinic.test/health' } },
  ],
});

describe('the compatibility report', () => {
  const { document, report } = importDocument(postman);

  it('counts what came over and what did not', () => {
    expect(report.format).toBe('postman');
    expect(report.tool).toBe('Postman');
    expect(report.counts).toMatchObject({ collections: 1, folders: 1, requests: 3, environments: 0 });
    // collection + folder + 3 requests = 5 items; "List" (auth, settings, script API) and "Create" (body, vault) changed
    expect(report.summary).toMatchObject({ items: 5, notImported: 1, valuesNeeded: 1 });
    expect(report.summary.changed).toBeGreaterThanOrEqual(2);
    expect(report.summary.full + report.summary.changed).toBe(report.summary.items);
  });

  it('lists findings by code with the item they belong to', () => {
    const codes = new Map(report.groups.map((g) => [g.code, g]));
    expect(codes.get('AUTH_UNSUPPORTED')).toMatchObject({ count: 1, severity: 'changed' });
    expect(codes.get('SETTING_DROPPED')).toBeTruthy();
    expect(codes.get('SCRIPT_API')).toBeTruthy();
    expect(codes.get('VALUE_NEEDED')).toBeTruthy();
    const auth = report.findings.find((f) => f.code === 'AUTH_UNSUPPORTED')!;
    expect(auth.where).toEqual(['Patients', 'List']);
    const body = report.findings.find((f) => f.field === 'body')!;
    expect(body).toMatchObject({ severity: 'not-imported', where: ['Patients', 'Create'] });
    // not-imported groups come first
    expect(report.groups[0]!.severity).toBe('not-imported');
  });

  it('keeps notes (the older result) and the report in step', () => {
    expect(document.findings.filter((f) => !f.reportOnly).length).toBeGreaterThan(3);
  });

  it('renders Markdown', () => {
    const md = reportMarkdown(report);
    expect(md).toContain('# Import report: Postman');
    expect(md).toMatch(/## Auth schemes TestPion does not have \(1\)/);
    expect(md).toContain('**Patients / List**');
  });
});

describe('Postman fields that used to be dropped', () => {
  const c = importDocument(postman).document.collections[0]!;
  const folder = c.items[0] as CollectionFolder;
  const list = folder.items[0] as SavedHttpRequest;

  it('request, folder and collection settings, folder description', () => {
    expect(c.settings).toEqual({ maxRedirects: 3 });
    expect(folder.settings).toEqual({ disableCookieJar: true, followOriginalMethod: true });
    expect(folder.description).toBe('Everything about patients');
    expect(list.request.settings).toEqual({ encodeUrl: false, insecure: true, tlsMinVersion: 'TLSv1.2' });
  });

  it('settings, folder description and folder headers go back to Postman', () => {
    const withHeaders: Collection = { ...c, headers: [{ key: 'X-Col', value: '1', enabled: true }], items: [{ ...folder, headers: [{ key: 'X-Folder', value: '2', enabled: true }], items: folder.items }, ...c.items.slice(1)] };
    const out = exportPostmanCollection(withHeaders).collection as { item: Array<{ description?: string; protocolProfileBehavior?: unknown; item?: Array<{ request: { header: Array<{ key: string }> } }> }> };
    expect(out.item[0]!.description).toBe('Everything about patients');
    expect(out.item[0]!.protocolProfileBehavior).toEqual({ disableCookies: true, followOriginalHttpMethod: true });
    // Postman has no folder headers: they are on each request
    expect(out.item[0]!.item![0]!.request.header.map((h) => h.key).filter((k) => !k.startsWith('X-Imported'))).toEqual(['X-Col', 'X-Folder']);
    const back = importPostman(JSON.stringify(exportPostmanCollection(withHeaders).collection)).collection;
    expect(((back.items[0] as CollectionFolder).items[0] as SavedHttpRequest).request.settings).toMatchObject({ encodeUrl: false, insecure: true });
  });
});

describe('collection and folder headers and settings reach the request', () => {
  it('collectionRequestToTest merges them under the request’s own (inner level wins)', () => {
    const c: Collection = {
      schemaVersion: '1.0', id: 'c', name: 'C', version: 0, variables: [], updatedAt: '',
      headers: [{ key: 'X-A', value: 'col', enabled: true }, { key: 'X-B', value: 'col', enabled: true }],
      settings: { followRedirects: false, timeoutMs: 1000 },
      items: [
        {
          kind: 'folder', id: 'f', name: 'F',
          headers: [{ key: 'x-a', value: 'folder', enabled: true }, { key: 'X-B', value: 'off', enabled: false }],
          settings: { timeoutMs: 2000 },
          items: [{ kind: 'http', id: 'r', name: 'R', request: { method: 'GET', url: 'http://x', headers: [{ key: 'X-C', value: 'own', enabled: true }], settings: { maxRedirects: 1 } } }],
        },
      ],
    };
    const t = collectionRequestToTest(c, { id: 'r', name: 'R', path: ['F'], node: (c.items[0] as CollectionFolder).items[0] as SavedHttpRequest, folders: [c.items[0] as CollectionFolder], auth: undefined } as never);
    const req = (t as { request: { headers: Array<{ key: string; value: string }>; settings: Record<string, unknown> } }).request;
    expect(req.headers.map((h) => `${h.key}=${h.value}`)).toEqual(['X-C=own', 'x-a=folder']);
    expect(req.settings).toEqual({ followRedirects: false, timeoutMs: 2000, maxRedirects: 1 });
  });
});

describe('preview: the plan writes nothing', () => {
  it('lists the tree, the clashes and the report, and leaves the workspace as it was', () => {
    const store = workspace();
    importIntoWorkspace(store, postman);
    const before = files(store.root).map((f) => [f, readFileSync(f, 'utf8')].join('\n'));
    const plan = planImport(store, postman);
    expect(plan.collections).toHaveLength(1);
    expect(plan.collections[0]).toMatchObject({ name: 'Vet clinic', folders: 1, requests: 3, nameTaken: true });
    const tree = plan.collections[0]!.tree;
    expect(tree.map((n) => n.name)).toEqual(['Patients', 'Health']);
    expect(tree[0]).toMatchObject({ kind: 'folder', status: 'full' });
    expect(tree[0]!.children!.map((n) => [n.name, n.method, n.status])).toEqual([['List', 'GET', 'changed'], ['Create', 'POST', 'changed']]);
    expect(tree[1]).toMatchObject({ method: 'GET', status: 'full' });
    expect(plan.report.summary.items).toBe(5);
    expect(files(store.root).map((f) => [f, readFileSync(f, 'utf8')].join('\n'))).toEqual(before);
  });

  it('names an environment that would be renamed, an API definition that exists, and counts secret values', () => {
    const store = workspace();
    const env = '# stage\nAPI_TOKEN=abc123\nHOST=https://x.test\n';
    importIntoWorkspace(store, env, { name: 'stage' });
    const e = planImport(store, env, { name: 'stage' });
    expect(e.environments[0]).toMatchObject({ name: 'stage', renamedTo: 'stage (imported)' });
    expect(e.secretValues).toBeGreaterThan(0);
    const spec = JSON.stringify({ openapi: '3.0.0', info: { title: 'Pets', version: '1' }, paths: { '/pets': { get: { responses: { 200: { description: 'ok' } } } } } });
    importIntoWorkspace(store, spec);
    expect(planImport(store, spec).specs).toEqual([{ path: 'specs/pets.openapi.json', existing: 'same' }]);
    expect(planImport(store, spec.replace('"Pets"', '"Pets"') + ' ').specs[0]!.existing).toBe('different');
  });

  it('plans several inputs, one of them broken', () => {
    const store = workspace();
    const r = planInputs(store, [
      { name: 'a', text: postman, source: 'a.json', fileCount: 1 },
      { name: 'b', text: '{ not json', source: 'b.json', fileCount: 1 },
    ], [{ path: 'logo.png', why: 'a .png file is not an import format' }]);
    expect(r.totals).toMatchObject({ collections: 1, requests: 3, errors: 1 });
    expect('error' in r.inputs[1]!).toBe(true);
    expect(r.skipped).toHaveLength(1);
  });
});

describe('undo', () => {
  it('takes the import back through Recently deleted, and a restore brings it again', () => {
    const store = workspace();
    const r = importIntoWorkspace(store, postman);
    expect(r.receipt).toMatchObject({ format: 'postman', collections: [{ name: 'Vet clinic' }] });
    expect(r.report!.counts.requests).toBe(3);
    expect(store.listCollections().map((c) => c.name)).toContain('Vet clinic');
    // the report and receipt are kept per computer
    expect(listImportReceipts(store)[0]).toMatchObject({ id: r.receipt!.id, collections: ['Vet clinic'] });
    expect(readImportReport(store, r.receipt!.id).report.summary.items).toBe(5);
    const u = undoImportReceipt(store, r.receipt!.id);
    expect(u.trashed).toHaveLength(1);
    expect(store.listCollections().map((c) => c.name)).not.toContain('Vet clinic');
    expect(listImportReceipts(store)).toEqual([]);
    const back = restoreItem(store, u.trashed[0]!.trashId);
    expect(back.name).toBe('Vet clinic');
    expect(store.listCollections().map((c) => c.name)).toContain('Vet clinic');
  });

  it('refuses while an imported collection was edited, unless forced', () => {
    const store = workspace();
    const r = importIntoWorkspace(store, postman);
    const c = store.listCollections().find((x) => x.id === r.collection!.id)!;
    store.saveCollection({ ...c, description: 'edited' });
    const refused = undoImportReceipt(store, r.receipt!.id);
    expect(refused.refused![0]).toMatch(/was edited after the import/);
    expect(store.listCollections().map((x) => x.name)).toContain('Vet clinic');
    expect(undoImportReceipt(store, r.receipt!.id, { force: true }).trashed).toHaveLength(1);
  });

  it('removes an environment, an API definition and flow files an import made', () => {
    const store = workspace();
    const spec = JSON.stringify({ openapi: '3.0.0', info: { title: 'Pets', version: '1' }, paths: { '/pets': { get: { responses: { 200: { description: 'ok' } } } } } });
    const r = importIntoWorkspace(store, spec);
    expect(existsSync(join(store.root, r.specPath!))).toBe(true);
    undoImportReceipt(store, r.receipt!.id);
    expect(existsSync(join(store.root, r.specPath!))).toBe(false);
    const e = importIntoWorkspace(store, 'A=1\nB=2\n', { name: 'tmp' });
    expect(store.listEnvironments().map((x) => x.name)).toContain('tmp');
    undoImportReceipt(store, e.receipt!.id);
    expect(store.listEnvironments().map((x) => x.name)).not.toContain('tmp');
  });

  it('importInputs and undoMany handle several files at once', () => {
    const store = workspace();
    const { imported, receipts } = importInputs(store, [
      { name: 'one', text: postman, source: 'one.json', fileCount: 1 },
      { name: 'two', text: 'X=1\n', source: 'two.env', fileCount: 1 },
      { name: 'bad', text: '{ nope', source: 'bad.json', fileCount: 1 },
    ]);
    expect(imported.map((i) => !!i.result)).toEqual([true, true, false]);
    expect(receipts).toHaveLength(2);
    undoMany(store, receipts);
    expect(store.listCollections().map((c) => c.name)).toEqual([]);
  });
});

/** A ZIP writer for the tests: deflate or stored entries, optional unsafe names. */
function makeZip(entries: Array<{ name: string; data: Buffer | string; store?: boolean; claimSize?: number }>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.data);
    const data = e.store ? raw : deflateRawSync(raw);
    const name = Buffer.from(e.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.store ? 0 : 8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(e.store ? 0 : 8, 10);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(e.claimSize ?? raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

describe('archives and folders', () => {
  const env = JSON.stringify({ id: 'e1', name: 'Staging', values: [{ key: 'host', value: 'h', enabled: true }, { key: 'pw', value: 'secret-pw', type: 'secret', enabled: true }], _postman_variable_scope: 'environment' });

  it('reads a ZIP (stored and deflated entries)', () => {
    const zip = makeZip([{ name: 'a/b.txt', data: 'hello' }, { name: 'c.txt', data: 'world', store: true }, { name: 'dir/', data: '' }]);
    expect(readZip(zip).map((e) => [e.path, e.data.toString()])).toEqual([['a/b.txt', 'hello'], ['c.txt', 'world']]);
  });

  it('refuses hostile archives: traversal, absolute and drive paths, NUL, bombs, too many entries, not a zip', () => {
    for (const name of ['../evil.txt', 'a/../../evil.txt', '/etc/passwd', 'C:/Windows/x', 'a\\..\\b', 'nul\0.txt']) expect(() => readZip(makeZip([{ name, data: 'x' }])), name).toThrow(/cannot be imported/);
    expect(() => readZip(makeZip([{ name: 'bomb.txt', data: Buffer.alloc(5_000_000) }]))).toThrow(/zip bomb/);
    expect(() => readZip(makeZip([{ name: 'lie.txt', data: Buffer.alloc(100_000, 'a'), claimSize: 10 }]))).toThrow(/damaged or larger/);
    expect(() => readZip(makeZip([{ name: 'a', data: '1' }, { name: 'b', data: '2' }]), { maxEntries: 1 })).toThrow(/entries/);
    expect(() => readZip(Buffer.from('this is not a zip file at all, only text'))).toThrow(/not a ZIP/);
    // a skipped macOS resource fork is not an error
    expect(readZip(makeZip([{ name: '__MACOSX/._a', data: 'x' }, { name: 'a', data: 'y' }])).map((e) => e.path)).toEqual(['a']);
  });

  it('a Postman data export (collections and environments in one ZIP) becomes one input each; secret values are kept for the secret store', () => {
    const zip = makeZip([
      { name: 'collection/1.json', data: postman },
      { name: 'environment/2.json', data: env },
      { name: 'archive.json', data: '{"collection":{"1":true}}' },
      { name: 'collection/logo.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]) },
    ]);
    const { inputs, skipped } = expandImportFiles([{ path: 'postman-data.zip', data: zip }]);
    expect(inputs.map((i) => i.source)).toEqual(['postman-data/collection/1.json', 'postman-data/environment/2.json']);
    expect(skipped.map((s) => s.path).sort()).toEqual(['postman-data/archive.json', 'postman-data/collection/logo.png']);
    const store = workspace();
    const { imported } = importInputs(store, inputs);
    expect(imported.every((i) => !!i.result)).toBe(true);
    expect(store.listCollections().map((c) => c.name)).toEqual(['Vet clinic']);
    expect(store.listEnvironments().map((e) => e.name)).toContain('Staging');
  });

  it('secret values of a Postman environment go to the secret store, never into the workspace files', () => {
    const store = workspace();
    const set: Record<string, string> = {};
    const secrets = { kind: 'test', writable: true, get: (k: string) => set[k], set: async (k: string, v: string) => void (set[k] = v), delete: async () => undefined, list: () => Object.keys(set) };
    const r = importIntoWorkspace(store, env, { secrets: secrets as never });
    expect(Object.values(set)).toEqual(['secret-pw']);
    expect(r.secretsToSet).toBeUndefined();
    expect(files(store.root).some((f) => readFileSync(f, 'utf8').includes('secret-pw'))).toBe(false);
  });

  it('a Bruno folder and an OpenCollection folder are one input each, in a picked folder or a ZIP', () => {
    const bru = (name: string) => `meta {\n  name: ${name}\n  type: http\n  seq: 1\n}\n\nget {\n  url: https://x.test/${name}\n  body: none\n  auth: none\n}\n`;
    const oc = (name: string) => `info:\n  name: ${name}\n  type: http\n  seq: 1\nhttp:\n  method: GET\n  url: https://x.test/${name}\n  auth: inherit\n`;
    const zip = makeZip([
      { name: 'bru-api/bruno.json', data: '{"name":"Bru API","version":"1"}' },
      { name: 'bru-api/List.bru', data: bru('list') },
      { name: 'oc-api/opencollection.yml', data: 'opencollection: 1.0.0\ninfo:\n  name: OC API\n' },
      { name: 'oc-api/List.yml', data: oc('list') },
      { name: 'oc-api/package.json', data: '{}' },
    ]);
    const { inputs, skipped } = expandImportFiles([{ path: 'both.zip', data: zip }]);
    expect(inputs.map((i) => [i.name, i.fileCount])).toEqual([['bru-api', 2], ['oc-api', 2]]);
    expect(skipped.map((s) => s.path)).toEqual(['both/oc-api/package.json']);
    const store = workspace();
    importInputs(store, inputs);
    expect(store.listCollections().map((c) => c.name).sort()).toEqual(['Bru API', 'OC API']);
    // a picked folder (no zip): the same
    const picked = expandImportFiles([{ path: 'bruno.json', data: '{"name":"Picked"}' }, { path: 'a.bru', data: bru('a') }, { path: 'b.bru', data: bru('b') }]);
    expect(picked.inputs).toHaveLength(1);
    expect(importDocument(picked.inputs[0]!.text).report.counts.requests).toBe(2);
  });

  it('files outside any collection: each one that is a format, the rest listed as skipped with why', () => {
    const { inputs, skipped } = expandImportFiles([
      { path: 'api.postman_collection.json', data: postman },
      { path: 'notes.txt', data: 'hello' },
      { path: 'package.json', data: '{"name":"x"}' },
      { path: '../escape.json', data: postman },
      { path: 'blob.json', data: Buffer.from([0, 1, 2, 0, 0]) },
      { path: '.hidden', data: 'x' },
    ]);
    expect(inputs.map((i) => i.name)).toEqual(['api.postman_collection']);
    expect(Object.fromEntries(skipped.map((s) => [s.path, s.why]))).toEqual({
      'notes.txt': 'not a format TestPion imports',
      'package.json': 'not a format TestPion imports',
      '../escape.json': 'the path leaves the folder',
      'blob.json': 'a binary file',
      '.hidden': 'a hidden file',
    });
  });
});

