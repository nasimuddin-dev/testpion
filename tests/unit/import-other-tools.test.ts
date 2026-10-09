import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore, detectFormat, importAny, importIntoWorkspace, normalizeTemplate, type CollectionNode, type SavedHttpRequest } from '../../packages/core/src/index.js';

const flat = (nodes: CollectionNode[]): CollectionNode[] => nodes.flatMap((n) => (n.kind === 'folder' ? [n, ...flat(n.items)] : [n]));
const req = (nodes: CollectionNode[], name: string) => flat(nodes).find((n) => n.name === name) as SavedHttpRequest;

const insomnia4 = JSON.stringify({
  _type: 'export',
  __export_format: 4,
  resources: [
    { _id: 'wrk_1', _type: 'workspace', name: 'Shop API', description: 'The shop' },
    { _id: 'env_base', _type: 'environment', parentId: 'wrk_1', name: 'Base Environment', data: { baseUrl: 'https://api.shop.test', api: { version: 'v2' } } },
    { _id: 'env_stg', _type: 'environment', parentId: 'env_base', name: 'Staging', data: { baseUrl: 'https://staging.shop.test' } },
    { _id: 'fld_1', _type: 'request_group', parentId: 'wrk_1', name: 'Orders', environment: { orderId: '42' }, metaSortKey: 1 },
    {
      _id: 'req_1', _type: 'request', parentId: 'fld_1', name: 'Create order', method: 'post', url: '{{ _.baseUrl }}/{{ _.api.version }}/orders', metaSortKey: 2,
      body: { mimeType: 'application/json', text: '{"sku":"{{ _.sku }}"}' },
      headers: [{ name: 'X-Trace', value: '1' }, { name: 'X-Off', value: '1', disabled: true }],
      parameters: [{ name: 'dryRun', value: 'true' }],
      authentication: { type: 'bearer', token: '{{ _.token }}' },
      afterResponseScript: "insomnia.test('ok', () => insomnia.expect(insomnia.response.code).to.eql(201));",
    },
    { _id: 'req_2', _type: 'request', parentId: 'fld_1', name: 'Login form', method: 'POST', url: '{{baseUrl}}/login', metaSortKey: 1, body: { mimeType: 'application/x-www-form-urlencoded', params: [{ name: 'user', value: 'ada' }] }, authentication: { type: 'basic', username: 'ada', password: '{{ _.pw }}' } },
    { _id: 'req_3', _type: 'request', parentId: 'wrk_1', name: 'Products (GraphQL)', method: 'POST', url: '{{ _.baseUrl }}/graphql', body: { mimeType: 'application/graphql', text: JSON.stringify({ query: '{ products { id } }', variables: { first: 5 } }) } },
  ],
});

const insomnia5 = `type: collection.insomnia.rest/5.0
name: Petstore
collection:
  - name: Pets
    children:
      - name: Get pet
        method: GET
        url: "{{ _.base }}/pets/1"
        authentication: { type: apikey, key: X-Key, value: "{{ _.key }}", addTo: header }
environments:
  name: Base Environment
  data: { base: https://pets.test }
`;

const bruno = JSON.stringify({
  name: 'Users API',
  version: '1',
  brunoConfig: { version: '1', name: 'Users API' },
  environments: [{ name: 'Local', variables: [{ name: 'host', value: 'http://localhost:3000', enabled: true }, { name: 'token', value: 'super-secret', enabled: true, secret: true }] }],
  items: [
    { type: 'folder', name: 'Users', items: [
      { type: 'http-request', name: 'List users', seq: 2, request: { url: '{{host}}/users?limit=10', method: 'GET', headers: [], params: [{ name: 'limit', value: '10', type: 'query', enabled: true }], body: { mode: 'none' }, auth: { mode: 'bearer', bearer: { token: '{{token}}' } }, assertions: [{ name: 'res.status', value: 'eq 200', enabled: true }], tests: "test('ok', () => expect(res.status).to.equal(200));" } },
      { type: 'http-request', name: 'Create user', seq: 1, request: { url: '{{host}}/users', method: 'POST', headers: [{ name: 'Content-Type', value: 'application/json', enabled: true }], params: [], body: { mode: 'json', json: '{"name":"Ada"}' }, auth: { mode: 'inherit' } } },
    ] },
  ],
});

