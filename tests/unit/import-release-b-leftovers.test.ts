import { describe, it, expect } from 'vitest';
import { expandImportFiles, importDocument, runScript, convertScript, type CollectionNode, type SavedHttpRequest } from '../../packages/core/src/index.js';

// Import compatibility B-23b: what release A left (Insomnia unit tests and cookie jar, Bruno examples / gRPC / WebSocket,
// the req.setTimeout and getProcessEnv lifts, Hoppscotch pw.* and environments, the sandbox equivalents).

const flat = (nodes: CollectionNode[]): CollectionNode[] => nodes.flatMap((n) => (n.kind === 'folder' ? [n, ...flat(n.items)] : [n]));
const http = (nodes: CollectionNode[], name: string) => flat(nodes).find((n) => n.name === name) as SavedHttpRequest;

describe('Insomnia unit tests and the cookie jar', () => {
  const v4 = JSON.stringify({
    _type: 'export',
    __export_format: 4,
    resources: [
      { _id: 'wrk_1', _type: 'workspace', name: 'Clinic', parentId: null },
      { _id: 'req_1', _type: 'request', parentId: 'wrk_1', name: 'Get dog', method: 'GET', url: 'https://a.test/dogs/1', metaSortKey: 1 },
      { _id: 'uts_1', _type: 'unit_test_suite', parentId: 'wrk_1', name: 'Dogs' },
      { _id: 'ut_1', _type: 'unit_test', parentId: 'uts_1', name: 'Returns the dog', requestId: 'req_1', code: "const response = await insomnia.send();\nexpect(response.status).to.equal(200);\nconst body = JSON.parse(response.data);\nexpect(body.name).to.equal('Rex');" },
      { _id: 'ut_2', _type: 'unit_test', parentId: 'uts_1', name: 'Orphan', requestId: 'req_gone', code: 'expect(1).to.equal(1);' },
      { _id: 'jar_1', _type: 'cookie_jar', parentId: 'wrk_1', cookies: [{ key: 'session', value: 'abc', domain: '.a.test', path: '/', secure: true, httpOnly: true, expires: '2030-01-01T00:00:00.000Z' }, { key: 'pref', value: 'dark', domain: 'a.test', path: '/', hostOnly: true, expires: null }] },
    ],
  });
  const { document: doc, report } = importDocument(v4);
  it('a unit test becomes a test of the request it sends and runs after the request', async () => {
    const req = http(doc.collections[0]!.items, 'Get dog');
    expect(req.testScript).toContain('tp.test("Dogs: Returns the dog"');
    expect(req.testScript).not.toMatch(/^\/\/ Insomnia script/m);
    const out = await runScript(req.testScript!, { response: { status: 200, headers: [['content-type', 'application/json']], body: '{"name":"Rex"}', time: 5 } });
    expect(out.error).toBeUndefined();
    expect(out.tests).toEqual([expect.objectContaining({ name: 'Dogs: Returns the dog', passed: true })]);
    const failing = await runScript(req.testScript!, { response: { status: 404, headers: [], body: '{}', time: 5 } });
    expect(failing.tests[0]!.passed).toBe(false);
  });
  it('a test with no request in the file is reported', () => {
    expect(report.findings.some((f) => /Orphan/.test(f.message) && f.severity === 'not-imported')).toBe(true);
  });
  it('the cookie jar becomes cookies for the workspace jar', () => {
    expect(doc.cookies).toEqual([
      { name: 'session', value: 'abc', domain: '.a.test', path: '/', expires: '2030-01-01T00:00:00.000Z', secure: true, httpOnly: true },
      { name: 'pref', value: 'dark', domain: 'a.test', path: '/', hostOnly: true },
    ]);
  });
  it('the v5 file has the same two', () => {
    const v5 = [
      'type: collection.insomnia.rest/5.0',
      'name: Clinic',
      'collection:',
      '  - name: Get dog',
      '    url: https://a.test/dogs/1',
      '    method: GET',
      '    meta:',
      '      id: req_1',
      'cookieJar:',
      '  name: Default Jar',
      '  cookies:',
      '    - key: s',
      '      value: v',
      '      domain: a.test',
      '      path: /',
      'testSuites:',
      '  - name: Dogs',
      '    tests:',
      '      - name: ok',
      '        requestId: req_1',
      '        code: "expect(1).to.equal(1);"',
    ].join('\n');
    const d = importDocument(v5).document;
    expect(d.cookies).toHaveLength(1);
    expect(http(d.collections[0]!.items, 'Get dog').testScript).toContain('tp.test("Dogs: ok"');
  });
});

