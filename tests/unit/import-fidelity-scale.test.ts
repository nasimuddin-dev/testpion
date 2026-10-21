import { describe, expect, it } from 'vitest';
import { importAny } from '../helpers-import.js';

// Quality bar: a 10,000-request import (with the 0.50 mapping layers: unknown auth, Insomnia template tags and
// chaining, Bruno bru.* → tp.* and .env) takes under 5 s. Measured, no sleeps.

const N = 10_000;
/** The best of three imports: a real slowdown is slow every time, a one-off stall of a busy CI machine is not. */
const timed = (text: string) => {
  let r = importAny(text);
  let ms = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    r = importAny(text);
    ms = Math.min(ms, performance.now() - t0);
  }
  return { r, ms };
};

describe('10,000-request imports stay under 5 s', () => {
  it('Postman with unsupported auth on every request', () => {
    const item = Array.from({ length: N }, (_, i) => ({
      name: `R${i}`,
      request: { method: 'GET', url: `https://api.test/r/${i}`, auth: { type: i % 2 ? 'asap' : 'bearer', asap: [], bearer: [{ key: 'token', value: 't' }] } },
      event: [{ listen: 'test', script: { exec: ["pm.test('ok', () => pm.response.to.have.status(200));"] } }],
    }));
    const { r, ms } = timed(JSON.stringify({ info: { _postman_id: 'x', name: 'Big', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item }));
    expect(r.collection!.items).toHaveLength(N);
    expect(r.notes).toHaveLength(N / 2);
    expect(ms).toBeLessThan(5000);
  });

  it('Insomnia v4 with template tags and chaining on every request', () => {
    const resources = [
      { _id: 'wrk', _type: 'workspace', name: 'Big' },
      { _id: 'req_login', _type: 'request', parentId: 'wrk', name: 'Log in', method: 'POST', url: 'https://api.test/login', metaSortKey: -1 },
    ];
    for (let i = 0; i < N; i++)
      resources.push({
        _id: `req_${i}`,
        _type: 'request',
        parentId: 'wrk',
        name: `R${i}`,
        method: 'GET',
        url: `{{ _.base }}/r/${i}?id={% uuid 'v4' %}&t={% response 'body', 'req_login', '$.token', 'never', 60 %}`,
        metaSortKey: i,
      } as never);
    const { r, ms } = timed(JSON.stringify({ _type: 'export', __export_format: 4, resources }));
    expect(r.collection!.items).toHaveLength(N + 1);
    expect(ms).toBeLessThan(5000);
  });

  it('Bruno with scripts and process.env on every request', () => {
    const items = Array.from({ length: N }, (_, i) => ({
      type: 'http-request',
      name: `R${i}`,
      seq: i,
      request: { url: `{{process.env.HOST}}/r/${i}`, method: 'GET', headers: [], params: [], auth: { mode: i % 2 ? 'ntlm' : 'inherit' }, script: { req: 'bru.setVar("i", bru.getEnvVar("n"));' } },
    }));
    const { r, ms } = timed(JSON.stringify({ name: 'Big', version: '1', items, dotenv: 'HOST=https://api.test\n' }));
    expect(r.collection!.items).toHaveLength(N);
    expect(r.scripts!.converted).toBe(N);
    expect(ms).toBeLessThan(5000);
  });
});
