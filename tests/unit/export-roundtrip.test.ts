import { describe, it, expect } from 'vitest';
import {
  collectionToInsomniaV4,
  collectionToInsomniaV5,
  collectionToOpenCollection,
  collectionToOpenCollectionBundle,
  detectFormat,
  expandImportFiles,
  importDocument,
  retargetScript,
  SCHEMA_VERSION,
  type AuthConfig,
  type BodyConfig,
  type Collection,
  type CollectionNode,
  type Environment,
  type KeyValue,
  type SavedGraphQLRequest,
  type SavedHttpRequest,
} from '../../packages/core/src/index.js';

// Exports to Insomnia (v4 JSON and v5 YAML) and OpenCollection, and the round trip: import(export(c)) keeps what the format can hold.

/** A small deterministic generator, so the "property" test is the same on every run. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  return { int: (n: number) => Math.floor(next() * n), pick: <T,>(l: readonly T[]): T => l[Math.floor(next() * l.length)]!, bool: () => next() < 0.5 };
}

const AUTHS: AuthConfig[] = [
  { type: 'none' },
  { type: 'bearer', token: '{{token}}' },
  { type: 'basic', username: '{{user}}', password: '{{pass}}' },
  { type: 'apiKey', key: 'X-Key', value: '{{key}}', in: 'header' },
  { type: 'apiKey', key: 'k', value: 'v', in: 'query' },
  { type: 'digest', username: 'u', password: 'p' },
  { type: 'oauth2', grantType: 'client_credentials', tokenUrl: '{{host}}/token', clientId: 'cid', clientSecret: 'sec', scope: 'a b' },
  { type: 'oauth2', grantType: 'password', tokenUrl: '{{host}}/token', clientId: 'cid', username: 'u', password: 'p' },
  { type: 'awsv4', accessKey: 'AK', secretKey: 'SK', region: 'eu-west-1', service: 'execute-api' },
  { type: 'ntlm', username: 'u', password: 'p' },
];

function makeCollection(seed: number): Collection {
  const r = rng(seed);
  let n = 0;
  const id = (p: string) => `${p}-${seed}-${++n}`;
  const kvs = (count: number): KeyValue[] => Array.from({ length: count }, (_, i) => ({ key: `k${i}`, value: r.pick(['v', '{{var}}', 'a b', '1']), enabled: r.pick([true, true, false]) }));
  const body = (): BodyConfig | undefined =>
    r.pick<BodyConfig | undefined>([
      undefined,
      { type: 'json', content: '{"a": "{{x}}", "n": 1}' },
      { type: 'xml', content: '<a>{{x}}</a>' },
      { type: 'text', content: 'plain {{x}}' },
      { type: 'form-urlencoded', fields: kvs(2) },
      { type: 'multipart', fields: [{ key: 'f', value: 'text', kind: 'text', enabled: true }, { key: 'file', value: '/tmp/a.png', kind: 'file', enabled: true }] },
    ]);
  const request = (): SavedHttpRequest => ({
    kind: 'http',
    id: id('req'),
    name: `Request ${n}`,
    request: { method: r.pick(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']), url: '{{host}}/items/' + r.int(100), params: kvs(r.int(3)), headers: kvs(r.int(3)).map((h) => ({ ...h, key: `X-H${h.key}` })), body: body(), auth: r.pick<AuthConfig>([{ type: 'inherit' }, ...AUTHS]) },
    ...(r.bool() ? { preRequestScript: "tp.environment.set('seen', Date.now());" } : {}),
    ...(r.bool() ? { testScript: "tp.test('ok', () => tp.expect(tp.response.code).to.equal(200));\ntp.environment.set('last', tp.response.json().id);" } : {}),
    ...(r.bool() ? { description: 'Describes request ' + n } : {}),
  });
  const gql = (): SavedGraphQLRequest => ({ kind: 'graphql', id: id('gql'), name: `Query ${n}`, request: { endpoint: '{{host}}/graphql', query: 'query { patients { id name } }', variables: { first: 5 }, headers: [], auth: { type: 'inherit' } } });
  const items = (depth: number): CollectionNode[] =>
    Array.from({ length: 2 + r.int(3) }, (): CollectionNode => {
      if (depth < 2 && r.int(3) === 0) return { kind: 'folder', id: id('fld'), name: `Folder ${n}`, items: items(depth + 1), ...(r.bool() ? { auth: r.pick(AUTHS) } : {}), ...(r.bool() ? { headers: [{ key: 'X-Folder', value: 'f', enabled: true }] } : {}), ...(r.bool() ? { variables: [{ key: 'fv', value: '1', enabled: true }] } : {}), ...(r.bool() ? { description: 'A folder' } : {}) };
      return r.int(5) === 0 ? gql() : request();
    });
  return { schemaVersion: SCHEMA_VERSION, id: `col-${seed}`, name: `Collection ${seed}`, version: 1, variables: [{ key: 'host', value: 'https://api.example.test', enabled: true }, { key: 'var', value: 'x', enabled: true }], items: items(0), updatedAt: '2026-03-01T00:00:00.000Z', description: 'Round trip' };
}

const envs: Environment[] = [
  { id: 'dev', name: 'Dev', variables: [{ key: 'host', value: 'http://localhost:3000', enabled: true }, { key: 'token', value: 't', enabled: true }] },
  { id: 'prod', name: 'Prod', variables: [{ key: 'host', value: 'https://p.test', enabled: true }, { key: 'secretKey', value: '', secret: true, enabled: true }] },
];

/** An object without its empty values (an importer writes `clientSecret: ''` and `usePkce: false` for what the file did not say). */
function clean<T>(v: T): T {
  if (Array.isArray(v)) return v.map(clean) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as object).filter(([, x]) => x !== '' && x !== false && x !== undefined).map(([k, x]) => [k, clean(x)])) as T;
  return v;
}

