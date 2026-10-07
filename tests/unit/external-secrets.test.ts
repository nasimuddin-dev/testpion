import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createEngineContext,
  environmentSecretRefs,
  externalSecrets,
  fetchSecretRef,
  isSecretRef,
  MemorySecretStore,
  prefetchEnvironmentSecrets,
  secretRefCommand,
  setSecretRunner,
  trustCommand,
  WorkspaceStore,
} from '../../packages/core/src/index.js';

afterEach(() => externalSecrets.clear());

describe('secret manager references', () => {
  it('knows a reference from a value', () => {
    expect(isSecretRef('op://Clinic/API/key')).toBe(true);
    expect(isSecretRef('vault://secret/clinic#apiKey')).toBe(true);
    expect(isSecretRef('aws-sm://prod/clinic#apiKey')).toBe(true);
    expect(isSecretRef('https://api.example.com')).toBe(false);
    expect(isSecretRef('op://')).toBe(false);
    expect(isSecretRef('plain value')).toBe(false);
  });

  it('reads each manager with its own tool, no shell for op, vault and aws', () => {
    expect(secretRefCommand('op://Clinic/API Keys/credential')).toMatchObject({ manager: '1password', command: 'op', args: ['read', '--no-newline', 'op://Clinic/API Keys/credential'] });
    expect(secretRefCommand('vault://secret/clinic#apiKey')).toMatchObject({ command: 'vault', args: ['kv', 'get', '-field=apiKey', 'secret/clinic'] });
    expect(secretRefCommand('aws-sm://prod/clinic?region=eu-west-1#apiKey')).toMatchObject({
      command: 'aws',
      args: ['secretsmanager', 'get-secret-value', '--secret-id', 'prod/clinic', '--query', 'SecretString', '--output', 'text', '--region', 'eu-west-1'],
      jsonKey: 'apiKey',
    });
    expect(secretRefCommand('azure-kv://clinic-kv/api-key')).toMatchObject({ command: 'az', args: ['keyvault', 'secret', 'show', '--vault-name', 'clinic-kv', '--name', 'api-key', '--query', 'value', '-o', 'tsv'] });
    expect(secretRefCommand('gcp-sm://my-project/api-key#3')).toMatchObject({ command: 'gcloud', args: ['secrets', 'versions', 'access', '3', '--secret=api-key', '--project=my-project'] });
  });

  it('refuses parts a shell would read, and incomplete references', () => {
    expect(() => secretRefCommand('azure-kv://kv/name&calc')).toThrow(/may only have letters/);
    expect(() => secretRefCommand('gcp-sm://p/s|x')).toThrow(/may only have letters/);
    expect(() => secretRefCommand('vault://secret/clinic')).toThrow(/Name the field after #/);
    expect(() => secretRefCommand('op://vault/item')).toThrow(/op:\/\/vault\/item\/field/);
  });

  it('takes a key out of a JSON secret, and trims the newline the tools print', async () => {
    const restore = setSecretRunner(async (command) => (command === 'aws' ? '{"apiKey":"k-123","other":1}\n' : 'from-vault\n'));
    try {
      expect(await fetchSecretRef('aws-sm://prod/clinic#apiKey')).toBe('k-123');
      expect(await fetchSecretRef('vault://secret/clinic#apiKey')).toBe('from-vault');
      await expect(fetchSecretRef('aws-sm://prod/clinic#missing')).rejects.toThrow(/has no key "missing"/);
    } finally {
      restore();
    }
  });

  it('prefetches what is allowed, reports the rest, and keeps values in memory', async () => {
    const calls: string[] = [];
    const restore = setSecretRunner(async (command, args) => {
      calls.push(command);
      if (command === 'gcloud') throw new Error('not signed in');
      return `${command}-value`;
    });
    try {
      const r = await externalSecrets.prefetch(['op://Clinic/API/key', 'vault://secret/x#y', 'gcp-sm://p/s'], { allow: (_ref, cmd) => cmd.command !== 'vault' });
      expect(r.fetched).toEqual(['op://Clinic/API/key']);
      expect(r.blocked).toEqual([{ ref: 'vault://secret/x#y', label: 'HashiCorp Vault', commandLine: 'vault kv get -field=y secret/x' }]);
      expect(r.failed[0]).toMatchObject({ ref: 'gcp-sm://p/s', error: 'not signed in' });
      expect(externalSecrets.get('op://Clinic/API/key')).toBe('op-value');
      // read once: the next prefetch doesn't run op again
      await externalSecrets.prefetch(['op://Clinic/API/key'], { allow: () => true });
      expect(calls.filter((c) => c === 'op')).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it('a workspace reads only the references allowed on this computer; requests get the value, redacted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-extsec-'));
    const restore = setSecretRunner(async () => 's3cret-from-1password');
    try {
      const store = WorkspaceStore.create(dir, 'ext');
      store.saveEnvironment({ id: 'dev', name: 'Development', variables: [{ key: 'apiKey', value: 'op://Clinic/API/key' }, { key: 'baseUrl', value: 'http://127.0.0.1' }] });
      expect(environmentSecretRefs(store.getEnvironment('dev'))).toEqual(['op://Clinic/API/key']);
      const first = await prefetchEnvironmentSecrets(store, 'dev');
      expect(first.blocked.map((b) => b.commandLine)).toEqual(['op read --no-newline op://Clinic/API/key']);
      expect(externalSecrets.get('op://Clinic/API/key')).toBeUndefined();
      trustCommand(store, 'op', ['read', '--no-newline', 'op://Clinic/API/key']);
      expect((await prefetchEnvironmentSecrets(store, 'dev')).fetched).toEqual(['op://Clinic/API/key']);
      const ctx = createEngineContext({ store, secrets: new MemorySecretStore(), environment: 'dev' });
      expect(ctx.vars.resolve('Bearer {{apiKey}}')).toBe('Bearer s3cret-from-1password');
      expect(ctx.redactor.redactString('token s3cret-from-1password')).not.toContain('s3cret');
      await ctx.dispose();
      // the CLI reads every reference
      externalSecrets.clear();
      expect((await prefetchEnvironmentSecrets(store, 'dev', { trustAll: true })).fetched).toHaveLength(1);
      store.close();
    } finally {
      restore();
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
