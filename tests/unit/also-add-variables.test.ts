import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { addVariablesToEnvironments, MemorySecretStore, secretKeys, WorkspaceStore } from '../../packages/core/src/index.js';
import { runCli, tempDir, cliData } from '../helpers.js';

// WF-14: a variable added to one environment, offered to the others: added where missing (never overwriting), empty or
// with the same value; a secret stays a secret (its value copied secret store to secret store).
const tmp = tempDir('tp-alsoadd-');
let root = '';

const fresh = (name: string) => {
  const dir = join(tmp.dir, name);
  const s = WorkspaceStore.create(dir, name);
  s.saveEnvironment({
    id: 'dev',
    name: 'Dev',
    variables: [
      { key: 'baseUrl', value: 'http://dev', enabled: true },
      { key: 'token', value: '', secret: true, enabled: true },
    ],
  } as never);
  s.saveEnvironment({ id: 'stg', name: 'Staging', variables: [{ key: 'baseUrl', value: 'http://stg', enabled: true }] } as never);
  s.saveEnvironment({ id: 'prd', name: 'Production', isProduction: true, variables: [] } as never);
  return s;
};

beforeAll(() => {
  const s = fresh('ws');
  root = s.root;
  s.close();
});
afterAll(() => tmp.cleanup());

describe('addVariablesToEnvironments', () => {
  it('adds what is missing, empty by default, and never changes what is there', async () => {
    const s = fresh('a');
    try {
      const r = await addVariablesToEnvironments(s, 'Dev', ['baseUrl'], ['Staging', 'Production', 'Dev']);
      expect(r).toEqual([
        { environment: 'Staging', added: [] },
        { environment: 'Production', added: ['baseUrl'] },
      ]);
      expect(s.getEnvironment('stg')!.variables.find((v) => v.key === 'baseUrl')!.value).toBe('http://stg');
      expect(s.getEnvironment('prd')!.variables).toEqual([expect.objectContaining({ key: 'baseUrl', value: '', enabled: true })]);
    } finally {
      s.close();
    }
  });

  it('copies the value when asked; a secret is copied through the secret store, never into the file', async () => {
    const s = fresh('b');
    const secrets = new MemorySecretStore();
    await secrets.set(secretKeys.envVar('dev', 'token'), 's3cret');
    try {
      await addVariablesToEnvironments(s, 'dev', ['baseUrl', 'token'], ['Production'], { copy: true, secrets });
      const prd = s.getEnvironment('prd')!;
      expect(prd.variables.find((v) => v.key === 'baseUrl')!.value).toBe('http://dev');
      expect(prd.variables.find((v) => v.key === 'token')).toMatchObject({ value: '', secret: true });
      expect(secrets.get(secretKeys.envVar('prd', 'token'))).toBe('s3cret');
      // without a secret store (CLI, agents): the secret is added without a value
      await addVariablesToEnvironments(s, 'dev', ['token'], ['Staging'], { copy: true });
      expect(s.getEnvironment('stg')!.variables.find((v) => v.key === 'token')).toMatchObject({ value: '', secret: true });
    } finally {
      s.close();
    }
  });

  it('says which environment does not exist', async () => {
    const s = fresh('c');
    try {
      await expect(addVariablesToEnvironments(s, 'Dev', ['baseUrl'], ['Nope'])).rejects.toThrow(/No environment "Nope"/);
      expect(await addVariablesToEnvironments(s, 'Dev', ['unknown'], ['Staging'])).toEqual([]);
    } finally {
      s.close();
    }
  });
});

describe('over RPC and the CLI', () => {
  it('vars.setInEnvironment adds to the environment and, with alsoIn, to the others', async () => {
    const be = new Backend({ appDir: join(tmp.dir, 'app'), emit: () => undefined, noMonitors: true });
    try {
      be.openStore(root);
      const r = (await be.invoke('vars.setInEnvironment', { environment: 'Dev', name: 'apiKey', value: 'k1', alsoIn: ['Staging', 'Production'], copy: false })) as { also: unknown };
      expect(r.also).toEqual([
        { environment: 'Staging', added: ['apiKey'] },
        { environment: 'Production', added: ['apiKey'] },
      ]);
      expect(be.ws.getEnvironment('stg')!.variables.find((v) => v.key === 'apiKey')!.value).toBe('');
      expect(await be.invoke('vars.addToEnvironments', { from: 'Dev', keys: ['apiKey'], to: ['Staging'], copy: true })).toEqual([{ environment: 'Staging', added: [] }]);
    } finally {
      await be.dispose();
    }
  });

  it('testpion env set --also-in', async () => {
    const r = await runCli(['env', 'set', 'Dev', 'region=eu', '-w', root, '--also-in', 'Staging,Production', '--copy', '--json'], { home: join(tmp.dir, 'home') });
    expect(r.status).toBe(0);
    expect(cliData(r.out)).toMatchObject({
      environment: 'Dev',
      set: ['region'],
      also: [
        { environment: 'Staging', added: ['region'] },
        { environment: 'Production', added: ['region'] },
      ],
    });
    const s = WorkspaceStore.open(root);
    try {
      expect(s.getEnvironment('prd')!.variables.find((v) => v.key === 'region')!.value).toBe('eu');
    } finally {
      s.close();
    }
  }, 60_000);
});
