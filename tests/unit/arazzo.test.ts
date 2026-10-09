import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  WorkspaceStore,
  criteriaToChecks,
  detectFormat,
  exportArazzo,
  exportArazzoFromWorkspace,
  importArazzo,
  importIntoWorkspace,
  jsonPathToPointer,
  loadTestsFromFile,
  parseOperationPath,
  pointerToJsonPath,
} from '../../packages/core/src/index.js';

const openapi = {
  openapi: '3.0.3',
  info: { title: 'Pets', version: '1' },
  servers: [{ url: 'https://pets.example.com/v1' }],
  paths: {
    '/login': { post: { operationId: 'login', responses: { 200: { description: 'ok' } } } },
    '/pets': {
      get: { operationId: 'listPets', parameters: [{ name: 'limit', in: 'query' }], responses: { 200: { description: 'ok' } } },
      post: { operationId: 'addPet', responses: { 201: { description: 'made' } } },
    },
    '/pets/{petId}': {
      parameters: [{ name: 'petId', in: 'path', required: true }],
      get: { operationId: 'getPet', responses: { 200: { description: 'ok' } } },
      delete: { responses: { 204: { description: 'gone' } } },
    },
  },
};

const arazzo = `arazzo: 1.0.1
info:
  title: Adopt a pet
  version: 1.0.0
sourceDescriptions:
  - name: pets
    url: ./pets.openapi.json
    type: openapi
workflows:
  - workflowId: adoptPet
    summary: Log in, add a pet, read it back, delete it
    inputs:
      type: object
      required: [username]
      properties:
        username: { type: string, description: Who logs in }
        password: { type: string, default: secret }
        petName: { type: string, default: Rex }
    steps:
      - stepId: login
        operationId: login
        requestBody:
          contentType: application/json
          payload:
            username: $inputs.username
            password: $inputs.password
        successCriteria:
          - condition: $statusCode == 200
        outputs:
          token: $response.body#/access_token
          requestId: $response.header.X-Request-Id
      - stepId: addPet
        operationId: $sourceDescriptions.pets.addPet
        parameters:
          - name: Authorization
            in: header
            value: Bearer {$steps.login.outputs.token}
        requestBody:
          payload:
            name: $inputs.petName
            tags: [new]
        successCriteria:
          - condition: $statusCode == 201 && $response.body#/name == 'Rex'
          - context: $response.body
            condition: $.id
            type: jsonpath
        onFailure:
          - name: again
            type: retry
            retryLimit: 2
            retryAfter: 1
        outputs:
          petId: $response.body#/id
      - stepId: getPet
        operationPath: '{$sourceDescriptions.pets.url}#/paths/~1pets~1{petId}/get'
        parameters:
          - name: petId
            in: path
            value: $steps.addPet.outputs.petId
          - name: verbose
            in: query
            value: true
        successCriteria:
          - condition: $statusCode >= 200 && $statusCode < 300
          - condition: $response.body#/tags/0 != null
          - context: $response.body
            condition: /x+/
            type: xpath
        onSuccess:
          - name: skip
            type: goto
            stepId: login
        outputs:
          name: $response.body#/name
      - stepId: removePet
        operationPath: '{$sourceDescriptions.pets.url}#/paths/~1pets~1{petId}/delete'
        parameters:
          - name: petId
            in: path
            value: $steps.addPet.outputs.petId
        successCriteria:
          - condition: $statusCode == 204
    outputs:
      petId: $steps.addPet.outputs.petId
      name: $steps.getPet.outputs.name
`;

const flowOf = (text: string) => parse(text) as { name: string; expose?: any; tests: any[]; output?: Record<string, string> };

