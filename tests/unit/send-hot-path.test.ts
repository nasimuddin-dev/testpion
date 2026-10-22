import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore, executeHttp, requireEnvironment } from '../../packages/core/src/index.js';

let server: Server;
let base = '';
let dir = '';
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/small') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    if (req.url === '/png') return void res.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    res.writeHead(200, { 'content-type': 'text/plain' }).end('x'.repeat(5000));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = mkdtempSync(join(tmpdir(), 'tp-send-hot-'));
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

// S-2: every response was spooled to payloads/resp-*.bin, even a 50-byte one that fits the preview
describe('the response payload file', () => {
  const get = (path: string, payloadDir: string, maxPreviewBytes?: number) => executeHttp({ method: 'GET', url: `${base}${path}`, headers: [] } as never, { payloadDir, maxPreviewBytes });

  it('is not made for a body that fits the preview: no folder, no file', async () => {
    const payloadDir = join(dir, 'p-small');
    const { response } = await get('/small', payloadDir);
    expect(response.bodyPreview).toBe('{"ok":true}');
    expect(response.payloadPath).toBeUndefined();
    expect(existsSync(payloadDir)).toBe(false);
  });

  it('holds the whole body when it does not fit the preview', async () => {
    const payloadDir = join(dir, 'p-big');
    const { response } = await get('/big', payloadDir, 1000);
    expect(response.truncated).toBe(true);
    expect(readFileSync(response.payloadPath!, 'utf8')).toBe('x'.repeat(5000));
  });

  it('holds a small binary body too (its preview is only a placeholder)', async () => {
    const payloadDir = join(dir, 'p-bin');
    const { response } = await get('/png', payloadDir);
    expect(response.bodyPreview).toMatch(/^<binary data 8 bytes/);
    expect([...readFileSync(response.payloadPath!)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    expect(readdirSync(payloadDir)).toHaveLength(1);
  });
});

// S-1: a send parsed every environment file (listEnvironments) to check that its environment exists
describe('requiring the environment of a send', () => {
  it('100 sends with 20 environments read the files once', () => {
    const store = WorkspaceStore.create(join(dir, 'ws-env'), 'Envs');
    try {
      for (let i = 0; i < 20; i++) writeFileSync(store.path('environments', `env${i}.json`), JSON.stringify({ id: `env${i}`, name: `Env ${i}`, variables: [{ key: 'k', value: String(i), enabled: true }] }));
      let lists = 0;
      const real = store.listEnvironments.bind(store);
      store.listEnvironments = () => (lists++, real());
      for (let i = 0; i < 100; i++) expect(requireEnvironment(store, `Env ${i % 20}`, true).id).toBe(`env${i % 20}`);
      expect(lists).toBe(1);
      // a changed file is noticed
      writeFileSync(store.path('environments', 'env3.json'), JSON.stringify({ id: 'env3', name: 'Renamed', variables: [] }));
      expect(requireEnvironment(store, 'Renamed', true).id).toBe('env3');
      expect(lists).toBe(2);
    } finally {
      store.close();
    }
  });
});

// S-9: tp.require read the package file from disk on every script run
describe('script packages', () => {
  it('are read once while unchanged and again when the file changes', () => {
    const store = WorkspaceStore.create(join(dir, 'ws-pkg'), 'Pkg');
    try {
      mkdirSync(store.path('packages'), { recursive: true });
      const file = store.path('packages', 'util.js');
      writeFileSync(file, 'module.exports = 1;');
      expect(store.readScriptPackage('util')).toBe('module.exports = 1;');
      expect(store.readScriptPackage('util')).toBe('module.exports = 1;');
      writeFileSync(file, 'module.exports = 22;');
      expect(store.readScriptPackage('util')).toBe('module.exports = 22;');
      expect(store.readScriptPackage('missing')).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
