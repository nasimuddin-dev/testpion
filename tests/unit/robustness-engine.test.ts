import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApsError, VariableScope, WorkspaceStore, executeHttp, normalizeError, readJson, requireCollection, requireEnvironment, writeJson } from '../../packages/core/src/index.js';
import { runCli, tempDir } from '../helpers.js';

/** Robustness audit fixes (2026-10-09) in the engine and the CLI: broken files, malformed files, timeouts, cycles, errors. */

let server: Server;
let base = '';
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith('/hang')) return; // never answers
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe('broken and malformed workspace files', () => {
  it('reading a broken JSON file leaves it where it is; saving over it keeps a .broken- copy', () => {
    const t = tempDir();
    try {
      const f = join(t.dir, 'x.json');
      writeFileSync(f, '<<<<<<< HEAD\n{"a":1}\n=======\n{"a":2}\n>>>>>>> theirs\n');
      expect(() => readJson(f)).toThrow(/merge conflict markers/);
      expect(() => readJson(f)).toThrow(ApsError);
      expect(readdirSync(t.dir)).toEqual(['x.json']);
      writeJson(f, { a: 3 });
      const files = readdirSync(t.dir);
      expect(files).toContain('x.json');
      const copy = files.find((x) => x.startsWith('x.json.broken-'));
      expect(copy && readFileSync(join(t.dir, copy), 'utf8')).toMatch(/<<<<<<< HEAD/);
      // a valid file is replaced without a copy
      writeJson(f, { a: 4 });
      expect(readdirSync(t.dir).filter((x) => x.includes('.broken-'))).toHaveLength(1);
    } finally {
      t.cleanup();
    }
  });

  it('broken collections and environments stay listed with their problem; using them says why', () => {
    const t = tempDir();
    const store = WorkspaceStore.create(join(t.dir, 'ws'), 'W');
    try {
      writeFileSync(store.path('collections', 'broken.json'), '{"schemaVersion":"1.0","id":"broken","name":"Broken","items":[');
      writeFileSync(store.path('environments', 'qa.json'), '{"id":"qa","name":"QA","variables":[');
      store.saveCollection({ schemaVersion: '1.0', id: 'good', name: 'Good', version: 0, variables: [], items: [], updatedAt: '' });
      for (let i = 0; i < 2; i++) {
        const b = store.listCollections().find((c) => c.id === 'broken');
        expect(b?.name).toBe('Broken');
        expect(b?.problem).toMatch(/not valid JSON/);
        const qa = store.listEnvironments().find((e) => e.id === 'qa');
        expect(qa?.name).toBe('QA');
        expect(qa?.problem).toMatch(/not valid JSON/);
      }
      expect(() => requireCollection(store, 'broken', { loadable: true })).toThrow(/Collection "Broken" is broken/);
      expect(() => requireEnvironment(store, 'QA')).toThrow(/Environment "QA" is broken/);
      expect(() => requireEnvironment(store, 'Nope')).toThrow(/No environment "Nope"\. Available: Development, QA/);
      // looking up another collection does not touch the broken file
      expect(store.getCollection('good').name).toBe('Good');
      expect(readdirSync(store.path('collections')).sort()).toEqual(['broken.json', 'good.json']);
      // reordering does not write over a broken environment
      store.reorderEnvironments(['qa', 'development']);
      expect(readFileSync(store.path('environments', 'qa.json'), 'utf8')).toBe('{"id":"qa","name":"QA","variables":[');
    } finally {
      store.close();
      t.cleanup();
    }
  });

  it('valid JSON without variables / items / a string name is normalised on read', () => {
    const t = tempDir();
    const store = WorkspaceStore.create(join(t.dir, 'ws'), 'W');
    try {
      writeFileSync(store.path('environments', 'odd.json'), '{"id":"odd","name":"Odd"}');
      writeFileSync(store.path('collections', 'odd.json'), '{"id":"odd","name":42,"items":[{"kind":"folder","id":"f","name":"F"}]}');
      expect(store.getEnvironment('odd')?.variables).toEqual([]);
      const c = store.getCollection('odd');
      expect(c.name).toBe('42');
      expect(c.variables).toEqual([]);
      expect(c.items[0]).toMatchObject({ kind: 'folder', items: [] });
      expect(store.listCollections().find((x) => x.id === 'odd')?.items).toHaveLength(1);
    } finally {
      store.close();
      t.cleanup();
    }
  });

  it("a folder with another tool's workspace.json (Nx) is refused and left untouched", () => {
    const t = tempDir();
    try {
      const original = JSON.stringify({ version: 2, projects: { app: 'apps/app' } });
      writeFileSync(join(t.dir, 'workspace.json'), original);
      expect(() => WorkspaceStore.open(t.dir)).toThrow(/is not a TestPion workspace/);
      expect(readdirSync(t.dir)).toEqual(['workspace.json']);
      expect(readFileSync(join(t.dir, 'workspace.json'), 'utf8')).toBe(original);
    } finally {
      t.cleanup();
    }
  });
});

