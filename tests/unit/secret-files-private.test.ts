import { describe, expect, it } from 'vitest';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALLOW_WEAK_SECRET_STORE_ENV, CurrentValues, EncryptedFileSecretStore, MemorySecretStore, PRIVATE_FILE_MODE, atomicWrite, fileSink, safeStorageCipher, weakStorageBackend, writeOwned, type SafeStorageLike } from '../../packages/core/src/index.js';

const dir = () => mkdtempSync(join(tmpdir(), 'tp-private-'));
const mode = (p: string) => statSync(p).mode & 0o777;

const stub = (backend: string | undefined): SafeStorageLike => ({
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`),
  decryptString: (b) => b.toString().slice(4),
  getSelectedStorageBackend: backend === undefined ? undefined : () => backend,
});

describe('secrets are never stored with the public Linux key', () => {
  it('basic_text and unknown count as unavailable on Linux, so the store refuses to write', async () => {
    for (const b of ['basic_text', 'unknown']) {
      const cipher = safeStorageCipher(stub(b), { platform: 'linux', env: {} });
      expect(cipher.isAvailable()).toBe(false);
      await expect(new EncryptedFileSecretStore(join(dir(), 'secrets.json'), cipher).set('k', 'v')).rejects.toThrow(/refusing to store the secret in plain text/);
    }
    expect(weakStorageBackend('basic_text', 'linux')).toBe(true);
    expect(weakStorageBackend('basic_text', 'win32')).toBe(false);
  });

  it('a real keyring backend works; the weak one only when the person opts in', async () => {
    for (const b of ['gnome_libsecret', 'kwallet5', 'kwallet6']) expect(safeStorageCipher(stub(b), { platform: 'linux', env: {} }).isAvailable(), b).toBe(true);
    const optIn = safeStorageCipher(stub('basic_text'), { platform: 'linux', env: { [ALLOW_WEAK_SECRET_STORE_ENV]: '1' } });
    expect(optIn.isAvailable()).toBe(true);
    expect(optIn.backend).toMatch(/not secure/);
    // Windows and macOS have no backend to choose from
    expect(safeStorageCipher(stub(undefined), { platform: 'win32', env: {} }).isAvailable()).toBe(true);
    const s = new EncryptedFileSecretStore(join(dir(), 'secrets.json'), safeStorageCipher(stub('gnome_libsecret'), { platform: 'linux', env: {} }));
    await s.set('k', 'v');
    expect(s.get('k')).toBe('v');
  });
});

describe.skipIf(process.platform === 'win32')('sensitive files are written for this account only', () => {
  it('secrets.json, current values, the log and saved sessions are 0600; the folders 0700', async () => {
    const d = dir();
    const secrets = join(d, 'data', 'secrets.json');
    await new EncryptedFileSecretStore(secrets, safeStorageCipher(stub('gnome_libsecret'), { platform: 'linux', env: {} })).set('k', 'v');
    expect(mode(secrets)).toBe(PRIVATE_FILE_MODE);
    expect(mode(join(d, 'data'))).toBe(0o700);

    const cv = join(d, 'current-values', 'w.json');
    await new CurrentValues(cv, new MemorySecretStore(), 'w').set('environment', 'dev', 'a', 'b', false);
    expect(mode(cv)).toBe(PRIVATE_FILE_MODE);

    const log = join(d, 'logs', 'app.log');
    fileSink(log)({ time: 'now', level: 'INFO', scope: 'x', message: 'hello' } as never);
    expect(mode(log)).toBe(PRIVATE_FILE_MODE);

    const har = join(d, 'sessions', 's.har');
    writeOwned(har, '{}', { mode: PRIVATE_FILE_MODE });
    expect(mode(har)).toBe(PRIVATE_FILE_MODE);
    atomicWrite(har, '{"a":1}', { mode: PRIVATE_FILE_MODE });
    expect(mode(har)).toBe(PRIVATE_FILE_MODE);
  });
});
