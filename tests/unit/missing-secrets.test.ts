import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore, MemorySecretStore, missingSecrets, secretKeys } from '../../packages/core/src/index.js';

/** After a clone every secret variable is empty on this computer: the list says which ones, and never what they hold. */
const dir = mkdtempSync(join(tmpdir(), 'tp-missing-secrets-'));
const store = WorkspaceStore.create(join(dir, 'ws'), 'MS');
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe('missingSecrets', () => {
  it('lists the secret variables without a value, per environment and in the globals', () => {
    store.saveEnvironment({ id: 'staging', name: 'Staging', variables: [{ key: 'apiKey', value: '', secret: true, enabled: true }, { key: 'baseUrl', value: 'http://x', enabled: true }, { key: 'token', value: '', secret: true, enabled: true }, { key: 'off', value: '', secret: true, enabled: false }] } as never);
    store.updateWorkspace({ variables: [{ key: 'signingKey', value: '', secret: true, enabled: true }] } as never);
    const secrets = new MemorySecretStore();
    const r = missingSecrets(store, secrets);
    expect(r.items.map(({ envVar: _e, ...i }) => i)).toEqual([
      { scope: 'environment', environment: 'Staging', key: 'apiKey' },
      { scope: 'environment', environment: 'Staging', key: 'token' },
      { scope: 'globals', key: 'signingKey' },
    ]);
    expect(r.count).toBe(3);
    expect(r.text).toBe('3 secrets have no value on this computer: Staging: apiKey, token; globals: signingKey.');
    // entering a value makes it leave the list; the value itself is never in the answer
    secrets.set(secretKeys.envVar('staging', 'apiKey'), 'sk-very-secret');
    secrets.set(secretKeys.workspaceVar(store.id, 'signingKey'), 'also-secret');
    const after = missingSecrets(store, secrets);
    expect(after.items.map((i) => i.key)).toEqual(['token']);
    expect(JSON.stringify(after)).not.toMatch(/sk-very-secret|also-secret/);
    secrets.set(secretKeys.envVar('staging', 'token'), 'x');
    expect(missingSecrets(store, secrets)).toMatchObject({ count: 0, text: 'Every secret has a value.' });
  });
});