const hoppscotch = JSON.stringify({
  v: 2,
  name: 'Blog',
  folders: [{ v: 2, name: 'Posts', folders: [], requests: [{ v: '6', name: 'New post', method: 'POST', endpoint: '<<base>>/posts', params: [], headers: [{ key: 'X-A', value: '1', active: true }], body: { contentType: 'application/json', body: '{"t":1}' }, auth: { authType: 'api-key', key: 'k', value: '<<key>>', addTo: 'HEADERS', authActive: true }, preRequestScript: '', testScript: 'pw.test("ok", () => {});' }] }],
  requests: [{ v: '6', name: 'Health', method: 'GET', endpoint: '<<base>>/health', params: [{ key: 'v', value: '1', active: true }], headers: [], body: { contentType: null, body: null }, auth: { authType: 'none', authActive: true } }],
});

describe('importing other API clients', () => {
  it('normalizes template syntax', () => {
    expect(normalizeTemplate('{{ _.baseUrl }}/{{ id }}/<<x>>/{{kept}}')).toBe('{{baseUrl}}/{{id}}/{{x}}/{{kept}}');
  });

  it('detects each format', () => {
    expect(detectFormat(insomnia4)).toBe('insomnia');
    expect(detectFormat(insomnia5)).toBe('insomnia');
    expect(detectFormat(bruno)).toBe('bruno');
    expect(detectFormat(hoppscotch)).toBe('hoppscotch');
  });

  it('Insomnia v4: folders, bodies, auth, GraphQL, variables and environments (base merged into each)', () => {
    const r = importAny(insomnia4);
    const c = r.collection!;
    expect(c.name).toBe('Shop API');
    expect(c.items.map((n) => n.name)).toEqual(['Products (GraphQL)', 'Orders']); // metaSortKey order
    const folder = flat(c.items).find((n) => n.name === 'Orders');
    expect(folder).toMatchObject({ kind: 'folder', variables: [{ key: 'orderId', value: '42' }] });
    // sorted by metaSortKey inside the folder
    expect((folder as { items: CollectionNode[] }).items.map((n) => n.name)).toEqual(['Login form', 'Create order']);
    const create = req(c.items, 'Create order');
    expect(create.request).toMatchObject({ method: 'POST', url: '{{baseUrl}}/{{api.version}}/orders', body: { type: 'json', content: '{"sku":"{{sku}}"}' }, auth: { type: 'bearer', token: '{{token}}' }, params: [{ key: 'dryRun', value: 'true', enabled: true }] });
    expect(create.request.headers).toEqual([{ key: 'X-Trace', value: '1', enabled: true }, { key: 'X-Off', value: '1', enabled: false }]);
    expect(create.testScript).toMatch(/^\/\/ Insomnia script/);
    // Insomnia's script API follows Postman's: the script stays runnable, as TestPion's tp.* (the default)
    expect(create.testScript).toContain("tp.test('ok', () => tp.expect(tp.response.code).to.eql(201));");
    expect(r.scripts?.converted).toBeGreaterThan(0);
    expect(create.testScript!.split('\n').slice(1).join('\n')).not.toContain('insomnia.');
    expect(req(c.items, 'Login form').request).toMatchObject({ body: { type: 'form-urlencoded', fields: [{ key: 'user', value: 'ada', enabled: true }] }, auth: { type: 'basic', username: 'ada', password: '{{pw}}' } });
    expect(flat(c.items).find((n) => n.name === 'Products (GraphQL)')).toMatchObject({ kind: 'graphql', request: { endpoint: '{{baseUrl}}/graphql', query: '{ products { id } }', variables: { first: 5 } } });
    expect(r.environments).toEqual([{ id: 'staging', name: 'Staging', variables: [{ key: 'api.version', value: 'v2', enabled: true }, { key: 'baseUrl', value: 'https://staging.shop.test', enabled: true }] }]);
  });

  it('Insomnia v5 YAML', () => {
    const r = importAny(insomnia5);
    expect(req(r.collection!.items, 'Get pet').request).toMatchObject({ url: '{{base}}/pets/1', auth: { type: 'apiKey', key: 'X-Key', value: '{{key}}', in: 'header' } });
    expect(r.environments?.[0]).toMatchObject({ name: 'Petstore', variables: [{ key: 'base', value: 'https://pets.test' }] });
  });

  it('Bruno: order by seq, query params, status assertions, secrets left empty', () => {
    const r = importAny(bruno);
    const users = flat(r.collection!.items).find((n) => n.name === 'Users') as { items: CollectionNode[] };
    expect(users.items.map((n) => n.name)).toEqual(['Create user', 'List users']);
    const list = req(r.collection!.items, 'List users');
    expect(list.request).toMatchObject({ url: '{{host}}/users', params: [{ key: 'limit', value: '10', enabled: true }], auth: { type: 'bearer', token: '{{token}}' } });
    expect(list.assertions).toEqual([{ type: 'status', expected: 200 }]);
    expect(list.testScript).toContain('// Bruno script');
    expect(req(r.collection!.items, 'Create user').request.body).toEqual({ type: 'json', content: '{"name":"Ada"}' });
    expect(r.environments?.[0]?.variables).toEqual([{ key: 'host', value: 'http://localhost:3000', enabled: true }, { key: 'token', value: '', enabled: true, secret: true }]);
    expect(JSON.stringify(r)).not.toContain('super-secret');
  });

  it('Hoppscotch: folders, <<variables>>, api-key auth, scripts as comments', () => {
    const r = importAny(hoppscotch);
    const post = req(r.collection!.items, 'New post');
    expect(post.request).toMatchObject({ method: 'POST', url: '{{base}}/posts', body: { type: 'json', content: '{"t":1}' }, auth: { type: 'apiKey', key: 'k', value: '{{key}}', in: 'header' } });
    expect(post.testScript).toContain('// Hoppscotch script');
    expect(req(r.collection!.items, 'Health').request).toMatchObject({ url: '{{base}}/health', params: [{ key: 'v', value: '1', enabled: true }], auth: { type: 'none' } });
  });
});

