import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  detectFormat,
  exportPostmanCollection,
  exportPostmanEnvironment,
  importPostman,
  importPostmanEnvironment,
  pmUrl,
  stableUuid,
  type Collection,
  type CollectionNode,
} from '../../packages/core/src/index.js';

const collection: Collection = {
  schemaVersion: '1.0',
  id: 'pets',
  name: 'Pets',
  description: 'Pet store',
  version: 2,
  variables: [
    { key: 'baseUrl', value: 'https://api.example.com' },
    { key: 'off', value: 'x', enabled: false },
  ],
  auth: { type: 'bearer', token: '{{token}}' },
  preRequestScript: "pm.variables.set('t', Date.now());",
  testScript: "pm.test('fast', () => pm.expect(pm.response.responseTime).to.be.below(2000));",
  updatedAt: '',
  items: [
    {
      kind: 'folder',
      id: 'f',
      name: 'Pets',
      auth: { type: 'apiKey', key: 'X-Key', value: '{{key}}', in: 'header' },
      variables: [{ key: 'species', value: 'dog' }],
      preRequestScript: "console.log('folder pre');",
      testScript: "pm.test('folder', () => pm.expect(pm.response.code).to.be.below(500));",
      items: [
        {
          kind: 'http',
          id: 'get',
          name: 'Get pet',
          description: 'One pet.',
          request: {
            method: 'GET',
            url: '{{baseUrl}}/pets/:id',
            pathVariables: [{ key: 'id', value: '1', description: 'Pet id' }],
            params: [
              { key: 'expand', value: 'owner' },
              { key: 'debug', value: '1', enabled: false },
            ],
            headers: [{ key: 'Accept', value: 'application/json' }],
            auth: { type: 'inherit' },
            settings: { followRedirects: false },
          },
          testScript: "pm.test('has id', () => pm.expect(pm.response.json().id).to.exist);",
          assertions: [{ type: 'status', expected: 200 }, { type: 'json-path', path: '$.id', exists: true } as never],
          examples: [{ id: 'e', name: 'Found', status: 200, statusText: 'OK', headers: [{ key: 'Content-Type', value: 'application/json' }], body: '{"id":1}' }],
        },
        {
          kind: 'http',
          id: 'create',
          name: 'Create pet',
          request: {
            method: 'POST',
            url: '{{baseUrl}}/pets',
            body: { type: 'json', content: '{"name":"Rex"}' },
            auth: { type: 'oauth2', grantType: 'client_credentials', tokenUrl: 'https://auth/token', clientId: 'c', clientSecret: '{{secret}}', scope: 'pets', clientAuth: 'header', redirectUri: 'http://localhost:8080/cb' },
          },
        },
        {
          kind: 'http',
          id: 'upload',
          name: 'Upload photo',
          request: {
            method: 'POST',
            url: 'https://api.example.com/pets/1/photo',
            body: { type: 'multipart', fields: [{ key: 'file', value: 'photo.png', kind: 'file' }, { key: 'caption', value: 'Rex' }] },
          },
        },
      ],
    },
    { kind: 'graphql', id: 'g', name: 'Search', request: { endpoint: '{{baseUrl}}/graphql', query: 'query { pets { id } }', variables: { first: 2 }, auth: { type: 'inherit' } } },
  ],
};

const strip = (nodes: CollectionNode[]): unknown[] =>
  nodes.map((n) => {
    const { id: _id, ...rest } = n as CollectionNode & { id: string };
    if (n.kind === 'folder') return { ...rest, items: strip(n.items) };
    if (n.kind === 'http') return { ...rest, examples: n.examples?.map(({ id: _e, ...ex }) => ex) };
    return rest;
  });

