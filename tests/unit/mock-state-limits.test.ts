import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { MAX_STATE_BYTES, MAX_STATE_RECORDS, MockState, collectMockRoutes, startMockServer, type Collection } from '@testpion/core';

// The stateful mock keeps what clients create in memory: a cap per resource and on the whole, ids from a counter; and the
// answers of the real API (the fallback) are not readable by any web page.
const collection: Collection = {
  schemaVersion: '1.0',
  id: 'pets',
  name: 'Pets',
  version: 1,
  variables: [],
  updatedAt: new Date(0).toISOString(),
  items: [
    {
      kind: 'http',
      id: 'list',
      name: 'List pets',
      request: { method: 'GET', url: '{{baseUrl}}/pets' },
      examples: [{ id: 'l', name: 'All', status: 200, headers: [], body: '[{"id":1,"name":"Rex"},{"id":2,"name":"Tom"}]' }],
    },
    { kind: 'http', id: 'tags', name: 'List tags', request: { method: 'GET', url: '{{baseUrl}}/tags' }, examples: [{ id: 't', name: 'All', status: 200, headers: [], body: '[]' }] },
  ],
};
const routes = collectMockRoutes(collection);
const bodyOf = (a: { body?: string } | undefined) => JSON.parse(a?.body ?? 'null');

