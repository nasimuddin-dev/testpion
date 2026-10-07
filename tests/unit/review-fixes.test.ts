import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import {
  applyTidy,
  collectSubscriptionEvents,
  createEngineContext,
  externalSecrets,
  fuzzCases,
  generateValue,
  importHttpFile,
  lintOpenApi,
  MemorySecretStore,
  moveCollectionVariablesToEnvironments,
  prefetchEnvironmentSecrets,
  runFuzz,
  setSecretRunner,
  tidyCollection,
  trustCommand,
  WorkspaceStore,
  type Collection,
} from '../../packages/core/src/index.js';

const ws = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `tp-fix-${name}-`));
  return { dir, store: WorkspaceStore.create(dir, name) };
};

describe('fixes from the review', () => {
  it('.http: an unclosed pre-request script ends the block instead of looping; a stray % in a form body stays as written', () => {
    const r = importHttpFile('GET http://localhost/a\n\n###\n< {% client.log(1)\nGET http://localhost/b\n');
    expect(r.collection.items).toHaveLength(1);
    expect(r.notes[0]).toMatch(/not closed with %}/);
    const f = importHttpFile('POST http://localhost/x\nContent-Type: application/x-www-form-urlencoded\n\ndiscount=50%&q=a+b\n');
    expect((f.collection.items[0] as any).request.body.fields).toEqual([
      { key: 'discount', value: '50%', enabled: true },
      { key: 'q', value: 'a b', enabled: true },
    ]);
  });

  const base: Collection = { schemaVersion: '1.0', id: 'c', name: 'C', version: 1, updatedAt: '', variables: [], items: [] };
  const http = (id: string, extra: Record<string, unknown> = {}) => ({ kind: 'http' as const, id, name: id, request: { method: 'GET', url: '{{b}}/users', ...extra } });

  it('tidy: requests that differ in auth, headers or scripts are not duplicates', () => {
    const c: Collection = {
      ...base,
      items: [
        http('admin', { auth: { type: 'bearer', token: 'A' } }),
        http('anon', { auth: { type: 'none' } }),
        { ...http('scripted'), testScript: 'pm.test("x", () => {})' },
        http('plain'),
        http('plain-copy'),
      ],
    };
    expect(
      tidyCollection(c)
        .filter((f) => f.kind === 'duplicate')
        .map((f) => f.ids),
    ).toEqual([['plain', 'plain-copy']]);
  });

  it('tidy: a variable read with double quotes in a script is used', () => {
    const c: Collection = {
      ...base,
      variables: [
        { key: 'token', value: 'x' },
        { key: 'b', value: 'y' },
      ],
      items: [{ ...http('r'), testScript: 'const t = pm.collectionVariables.get("token");' }],
    };
    expect(tidyCollection(c).filter((f) => f.kind === 'unused-variable')).toEqual([]);
  });

  it("tidy: requests under a folder with its own auth don't get the collection auth", () => {
    const h = (id: string) => http(id, { headers: [{ key: 'Authorization', value: 'Bearer {{t}}' }] });
    const c: Collection = { ...base, items: [{ kind: 'folder', id: 'f', name: 'F', auth: { type: 'basic', username: 'u', password: 'p' }, items: [h('f1'), h('f2'), h('f3')] }, h('a'), h('b')] };
    expect(tidyCollection(c).some((f) => f.kind === 'repeated-auth-header')).toBe(false);
    const d: Collection = { ...c, items: [...c.items, h('c')] };
    const f = tidyCollection(d).find((x) => x.kind === 'repeated-auth-header')!;
    expect(f.ids).toEqual(['a', 'b', 'c']);
    const folder = applyTidy(d, { useCollectionAuth: true }).collection.items[0] as any;
    expect(folder.items[0].request.headers).toEqual([{ key: 'Authorization', value: 'Bearer {{t}}' }]);
  });

  it("secrets: a value read for one workspace never reaches another that wasn't allowed", async () => {
    const a = ws('a');
    const b = ws('b');
    const restore = setSecretRunner(async () => 'bank-password');
    try {
      for (const { store } of [a, b]) store.saveEnvironment({ id: 'e', name: 'E', variables: [{ key: 'pw', value: 'op://Private/Bank/password' }] });
      trustCommand(a.store, 'op', ['read', '--no-newline', 'op://Private/Bank/password']);
      expect((await prefetchEnvironmentSecrets(a.store, 'e')).fetched).toHaveLength(1);
      expect((await prefetchEnvironmentSecrets(b.store, 'e')).blocked).toHaveLength(1);
      const ctxB = createEngineContext({ store: b.store, secrets: new MemorySecretStore(), environment: 'e' });
      expect(ctxB.vars.resolve('{{pw}}')).toBe('');
      await ctxB.dispose();
      const ctxA = createEngineContext({ store: a.store, secrets: new MemorySecretStore(), environment: 'e' });
      expect(ctxA.vars.resolve('{{pw}}')).toBe('bank-password');
      await ctxA.dispose();
    } finally {
      restore();
      externalSecrets.clear();
      for (const w of [a, b]) (w.store.close(), rmSync(w.dir, { recursive: true, force: true, maxRetries: 3 }));
    }
  });

  it('generated data: one bound gives the other', () => {
    for (let i = 0; i < 50; i++) {
      const y = generateValue('year', { type: 'integer', minimum: 1900 }) as number;
      expect(y).toBeGreaterThanOrEqual(1900);
      const age = generateValue('age', { type: 'integer', minimum: 21 }) as number;
      expect(age).toBeGreaterThanOrEqual(21);
      const temp = generateValue('t', { type: 'number', maximum: -10 }) as number;
      expect(temp).toBeLessThanOrEqual(-10);
    }
  });

  it('moving a secret variable keeps its value in the secret store, or leaves it when there is none', async () => {
    const w = ws('move');
    try {
      w.store.saveCollection({ ...base, variables: [{ key: 'apiKey', value: 's3cret', secret: true } as never, { key: 'url', value: 'http://x' }] });
      w.store.saveEnvironment({ id: 'dev', name: 'Dev', variables: [] });
      const noStore = await moveCollectionVariablesToEnvironments(w.store, { collectionId: 'c', environments: ['dev'] });
      expect(noStore).toMatchObject({ moved: ['url'], notMoved: ['apiKey'] });
      expect(w.store.getCollection('c').variables.map((v) => v.key)).toEqual(['apiKey']);
      const secrets = new MemorySecretStore();
      const r = await moveCollectionVariablesToEnvironments(w.store, { collectionId: 'c', environments: ['dev'], secrets });
      expect(r.moved).toEqual(['apiKey']);
      expect(w.store.getEnvironment('dev')!.variables.find((v) => v.key === 'apiKey')).toEqual({ key: 'apiKey', value: '', enabled: true, secret: true });
      expect(secrets.get('env.dev.apiKey')).toBe('s3cret');
    } finally {
      w.store.close();
      rmSync(w.dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it('fuzz: every request is checked for its host, not only the first', async () => {
    const spec = `openapi: 3.0.0
info: { title: T, version: '1' }
paths:
  /ok: { get: { responses: { '200': { description: ok } } } }
  '@evil.example/x': { get: { responses: { '200': { description: ok } } } }
`;
    const { cases } = fuzzCases(spec, { baseUrl: 'http://127.0.0.1:9' });
    const r = await runFuzz(spec, cases, { timeoutMs: 1000 });
    const evil = r.results.find((x) => x.case.operation.includes('@evil'))!;
    expect(evil.verdict).toBe('failed');
    expect(evil.message).toMatch(/remote host "evil\.example" needs explicit opt-in/);
  });

  it('a stopped run ends a subscription wait at once', async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1', handleProtocols: () => 'graphql-transport-ws' });
    server.on('connection', (s) => s.on('message', (raw) => JSON.parse(String(raw)).type === 'connection_init' && s.send(JSON.stringify({ type: 'connection_ack' }))));
    await new Promise<void>((r) => server.once('listening', () => r()));
    try {
      const ctrl = new AbortController();
      const t0 = Date.now();
      setTimeout(() => ctrl.abort(), 200);
      await collectSubscriptionEvents({ url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`, query: 'subscription { a }', durationMs: 60_000, signal: ctrl.signal });
      expect(Date.now() - t0).toBeLessThan(5000);
    } finally {
      server.close();
    }
  });

  it('lint: a schema property named value is read (its $ref counts)', () => {
    const r = lintOpenApi(`openapi: 3.0.0
info: { title: T, version: '1' }
servers: [{ url: 'https://x.example' }]
paths:
  /a:
    get:
      operationId: a
      summary: A
      tags: [t]
      responses:
        '200':
          description: ok
          content: { application/json: { schema: { type: object, properties: { value: { $ref: '#/components/schemas/Money' } } } } }
tags: [{ name: t }]
components: { schemas: { Money: { type: number } } }
`);
    expect(r.problems.filter((p) => p.rule === 'component-unused')).toEqual([]);
  });
});