describe('Postman v2.1 export', () => {
  const { collection: pm, notes } = exportPostmanCollection(collection);
  const json = JSON.stringify(pm);

  it('writes a v2.1 collection that the importer recognises', () => {
    expect(detectFormat(json)).toBe('postman');
    expect(pm.info).toMatchObject({ name: 'Pets', description: 'Pet store', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json', _postman_id: stableUuid('pets') });
    expect(stableUuid('pets')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('builds Postman URL objects', () => {
    expect(pmUrl('https://api.example.com/v1/pets?limit=2')).toEqual({ raw: 'https://api.example.com/v1/pets?limit=2', protocol: 'https', host: ['api', 'example', 'com'], path: ['v1', 'pets'], query: [{ key: 'limit', value: '2' }] });
    expect(pmUrl('{{baseUrl}}/pets/:id', [{ key: 'a', value: '1' }, { key: 'b', value: '2', enabled: false }], [{ key: 'id', value: '7' }])).toEqual({
      raw: '{{baseUrl}}/pets/:id?a=1',
      host: ['{{baseUrl}}'],
      path: ['pets', ':id'],
      query: [{ key: 'a', value: '1' }, { key: 'b', value: '2', disabled: true }],
      variable: [{ key: 'id', value: '7' }],
    });
  });

  it('turns status assertions into pm tests and reports what it left out', () => {
    expect(json).toContain('pm.response.to.have.status(200);');
    expect(notes).toEqual(['Get pet: assertions of type json-path have no Postman equivalent and were left out']);
  });

  it('round-trips through the Postman importer', () => {
    // the source scripts use pm.*: keep them so the round trip is exact (the default import converts to tp.*)
    const back = importPostman(json, { scripts: 'keep' }).collection;
    expect(back).toMatchObject({ name: 'Pets', description: 'Pet store', auth: collection.auth, preRequestScript: collection.preRequestScript, testScript: collection.testScript });
    expect(back.variables).toEqual([
      { key: 'baseUrl', value: 'https://api.example.com', enabled: true },
      { key: 'off', value: 'x', enabled: false },
    ]);
    const expected = structuredClone(collection.items) as CollectionNode[];
    // the status assertion comes back as a pm.test in the test script; other assertions are not in Postman
    const get = (expected[0] as { items: CollectionNode[] }).items[0] as Extract<CollectionNode, { kind: 'http' }>;
    get.testScript += "\n\npm.test(\"Status code is 200\", function () {\n  pm.response.to.have.status(200);\n});";
    delete get.assertions;
    // defaults the importer fills in
    for (const n of (expected[0] as { items: CollectionNode[] }).items) if (n.kind === 'http') {
      n.request.params ??= [];
      n.request.headers ??= [];
      n.request.auth ??= { type: 'inherit' };
    }
    (((expected[0] as { items: CollectionNode[] }).items[2] as Extract<CollectionNode, { kind: 'http' }>).request.body as { fields: Array<{ enabled?: boolean; kind?: string }> }).fields.forEach((f) => ((f.enabled = true), (f.kind ??= 'text')));
    get.request.params!.forEach((p) => (p.enabled ??= true));
    ((expected[0] as { variables: Array<{ enabled?: boolean }> }).variables).forEach((v) => (v.enabled ??= true));
    get.request.headers!.forEach((h) => (h.enabled ??= true));
    const g = expected[1] as Extract<CollectionNode, { kind: 'graphql' }>;
    g.request = { ...g.request, variables: JSON.stringify({ first: 2 }, null, 2), headers: [] };
    expect(JSON.parse(JSON.stringify(strip(back.items)))).toEqual(JSON.parse(JSON.stringify(strip(expected))));
  });

  it('round-trips the example workspace collection', () => {
    const c = JSON.parse(readFileSync(resolve('examples/veterinary-workspace/collections/veterinary-api.json'), 'utf8')) as Collection;
    const back = importPostman(JSON.stringify(exportPostmanCollection(c).collection)).collection;
    // a query string kept in the URL comes back as the Params table: compare the effective URL
    const flat = (nodes: CollectionNode[]): string[] =>
      nodes.flatMap((n) => (n.kind === 'folder' ? [`folder ${n.name}`, ...flat(n.items)] : [`${n.kind === 'http' ? n.request.method : 'gql'} ${n.name} ${n.kind === 'http' ? pmUrl(n.request.url, n.request.params).raw : ''} ${n.kind === 'http' ? n.examples?.length ?? 0 : 0}`]));
    expect(flat(back.items)).toEqual(flat(c.items));
    expect(back.description).toBe(c.description);
  });
});

describe('Postman environment export', () => {
  it('exports variables, with secret values left out, and imports back', () => {
    const env = { id: 'dev', name: 'Development', variables: [{ key: 'baseUrl', value: 'http://localhost:4010' }, { key: 'token', value: 'should-not-leak', secret: true }, { key: 'old', value: '1', enabled: false }] };
    const pm = exportPostmanEnvironment(env);
    expect(JSON.stringify(pm)).not.toContain('should-not-leak');
    expect(detectFormat(JSON.stringify(pm))).toBe('postman-env');
    expect(importPostmanEnvironment(JSON.stringify(pm))).toEqual({
      id: 'development',
      name: 'Development',
      variables: [
        { key: 'baseUrl', value: 'http://localhost:4010', secret: false, enabled: true },
        { key: 'token', value: '', secret: true, enabled: true },
        { key: 'old', value: '1', secret: false, enabled: false },
      ],
    });
  });
});
