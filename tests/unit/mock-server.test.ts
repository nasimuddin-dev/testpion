import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bodyMatch, collectMockRoutes, matchMockRoute, mockPathOf, startMockServer, type Collection, type MockServer } from '../../packages/core/src/index.js';

const collection: Collection = {
  schemaVersion: '1.0',
  id: 'c',
  name: 'Pets',
  version: 1,
  variables: [],
  updatedAt: '',
  items: [
    {
      kind: 'folder',
      id: 'f',
      name: 'Pets',
      items: [
        {
          kind: 'http',
          id: 'get',
          name: 'Get pet',
          request: { method: 'GET', url: '{{baseUrl}}/pets/:id' },
          examples: [
            { id: 'e1', name: 'Found', status: 200, statusText: 'OK', headers: [{ key: 'Content-Type', value: 'application/json' }, { key: 'Content-Length', value: '999' }], body: '{"id":1}' },
            { id: 'e2', name: 'Missing', status: 404, headers: [], body: '{"error":"not_found"}', request: { method: 'GET', url: '{{baseUrl}}/pets/999' } },
          ],
        },
        {
          kind: 'http',
          id: 'list',
          name: 'List pets',
          request: { method: 'GET', url: 'https://api.example.com/v1/pets?species=cat' },
          examples: [
            { id: 'e3', name: 'Cats', status: 200, headers: [], body: '["cat"]' },
            { id: 'e4', name: 'Dogs', status: 200, headers: [], body: '["dog"]', request: { method: 'GET', url: 'https://api.example.com/v1/pets?species=dog' } },
          ],
        },
        { kind: 'http', id: 'create', name: 'Create pet', request: { method: 'POST', url: '{{baseUrl}}/pets' } },
      ],
    },
  ],
};

describe('mock routes', () => {
  it('turns saved URLs into paths', () => {
    expect(mockPathOf('{{baseUrl}}/pets/:id?x=1&y=a+b')).toEqual({ path: '/pets/:id', query: { x: '1', y: 'a b' } });
    expect(mockPathOf('https://api.example.com/v1/pets/')).toEqual({ path: '/v1/pets', query: {} });
    expect(mockPathOf('api.example.com/v1')).toEqual({ path: '/v1', query: {} });
  });

  it('collects one route per example, skipping requests without examples', () => {
    const routes = collectMockRoutes(collection);
    expect(routes.map((r) => `${r.method} ${r.path} ${r.example.name}`)).toEqual(['GET /pets/:id Found', 'GET /pets/999 Missing', 'GET /v1/pets Cats', 'GET /v1/pets Dogs']);
  });

  it('prefers literal paths, then query matches, then 2xx; headers pick an example', () => {
    const routes = collectMockRoutes(collection);
    const m = (path: string, query?: Record<string, string>, headers?: Record<string, string>) => matchMockRoute(routes, { method: 'GET', path, query, headers })?.example.name;
    expect(m('/pets/1')).toBe('Found');
    expect(m('/pets/999')).toBe('Missing');
    expect(m('/v1/pets', { species: 'dog' })).toBe('Dogs');
    expect(m('/v1/pets', { species: 'cat' })).toBe('Cats');
    expect(m('/pets/1', {}, { 'x-mock-response-code': '404' })).toBe('Missing');
    expect(m('/pets/1', {}, { 'x-mock-response-name': 'missing' })).toBe('Missing');
    expect(m('/nope')).toBeUndefined();
    expect(matchMockRoute(routes, { method: 'POST', path: '/pets/1' })).toBeUndefined();
  });

  it('lets a saved id answer other ids when nothing matches exactly', () => {
    const routes = collectMockRoutes({ ...collection, items: [{ kind: 'http', id: 'x', name: 'x', request: { method: 'GET', url: '/patients/1' }, examples: [{ id: 'a', name: 'one', status: 200, headers: [], body: '1' }] }] });
    expect(matchMockRoute(routes, { method: 'GET', path: '/patients/7' })?.example.name).toBe('one');
    expect(matchMockRoute(routes, { method: 'GET', path: '/owners/7' })).toBeUndefined();
  });
});

