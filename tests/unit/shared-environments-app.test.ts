import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { secretKeys } from '../../packages/core/src/index.js';

// Environments from another workspace in the app: added and removed with ws.shareAdd / ws.shareRemove; Save on one keeps
// only the secret values typed here (on this computer), never its file, which is changed where it lives.
const home = mkdtempSync(join(tmpdir(), 'tp-shared-app-'));
const be = new Backend({ appDir: home, emit: () => undefined });
afterAll(async () => {
  await be.dispose();
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

describe('shared environments in the app', () => {
  it('adds a folder, keeps only the secret values of a save, and removes the folder', async () => {
    const other = join(dirname(be.ws.root), 'platform-shared');
    mkdirSync(join(other, 'environments'), { recursive: true });
    writeFileSync(join(other, 'workspace.json'), JSON.stringify({ schemaVersion: '1.0', id: 'platform', name: 'Platform' }));
    const file = join(other, 'environments', 'platform-prod.json');
    const text = JSON.stringify({ id: 'platform-prod', name: 'Platform prod', variables: [{ key: 'token', value: '', secret: true }, { key: 'baseUrl', value: 'https://api.example.com' }] });
    writeFileSync(file, text);
    const rel = relative(be.ws.root, other).split('\\').join('/');
    const added = (await be.invoke('ws.shareAdd', { path: rel })) as { shared: Array<{ path: string }>; environments: Array<{ name: string; from: string }> };
    expect(added.environments).toEqual([{ name: 'Platform prod', from: 'platform-shared' }]);

    const saved = (await be.invoke('env.save', {
      env: { id: 'platform-prod', name: 'Platform prod', variables: [{ key: 'token', value: '', secret: true }, { key: 'baseUrl', value: 'https://elsewhere.example' }] },
      secrets: { token: 's3cret', notOurs: 'x' },
    })) as { name: string; secretsOnly: number };
    expect(saved).toMatchObject({ name: 'Platform prod', secretsOnly: 1 });
    expect(be.secrets.get(secretKeys.envVar('platform-prod', 'token'))).toBe('s3cret');
    expect(be.secrets.get(secretKeys.envVar('platform-prod', 'notOurs'))).toBeFalsy();
    expect(readFileSync(file, 'utf8')).toBe(text); // the file is the other workspace's: untouched
    // a rename (F2, the tab) is refused: it is renamed where it lives
    await expect(be.invoke('env.save', { env: { id: 'platform-prod', name: 'Renamed here', variables: [] } })).rejects.toThrow(/rename it there/);

    const removed = (await be.invoke('ws.shareRemove', { path: rel })) as { shared: unknown[]; environments: unknown[] };
    expect(removed).toEqual({ shared: [], environments: [] });
    await expect(be.invoke('ws.shareAdd', { path: '../nowhere-at-all' })).rejects.toThrow(/is not a workspace|has no environments folder/);
  });
});