/** What a request keeps through a round trip, as comparable data. */
function essence(n: CollectionNode): unknown {
  if (n.kind === 'folder') {
    return { folder: n.name, description: n.description, headers: n.headers?.map((h) => [h.key, h.value, h.enabled !== false]), auth: n.auth?.type === 'inherit' ? undefined : clean(n.auth), variables: n.variables?.map((v) => [v.key, v.value]), items: n.items.map(essence) };
  }
  if (n.kind === 'graphql') return { gql: n.name, endpoint: n.request.endpoint, query: n.request.query, variables: n.request.variables };
  const q = n.request;
  const auth = q.auth && q.auth.type !== 'inherit' ? clean(q.auth) : undefined;
  return {
    name: n.name,
    method: q.method,
    url: q.url,
    params: (q.params ?? []).map((p) => [p.key, p.value, p.enabled !== false]),
    headers: (q.headers ?? []).map((p) => [p.key, p.value, p.enabled !== false]),
    body: q.body,
    auth,
    description: n.description,
    pre: script(n.preRequestScript),
    post: script(n.testScript),
  };
}
/** A script without the marker line an importer adds. */
const script = (s: string | undefined) => (s ? s.replace(/^\/\/ (Insomnia|Bruno) script[^\n]*\n/, '').trim() : undefined);

/** Auth that the target format has no place for, exported as none. */
const mapAuthFor = (format: 'insomnia' | 'oc', a: AuthConfig | undefined) => a;
void mapAuthFor;

function stripAuth(e: unknown): unknown {
  return JSON.parse(JSON.stringify(e));
}

function roundTrip(c: Collection, how: 'v4' | 'v5' | 'oc-folder' | 'oc-bundle') {
  let text: string;
  let notes: string[];
  if (how === 'v4') ({ text, notes } = collectionToInsomniaV4(c, envs));
  else if (how === 'v5') ({ text, notes } = collectionToInsomniaV5(c, envs));
  else if (how === 'oc-bundle') ({ text, notes } = collectionToOpenCollectionBundle(c, envs));
  else {
    const r = collectionToOpenCollection(c, envs);
    notes = r.notes;
    const { inputs } = expandImportFiles(r.files.map((f) => ({ path: `Out/${f.path}`, data: f.text })));
    expect(inputs).toHaveLength(1);
    text = inputs[0]!.text;
  }
  return { ...importDocument(text), text, notes, format: detectFormat(text) };
}

