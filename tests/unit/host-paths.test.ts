import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { assertHostPath, defaultSettings, executeHttp, setNetworkPolicy } from '../../packages/core/src/index.js';

// the host capability `localFiles`: the desktop reads what the person picked; a shared server reaches only the user's own folder
const root = mkdtempSync(join(tmpdir(), 'tp-hostpath-'));
const userRoot = join(root, 'user');
mkdirSync(userRoot, { recursive: true });
const be = new Backend({ appDir: join(root, 'data'), emit: () => {}, noMonitors: true, serverMode: true, userRoot });

afterAll(() => {
  setNetworkPolicy({ allowLocalFiles: true, localFileRoots: undefined });
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* left for the OS */
  }
});

const refused = /does not read or write files on its own computer/;

describe('a server host refuses paths on its own computer', () => {
  it('reports the capability', async () => {
    expect(((await be.invoke('app.info', {})) as { capabilities: { localFiles: boolean } }).capabilities.localFiles).toBe(false);
  });

  it('every RPC that takes a host path is refused outside the user folder', async () => {
    const outside = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc';
    await expect(be.invoke('git.clone', { url: 'https://example.invalid/r.git', dest: outside })).rejects.toThrow(refused);
    await expect(be.invoke('git.openFolder', { path: outside })).rejects.toThrow(refused);
    await expect(be.invoke('ws.open', { ref: outside })).rejects.toThrow(refused);
    await expect(be.invoke('col.previewDataFile', { path: join(outside, 'passwd.csv') })).rejects.toThrow(refused);
    await expect(be.invoke('terminal.create', { cwd: outside })).rejects.toThrow(refused);
    await expect(be.invoke('bundle.preview', { path: join(outside, 'x.testpion.zip') })).rejects.toThrow(refused);
  });

  it('a name for ws.open is not a path, and the user folder is reachable', async () => {
    await expect(be.invoke('ws.open', { ref: 'no-such-workspace' })).rejects.not.toThrow(refused);
    expect(assertHostPath(join(userRoot, 'w'), 'x')).toBe(join(userRoot, 'w'));
  });

  it('a client certificate path in a request is read through the same gate', async () => {
    const outside = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd';
    await expect(executeHttp({ method: 'GET', url: 'https://127.0.0.1:9/', settings: { clientCert: { certPath: outside, keyPath: outside } } as never }, {})).rejects.toThrow(refused);
  });

  it('settings.save ignores the environment variables the window allows', async () => {
    const s = (await be.invoke('settings.save', { ...defaultSettings(), envVariables: ['AWS_SECRET_ACCESS_KEY'] })) as { envVariables?: string[] };
    expect(s.envVariables ?? []).toEqual([]);
    expect(be.settings.envVariables ?? []).toEqual([]);
  });
});