describe('Bruno response examples, gRPC and WebSocket requests', () => {
  const bru = (path: string, text: string) => ({ path, data: text });
  const files = [
    bru('bruno.json', '{"version":"1","name":"Pets","type":"collection"}'),
    bru(
      'Get pet.bru',
      `meta {
  name: Get pet
  type: http
  seq: 1
}

get {
  url: {{host}}/pets/1
  body: none
  auth: none
}

script:pre-request {
  req.setTimeout(5000);
  const key = bru.getProcessEnv('PET_KEY');
  req.setHeader('X-Key', key);
}

example {
  name: Found
  description: The pet exists
  request: {
    url: {{host}}/pets/1
    method: GET
    headers: {
      Accept: application/json
    }
  }
  response: {
    headers: {
      content-type: application/json
    }
    status: {
      code: 200
      text: OK
    }
    body: {
      type: json
      content: '''
        {"id":1,"name":"Rex"}
      '''
    }
  }
}
`,
    ),
    bru(
      'Say hello.bru',
      `meta {
  name: Say hello
  type: grpc
  seq: 2
}

grpc {
  url: grpc://localhost:50051
  method: /helloworld.Greeter/SayHello
  methodType: unary
}

metadata {
  x-trace: 1
}

body:grpc {
  name: message 1
  content: '''
    {"name":"Rex"}
  '''
}
`,
    ),
    bru(
      'Feed.bru',
      `meta {
  name: Feed
  type: ws
  seq: 3
}

ws {
  url: wss://example.test/feed
}

body:ws {
  name: message 1
  type: json
  content: '''
    {"subscribe":"pets"}
  '''
}
`,
    ),
  ];
  const { inputs } = expandImportFiles(files, { folderName: 'Pets' });
  const { document: doc, report } = importDocument(inputs[0]!.text);
  it('examples come over with their request and response', () => {
    const pet = http(doc.collections[0]!.items, 'Get pet');
    expect(pet.examples).toEqual([
      expect.objectContaining({ name: 'Found', status: 200, statusText: 'OK', body: '{"id":1,"name":"Rex"}', headers: [{ key: 'content-type', value: 'application/json' }], request: expect.objectContaining({ method: 'GET', url: '{{host}}/pets/1' }) }),
    ]);
  });
  it('gRPC and WebSocket requests become library items of the collection', () => {
    const saved = doc.savedItems as { grpc: Array<{ name: string; data: Record<string, unknown> }>; websocket: Array<{ name: string; data: Record<string, unknown> }> };
    expect(saved.grpc[0]).toMatchObject({ name: 'Say hello', data: { target: 'localhost:50051', method: 'helloworld.Greeter/SayHello', message: '{"name":"Rex"}', tls: false } });
    expect(saved.websocket[0]).toMatchObject({ name: 'Feed', data: { url: 'wss://example.test/feed', message: '{"subscribe":"pets"}' } });
    expect(doc.collections[0]!.items.map((n) => n.name)).toEqual(['Get pet']);
    expect(report.findings.some((f) => /gRPC request came over as a gRPC call without its .proto/.test(f.message))).toBe(true);
  });
  it('req.setTimeout moves to the request settings, getProcessEnv names a value to enter, req.* is tp.*', () => {
    const pet = http(doc.collections[0]!.items, 'Get pet');
    expect(pet.request.settings).toEqual({ timeoutMs: 5000 });
    expect(pet.preRequestScript!.replace(/^\/\/.*$/gm, '')).not.toMatch(/\breq\./);
    expect(pet.preRequestScript).toContain("tp.request.headers.upsert({ key: 'X-Key', value: key })");
    expect(pet.preRequestScript).toContain("tp.variables.get('PET_KEY')");
    expect(report.findings.some((f) => f.code === 'VALUE_NEEDED' && /PET_KEY/.test(f.message))).toBe(true);
    expect(report.findings.some((f) => f.code === 'SCRIPT_LIFT')).toBe(true);
  });
});