describe('stateful mock: limits', () => {
  it('has caps by default', () => {
    expect(MAX_STATE_RECORDS).toBe(10_000);
    expect(MAX_STATE_BYTES).toBe(32 * 1024 * 1024);
  });

  it('a resource that is full answers 507 with a JSON error; changing and deleting still work, and deleting makes room', () => {
    const s = new MockState(routes, { maxRecords: 4 });
    expect(s.handle('POST', '/pets', '{"name":"A"}')?.status).toBe(201);
    expect(s.handle('POST', '/pets', '{"name":"B"}')?.status).toBe(201);
    const full = s.handle('POST', '/pets', '{"name":"C"}');
    expect(full?.status).toBe(507);
    expect(full?.headers['content-type']).toBe('application/json');
    expect(bodyOf(full)).toMatchObject({ error: 'insufficient_storage' });
    expect(bodyOf(full).message).toMatch(/4 records/);
    expect(s.handle('PUT', '/pets/99', '{"name":"New"}')?.status).toBe(507);
    expect(s.snapshot()['/pets']).toHaveLength(4);
    // a record that exists is changed in place
    expect(s.handle('PUT', '/pets/1', '{"name":"Rexy"}')?.status).toBe(200);
    expect(s.handle('PATCH', '/pets/2', '{"age":3}')?.status).toBe(200);
    // the cap is per resource
    expect(s.handle('POST', '/tags', '{"name":"cute"}')?.status).toBe(201);
    expect(s.handle('DELETE', '/pets/1', undefined)?.status).toBe(204);
    expect(s.handle('POST', '/pets', '{"name":"C"}')?.status).toBe(201);
  });

  it('the bytes of all resources together are capped; what is deleted or reset is given back', () => {
    const s = new MockState(routes, { maxBytes: 2000 });
    const big = JSON.stringify({ name: 'x'.repeat(600) });
    expect(s.handle('POST', '/pets', big)?.status).toBe(201);
    expect(s.handle('POST', '/tags', big)?.status).toBe(201);
    expect(s.handle('POST', '/tags', big)?.status).toBe(201);
    const full = s.handle('POST', '/pets', big);
    expect(full?.status).toBe(507);
    expect(bodyOf(full)).toMatchObject({ error: 'insufficient_storage' });
    // a change that makes a record larger than the room left is refused, and the record stays as it was
    expect(s.handle('PATCH', '/pets/1', big)?.status).toBe(507);
    expect(bodyOf(s.handle('GET', '/pets/1', undefined))).toEqual({ id: 1, name: 'Rex' });
    // replacing a record counts the difference, not the whole record again
    expect(s.handle('PUT', '/tags/1', big)?.status).toBe(200);
    expect(s.handle('DELETE', '/tags', undefined)?.status).toBe(204);
    expect(s.handle('POST', '/pets', big)?.status).toBe(201);
    s.reset();
    for (let i = 0; i < 3; i++) expect(s.handle('POST', '/tags', big)?.status).toBe(201);
    expect(s.handle('POST', '/tags', big)?.status).toBe(507);
  });

  it('new ids come from a counter per resource: numbers after the seeds, never one that is in use, 1 again for an emptied resource', () => {
    const s = new MockState(routes);
    expect(bodyOf(s.handle('POST', '/pets', '{"name":"A"}'))).toEqual({ name: 'A', id: 3 });
    expect(bodyOf(s.handle('POST', '/pets', '{"id":40,"name":"Given"}'))).toEqual({ id: 40, name: 'Given' });
    expect(bodyOf(s.handle('POST', '/pets', '{"name":"B"}')).id).toBe(41);
    s.handle('DELETE', '/pets/3', undefined);
    expect(s.handle('POST', '/pets', '{"name":"C"}')?.headers.location).toBe('/pets/42');
    // another resource counts for itself
    expect(bodyOf(s.handle('POST', '/tags', '{"name":"t"}')).id).toBe(1);
    expect(bodyOf(s.handle('POST', '/tags', '{"name":"u"}')).id).toBe(2);
    s.handle('DELETE', '/tags', undefined);
    expect(bodyOf(s.handle('POST', '/tags', '{"name":"v"}')).id).toBe(1);
    // a text id among them: the ids made after it are text too, as before
    s.handle('POST', '/tags', '{"id":"abc","name":"w"}');
    expect(typeof bodyOf(s.handle('POST', '/tags', '{"name":"x"}')).id).toBe('string');
  });

  it('many POSTs stay fast (no pass over every record for each one)', () => {
    const s = new MockState(routes);
    const t0 = performance.now();
    for (let i = 0; i < MAX_STATE_RECORDS - 2; i++) s.handle('POST', '/pets', '{"name":"n"}');
    const ms = performance.now() - t0;
    expect(s.snapshot()['/pets']).toHaveLength(MAX_STATE_RECORDS);
    expect(s.handle('POST', '/pets', '{"name":"one too many"}')?.status).toBe(507);
    expect(ms).toBeLessThan(2000);
  });

  it('the server answers 507 for a full resource', async () => {
    const m = await startMockServer(collection, { stateful: true });
    try {
      const body = JSON.stringify({ blob: 'x'.repeat(30_000) });
      const post = async () => {
        const r = await fetch(`${m.url}/pets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
        await r.arrayBuffer();
        return r.status;
      };
      // 32 MB of records of 30 KB: full after about 1100 of them
      const statuses: number[] = [];
      for (let batch = 0; batch < 80 && !statuses.includes(507); batch++) statuses.push(...(await Promise.all(Array.from({ length: 20 }, post))));
      expect(statuses.filter((s) => s === 201).length).toBeGreaterThan(1000);
      expect(statuses.filter((s) => s === 201).length).toBeLessThan(1120);
      const r = await fetch(`${m.url}/pets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      expect(r.status).toBe(507);
      expect(await r.json()).toMatchObject({ error: 'insufficient_storage' });
      // the state is given back by a reset
      m.state!.reset();
      expect(await post()).toBe(201);
    } finally {
      await m.close();
    }
  });
});

describe('mock server: the fallback and other origins', () => {
  it('a forwarded answer names a loopback origin only; mocked answers are open as before', async () => {
    let realHits = 0;
    const real = createServer((req, res) => {
      realHits++;
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }).end(JSON.stringify({ real: true, path: req.url }));
    });
    await new Promise<void>((r) => real.listen(0, '127.0.0.1', r));
    const realUrl = `http://127.0.0.1:${(real.address() as { port: number }).port}`;
    const m = await startMockServer(collection, { fallbackUrl: realUrl });
    const dead = await startMockServer(collection, { fallbackUrl: 'http://127.0.0.1:9' });
    try {
      const get = (path: string, origin?: string, base = m.url) => fetch(`${base}${path}`, { headers: origin ? { origin } : {} });
      const preflight = (path: string, origin: string, method = 'PUT') => fetch(`${m.url}${path}`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': method } });
      // forwarded
      const evil = await get('/live', 'https://evil.example');
      expect(evil.status).toBe(200);
      expect(evil.headers.get('x-mock-forwarded')).toBe('true');
      expect(evil.headers.get('access-control-allow-origin')).toBeNull();
      expect((await get('/live')).headers.get('access-control-allow-origin')).toBeNull();
      for (const origin of ['http://localhost:5173', 'http://127.0.0.1:3000', 'http://[::1]:8080']) {
        const local = await get('/live', origin);
        expect(local.headers.get('access-control-allow-origin'), origin).toBe(origin);
        expect(local.headers.get('vary')).toBe('Origin');
      }
      // a name that only looks like this computer
      expect((await get('/live', 'http://localhost.evil.example')).headers.get('access-control-allow-origin')).toBeNull();
      // the fallback cannot be reached: the error is not open either
      const failed = await get('/live', 'https://evil.example', dead.url);
      expect(failed.status).toBe(502);
      expect(failed.headers.get('access-control-allow-origin')).toBeNull();
      // mocked
      expect((await get('/pets', 'https://evil.example')).headers.get('access-control-allow-origin')).toBe('*');
      // preflight: what would be forwarded is allowed to pages of this computer only
      const before = realHits;
      expect((await preflight('/live', 'https://evil.example')).headers.get('access-control-allow-origin')).toBeNull();
      expect((await preflight('/live', 'http://localhost:5173')).headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
      expect((await preflight('/pets', 'https://evil.example', 'GET')).headers.get('access-control-allow-origin')).toBe('*');
      expect(realHits).toBe(before);
    } finally {
      await m.close();
      await dead.close();
      await new Promise<void>((r) => real.close(() => r()));
    }
  });
});
