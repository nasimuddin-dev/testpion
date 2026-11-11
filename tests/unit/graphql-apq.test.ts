import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { executeGraphQL } from '../../packages/core/src/index.js';

// Automatic persisted queries (Apollo's APQ): the query's hash first; the server that does not know it answers
// PERSISTED_QUERY_NOT_FOUND and gets the query with the hash (registered); the next time the hash alone is enough (hit).
let server: Server;
let base = '';
const kept = new Map<string, string>();
const bodies: Array<Record<string, unknown>> = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const b = JSON.parse(raw) as { query?: string; extensions?: { persistedQuery?: { sha256Hash: string } } };
      bodies.push(b);
      res.setHeader('content-type', 'application/json');
      const reply = (x: unknown) => res.end(JSON.stringify(x));
      if (req.url === '/plain')
        return b.extensions ? reply({ errors: [{ message: 'PersistedQueryNotSupported', extensions: { code: 'PERSISTED_QUERY_NOT_SUPPORTED' } }] }) : reply({ data: { hello: 'plain' } });
      // a server that never heard of APQ: no query, no answer (graphql-http's "Must provide query string")
      if (req.url === '/strict') return b.query ? reply({ data: { hello: 'strict' } }) : ((res.statusCode = 400), reply({ errors: [{ message: 'Must provide query string.' }] }));
      // refuses everything (not signed in): APQ is not the reason
      if (req.url === '/closed') return reply({ errors: [{ message: 'Not signed in' }] });
      const hash = b.extensions?.persistedQuery?.sha256Hash;
      if (hash && !b.query && !kept.has(hash)) return reply({ errors: [{ message: 'PersistedQueryNotFound', extensions: { code: 'PERSISTED_QUERY_NOT_FOUND' } }] });
      if (hash && b.query) {
        if (createHash('sha256').update(b.query).digest('hex') !== hash) return reply({ errors: [{ message: 'provided sha does not match query' }] });
        kept.set(hash, b.query);
      }
      reply({ data: { hello: 'world' } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('automatic persisted queries', () => {
  it('registered the first time, a hit the next, unsupported where the server does not do it', async () => {
    const query = '{ hello }';
    const first = await executeGraphQL({ endpoint: `${base}/apq`, query, persistedQueries: true });
    expect(first).toMatchObject({ persisted: 'registered', data: { hello: 'world' } });
    expect(bodies.slice(-2).map((b) => !!b.query)).toEqual([false, true]); // the hash alone, then the query with it
    const second = await executeGraphQL({ endpoint: `${base}/apq`, query, persistedQueries: true });
    expect(second).toMatchObject({ persisted: 'hit', data: { hello: 'world' } });
    expect(bodies.at(-1)!.query).toBeUndefined();
    expect(await executeGraphQL({ endpoint: `${base}/plain`, query, persistedQueries: true })).toMatchObject({ persisted: 'unsupported', data: { hello: 'plain' } });
    // a server that only refuses the request without a query gets the query as usual
    expect(await executeGraphQL({ endpoint: `${base}/strict`, query, persistedQueries: true })).toMatchObject({ persisted: 'unsupported', data: { hello: 'strict' } });
    const closed = await executeGraphQL({ endpoint: `${base}/closed`, query, persistedQueries: true });
    expect(closed.persisted).toBeUndefined();
    expect(closed.errors).toEqual([{ message: 'Not signed in' }]);
    // without the option nothing changes: the query, no extensions
    const plain = await executeGraphQL({ endpoint: `${base}/apq`, query });
    expect(plain.persisted).toBeUndefined();
    expect(bodies.at(-1)).toEqual({ query });
  });

  it('a test file says persistedQueries: true (and a gRPC test web: true): the loader keeps them', async () => {
    const { normalizeTest } = await import('../../packages/core/src/runner/loader.js');
    expect(normalizeTest({ type: 'graphql', endpoint: 'http://x/graphql', query: '{ a }', persistedQueries: true })).toMatchObject({ type: 'graphql', persistedQueries: true });
    expect(normalizeTest({ type: 'grpc', target: 'https://x/grpc', method: 'a.B/C', web: true })).toMatchObject({ type: 'grpc', web: true });
    expect(normalizeTest({ type: 'graphql', endpoint: 'http://x/graphql', query: '{ a }' })).not.toHaveProperty('persistedQueries');
  });
});