describe('importing into a workspace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-import-'));
  const store = WorkspaceStore.create(join(dir, 'ws'), 'Imports');
  afterAll(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('saves every environment and never replaces an existing one', () => {
    store.saveEnvironment({ id: 'staging', name: 'Staging', variables: [{ key: 'mine', value: 'keep', enabled: true }] });
    const r = importIntoWorkspace(store, insomnia4);
    expect(r.format).toBe('insomnia');
    expect(r.environments?.map((e) => e.name)).toEqual(['Staging (imported)']);
    expect(store.getEnvironment('staging')?.variables).toEqual([{ key: 'mine', value: 'keep', enabled: true }]);
    expect(store.getEnvironment('Staging (imported)')?.variables.some((v) => v.key === 'baseUrl')).toBe(true);
    importIntoWorkspace(store, insomnia4);
    expect(store.listEnvironments().map((e) => e.name)).toContain('Staging (imported 2)');
  });

  it('says where a broken JSON file is broken instead of "unknown format"', () => {
    const text = ['{', '  "info": { "name": "x" },', '  "item": ["a\\.b"]', '}'].join('\n');
    expect(() => importAny(text)).toThrow(/not valid JSON \(line 3, column \d+\)/);
    expect(() => importAny('hello there')).toThrow(/Unrecognised import format/);
  });

  it('imports Postman v2.0 collections, whose auth attributes are objects', () => {
    const v20 = {
      info: { name: 'Old', schema: 'https://schema.getpostman.com/json/collection/v2.0.0/collection.json' },
      auth: { type: 'bearer', bearer: { token: '{{tok}}' } },
      item: [
        { name: 'Basic', request: { url: 'https://a.test/x', method: 'GET', auth: { type: 'basic', basic: { username: 'u', password: 'p' } } } },
        { name: 'Key', request: { url: 'https://a.test/y', method: 'GET', header: 'Accept: application/json\nX-Trace: t:1', auth: { type: 'apikey', apikey: { key: 'X-Key', value: 'k', in: 'header' } } } },
      ],
    };
    const r = importAny(JSON.stringify(v20));
    expect(r.collection!.auth).toEqual({ type: 'bearer', token: '{{tok}}' });
    expect(r.collection!.items.map((i) => (i as SavedHttpRequest).request.auth)).toEqual([
      { type: 'basic', username: 'u', password: 'p' },
      { type: 'apiKey', key: 'X-Key', value: 'k', in: 'header' },
    ]);
    // headers written as one string
    expect((r.collection!.items[1] as SavedHttpRequest).request.headers?.map((h) => [h.key, h.value])).toEqual([
      ['Accept', 'application/json'],
      ['X-Trace', 't:1'],
    ]);
  });
});