describe('mock server', () => {
  let mock: MockServer;
  const seen: string[] = [];
  beforeAll(async () => {
    mock = await startMockServer(collection, { onRequest: (e) => seen.push(`${e.status} ${e.example ?? '-'}`) });
  });
  afterAll(() => mock.close());

  it('serves examples with their status, headers and body', async () => {
    const r = await fetch(`${mock.url}/pets/7`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/json');
    expect(r.headers.get('x-mock-example')).toBe('Found');
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(await r.json()).toEqual({ id: 1 });
    const missing = await fetch(`${mock.url}/pets/7`, { headers: { 'x-mock-response-code': '404' } });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found' });
  });

  it('answers unknown routes with 404 and the list of routes, and picks up changes', async () => {
    const r = await fetch(`${mock.url}/owners`);
    expect(r.status).toBe(404);
    expect((await r.json()).available).toContain('GET /pets/:id → 200 Found');
    mock.update({ ...collection, items: [] });
    expect((await fetch(`${mock.url}/pets/1`)).status).toBe(404);
    expect(seen).toEqual(['200 Found', '404 Missing', '404 -', '404 -']);
  });

  it('only listens on localhost', async () => {
    await expect(startMockServer(collection, { host: '0.0.0.0' })).rejects.toThrow(/localhost/);
  });
});

describe('mock server: matching on the request body and headers', () => {
  const login: Collection = {
    schemaVersion: '1.0',
    id: 'l',
    name: 'Auth',
    version: 1,
    variables: [],
    updatedAt: '',
    items: [
      {
        kind: 'http',
        id: 'login',
        name: 'Login',
        request: { method: 'POST', url: '{{baseUrl}}/login' },
        examples: [
          { id: 'ok', name: 'Success', status: 200, headers: [], body: '{"token":"t"}', request: { method: 'POST', url: '{{baseUrl}}/login', body: '{"user":"ann","password":"right"}', headers: [{ key: 'X-Tenant', value: 'a' }] } },
          { id: 'bad', name: 'Wrong password', status: 401, headers: [], body: '{"error":"invalid"}', request: { method: 'POST', url: '{{baseUrl}}/login', body: '{"user":"ann","password":"wrong"}', headers: [{ key: 'X-Tenant', value: 'b' }] } },
          { id: 'form', name: 'Form login', status: 200, headers: [], body: 'ok', request: { method: 'POST', url: '{{baseUrl}}/login', body: 'user=bob&password=x' } },
        ],
      },
    ],
  };
  const routes = collectMockRoutes(login);
  const pick = (body?: string, headers: Record<string, string> = {}) => matchMockRoute(routes, { method: 'POST', path: '/login', body, headers })?.example.name;

  it('compares bodies: equal, JSON subset, form fields in any order', () => {
    expect(bodyMatch('{"a":1,"b":[1,2]}', '{ "b": [1,2], "a": 1 }')).toBe('equal');
    expect(bodyMatch('{"user":"ann"}', '{"user":"ann","extra":true}')).toBe('subset');
    expect(bodyMatch('{"user":"ann"}', '{"user":"bob"}')).toBe('differs');
    expect(bodyMatch('a=1&b=2', 'b=2&a=1')).toBe('equal');
    expect(bodyMatch(undefined, '{}')).toBe('none');
  });

  it('picks the example whose saved body matches the request', () => {
    expect(pick('{"password":"wrong","user":"ann"}')).toBe('Wrong password');
    expect(pick('{"user":"ann","password":"right","remember":true}')).toBe('Success');
    expect(pick('password=x&user=bob')).toBe('Form login');
  });

  it('honours x-mock-match-request-body and x-mock-match-request-headers', () => {
    expect(pick('{"user":"zed"}', { 'x-mock-match-request-body': 'true' })).toBeUndefined();
    expect(pick('{"user":"zed"}')).toBeDefined(); // without the header the best guess still answers
    expect(pick('{"user":"ann","password":"right"}', { 'x-mock-match-request-headers': 'x-tenant', 'x-tenant': 'b' })).toBe('Wrong password');
  });

  it('reads the body over HTTP', async () => {
    const m = await startMockServer(login, { port: 0 });
    try {
      const r = await fetch(`${m.url}/login`, { method: 'POST', body: '{"user":"ann","password":"wrong"}', headers: { 'content-type': 'application/json' } });
      expect(r.status).toBe(401);
      expect(r.headers.get('x-mock-example')).toBe('Wrong%20password');
    } finally {
      await m.close();
    }
  });

  it('a stateful mock: POST creates, GET returns it (the list example seeds), PATCH changes, DELETE removes; a POST with no resource goes to the examples', async () => {
    const stateful: Collection = {
      ...collection,
      items: [
        { kind: 'http', id: 'list2', name: 'List pets', request: { method: 'GET', url: '{{baseUrl}}/pets' }, examples: [{ id: 'l', name: 'All', status: 200, headers: [], body: '[{"id":1,"name":"Rex"},{"id":2,"name":"Tom"}]' }] },
        { kind: 'http', id: 'login', name: 'Log in', request: { method: 'POST', url: '{{baseUrl}}/login' }, examples: [{ id: 'ok', name: 'Success', status: 200, headers: [], body: '{"token":"t"}' }] },
      ],
    };
    const m = await startMockServer(stateful, { stateful: true });
    try {
      const j = async (method: string, path: string, body?: unknown) => {
        const r = await fetch(m.url + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: r.status, state: r.headers.get('x-mock-state'), location: r.headers.get('location'), body: r.status === 204 ? undefined : await r.json() };
      };
      expect((await j('GET', '/pets')).body).toEqual([{ id: 1, name: 'Rex' }, { id: 2, name: 'Tom' }]);
      const created = await j('POST', '/pets', { name: 'Fluffy' });
      expect(created).toMatchObject({ status: 201, state: '/pets', location: '/pets/3', body: { id: 3, name: 'Fluffy' } });
      expect((await j('GET', '/pets')).body).toHaveLength(3);
      expect((await j('GET', '/pets/3')).body).toEqual({ id: 3, name: 'Fluffy' });
      expect((await j('PATCH', '/pets/3', { name: 'Fluff' })).body).toEqual({ id: 3, name: 'Fluff' });
      expect((await j('PUT', '/pets/1', { name: 'Rexy', age: 4 })).body).toEqual({ id: 1, name: 'Rexy', age: 4 });
      expect((await j('DELETE', '/pets/2')).status).toBe(204);
      expect((await j('GET', '/pets/2')).status).toBe(404);
      expect((await j('GET', '/pets')).body.map((p: { id: number }) => p.id)).toEqual([1, 3]);
      expect(m.state!.snapshot()).toEqual({ '/pets': [{ id: 1, name: 'Rexy', age: 4 }, { id: 3, name: 'Fluff' }] });
      // not a resource: the examples answer, as always
      expect(await j('POST', '/login', { user: 'a' })).toMatchObject({ status: 200, state: null, body: { token: 't' } });
      m.state!.reset();
      expect((await j('GET', '/pets')).body).toHaveLength(2);
      // a request that carries x-mock-state-reset: true starts from the examples again (a suite's first request)
      await j('POST', '/pets', { name: 'Again' });
      expect((await j('GET', '/pets')).body).toHaveLength(3);
      const r = await fetch(m.url + '/pets', { headers: { 'x-mock-state-reset': 'true' } });
      expect((await r.json()).length).toBe(2);

    } finally {
      await m.close();
    }
  });

  it('forwards requests without an example to a fallback API (partial mocking)', async () => {
    const { createServer } = await import('node:http');
    const real = createServer((req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ real: true, path: req.url, method: req.method })));
    await new Promise<void>((r) => real.listen(0, '127.0.0.1', r));
    const realUrl = `http://127.0.0.1:${(real.address() as { port: number }).port}`;
    const c: Collection = {
      schemaVersion: '1.0',
      id: 'fb',
      name: 'Fallback',
      version: 1,
      variables: [],
      updatedAt: new Date(0).toISOString(),
      items: [{ kind: 'http', id: 'r', name: 'Mocked', request: { method: 'GET', url: '{{baseUrl}}/mocked' }, examples: [{ id: 'e', name: 'ok', status: 200, headers: [], body: '{"mock":true}' }] }],
    };
    const events: Array<{ path: string; forwarded?: boolean }> = [];
    const m = await startMockServer(c, { fallbackUrl: realUrl, onRequest: (e) => events.push(e) });
    try {
      expect(await (await fetch(`${m.url}/mocked`)).json()).toEqual({ mock: true });
      const f = await fetch(`${m.url}/live?x=1`, { method: 'POST', body: 'hi' });
      expect(f.headers.get('x-mock-forwarded')).toBe('true');
      expect(await f.json()).toEqual({ real: true, path: '/live?x=1', method: 'POST' });
      expect(events.map((e) => [e.path, !!e.forwarded])).toEqual([
        ['/mocked', false],
        ['/live', true],
      ]);
    } finally {
      await m.close();
      await new Promise<void>((r) => real.close(() => r()));
    }
  });

  it('fills dynamic variables in example bodies and headers on every response', async () => {
    const c: Collection = {
      schemaVersion: '1.0',
      id: 'dyn',
      name: 'Dyn',
      version: 1,
      variables: [],
      updatedAt: new Date(0).toISOString(),
      items: [
        {
          kind: 'http',
          id: 'r',
          name: 'User',
          request: { method: 'GET', url: '{{baseUrl}}/user' },
          examples: [{ id: 'e', name: 'ok', status: 200, headers: [{ key: 'X-Request-Id', value: '{{$guid}}', enabled: true }], body: '{"id":"{{$guid}}","name":"{{$randomFirstName}}","n":{{$randomInt(5,5)}},"keep":"{{notDynamic}}"}' }],
        },
      ],
    };
    const m = await startMockServer(c);
    try {
      const a = await fetch(`${m.url}/user`);
      const j = (await a.json()) as { id: string; name: string; n: number; keep: string };
      expect(j.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(j.name).toMatch(/^[A-Z]/);
      expect(j.n).toBe(5);
      expect(j.keep).toBe('{{notDynamic}}');
      expect(a.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
      const b = (await (await fetch(`${m.url}/user`)).json()) as { id: string };
      expect(b.id).not.toBe(j.id);
    } finally {
      await m.close();
    }
  });
});