describe('Hoppscotch pw.* / hopp.* scripts and environments', () => {
  const collection = JSON.stringify({
    v: 6,
    name: 'Hopp',
    folders: [],
    headers: [{ key: 'X-Team', value: 'vets', active: true }],
    variables: [{ key: 'region', value: 'eu' }],
    requests: [
      {
        v: '15',
        name: 'Check',
        method: 'GET',
        endpoint: '<<base>>/x',
        params: [],
        headers: [],
        auth: { authType: 'none', authActive: true },
        body: { contentType: null, body: null },
        requestVariables: [{ key: 'id', value: '7', active: true }],
        preRequestScript: 'pw.env.set("stamp", "1");',
        testScript: [
          'pw.test("status is 200", () => { pw.expect(pw.response.status).toBe(200); });',
          'pw.test("2xx", () => { pw.expect(pw.response.status).toBeLevel2xx(); });',
          'pw.test("not found is false", () => { pw.expect(pw.response.status).not.toBe(404); });',
          'pw.test("body", () => { pw.expect(pw.response.body.name).toBe("Rex"); pw.expect(pw.response.body.tags).toHaveLength(2); });',
          'pw.test("type", () => { pw.expect(pw.response.body.id).toBeType("number"); });',
          'hopp.test("new api", () => { hopp.expect(hopp.response.statusCode).toBe(200); hopp.env.active.set("seen", hopp.response.asJSON().name); });',
          'pm.test("layer", () => { pm.expect(pm.response.code).to.eql(200); });',
        ].join('\n'),
      },
    ],
  });
  const { document: doc } = importDocument(collection);
  it('scripts become tp.* (matchers as chai), request variables become lines, collection headers and variables stay', async () => {
    const req = http(doc.collections[0]!.items, 'Check');
    expect(req.preRequestScript).toContain('tp.variables.set("id", "7");');
    expect(req.preRequestScript).toContain('tp.environment.set("stamp", "1");');
    expect(req.testScript).toContain('tp.expect(tp.response.code).to.equal(200)');
    expect(req.testScript).toContain('to.be.within(200, 299)');
    expect(req.testScript).toContain('.not.to.equal(404)');
    expect(req.testScript).toContain('tp.expect(tp.response.json().tags).to.have.lengthOf(2)');
    expect(req.testScript).toContain('to.be.a("number")');
    expect(req.testScript).toContain('tp.environment.set("seen", tp.response.json().name)');
    expect(req.testScript).not.toMatch(/\b(pw|hopp|pm)\./);
    expect(doc.collections[0]!.headers).toEqual([{ key: 'X-Team', value: 'vets', enabled: true }]);
    expect(doc.collections[0]!.variables).toEqual([{ key: 'region', value: 'eu', enabled: true }]);
    const out = await runScript(req.testScript!, { response: { status: 200, headers: [], body: '{"id":3,"name":"Rex","tags":["a","b"]}', time: 5 } });
    expect(out.error).toBeUndefined();
    expect(out.tests.every((t) => t.passed)).toBe(true);
    expect(out.tests).toHaveLength(7);
  });
  it('environments import with their secret flags', () => {
    const envs = JSON.stringify([
      { v: 2, id: 'e1', name: 'Prod', variables: [{ key: 'host', initialValue: 'https://p.test', currentValue: 'https://p.test', secret: false }, { key: 'token', initialValue: '', currentValue: '', secret: true }] },
      { v: 2, id: 'e2', name: 'Dev', variables: [{ key: 'host', initialValue: 'http://d.test', currentValue: 'http://d.test', secret: false }, { key: 'key', initialValue: 'k', currentValue: 'k', secret: true }] },
    ]);
    const { document: d, report } = importDocument(envs);
    expect(d.environments.map((e) => e.name)).toEqual(['Prod', 'Dev']);
    expect(d.environments[0]!.variables).toEqual([{ key: 'host', value: 'https://p.test', enabled: true }, { key: 'token', value: '', secret: true, enabled: true }]);
    expect(d.secretValues).toEqual({ dev: { key: 'k' } });
    expect(report.findings.some((f) => f.code === 'VALUE_NEEDED' && /token/.test(f.message))).toBe(true);
  });
});

describe('the sandbox has equivalents', () => {
  it('bru.sendRequest imports as an adapter over tp.sendRequest', () => {
    const r = convertScript("const res = await bru.sendRequest({ url: 'https://x.test', method: 'POST', data: { a: 1 } });\ntp.environment.set('s', res.status);", 'bruno');
    expect(r.code).not.toContain('bru.');
    expect(r.code).toContain('tp.sendRequest');
    expect(r.findings).toEqual([]);
  });
  it('tp.state keeps values as globals named state.<key>', async () => {
    const out = await runScript("tp.state.set('visits', 3); tp.test('read', () => tp.expect(tp.state.get('visits')).to.equal(3)); tp.test('has', () => tp.expect(tp.state.has('nope')).to.equal(false));", {});
    expect(out.error).toBeUndefined();
    expect(out.scopeSets.globals).toEqual({ 'state.visits': 3 });
    expect(out.tests.map((t) => t.passed)).toEqual([true, true]);
    const persisted = await runScript("tp.test('persisted', () => tp.expect(tp.state.get('visits')).to.equal(3)); tp.state.clear();", { globals: { 'state.visits': 3, other: 1 } });
    expect(persisted.tests[0]!.passed).toBe(true);
    expect(persisted.scopeUnsets.globals).toEqual(['state.visits']);
  });
  it("Bruno's cookie jar methods answer promises over the same jar", async () => {
    const out = await runScript("(async () => { const jar = tp.cookies.jar(); await jar.setCookie('https://a.test/', 'k', 'v'); const c = await jar.getCookie('https://a.test/', 'k'); tp.environment.set('got', c.value); })();", {});
    expect(out.error).toBeUndefined();
    expect(out.scopeSets.environment).toEqual({ got: 'v' });
  });
  it('pm.datasets and pm.mock stay findings with a way forward', () => {
    const r = convertScript("pm.datasets.query('select 1'); pm.mock.match('x');", 'postman');
    expect(r.findings.map((f) => f.api)).toEqual(['pm.datasets', 'pm.mock']);
    expect(r.findings[0]!.message).toMatch(/iterationData/);
    expect(r.findings[1]!.message).toMatch(/mock server/);
  });
});
