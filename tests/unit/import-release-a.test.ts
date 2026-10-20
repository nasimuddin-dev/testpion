import { describe, it, expect } from 'vitest';
import {
  importAny,
  importDocument,
  detectFormat,
  ocFilesToBundle,
  fetchPostmanInputs,
  parsePostmanRef,
  expandImportFiles,
  DYNAMIC_VARIABLES,
  type CollectionFolder,
  type SavedHttpRequest,
} from '../../packages/core/src/index.js';

// Import compatibility, release A: OpenCollection YAML, Bruno and Insomnia gaps, the Postman API, the dynamic variables.

const OC_ROOT = `opencollection: 1.0.0
info:
  name: Clinic
  summary: The clinic API
request:
  headers:
    - name: X-Team
      value: vets
  auth:
    type: bearer
    token: "{{token}}"
  variables:
    - name: api
      value: v1
  settings:
    http:
      followRedirects: false
      timeout: 5000
`;
const OC_FOLDER = `info:
  name: Patients
  type: folder
request:
  headers:
    - name: X-Folder
      value: p
  scripts:
    - type: before-request
      code: bru.setVar("folder", 1);
docs: Everything about patients
`;
const OC_REQUEST = `info:
  name: Create
  type: http
  seq: 2
http:
  method: POST
  url: "{{host}}/patients"
  headers:
    - name: Content-Type
      value: application/json
    - name: X-Off
      value: "1"
      disabled: true
  params:
    - name: dry
      value: "true"
      type: query
    - name: id
      value: "7"
      type: path
  body:
    type: json
    data: '{"name":"Rex"}'
  auth:
    type: ntlm
    username: vet
    password: "{{pw}}"
    domain: CLINIC
runtime:
  variables:
    - name: pre
      value: one
  scripts:
    - type: after-response
      code: bru.setEnvVar("id", res.body.id);
    - type: tests
      code: |-
        test("created", function () { expect(res.status).to.equal(201); });
    - type: hooks
      code: noop();
  assertions:
    - expression: res.status
      operator: eq
      value: "201"
    - expression: res.body.id
      operator: isNumber
  actions:
    - type: set-variable
      phase: after-response
      selector:
        expression: res.body.token
        method: jsonq
      variable:
        name: tok
        scope: runtime
settings:
  encodeUrl: false
docs: Creates a patient
examples:
  - name: Created
    request:
      url: "{{host}}/patients"
      method: POST
    response:
      status: 201
      statusText: Created
      headers:
        - name: Content-Type
          value: application/json
      body:
        type: json
        data: '{"id":1}'
`;
const OC_ENV = `name: Local
variables:
  - name: host
    value: http://localhost:3000
  - name: secret
    secret: true
`;
const ocFiles = [
  { path: 'opencollection.yml', text: OC_ROOT },
  { path: 'patients/folder.yml', text: OC_FOLDER },
  { path: 'patients/Create.yml', text: OC_REQUEST },
  { path: 'environments/Local.yml', text: OC_ENV },
];

