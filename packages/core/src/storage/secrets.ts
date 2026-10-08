import { ApsError } from '../errors.js';
import { atomicWrite, readJson } from './fsutil.js';
import type { SecretReader } from '../vars/variables.js';

/**
 * Secret storage abstraction. Secrets are never written in plain text:
 *  - Desktop: values are encrypted with the OS credential facility (Windows DPAPI /
 *    macOS Keychain / Linux Secret Service via Electron `safeStorage`).
 *  - CLI / CI: secrets come from environment variables (`TESTPION_SECRET_<NAME>`), the
 *    standard mechanism for CI secret injection.
 */
export interface SecretStore extends SecretReader {
  readonly kind: string;
  readonly writable: boolean;
  get(name: string): string | undefined;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  /** Names only — values are never listed. */
  list(): string[];
}

/** `provider.openai.apiKey` → `TESTPION_SECRET_PROVIDER_OPENAI_APIKEY` */
export function envNameForSecret(name: string): string {
  return 'TESTPION_SECRET_' + name.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
}

export class EnvSecretStore implements SecretStore {
  readonly kind = 'environment';
  readonly writable = false;
  constructor(private env: NodeJS.ProcessEnv = process.env) {}
  get(name: string): string | undefined {
    // earlier names of the project still work: FLUXPION_ (0.5), PROTOPION_ (0.4), PROTOLENS_ (0.2–0.3), APS_ (0.1)
    const n = envNameForSecret(name);
    for (const prefix of ['TESTPION_', 'FLUXPION_', 'PROTOPION_', 'PROTOLENS_', 'APS_']) {
      const v = this.env[n.replace(/^TESTPION_/, prefix)];
      if (v !== undefined) return v;
    }
    return undefined;
  }
  async set(): Promise<void> {
    throw new ApsError('ConfigurationError', 'Secrets cannot be written in CLI mode', { suggestions: ['Provide secrets as TESTPION_SECRET_* environment variables.'] });
  }
  async delete(): Promise<void> {
    /* no-op */
  }
  list(): string[] {
    return Object.keys(this.env)
      .filter((k) => k.startsWith('TESTPION_SECRET_'))
      .map((k) => k.slice(11).toLowerCase());
  }
}

export class MemorySecretStore implements SecretStore {
  readonly kind = 'memory';
  readonly writable = true;
  private m = new Map<string, string>();
  get(name: string) {
    return this.m.get(name);
  }
  async set(name: string, value: string) {
    this.m.set(name, value);
  }
  async delete(name: string) {
    this.m.delete(name);
  }
  list() {
    return [...this.m.keys()];
  }
}

export interface SecretCipher {
  isAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
  /** Human-readable backend name, e.g. "Windows DPAPI". */
  backend?: string;
}

/** File of individually encrypted values; the cipher is provided by the host (Electron safeStorage). */
export class EncryptedFileSecretStore implements SecretStore {
  readonly kind: string;
  readonly writable = true;
  private cache = new Map<string, string>();
  private raw: Record<string, string> = {};

  constructor(
    private path: string,
    private cipher: SecretCipher,
  ) {
    this.kind = `encrypted (${cipher.backend ?? 'os'})`;
    try {
      this.raw = readJson<{ secrets?: Record<string, string> }>(path, {}).secrets ?? {};
    } catch {
      this.raw = {};
    }
  }

  get(name: string): string | undefined {
    if (this.cache.has(name)) return this.cache.get(name);
    const enc = this.raw[name];
    if (!enc || !this.cipher.isAvailable()) return undefined;
    try {
      const v = this.cipher.decrypt(Buffer.from(enc, 'base64'));
      this.cache.set(name, v);
      return v;
    } catch {
      return undefined;
    }
  }

  async set(name: string, value: string): Promise<void> {
    if (!this.cipher.isAvailable())
      throw new ApsError('ConfigurationError', 'OS secure storage is not available; refusing to store the secret in plain text', {
        suggestions: ['On Linux, install and unlock a Secret Service provider (gnome-keyring or KWallet).', 'Alternatively provide the secret via an TESTPION_SECRET_* environment variable.'],
      });
    this.raw[name] = this.cipher.encrypt(value).toString('base64');
    this.cache.set(name, value);
    this.flush();
  }

  async delete(name: string): Promise<void> {
    delete this.raw[name];
    this.cache.delete(name);
    this.flush();
  }

  list(): string[] {
    return Object.keys(this.raw);
  }

  private flush(): void {
    atomicWrite(this.path, JSON.stringify({ schemaVersion: '1.0', note: 'Values are encrypted with the OS credential store and cannot be decrypted on another machine.', secrets: this.raw }, null, 2));
  }
}

/** Reads from the first store that has the value; writes go to the first writable store. */
export class ChainSecretStore implements SecretStore {
  readonly kind: string;
  readonly writable: boolean;
  constructor(private stores: SecretStore[]) {
    this.kind = stores.map((s) => s.kind).join(' + ');
    this.writable = stores.some((s) => s.writable);
  }
  get(name: string) {
    for (const s of this.stores) {
      const v = s.get(name);
      if (v !== undefined) return v;
    }
    return undefined;
  }
  async set(name: string, value: string) {
    const s = this.stores.find((x) => x.writable);
    if (!s) throw new ApsError('ConfigurationError', 'No writable secret store configured');
    await s.set(name, value);
  }
  async delete(name: string) {
    for (const s of this.stores) if (s.writable) await s.delete(name);
  }
  list() {
    return [...new Set(this.stores.flatMap((s) => s.list()))];
  }
}

/** Secret key naming helpers. */
export const secretKeys = {
  envVar: (envId: string, key: string) => `env.${envId}.${key}`,
  workspaceVar: (wsId: string, key: string) => `ws.${wsId}.${key}`,
  provider: (providerId: string) => `provider.${providerId}.apiKey`,
  /** The workspace cookie jar (JSON list of cookies). */
  cookies: (wsId: string) => `cookies.${wsId}`,
};
