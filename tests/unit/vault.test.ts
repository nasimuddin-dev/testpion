import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChainSecretStore, EnvSecretStore, VaultSecretStore, osKeyring, readOnlySecrets, type VaultKeyring } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers';

/**
 * The vault (storage/vault.ts): the secret store the command line writes and the app reads. Values are sealed one by
 * one under a key from a passphrase or from the operating system's keyring; here the keyring is a fake one, and the
 * real Windows one where the test runs on Windows.
 */
const dirs: Array<ReturnType<typeof tempDir>> = [];
const dir = () => (dirs.push(tempDir('tp-vault-')), dirs.at(-1)!.dir);
afterEach(() => {
  for (const d of dirs.splice(0)) d.cleanup();
});

/** A keyring that keeps the key in memory (what DPAPI, the Keychain and the Secret Service do behind their tools). */
const fakeKeyring = (o: { available?: boolean } = {}): VaultKeyring & { key?: Buffer; stored: number } => ({
  name: 'Test keyring',
  stored: 0,
  available() {
    return o.available === false ? { ok: false, why: 'no keyring here' } : { ok: true };
  },
  read() {
    return this.key;
  },
  store(key) {
    this.key = key;
    this.stored++;
  },
});

describe('the vault', () => {
  it('keeps a value under a passphrase: sealed in the file, read back by another process with the passphrase', async () => {
    const d = dir();
    const v = new VaultSecretStore(d, { passphrase: 'correct horse' });
    expect(v.status()).toMatchObject({ exists: false, key: 'passphrase', usable: true, count: 0 });
    await v.set('env.dev.token', 'tok-12345');
    const text = readFileSync(join(d, 'secrets.vault.json'), 'utf8');
    expect(text).not.toContain('tok-12345');
    expect(JSON.parse(text).key.from).toBe('passphrase');
    const again = new VaultSecretStore(d, { env: { TESTPION_VAULT_PASSPHRASE: 'correct horse' } });
    expect(again.get('env.dev.token')).toBe('tok-12345');
    expect(again.list()).toEqual(['env.dev.token']);
    expect(again.get('env.dev.other')).toBeUndefined();
    await again.delete('env.dev.token');
    expect(new VaultSecretStore(d, { passphrase: 'correct horse' }).list()).toEqual([]);
  });

  it('a wrong passphrase, or none, reads nothing and says why; it never throws from a read', async () => {
    const d = dir();
    await new VaultSecretStore(d, { passphrase: 'right' }).set('a', '1');
    const wrong = new VaultSecretStore(d, { passphrase: 'wrong' });
    expect(wrong.get('a')).toBeUndefined();
    expect(wrong.problem).toMatch(/does not open with this passphrase/);
    expect(wrong.status()).toMatchObject({ usable: false, count: 1 });
    const none = new VaultSecretStore(d, { env: {}, keyring: fakeKeyring() });
    expect(none.get('a')).toBeUndefined();
    expect(none.problem).toMatch(/set TESTPION_VAULT_PASSPHRASE/);
    // a write with the wrong passphrase is refused: it would seal a value no one can read beside the others
    await expect(new VaultSecretStore(d, { passphrase: 'wrong' }).set('b', '2')).rejects.toThrow(/does not open/);
  });

  it('keeps the key in the keyring when there is no passphrase, and asks for it only when a value is in the vault', async () => {
    const d = dir();
    const ring = fakeKeyring();
    const v = new VaultSecretStore(d, { env: {}, keyring: ring });
    expect(v.get('nothing')).toBeUndefined();
    expect(ring.stored).toBe(0);
    expect(existsSync(join(d, 'secrets.vault.json'))).toBe(false);
    await v.set('provider.openai.apiKey', 'sk-test');
    expect(ring.stored).toBe(1);
    expect(ring.key).toHaveLength(32);
    expect(JSON.parse(readFileSync(join(d, 'secrets.vault.json'), 'utf8')).key).toEqual({ from: 'os', keyring: 'Test keyring' });
    expect(new VaultSecretStore(d, { env: {}, keyring: ring }).get('provider.openai.apiKey')).toBe('sk-test');
    // another computer: the file is there, the key is not
    const other = new VaultSecretStore(d, { env: {}, keyring: fakeKeyring() });
    expect(other.get('provider.openai.apiKey')).toBeUndefined();
    expect(other.problem).toMatch(/another user or on another computer/);
  });

  it('says what to do when there is no keyring and no passphrase', async () => {
    const v = new VaultSecretStore(dir(), { env: {}, keyring: fakeKeyring({ available: false }) });
    expect(v.status()).toMatchObject({ usable: false, why: 'no keyring here' });
    await expect(v.set('a', '1')).rejects.toThrow(/No place to keep the vault key: no keyring here/);
  });

  it('a value is bound to its name: moved under another name it does not open', async () => {
    const d = dir();
    const v = new VaultSecretStore(d, { passphrase: 'p' });
    await v.set('a', 'value-a');
    await v.set('b', 'value-b');
    const file = join(d, 'secrets.vault.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.secrets.b = data.secrets.a;
    writeFileSync(file, JSON.stringify(data));
    const again = new VaultSecretStore(d, { passphrase: 'p' });
    expect(again.get('a')).toBe('value-a');
    expect(again.get('b')).toBeUndefined();
  });

  it('a file that is not a vault is refused, not overwritten', async () => {
    const d = dir();
    writeFileSync(join(d, 'secrets.vault.json'), '{"secrets":"nope"}');
    const v = new VaultSecretStore(d, { passphrase: 'p' });
    expect(v.status()).toMatchObject({ usable: false });
    await expect(v.set('a', '1')).rejects.toThrow(/not a vault file/);
    expect(readFileSync(join(d, 'secrets.vault.json'), 'utf8')).toBe('{"secrets":"nope"}');
  });

  it('in the chain of the command line an environment variable wins, and a run cannot write the vault', async () => {
    const d = dir();
    await new VaultSecretStore(d, { passphrase: 'p' }).set('provider.demo.apiKey', 'from-vault');
    const chain = (env: Record<string, string>) => new ChainSecretStore([new EnvSecretStore(env), readOnlySecrets(new VaultSecretStore(d, { passphrase: 'p' }))]);
    expect(chain({}).get('provider.demo.apiKey')).toBe('from-vault');
    expect(chain({ TESTPION_SECRET_PROVIDER_DEMO_APIKEY: 'from-env' }).get('provider.demo.apiKey')).toBe('from-env');
    expect(chain({}).writable).toBe(false);
    await expect(chain({}).set('x', 'y')).rejects.toThrow(/No writable secret store/);
  });

  it.runIf(process.platform === 'win32')(
    'Windows: the key is protected by DPAPI in a file beside the vault and opens again',
    async () => {
      const d = dir();
      const v = new VaultSecretStore(d, { env: {} });
      await v.set('env.dev.token', 'dpapi-value');
      expect(osKeyring(d).name).toBe('Windows DPAPI');
      expect(existsSync(join(d, 'secrets.vault.key'))).toBe(true);
      expect(new VaultSecretStore(d, { env: {} }).get('env.dev.token')).toBe('dpapi-value');
      // the protected key is not the key itself: it is longer, and only this user can unprotect it
      expect(readFileSync(join(d, 'secrets.vault.key'), 'utf8').trim().length).toBeGreaterThan(100);
    },
    60_000,
  );
});
