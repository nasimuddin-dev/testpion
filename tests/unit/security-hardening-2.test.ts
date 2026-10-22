import { afterAll, describe, expect, it } from 'vitest';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WorkspaceStore,
  exportOtlp,
  isLoopbackHostHeader,
  isLoopbackOrigin,
  notifyMonitorWebhook,
  setNetworkPolicy,
  startMockServer,
  startRecorder,
  type Collection,
  type MonitorResult,
} from '../../packages/core/src/index.js';
import { captureScript } from '../../apps/desktop/electron/capture.js';
import { permissionAllowed } from '../../apps/desktop/electron/permissions.js';

// the 2026-10-22 security review, P2 items

/** One request with a Host and an Origin of the caller's choosing (what a web page or a rebinding name sends). */
const call = (port: number, path: string, headers: Record<string, string>, method = 'GET') =>
  new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end();
  });

describe('local servers: DNS rebinding and cross-site pages', () => {
  it('Host and Origin helpers', () => {
    for (const h of ['localhost', 'localhost:8080', '127.0.0.1:4010', '[::1]:80', 'app.localhost:3000']) expect(isLoopbackHostHeader(h), h).toBe(true);
    for (const h of ['evil.example', 'evil.example:4010', '127.0.0.1.evil.example', undefined, '']) expect(isLoopbackHostHeader(h), String(h)).toBe(false);
    expect(isLoopbackOrigin('http://localhost:5173')).toBe(true);
    expect(isLoopbackOrigin('https://evil.example')).toBe(false);
    expect(isLoopbackOrigin('null')).toBe(false);
  });

  it('the recorder refuses another Host, answers CORS for this computer only, and never sends credentials with *', async () => {
    const target = createServer((_q, r) => r.end('target'));
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    const rec = await startRecorder({ target: `http://127.0.0.1:${(target.address() as AddressInfo).port}` });
    try {
      const host = `127.0.0.1:${rec.port}`;
      expect((await call(rec.port, '/x', { host: 'evil.example' })).status).toBe(421);
      const evil = await call(rec.port, '/x', { host, origin: 'https://evil.example' });
      expect(evil.status).toBe(403);
      expect(evil.headers['access-control-allow-origin']).toBeUndefined();
      const dev = await call(rec.port, '/x', { host, origin: 'http://localhost:5173' });
      expect(dev.status).toBe(200);
      expect(dev.headers['access-control-allow-origin']).toBe('http://localhost:5173');
      expect(dev.headers['access-control-allow-credentials']).toBe('true');
      const plain = await call(rec.port, '/x', { host });
      expect(plain.headers['access-control-allow-origin']).toBe('*');
      expect(plain.headers['access-control-allow-credentials']).toBeUndefined();
    } finally {
      await rec.close();
      target.close();
    }
    const listed = await startRecorder({ target: 'http://127.0.0.1:9', allowOrigins: ['https://app.example'] });
    try {
      expect((await call(listed.port, '/x', { host: `127.0.0.1:${listed.port}`, origin: 'https://app.example' })).headers['access-control-allow-origin']).toBe('https://app.example');
    } finally {
      await listed.close();
    }
  });

  it('the mock server refuses another Host', async () => {
    const collection = { id: 'c', name: 'c', items: [], variables: [] } as unknown as Collection;
    const mock = await startMockServer(collection, {});
    try {
      expect((await call(mock.port, '/x', { host: 'rebind.example' })).status).toBe(421);
      expect((await call(mock.port, '/x', { host: `127.0.0.1:${mock.port}` })).status).not.toBe(421);
    } finally {
      await mock.close();
    }
  });
});

describe('outbound calls that bypassed the network policy', () => {
  afterAll(() => setNetworkPolicy({ blockPrivateNetworks: false }));
  const result = { status: 'failed', total: 1, passed: 0, failed: 1, errors: 0, startedAt: new Date().toISOString() } as unknown as MonitorResult;

  it('monitor webhooks and OTLP export are refused for private addresses when the server blocks them', async () => {
    setNetworkPolicy({ blockPrivateNetworks: true });
    const r = await notifyMonitorWebhook('http://169.254.169.254/latest/meta-data', { id: 'm', name: 'M' }, result);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Blocked by the network policy/);
    await expect(exportOtlp([], { endpoint: 'http://127.0.0.1:4318' })).rejects.toThrow(/Blocked by the network policy/);
  });

  it('the desktop default still reaches them', async () => {
    setNetworkPolicy({ blockPrivateNetworks: false });
    const srv = createServer((_q, r) => r.end('ok'));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const r = await notifyMonitorWebhook(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/hook`, { id: 'm', name: 'M' }, result);
      expect(r.ok).toBe(true);
    } finally {
      srv.close();
    }
  });
});

describe('tests.delete', () => {
  it('refuses the tests folder itself, deletes a file inside it', () => {
    const root = mkdtempSync(join(tmpdir(), 'tp-testdel-'));
    try {
      const ws = WorkspaceStore.create(root, 'w');
      mkdirSync(join(root, 'tests', 'sub'), { recursive: true });
      writeFileSync(join(root, 'tests', 'a.yaml'), 'name: a\n');
      writeFileSync(join(root, 'tests', 'sub', 'b.yaml'), 'name: b\n');
      for (const rel of ['.', '', './', 'sub/..']) expect(() => ws.deleteTestFile(rel), JSON.stringify(rel)).toThrow(/not tests\/ itself/);
      expect(() => ws.deleteTestFile('../collections')).toThrow();
      ws.deleteTestFile('a.yaml');
      ws.deleteTestFile('sub');
      ws.close();
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

describe('the installed app', () => {
  it('ignores TESTPION_CAPTURE_SCRIPT unless it was started with --testpion-capture', () => {
    const env = { TESTPION_CAPTURE_SCRIPT: '/tmp/evil.js' };
    expect(captureScript(env, ['app'], true)).toEqual({ ignored: '/tmp/evil.js' });
    expect(captureScript(env, ['app', '--testpion-capture'], true)).toEqual({ script: '/tmp/evil.js' });
    expect(captureScript(env, ['app'], false)).toEqual({ script: '/tmp/evil.js' });
    expect(captureScript({}, ['app'], true)).toEqual({});
  });

  it('grants the page only the web permissions it uses', () => {
    const page = 'file:///C:/Program Files/TestPion/resources/app.asar/dist/index.html';
    for (const p of ['notifications', 'clipboard-read', 'clipboard-sanitized-write']) expect(permissionAllowed(p, page), p).toBe(true);
    for (const p of ['media', 'geolocation', 'camera', 'microphone', 'midi', 'display-capture', 'openExternal', 'fullscreen']) expect(permissionAllowed(p, page), p).toBe(false);
    expect(permissionAllowed('notifications', 'tpviz://abc/')).toBe(false);
    expect(permissionAllowed('notifications', 'https://evil.example/')).toBe(false);
    expect(permissionAllowed('notifications', 'http://localhost:5173/', 'http://localhost:5173')).toBe(true);
    expect(permissionAllowed('notifications', 'http://localhost:5173/')).toBe(false);
  });
});