describe('Arazzo import', () => {
  it('is detected by its arazzo: key', () => {
    expect(detectFormat(arazzo)).toBe('arazzo');
    expect(detectFormat(JSON.stringify(parse(arazzo)))).toBe('arazzo');
  });

  it('turns a workflow into a flow file: operations, parameters, bodies, variables, extracts, checks, inputs', () => {
    const r = importArazzo(arazzo, { sources: { pets: openapi } });
    expect(r.flows).toHaveLength(1);
    const f = r.flows[0]!;
    expect(f.path).toBe('tests/arazzo/adoptpet.yaml');
    expect(f.text).toMatch(/# arazzo-workflow: adoptPet/);
    expect(f.text).toMatch(/# arazzo-source: pets openapi \.\/pets\.openapi\.json/);
    expect(f.text).toMatch(/https:\/\/pets\.example\.com\/v1/);
    const flow = flowOf(f.text);
    expect(flow.name).toBe('Log in, add a pet, read it back, delete it');
    expect(flow.expose.tool).toBe('adopt_pet');
    expect(flow.expose.inputs).toEqual([
      { name: 'username', description: 'Who logs in', required: true },
      { name: 'password', default: 'secret' },
      { name: 'petName', default: 'Rex' },
    ]);
    const [login, add, get, del] = flow.tests;
    // operationId → method + URL; body payload with $inputs → {{variables}}
    expect(login).toMatchObject({ id: 'login', method: 'POST', url: '{{baseUrl}}/login', body: { username: '{{username}}', password: '{{password}}' } });
    expect(login.dependsOn).toBeUndefined();
    expect(login.extract).toEqual({ login_token: '$.access_token' });
    expect(login.testScript).toContain("tp.variables.set('login_requestId', tp.response.headers.get('X-Request-Id'))");
    expect(login.assertions).toEqual([{ type: 'status', expected: 200 }]);
    // $sourceDescriptions.x.opId, a header with an embedded expression, && conditions, jsonpath criteria, retry
    expect(add).toMatchObject({
      id: 'addPet',
      dependsOn: 'login',
      method: 'POST',
      url: '{{baseUrl}}/pets',
      headers: { Authorization: 'Bearer {{login_token}}' },
      body: { name: '{{petName}}', tags: ['new'] },
      retries: 2,
    });
    expect(add.assertions).toEqual([
      { type: 'status', expected: 201 },
      { type: 'equals', path: '$.name', expected: 'Rex' },
      { type: 'exists', path: '$.id' },
    ]);
    expect(add.extract).toEqual({ addPet_petId: '$.id' });
    // operationPath with path and query parameters; a status range is the 2xx class
    expect(get).toMatchObject({ id: 'getPet', dependsOn: 'addPet', method: 'GET', url: '{{baseUrl}}/pets/{{addPet_petId}}', params: { verbose: 'true' } });
    expect(get.assertions).toEqual([
      { type: 'status', expected: '2xx' },
      { type: 'exists', path: '$.tags[0]' },
    ]);
    expect(del).toMatchObject({ method: 'DELETE', url: '{{baseUrl}}/pets/{{addPet_petId}}', assertions: [{ type: 'status', expected: 204 }] });
    expect(flow.output).toEqual({ petId: '{{addPet_petId}}', name: '{{getPet_name}}' });
    // what is not representable is reported and kept as a comment on the step
    expect(r.notes.some((n) => /goto login/.test(n))).toBe(true);
    expect(r.notes.some((n) => /xpath criterion/.test(n))).toBe(true);
    expect(r.notes.some((n) => /retry after 1s/.test(n))).toBe(true);
    expect(f.text).toMatch(/# Arazzo, not imported: on success goto login/);
    expect(r.unresolvedSources).toEqual([]);
  });

  it('without the OpenAPI document: operationPath still converts, operationId steps are skipped and reported', () => {
    const r = importArazzo(arazzo);
    expect(r.unresolvedSources).toEqual(['pets']);
    const [login, , get] = flowOf(r.flows[0]!.text).tests;
    expect(login.skip).toBe(true);
    expect(get).toMatchObject({ method: 'GET', url: '{{baseUrl}}/pets/{{addPet_petId}}' });
    expect(r.notes[0]).toMatch(/source pets/);
  });

  it('a step that calls another workflow becomes a sub-flow step', () => {
    const doc = `arazzo: 1.0.0
info: { title: Two, version: '1' }
sourceDescriptions: [{ name: pets, url: pets.json, type: openapi }]
workflows:
  - workflowId: inner
    steps:
      - stepId: one
        operationId: listPets
        parameters: [{ name: limit, in: query, value: 5 }]
        outputs: { first: $response.body#/0/id }
    outputs: { first: $steps.one.outputs.first }
  - workflowId: outer
    steps:
      - stepId: call
        workflowId: inner
        parameters: [{ name: limit, value: 3 }]
        outputs: { got: $outputs.first }
      - stepId: use
        operationId: getPet
        parameters: [{ name: petId, in: path, value: $steps.call.outputs.got }]
`;
    const r = importArazzo(doc, { sources: { pets: JSON.stringify(openapi) } });
    expect(r.flows.map((f) => f.path)).toEqual(['tests/arazzo/inner.yaml', 'tests/arazzo/outer.yaml']);
    const inner = flowOf(r.flows[0]!.text);
    expect(inner.tests[0]).toMatchObject({ params: { limit: '5' }, extract: { one_first: '$[0].id' } });
    const outer = flowOf(r.flows[1]!.text);
    expect(outer.tests[0]).toMatchObject({ type: 'flow', file: './inner.yaml', inputs: { limit: 3 } });
    expect(outer.tests[1].url).toBe('{{baseUrl}}/pets/{{first}}');
  });

  it('criteria and expressions helpers', () => {
    expect(pointerToJsonPath('/a/0/b~1c')).toBe("$.a[0]['b/c']");
    expect(pointerToJsonPath('')).toBe('$');
    expect(jsonPathToPointer("$.a[0]['b/c']")).toBe('/a/0/b~1c');
    expect(jsonPathToPointer('$..x')).toBeUndefined();
    expect(parseOperationPath('{$sourceDescriptions.p.url}#/paths/~1a~1{id}/patch')).toEqual({ source: 'p', path: '/a/{id}', method: 'patch' });
    const { checks, unsupported } = criteriaToChecks([
      { condition: "$response.header.Content-Type == 'application/json'" },
      { condition: '$response.body.count > 2 && $response.body.count <= 9' },
      { condition: '$statusCode == 200 || $statusCode == 201' },
      { context: '$response.body#/name', condition: '^R', type: 'regex' },
    ]);
    expect(checks).toEqual([
      { type: 'header', header: 'Content-Type', expected: 'application/json' },
      { type: 'greater-than', path: '$.count', expected: 2 },
      { type: 'threshold', path: '$.count', max: 9 },
      { type: 'regex', path: '$.name', expected: '^R' },
    ]);
    expect(unsupported).toHaveLength(1);
  });

  it('imports into a workspace: finds the OpenAPI document in specs/, writes flow files that load, never replaces one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-arazzo-'));
    const store = WorkspaceStore.create(join(dir, 'ws'), 'Arazzo');
    mkdirSync(join(store.root, 'specs'), { recursive: true });
    writeFileSync(join(store.root, 'specs', 'pets.openapi.json'), JSON.stringify(openapi));
    const r = importIntoWorkspace(store, arazzo);
    expect(r.format).toBe('arazzo');
    expect(r.flows).toEqual([{ path: 'tests/arazzo/adoptpet.yaml', workflowId: 'adoptPet', steps: 4 }]);
    const again = importIntoWorkspace(store, arazzo);
    expect(again.flows![0]!.path).toBe('tests/arazzo/adoptpet-2.yaml');
    const tests = [];
    for await (const t of loadTestsFromFile(join(store.root, 'tests', 'arazzo', 'adoptpet.yaml'))) tests.push(t);
    expect(tests.map((t) => t.id)).toEqual(['login', 'addPet', 'getPet', 'removePet']);
    expect(tests[0]!.skip).toBeFalsy();

    // export from the workspace finds the same OpenAPI document from the file's comments
    const ex = exportArazzoFromWorkspace(store, 'arazzo/adoptpet.yaml');
    expect(ex.file).toBe('tests/arazzo/adoptpet.yaml');
    expect(ex.document.workflows[0].steps[0].operationId).toBe('login');
    // a flow without marks is matched against the workspace's specs
    writeFileSync(join(store.root, 'tests', 'plain.yaml'), 'tests:\n  - id: list\n    method: GET\n    url: "{{baseUrl}}/pets?limit=2"\n    assertions: [{ type: status, expected: 200 }]\n');
    const plain = exportArazzoFromWorkspace(store, 'tests/plain.yaml');
    expect(plain.document.workflows[0].steps[0]).toMatchObject({
      stepId: 'list',
      operationId: 'listPets',
      parameters: [{ name: 'limit', in: 'query', value: '2' }],
      successCriteria: [{ condition: '$statusCode == 200' }],
    });
    expect(plain.document.sourceDescriptions[0].url).toBe('./specs/pets.openapi.json');
    expect(readFileSync(join(store.root, 'tests', 'arazzo', 'adoptpet.yaml'), 'utf8')).toMatch(/arazzo-workflow/);
  });
});