describe('HTTP timeout and cancellation', () => {
  it('a server that never answers times out after settings.timeoutMs (CLI send, MCP, scripts)', async () => {
    const t0 = Date.now();
    const e = await executeHttp({ method: 'GET', url: `${base}/hang`, settings: { timeoutMs: 300 } } as never).catch((x) => x);
    expect(e).toBeInstanceOf(ApsError);
    expect(e.kind).toBe('TimeoutError');
    expect(e.message).toBe('Request timed out after 300 ms');
    expect(Date.now() - t0).toBeLessThan(5000);
    // the caller's timeoutMs wins
    const e2 = await executeHttp({ method: 'GET', url: `${base}/hang`, settings: { timeoutMs: 60_000 } } as never, { timeoutMs: 200 }).catch((x) => x);
    expect(e2.message).toBe('Request timed out after 200 ms');
  });

  it('a cancelled request says "Request cancelled", not "This operation was aborted: 20"', async () => {
    const ctrl = new AbortController();
    const p = executeHttp({ method: 'GET', url: `${base}/hang` } as never, { signal: ctrl.signal }).catch((x) => x);
    setTimeout(() => ctrl.abort(), 100);
    const n = normalizeError(await p);
    expect(n.kind).toBe('CancelledError');
    expect(n.message).toBe('Request cancelled');
  });

  it('sends with one long-lived signal do not pile up abort listeners on it (timeouts and retry waits)', async () => {
    const ctrl = new AbortController();
    let live = 0;
    const add = ctrl.signal.addEventListener.bind(ctrl.signal);
    const remove = ctrl.signal.removeEventListener.bind(ctrl.signal);
    ctrl.signal.addEventListener = ((type: string, fn: never, o?: never) => {
      if (type === 'abort') live++;
      add(type, fn, o);
    }) as never;
    ctrl.signal.removeEventListener = ((type: string, fn: never, o?: never) => {
      if (type === 'abort') live--;
      remove(type, fn, o);
    }) as never;
    const before = live;
    for (let i = 0; i < 5; i++) await executeHttp({ method: 'GET', url: `${base}/ok` } as never, { signal: ctrl.signal });
    // retries: 500s are retried after a wait whose listener must go too
    const flaky = createServer((_req, res) => {
      res.writeHead(503);
      res.end();
    });
    await new Promise<void>((r) => flaky.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(flaky.address() as AddressInfo).port}/`;
      for (let i = 0; i < 3; i++) await executeHttp({ method: 'GET', url, settings: { retries: 2, retryDelayMs: 1 } } as never, { signal: ctrl.signal });
    } finally {
      flaky.closeAllConnections();
      flaky.close();
    }
    // undici may keep at most one of its own per request in flight; nothing ours stays
    expect(live - before).toBeLessThanOrEqual(0);
  });
});

describe('variables', () => {
  it('resolves nested variables and reports cycles instead of sending them', () => {
    const v = new VariableScope();
    v.setScope('environment', [
      { key: 'host', value: 'example.com', enabled: true },
      { key: 'baseUrl', value: 'https://{{host}}/api', enabled: true },
      { key: 'a', value: '{{b}}', enabled: true },
      { key: 'b', value: '{{a}}', enabled: true },
      { key: 'self', value: 'x{{self}}', enabled: true },
    ]);
    expect(v.resolve('{{baseUrl}}/users')).toBe('https://example.com/api/users');
    expect(v.unresolved.size).toBe(0);
    expect(v.resolve('{{a}}')).toBe('{{a}}');
    expect(v.resolve('{{self}}')).toBe('{{self}}');
    expect([...v.unresolved].sort()).toEqual(['a', 'b', 'self']);
    expect([...v.cycles]).toEqual(expect.arrayContaining(['a → b → a', 'self → self']));
    expect(v.resolveDeep({ u: '{{baseUrl}}' })).toEqual({ u: 'https://example.com/api' });
  });
});

describe('error normalisation', () => {
  it('a bug is an InternalError with "report the problem", not a protocol problem', () => {
    const n = normalizeError(new TypeError("Cannot read properties of undefined (reading 'map')"));
    expect(n.kind).toBe('InternalError');
    expect(n.why).toMatch(/Something went wrong/);
    expect(n.suggestions.join(' ')).toMatch(/Report a problem/);
    expect(normalizeError(new RangeError('x')).kind).toBe('InternalError');
    expect(normalizeError(Object.assign(new Error('bad frame'), { code: 'WS_ERR_INVALID_OPCODE' })).kind).toBe('ProtocolError');
    expect(normalizeError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })).kind).toBe('NetworkError');
    expect(normalizeError(new SyntaxError('Unexpected token')).suggestions.join(' ')).not.toMatch(/response body/);
  });

  it('a corrupted gzip body is reported as an invalid compressed body', () => {
    const n = normalizeError(Object.assign(new TypeError('terminated'), { cause: Object.assign(new Error('incorrect header check'), { code: 'Z_DATA_ERROR' }) }));
    expect(n.message).toMatch(/compressed response body is invalid/);
  });
});

describe('CLI', () => {
  it('send -e with an unknown environment fails and names the ones there are; lint-tests reads a file anywhere', async () => {
    const t = tempDir();
    const store = WorkspaceStore.create(join(t.dir, 'ws'), 'W');
    store.close();
    try {
      const r = await runCli(['send', `${base}/ok`, '-e', 'Nope', '-w', join(t.dir, 'ws')], { home: join(t.dir, 'home') });
      expect(r.status).toBe(2);
      expect(r.err).toMatch(/No environment "Nope"\. Available: Development/);
      const outside = join(t.dir, 'elsewhere');
      mkdirSync(outside);
      writeFileSync(join(outside, 'a.yaml'), 'name: a\ntests:\n  - id: t1\n    type: http\n    request: { method: GET, url: http://x }\n');
      const l = await runCli(['lint-tests', join(outside, 'a.yaml'), '--json', '-w', join(t.dir, 'ws')], { home: join(t.dir, 'home') });
      expect(l.err).not.toMatch(/No such test file/);
      expect(JSON.parse(l.out).files).toBe(1);
    } finally {
      t.cleanup();
    }
  });
});
