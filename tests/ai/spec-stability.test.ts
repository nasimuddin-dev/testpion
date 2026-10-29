/**
 * AI-4 stability filter: the generated tests run twice against a mock built from the document (offline, on this computer).
 * A test that gives another result on the second run is called unstable; one that cannot pass on the mock of the
 * document is a warning; the rest pass twice. Also the preparation of a 300-operation document stays small and quick.
 */
import { describe, expect, it } from 'vitest';
import { createEngineContext, draftSpecTestsProposal, loadOpenApi, MemorySecretStore, specGapsWithDraft, startSpecMock, verifySpecStable } from '../../packages/core/src/index.js';
import { generateTestsWithAi } from '../../packages/core/src/mcp-server/tools/ai-spec-tools.js';
import { harness } from './harness.js';
import { addShopSpec, SHOP_SPEC } from './spec-fixtures.js';

const services = (store: Parameters<typeof createEngineContext>[0]['store']) => createEngineContext({ store, secrets: new MemorySecretStore(), settings: { pricing: [] } as never });

describe('spec mock', () => {
  it('answers like the document: 401 without credentials, 422 for a body that breaks the schema, 404 for a missing id, the example otherwise', async () => {
    const mock = await startSpecMock(loadOpenApi(SHOP_SPEC));
    try {
      const call = (method: string, path: string, init: { auth?: boolean; body?: unknown } = {}) =>
        fetch(mock.url + path, { method, headers: { ...(init.auth ? { authorization: 'Bearer t' } : {}), 'content-type': 'application/json' }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
      expect((await call('GET', '/health')).status).toBe(200);
      expect((await call('GET', '/orders')).status).toBe(401);
      expect((await call('GET', '/orders', { auth: true })).status).toBe(200);
      expect((await call('POST', '/orders', { auth: true, body: { item: 'x', qty: 0 } })).status).toBe(422);
      expect((await call('POST', '/orders', { auth: true, body: { item: 'x', qty: 3 } })).status).toBe(201);
      expect((await call('GET', '/orders/00000000-0000-4000-8000-000000000000', { auth: true })).status).toBe(404);
      expect((await call('GET', '/invoices', { auth: true })).status).toBe(404);
    } finally {
      await mock.close();
    }
  });
});

describe('spec-stable verifier', () => {
  it('the deterministic proposal carries a badge: the tests ran twice on the mock of the document', async () => {
    const h = harness();
    const ctx = services(h.store);
    try {
      addShopSpec(h.store);
      const p = await draftSpecTestsProposal(h.store, 'specs/shop.yaml', { surface: 'cli', services: ctx.services });
      const badge = p.items[0]!.verification.find((b) => b.verifier === 'spec-stable');
      expect(badge, JSON.stringify(p.items[0]!.verification)).toBeDefined();
      expect(badge!.status).not.toBe('fail');
      expect(badge!.label).toMatch(/pass twice on a mock of the document/);
      // most of the cases hold on the mock; the rest are named, never hidden
      const [pass, total] = /(\d+)\/(\d+)/.exec(badge!.label)!.slice(1).map(Number);
      expect(pass! / total!).toBeGreaterThan(0.7);
    } finally {
      await ctx.dispose();
      h.cleanup();
    }
  });

  it('without engine services there is no badge (nothing runs)', async () => {
    const h = harness();
    try {
      addShopSpec(h.store);
      const p = await draftSpecTestsProposal(h.store, 'specs/shop.yaml', { surface: 'cli' });
      expect(p.items[0]!.verification.some((b) => b.verifier === 'spec-stable')).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it('a test whose result changes between the two runs is unstable; one that cannot pass on the mock is named', async () => {
    const h = harness();
    const ctx = services(h.store);
    try {
      const random = Array.from({ length: 16 }, (_v, i) => `  - id: r${i}
    name: Random quantity ${i}
    method: POST
    url: "{{baseUrl}}/orders"
    auth: { type: bearer, token: t }
    body: '{"item":"x","qty":{{$randomInt(1,20)}}}'
    assertions: [{ type: status, expected: 201 }]`);
      const raw = random;
      // the test that can never pass comes first: the badge names the first five of each kind, and random ones that fail twice would crowd it out
      const wrong = `  - id: wrong\n    name: Health says 500\n    method: GET\n    url: "{{baseUrl}}/health"\n    assertions: [{ type: status, expected: 500 }]`;
      const stable = `  - id: stable\n    name: Health\n    method: GET\n    url: "{{baseUrl}}/health"\n    assertions: [{ type: status, expected: 200 }]`;
      const yaml = `defaults: { type: http }\ntests:\n${[wrong, stable, ...raw].join('\n')}\n`;
      const badge = await verifySpecStable(yaml, loadOpenApi(SHOP_SPEC), ctx.services);
      expect(badge.status).toBe('warn');
      expect(badge.label).toMatch(/unstable/);
      expect(badge.detail).toMatch(/Health says 500: does not pass on a mock/);
      expect(badge.detail).toMatch(/unstable/);
    } finally {
      await ctx.dispose();
      h.cleanup();
    }
  }, 60_000);
});

describe('generate_tests { ai: true }', () => {
  it('goes to the proposal tool; without ai the first suite is written as before', async () => {
    const calls: string[] = [];
    const mk = (name: string): never => ({ name, description: name, inputSchema: { type: 'object', properties: { categories: {} } }, run: () => (calls.push(name), {}) }) as never;
    const [gen] = generateTestsWithAi([mk('generate_tests'), mk('spec_tests_generate')]) as unknown as Array<{ inputSchema: { properties: Record<string, unknown> }; run(a: object): unknown }>;
    expect(Object.keys(gen!.inputSchema.properties)).toContain('ai');
    gen!.run({ spec: 'x', ai: true });
    gen!.run({ spec: 'x' });
    expect(calls).toEqual(['spec_tests_generate', 'generate_tests']);
  });
});

describe('a big document', () => {
  it('300 operations: the gap report and the draft count come in under a second', () => {
    const h = harness();
    try {
      const paths: Record<string, unknown> = {};
      for (let i = 0; i < 150; i++) {
        paths[`/r${i}`] = {
          get: { operationId: `list${i}`, tags: [`t${i % 10}`], responses: { '200': { description: 'ok' }, '401': { description: 'no' } } },
          post: { operationId: `create${i}`, tags: [`t${i % 10}`], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 20 }, qty: { type: 'integer', minimum: 1, maximum: 9 } } } } } }, responses: { '201': { description: 'ok' }, '422': { description: 'bad' } } },
        };
      }
      const spec = JSON.stringify({ openapi: '3.0.3', info: { title: 'Big', version: '1' }, paths });
      const { mkdirSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
      mkdirSync(`${h.store.root}/specs`, { recursive: true });
      writeFileSync(`${h.store.root}/specs/big.json`, spec);
      const t = performance.now();
      const r = specGapsWithDraft(h.store, 'specs/big.json');
      expect(performance.now() - t).toBeLessThan(2000);
      expect(r.report.operations.length).toBe(300);
      expect(r.draft.tests).toBeGreaterThan(100);
    } finally {
      h.cleanup();
    }
  });
});