describe('Arazzo export', () => {
  const source = { name: 'pets', url: './pets.json', type: 'openapi', doc: openapi };

  it('turns a flow file into a workflow: operations, parameters, bodies, outputs, criteria, inputs', () => {
    const flow = `name: Pets flow
expose:
  tool: pets_flow
  inputs:
    - { name: user, description: Who }
tests:
  - id: list
    method: GET
    url: "https://pets.example.com/v1/pets"
    params: { limit: "{{limit}}" }
    extract: { firstId: "$[0].id", list_count: $.length, odd: "$..x" }
    assertions:
      - { type: status, expected: 200 }
      - { type: latency, max: 500 }
  - id: get
    dependsOn: list
    method: GET
    url: "{{baseUrl}}/pets/{{firstId}}"
    headers: { X-User: "user {{user}}" }
    retries: 3
    if: status == 200
  - id: other
    method: POST
    url: https://elsewhere.example.com/x
    json: { a: 1 }
  - id: wait
    type: delay
    ms: 100
output: { first: "{{firstId}}" }
`;
    const r = exportArazzo(flow, { file: 'tests/pets.yaml', sources: [source] });
    const wf = r.document.workflows[0];
    expect(r.document.arazzo).toBe('1.0.1');
    expect(wf.workflowId).toBe('pets');
    expect(wf.summary).toBe('Pets flow');
    expect(wf.inputs).toEqual({ type: 'object', properties: { user: { type: 'string', description: 'Who' }, limit: { type: 'string' } }, required: ['user'] });
    const [list, get, other, wait] = wf.steps;
    expect(list).toMatchObject({
      stepId: 'list',
      operationId: 'listPets',
      parameters: [{ name: 'limit', in: 'query', value: '$inputs.limit' }],
      outputs: { firstId: '$response.body#/0/id', count: '$response.body#/length', odd: { context: '$response.body', selector: '$..x', type: 'jsonpath' } },
      successCriteria: [{ condition: '$statusCode == 200' }],
      'x-testpion-assertions': [{ type: 'latency', max: 500 }],
    });
    expect(get).toMatchObject({
      operationId: 'getPet',
      parameters: [
        { name: 'petId', in: 'path', value: '$steps.list.outputs.firstId' },
        { name: 'X-User', in: 'header', value: 'user {$inputs.user}' },
      ],
      onFailure: [{ name: 'retry', type: 'retry', retryLimit: 3 }],
      'x-testpion': { if: 'status == 200' },
    });
    expect(other['x-testpion-request']).toMatchObject({ method: 'POST', url: 'https://elsewhere.example.com/x', body: { a: 1 } });
    expect(wait['x-testpion-step']).toMatchObject({ type: 'delay', ms: 100 });
    expect(wf.outputs).toEqual({ first: '$steps.list.outputs.firstId' });
    expect(r.notes.some((n) => /elsewhere/.test(n))).toBe(true);
    expect(r.text).toMatch(/^arazzo: 1\.0\.1/);
  });

  it('round trip: an imported Arazzo document exports to an equivalent one', () => {
    const imported = importArazzo(arazzo, { sources: { pets: openapi } });
    const back = exportArazzo(imported.flows[0]!.text, { sources: [{ ...source, url: './pets.openapi.json' }] }).document;
    const orig = parse(arazzo);
    expect(back.sourceDescriptions).toEqual(orig.sourceDescriptions);
    const [wa, wb] = [orig.workflows[0], back.workflows[0]];
    expect(wb.workflowId).toBe(wa.workflowId);
    expect(wb.summary).toBe(wa.summary);
    expect(Object.keys(wb.inputs.properties)).toEqual(Object.keys(wa.inputs.properties));
    expect(wb.inputs.required).toEqual(wa.inputs.required);
    expect(wb.inputs.properties.password.default).toBe('secret');
    expect(wb.outputs).toEqual(wa.outputs);
    expect(wb.steps.map((s: any) => s.stepId)).toEqual(wa.steps.map((s: any) => s.stepId));
    // the same operation (operationId, or an operationPath to an operation without one)
    const target = (s: any) => s.operationId?.replace(/^\$sourceDescriptions\.pets\./, '') ?? s.operationPath;
    const resolved = (s: any) => (s.operationPath === '{$sourceDescriptions.pets.url}#/paths/~1pets~1{petId}/get' ? 'getPet' : target(s));
    expect(wb.steps.map(resolved)).toEqual(wa.steps.map(resolved));
    const params = (s: any) => (s.parameters ?? []).map((p: any) => `${p.in}:${p.name}=${String(p.value)}`).sort();
    expect(wb.steps.map(params)).toEqual(wa.steps.map(params));
    expect(wb.steps.map((s: any) => s.requestBody?.payload)).toEqual(wa.steps.map((s: any) => s.requestBody?.payload));
    expect(wb.steps.map((s: any) => s.outputs)).toEqual(wa.steps.map((s: any) => s.outputs));
    expect(wb.steps[0].successCriteria).toEqual(wa.steps[0].successCriteria);
    expect(wb.steps[1].successCriteria).toEqual([{ condition: '$statusCode == 201' }, { condition: "$response.body#/name == 'Rex'" }, { condition: '$response.body#/id != null' }]);
    expect(wb.steps[2].successCriteria).toEqual([{ condition: '$statusCode >= 200 && $statusCode < 300' }, { condition: '$response.body#/tags/0 != null' }]);
    expect(wb.steps[1].onFailure).toEqual([{ name: 'retry', type: 'retry', retryLimit: 2 }]);
  });
});
