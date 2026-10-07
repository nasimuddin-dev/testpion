import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { MemorySecretStore, Redactor, VariableScope, ProviderRegistry, McpManager, runTests, normalizeTest, type ExecServices } from '../../packages/core/src/index.js';

// A GraphQL subscription in a test file (or a collection run): the runner subscribes, collects events, and the
// checks see a body shaped like a query's ($.data…) plus every event in $.events.
const seen: Array<{ type: string; payload?: any }> = [];
const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', handleProtocols: (ps) => (ps.has('graphql-transport-ws') ? 'graphql-transport-ws' : false) });
const headers: string[] = [];
wss.on('connection', (ws, req) => {
  headers.push(String(req.headers.authorization ?? ''));
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    seen.push(m);
    if (m.type === 'connection_init') ws.send(JSON.stringify({ type: 'connection_ack' }));
    if (m.type === 'subscribe') {
      let n = 0;
      const t = setInterval(() => {
        n++;
        ws.send(JSON.stringify({ id: m.id, type: 'next', payload: { data: { vitals: { pet: m.payload.variables?.pet ?? null, beat: n } } } }));
        if (n === 3) {
          clearInterval(t);
          ws.send(JSON.stringify({ id: m.id, type: 'complete' }));
        }
      }, 20);
    }
  });
});
const url = () => `http://127.0.0.1:${(wss.address() as AddressInfo).port}/graphql`;
beforeAll(() => new Promise<void>((r) => (wss.address() ? r() : wss.once('listening', () => r()))));
afterAll(() => wss.close());

const services = (): ExecServices => {
  const redactor = new Redactor();
  const vars = new VariableScope(new MemorySecretStore(), redactor);
  return { vars, providers: new ProviderRegistry([], vars, redactor), mcp: new McpManager(() => undefined, redactor), mcpServers: [], redactor, pricing: [], defaultTimeoutMs: 5000 };
};

describe('GraphQL subscriptions in test files', () => {
  it('checks the first event by default, with the bearer token on the handshake', async () => {
    const test = normalizeTest({
      name: 'vitals arrive',
      type: 'graphql',
      endpoint: url(),
      query: 'subscription($pet: ID!) { vitals(pet: $pet) { pet beat } }',
      variables: { pet: 'p1' },
      auth: { type: 'bearer', token: 't0ken' },
      assertions: [
        { type: 'equals', path: '$.data.vitals.beat', expected: 1 },
        { type: 'equals', path: '$.count', expected: 1 },
      ],
    });
    const results: any[] = [];
    const summary = await runTests({ name: 's', runId: 'r1', tests: [test], services: services(), concurrency: 1, onEvent: (e) => e.type === 'test-end' && results.push(e.result) });
    expect(summary.passed, JSON.stringify(results[0]?.assertions ?? results[0]?.error)).toBe(1);
    expect(headers.at(-1)).toBe('Bearer t0ken');
    expect(seen.find((m) => m.type === 'subscribe')?.payload.variables).toEqual({ pet: 'p1' });
  });

  it('collects several events, or until the subscription completes', async () => {
    const test = normalizeTest({
      name: 'three beats',
      type: 'graphql',
      url: url(),
      query: 'subscription { vitals { beat } }',
      events: 10,
      wait: 3000,
      assertions: [
        { type: 'equals', path: '$.count', expected: 3 },
        { type: 'equals', path: '$.events[2].data.vitals.beat', expected: 3 },
        { type: 'equals', path: '$.completed', expected: true },
      ],
    });
    const summary = await runTests({ name: 's', runId: 'r2', tests: [test], services: services(), concurrency: 1 });
    expect(summary.passed).toBe(1);
  });

  it('fails a check when no event arrives in time', async () => {
    const quiet = new WebSocketServer({ port: 0, host: '127.0.0.1', handleProtocols: () => 'graphql-transport-ws' });
    quiet.on('connection', (ws) => ws.on('message', (raw) => JSON.parse(String(raw)).type === 'connection_init' && ws.send(JSON.stringify({ type: 'connection_ack' }))));
    await new Promise<void>((r) => quiet.once('listening', () => r()));
    try {
      const test = normalizeTest({
        name: 'silence',
        type: 'graphql',
        endpoint: `http://127.0.0.1:${(quiet.address() as AddressInfo).port}/graphql`,
        query: 'subscription { vitals { beat } }',
        wait: 300,
        assertions: [{ type: 'equals', path: '$.count', expected: 1 }],
      });
      const summary = await runTests({ name: 's', runId: 'r3', tests: [test], services: services(), concurrency: 1 });
      expect(summary.failed).toBe(1);
      // without checks, the default one fails and says why
      const bare = normalizeTest({
        name: 'silence',
        type: 'graphql',
        endpoint: `http://127.0.0.1:${(quiet.address() as AddressInfo).port}/graphql`,
        query: 'subscription { vitals { beat } }',
        wait: 300,
      });
      const out: any[] = [];
      await runTests({ name: 's', runId: 'r4', tests: [bare], services: services(), concurrency: 1, onEvent: (e) => e.type === 'test-end' && out.push(e.result) });
      expect(out[0].status).toBe('failed');
      expect(out[0].checks[0].message).toMatch(/No subscription event arrived within 300 ms/);
    } finally {
      quiet.close();
    }
  });
});
