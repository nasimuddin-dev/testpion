import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySecretStore, WorkspaceStore, copyVariableToEnvironment, expandEnvironmentGroups, secretKeys, setEnvironmentVariables, unsetEnvironmentVariables } from '../../packages/core/src/index.js';

describe('environment groups in a matrix (--env-matrix group:Acme)', () => {
  it('unfolds a group into its environments, keeps names as written, and never repeats one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-envgroups-'));
    const store = WorkspaceStore.create(join(dir, 'ws'), 'W');
    try {
      store.saveEnvironment({ id: 'dev', name: 'Dev', variables: [] } as never);
      store.saveEnvironment({ id: 'acme-1', name: 'Acme Staging', group: 'Acme', variables: [] } as never);
      store.saveEnvironment({ id: 'acme-2', name: 'Acme Production', group: 'Acme', variables: [] } as never);
      expect(expandEnvironmentGroups(store, ['group:Acme'])).toEqual(['Acme Staging', 'Acme Production']);
      expect(expandEnvironmentGroups(store, ['acme', 'Dev'])).toEqual(['Acme Staging', 'Acme Production', 'Dev']);
      expect(expandEnvironmentGroups(store, ['Dev', 'Acme Staging', 'Nope'])).toEqual(['Dev', 'Acme Staging', 'Nope']);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('copy a variable to another environment (Compare → ←, env copy)', () => {
  it('replaces or adds the variable as on the source; a secret value goes store to store and is never in the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-envcopy-'));
    const store = WorkspaceStore.create(join(dir, 'ws'), 'W');
    const secrets = new MemorySecretStore();
    try {
      store.saveEnvironment({ id: 'staging', name: 'Staging', variables: [{ key: 'baseUrl', value: 'https://staging.example.com', enabled: true }, { key: 'flag', value: 'on', enabled: false }, { key: 'apiKey', value: '', enabled: true, secret: true } as never] } as never);
      store.saveEnvironment({ id: 'prod', name: 'Production', variables: [{ key: 'baseUrl', value: 'https://api.example.com', enabled: true }] } as never);
      await secrets.set(secretKeys.envVar('staging', 'apiKey'), 'sk-staging');
      expect(await copyVariableToEnvironment(store, 'Staging', 'Production', 'baseUrl', { secrets })).toEqual({ from: 'Staging', to: 'Production', key: 'baseUrl', secret: false, replaced: true, secretCopied: false });
      expect(await copyVariableToEnvironment(store, 'staging', 'prod', 'flag', { secrets })).toMatchObject({ replaced: false, secret: false });
      expect(await copyVariableToEnvironment(store, 'staging', 'prod', 'apiKey', { secrets })).toMatchObject({ secret: true, replaced: false, secretCopied: true });
      const prod = store.getEnvironment('prod')!;
      expect(prod.variables.map((v) => [v.key, v.value, v.enabled, !!(v as { secret?: boolean }).secret])).toEqual([
        ['baseUrl', 'https://staging.example.com', true, false],
        ['flag', 'on', false, false],
        ['apiKey', '', true, true],
      ]);
      expect(secrets.get(secretKeys.envVar('prod', 'apiKey'))).toBe('sk-staging');
      await expect(copyVariableToEnvironment(store, 'staging', 'staging', 'flag')).rejects.toThrow(/two different environments/);
      await expect(copyVariableToEnvironment(store, 'staging', 'prod', 'nope')).rejects.toThrow(/has no variable nope/);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('editing environment variables (CLI / agents)', () => {
  it('sets and removes plain variables, creates environments on request, refuses secrets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-envedit-'));
    const store = WorkspaceStore.create(join(dir, 'ws'), 'W');
    try {
      store.saveEnvironment({ id: 'dev', name: 'Dev', variables: [{ key: 'token', value: '', enabled: true, secret: true } as never, { key: 'a', value: '1', enabled: false }] } as never);
      const env = setEnvironmentVariables(store, 'dev', { a: '2', b: 'x' });
      expect(env.variables.map((v) => [v.key, v.value, v.enabled])).toEqual([
        ['token', '', true],
        ['a', '2', true],
        ['b', 'x', true],
      ]);
      expect(() => setEnvironmentVariables(store, 'Dev', { token: 'sk-1' })).toThrow(/secret variable/);
      expect(() => setEnvironmentVariables(store, 'QA', { a: '1' })).toThrow(/No environment "QA"/);
      expect(setEnvironmentVariables(store, 'QA', { a: '1' }, { create: true }).name).toBe('QA');
      expect(() => setEnvironmentVariables(store, 'QA', { 'bad key': '1' })).toThrow(/not a valid variable name/);
      expect(unsetEnvironmentVariables(store, 'Dev', ['b']).variables.map((v) => v.key)).toEqual(['token', 'a']);
      expect(() => unsetEnvironmentVariables(store, 'Dev', ['token'])).toThrow(/secret variable/);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