describe('OpenCollection YAML', () => {
  const text = JSON.stringify(ocFilesToBundle(ocFiles));
  const r = importAny(text);
  const c = r.collection!;
  const folder = c.items[0] as CollectionFolder;
  const req = folder.items[0] as SavedHttpRequest;

  it('is detected, as a bundled file and as a folder of files', () => {
    expect(detectFormat(text)).toBe('opencollection');
    expect(detectFormat('opencollection: 1.0.0\ninfo:\n  name: X\nitems: []\n')).toBe('opencollection');
    const { inputs } = expandImportFiles(ocFiles.map((f) => ({ path: `clinic/${f.path}`, data: f.text })));
    expect(inputs).toHaveLength(1);
    expect(importAny(inputs[0]!.text).collection!.name).toBe('Clinic');
  });

  it('collection and folder defaults: headers, auth, variables, settings, scripts, docs', () => {
    expect(c).toMatchObject({ name: 'Clinic', description: 'The clinic API', auth: { type: 'bearer', token: '{{token}}' }, headers: [{ key: 'X-Team', value: 'vets', enabled: true }], variables: [{ key: 'api', value: 'v1', enabled: true }] });
    expect(c.settings).toEqual({ followRedirects: false, timeoutMs: 5000 });
    expect(folder).toMatchObject({ name: 'Patients', description: 'Everything about patients', headers: [{ key: 'X-Folder', value: 'p', enabled: true }] });
    expect(folder.preRequestScript).toContain('tp.collectionVariables.set("folder", 1);');
  });

  it('a request: method, url, params, path variables, body, NTLM auth, settings, docs, example', () => {
    expect(req.request).toMatchObject({
      method: 'POST',
      url: '{{host}}/patients',
      params: [{ key: 'dry', value: 'true', enabled: true }],
      pathVariables: [{ key: 'id', value: '7' }],
      body: { type: 'json', content: '{"name":"Rex"}' },
      auth: { type: 'ntlm', username: 'vet', password: '{{pw}}', domain: 'CLINIC' },
      settings: { encodeUrl: false },
    });
    expect(req.request.headers).toEqual([{ key: 'Content-Type', value: 'application/json', enabled: true }, { key: 'X-Off', value: '1', enabled: false }]);
    expect(req.description).toBe('Creates a patient');
    expect(req.examples?.[0]).toMatchObject({ name: 'Created', status: 201, body: '{"id":1}' });
  });

  it('scripts speak tp.*; assertions and actions become checks and lines; an unknown script type is reported', () => {
    expect(req.preRequestScript).toContain('tp.variables.set("pre", "one");');
    expect(req.testScript).toContain('tp.environment.set("id", res.body.id);');
    expect(req.testScript).toContain('tp.collectionVariables.set("tok", res.body.token);');
    expect(req.testScript).toContain('to.be.a(\'number\')');
    expect(req.assertions).toEqual([{ type: 'status', expected: 201 }]);
    expect(r.notes?.some((n) => /type hooks/.test(n))).toBe(true);
  });

  it('environments: secrets are names to enter', () => {
    expect(r.environments![0]).toMatchObject({ name: 'Local', variables: [{ key: 'host', value: 'http://localhost:3000' }, { key: 'secret', value: '', secret: true }] });
    expect(r.notes?.some((n) => /Values needed: secret in the "Local"/.test(n))).toBe(true);
  });
});

describe('Bruno gaps', () => {
  it('settings, custom http method, sparql, examples are read or reported; collection root post-response vars', () => {
    const bru = 'meta {\n  name: Purge\n  type: http\n  seq: 1\n}\n\nhttp {\n  method: purge\n  url: https://x.test/cache\n  body: sparql\n  auth: none\n}\n\nbody:sparql {\n  SELECT * WHERE { ?s ?p ?o }\n}\n\nsettings {\n  encodeUrl: false\n  timeout: 2500\n}\n\nexample {\n  name: One\n}\n';
    const r = importAny(bru);
    const req = r.collection!.items[0] as SavedHttpRequest;
    expect(req.request).toMatchObject({ method: 'PURGE', body: { type: 'text', content: 'SELECT * WHERE { ?s ?p ?o }' }, settings: { encodeUrl: false, timeoutMs: 2500 } });
    expect(r.notes?.some((n) => /SPARQL body was imported as a text body/.test(n))).toBe(true);
    expect(r.notes?.some((n) => /1 Bruno response example was not imported/.test(n))).toBe(true);
  });
});

describe('Insomnia gaps', () => {
  it('v5: a design document is kept as a spec file, request settings and scripts are read', () => {
    const yaml = `type: collection.insomnia.rest/5.0
name: Shop
meta:
  id: wrk_1
collection:
  - name: Orders
    meta: { id: fld_1 }
    description: All the orders
    headers:
      - name: X-Shop
        value: s
    scripts:
      preRequest: insomnia.environment.set('a', 1);
    children:
      - name: List
        meta: { id: req_1 }
        method: GET
        url: https://shop.test/orders
        settings:
          followRedirects: off
          encodeUrl: false
          cookies: { send: false, store: true }
      - name: Feed
        meta: { id: req_2 }
        url: ws://shop.test/feed
        body: { text: hello }
spec:
  meta: { name: Shop API }
  contents: |
    openapi: 3.0.0
    info: { title: Shop, version: '1' }
    paths: {}
`;
    const r = importAny(yaml);
    const folder = r.collection!.items[0] as CollectionFolder;
    expect(folder).toMatchObject({ description: 'All the orders', headers: [{ key: 'X-Shop', value: 's' }] });
    expect(folder.preRequestScript).toContain("tp.environment.set('a', 1);");
    expect((folder.items[0] as SavedHttpRequest).request.settings).toEqual({ followRedirects: false, encodeUrl: false, disableCookieJar: true });
    expect(r.specFile).toMatchObject({ path: 'specs/shop-api.openapi.yaml' });
    expect((r.savedItems as { websocket: Array<{ name: string }> }).websocket[0]!.name).toBe('Feed');
  });
});