describe('export to Insomnia and OpenCollection', () => {
  const c = makeCollection(7);
  for (const how of ['v4', 'v5', 'oc-folder', 'oc-bundle'] as const)
    it(`${how}: detected as its own format, and the collection comes back`, () => {
      const r = roundTrip(c, how);
      expect(r.format).toBe(how.startsWith('oc') ? 'opencollection' : 'insomnia');
      expect(r.document.collections[0]!.items.length).toBe(c.items.length);
      expect(r.document.environments.map((e) => e.name).sort()).toEqual(how.startsWith('oc') ? ['Dev', 'Prod'] : ['Dev', 'Prod']);
    });
  it('Insomnia gets {{ _.x }} and tags, and insomnia.* scripts; the file says what it could not carry', () => {
    const col: Collection = { ...c, items: [{ kind: 'http', id: 'r1', name: 'T', request: { method: 'GET', url: '{{host}}/{{$guid}}/{{$randomFirstName}}', headers: [{ key: 'X', value: '{{$timestamp}}', enabled: true }] }, testScript: "tp.test('a', () => tp.expect(tp.globals.get('g')).to.equal(1));", assertions: [{ type: 'status', expected: 200 }], examples: [{ id: 'e', name: 'ok', status: 200, headers: [], body: '{}' }] }] };
    const r = collectionToInsomniaV5(col, []);
    expect(r.text).toContain("{{ _.host }}/{% uuid 'v4' %}/{% faker 'randomFirstName' %}");
    expect(r.text).toContain('insomnia.test');
    expect(r.text).not.toMatch(/\btp\./);
    expect(r.text).toContain("insomnia.expect(insomnia.response.code).to.equal(200)");
    expect(r.notes.join('\n')).toMatch(/insomnia\.globals has no Insomnia equivalent/);
    expect(r.notes.join('\n')).toMatch(/saved example/);
  });
  it('the collection auth, headers and scripts are copied onto the top-level items for Insomnia', () => {
    const col: Collection = { ...c, auth: { type: 'bearer', token: 'T' }, headers: [{ key: 'X-All', value: '1', enabled: true }], items: [{ kind: 'http', id: 'r1', name: 'Only', request: { method: 'GET', url: 'https://a.test', auth: { type: 'inherit' } } }] };
    const back = importDocument(collectionToInsomniaV5(col).text).document.collections[0]!;
    const req = back.items[0] as SavedHttpRequest;
    expect(req.request.auth).toEqual({ type: 'bearer', token: 'T' });
    expect(req.request.headers).toEqual([{ key: 'X-All', value: '1', enabled: true }]);
  });
  it('OpenCollection keeps the status check as an assertion and the others as tests', () => {
    const col: Collection = { ...c, items: [{ kind: 'http', id: 'r1', name: 'A', request: { method: 'GET', url: 'https://a.test' }, assertions: [{ type: 'status', expected: 201 }, { type: 'latency', max: 300 }] }] };
    const files = collectionToOpenCollection(col).files;
    const req = files.find((f) => f.path === 'a.yml')!.text;
    expect(req).toContain('expression: res.status');
    expect(req).toContain('tp.response.responseTime'.replace('tp.response.responseTime', 'res.responseTime'));
  });
  it('retargetScript renames the sandbox global and leaves a local tp alone', () => {
    const r = retargetScript("const a = tp.environment.get('x');\nfunction f(tp) { return tp.value; }\nconsole.log('tp.x', pm.info.requestName);", 'insomnia');
    expect(r.code).toBe("const a = insomnia.environment.get('x');\nfunction f(tp) { return tp.value; }\nconsole.log('tp.x', insomnia.info.requestName);");
    expect(retargetScript('tp.execution.setNextRequest(null); tp.iterationData.get(1)', 'insomnia').unsupported.sort()).toEqual(['insomnia.execution', 'insomnia.iterationData']);
  });
});

describe('round trip: import(export(c)) keeps what the format holds', () => {
  const seeds = Array.from({ length: 30 }, (_, i) => i + 1);
  // auth Insomnia / OpenCollection hold: all of AUTHS (JWT / EdgeGrid are not generated)
  for (const how of ['v4', 'v5', 'oc-folder', 'oc-bundle'] as const)
    it(`${how}: 30 generated collections`, () => {
      for (const seed of seeds) {
        const c = makeCollection(seed);
        const r = roundTrip(c, how);
        const got = r.document.collections[0]!;
        // (the collection's own settings are copied onto top-level items for Insomnia: compare the requests below)
        const strip = (e: unknown) => stripAuth(e);
        // (an OpenCollection folder lists its requests before its sub-folders)
        const arrange = (nodes: CollectionNode[]): CollectionNode[] => (how === 'oc-folder' ? [...nodes.filter((n) => n.kind !== 'folder'), ...nodes.filter((n) => n.kind === 'folder').map((f) => ({ ...f, items: arrange((f as { items: CollectionNode[] }).items) }) as CollectionNode)] : nodes);
        const want = arrange(c.items).map(essence);
        const have = got.items.map(essence);
        expect(strip(have), `seed ${seed} (${how})`).toEqual(strip(want));
        expect(got.name).toBe(c.name);
        // (Insomnia's collection variables are its base environment, merged into each environment)
        if (how.startsWith('oc')) expect(got.variables.map((v) => [v.key, v.value])).toEqual(c.variables.map((v) => [v.key, v.value]));
        else expect(r.document.environments.find((e) => e.name === 'Dev')!.variables.map((v) => [v.key, v.value])).toEqual([['var', 'x'], ['host', 'http://localhost:3000'], ['token', 't']]);
      }
    });
});
