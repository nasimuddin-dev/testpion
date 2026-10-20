import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { runScript, scriptRequestSender, savedRequestSpec, VariableScope, type Collection } from '../../packages/core/src/index.js';

// tp.execution.runRequest("name"): a script runs another saved request of the collection (Bruno's bru.runRequest,
// Thunder's tc.runRequest) with the auth, headers and variables it would have, and gets its response.
describe('tp.execution.runRequest', () => {
  const collection: Collection = {
    schemaVersion: '1.0', id: 'c', name: 'C', version: 0, variables: [], updatedAt: '',
    auth: { type: 'bearer', token: '{{token}}' },
    headers: [{ key: 'X-Col', value: 'c', enabled: true }],
    items: [
      { kind: 'folder', id: 'f', name: 'Auth', items: [{ kind: 'http', id: 'login', name: 'Log in', request: { method: 'POST', url: '{{base}}/login', auth: { type: 'inherit' } } }] },
      { kind: 'http', id: 'sock', name: 'Socket', request: { method: 'GET', url: 'ws://x' } },
    ],
  };

  it('finds a request by id, name or path, with inherited auth and collection headers', () => {
    expect(savedRequestSpec(collection, 'login')?.url).toBe('{{base}}/login');
    expect(savedRequestSpec(collection, 'Auth / Log in')?.auth).toEqual({ type: 'bearer', token: '{{token}}' });
    expect(savedRequestSpec(collection, 'log in')?.headers).toEqual([{ key: 'X-Col', value: 'c', enabled: true }]);
    expect(savedRequestSpec(collection, 'nope')).toBeUndefined();
  });

  it('runs it from a script and answers its response', async () => {
    const seen: Array<{ url?: string; auth?: string; col?: string; method?: string }> = [];
    const server = createServer((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization, col: String(req.headers['x-col']), method: req.method });
      res.setHeader('content-type', 'application/json');
      res.end('{"session":"s-9"}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const vars = new VariableScope();
      vars.setScope('environment', { base: `http://127.0.0.1:${port}`, token: 'tok-1' });
      const sender = scriptRequestSender({ production: undefined, saved: { find: (ref) => savedRequestSpec(collection, ref), resolve: (s) => vars.resolveDeep(s) } });
      const out = await runScript(
        "const res = await tp.execution.runRequest('Log in');\ntp.variables.set('session', res.json().session);\ntp.test('status', () => tp.expect(res.code).to.equal(200));\ntp.execution.runRequest('Missing', (err) => tp.variables.set('err', String(err && err.message)));",
        { variables: {} },
        { sendRequest: sender },
      );
      expect(out.error).toBeUndefined();
      expect(out.tests).toEqual([expect.objectContaining({ name: 'status', passed: true })]);
      expect(out.vars.session).toBe('s-9');
      expect(out.vars.err).toMatch(/no HTTP request "Missing"/);
      expect(seen).toEqual([{ url: '/login', auth: 'Bearer tok-1', col: 'c', method: 'POST' }]);
    } finally {
      server.close();
    }
  });
});