describe('Postman by API key', () => {
  const calls: string[] = [];
  const fetchImpl = async (url: string, init: { headers: Record<string, string> }) => {
    calls.push(`${url} key=${init.headers['X-Api-Key']}`);
    const body = url.endsWith('/workspaces/w1')
      ? { workspace: { collections: [{ uid: '1-c' }], environments: [{ uid: '2-e' }] } }
      : url.includes('/collections/') ? { collection: { info: { name: 'C', _postman_id: 'x', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [] } }
        : { environment: { name: 'E', values: [] } };
    return { ok: true, status: 200, json: async () => body };
  };
  it('reads references and links', () => {
    expect(parsePostmanRef('postman:collection/12-abc')).toEqual({ kind: 'collection', id: '12-abc' });
    expect(parsePostmanRef('https://api.getpostman.com/environments/9-z')).toEqual({ kind: 'environment', id: '9-z' });
    expect(parsePostmanRef('https://www.postman.com/team/workspace/ws/collection/1234-abcd')).toEqual({ kind: 'collection', id: '1234-abcd' });
    expect(parsePostmanRef('https://example.com/collection/1')).toBeUndefined();
    expect(parsePostmanRef('not a link')).toBeUndefined();
  });
  it('fetches a workspace with the key, and says what is missing without one; the key is never in an error', async () => {
    const inputs = await fetchPostmanInputs({ kind: 'workspace', id: 'w1' }, 'PMAK-secret', { fetchImpl: fetchImpl as never });
    expect(inputs.map((i) => i.name)).toEqual(['C', 'E']);
    expect(importDocument(inputs[0]!.text).report.format).toBe('postman');
    expect(calls.every((c) => c.startsWith('https://api.getpostman.com/') && c.endsWith('key=PMAK-secret'))).toBe(true);
    await expect(fetchPostmanInputs({ kind: 'collection', id: 'x' }, undefined)).rejects.toThrow(/API key/);
    const failing = async () => {
      throw new Error('connect ECONNREFUSED while using PMAK-secret');
    };
    await expect(fetchPostmanInputs({ kind: 'collection', id: 'x' }, 'PMAK-secret', { fetchImpl: failing as never })).rejects.not.toThrow(/PMAK-secret/);
    const denied = async () => ({ ok: false, status: 401, json: async () => ({}) });
    await expect(fetchPostmanInputs({ kind: 'collection', id: 'x' }, 'PMAK-secret', { fetchImpl: denied as never })).rejects.toThrow(/did not accept the API key/);
  });
});

describe('Postman dynamic variables', () => {
  it('has every name of Postman’s list', () => {
    const have = new Set(DYNAMIC_VARIABLES.map((v) => v.name));
    const want = '$randomAbstractImage $randomAnimalsImage $randomBusinessImage $randomCatsImage $randomCityImage $randomFoodImage $randomNightlifeImage $randomFashionImage $randomPeopleImage $randomNatureImage $randomSportsImage $randomTransportImage $randomImageDataUri $randomBankAccountName $randomBankAccountBic $randomBankAccountIban $randomCreditCardMask $randomBitcoin $randomTransactionType $randomBs $randomBsAdjective $randomBsBuzz $randomBsNoun $randomCatchPhraseAdjective $randomCatchPhraseDescriptor $randomCatchPhraseNoun $randomDatabaseColumn $randomDatabaseType $randomDatabaseCollation $randomDatabaseEngine $randomAdjective $randomNoun $randomVerb $randomIngverb $randomPhrase $randomCommonFileName $randomCommonFileType $randomCommonFileExt $randomFilePath $randomDirectoryPath $randomJobDescriptor $randomJobType $randomLoremLines $randomLoremText $randomDirectionAbbreviation $randomCardinalDirection $randomOrdinalDirection $randomStreetSuffix $randomZipCode $randomPort'.split(' ');
    expect(want.filter((n) => !have.has(n))).toEqual([]);
  });
});
