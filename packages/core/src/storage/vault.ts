import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApsError } from '../errors.js';
import { atomicWrite, readJson } from './fsutil.js';
import type { SecretStore } from './secrets.js';

/**
 * The vault: a secret store the command line can write to, and the app reads (planning/backlog.md B-27b). One file in
 * the app folder (`secrets.vault.json`), every value encrypted on its own with AES-256-GCM under one master key; the
 * secret's name is bound to its value (a value moved under another name does not decrypt).
 *
 * Where the master key comes from:
 *  - a passphrase in `TESTPION_VAULT_PASSPHRASE` (CI, containers, a computer without a keyring): the key is derived with
 *    scrypt and a salt kept in the file; or
 *  - the operating system's own protection, through the tool every such system ships: Windows DPAPI (the key, protected
 *    for this user, is kept beside the vault), the macOS Keychain (`security`), the Linux Secret Service (`secret-tool`).
 *    The key never appears on a command line: it goes to those tools on standard input.
 *
 * Nothing is opened until a value is asked for or written: a run that needs no vault secret never starts a tool.
 */
export const VAULT_PASSPHRASE_ENV = 'TESTPION_VAULT_PASSPHRASE';
export const VAULT_FILE = 'secrets.vault.json';
const KEY_FILE = 'secrets.vault.key';
const SERVICE = 'TestPion vault';

/** Where the master key is kept: how it is read, and how a new one is stored. */
export interface VaultKeyring {
  /** Shown by `testpion vault status` ("Windows DPAPI", "macOS Keychain" …). */
  readonly name: string;
  /** Whether this keyring can be used here; when not, why (and what to do). */
  available(): { ok: true } | { ok: false; why: string };
  /** The stored key, or undefined when none was stored yet. */
  read(): Buffer | undefined;
  store(key: Buffer): void;
}

interface VaultFile {
  schemaVersion: '1.0';
  note: string;
  /** How the master key is obtained: from the operating system, or from a passphrase with this salt. */
  key: { from: 'os'; keyring: string } | { from: 'passphrase'; salt: string };
  /** A known text encrypted with the key: a wrong passphrase or a key of another computer is told apart from a damaged value. */
  check: string;
  secrets: Record<string, string>;
}

const run = (cmd: string, args: string[], input?: string): { ok: boolean; out: string; err: string } => {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  return { ok: !r.error && r.status === 0, out: String(r.stdout ?? ''), err: String(r.stderr ?? r.error?.message ?? '') };
};

/** Windows: DPAPI through PowerShell. The protected key is a file beside the vault; only this user on this computer can unprotect it. */
function dpapiKeyring(dir: string): VaultKeyring {
  const file = join(dir, KEY_FILE);
  const ps = (verb: 'Protect' | 'Unprotect', b64: string) =>
    run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadLine()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${verb}($b,$null,'CurrentUser'))`],
      `${b64}\n`,
    );
  return {
    name: 'Windows DPAPI',
    available: () => ({ ok: true }),
    read: () => {
      if (!existsSync(file)) return undefined;
      const r = ps('Unprotect', readFileSync(file, 'utf8').trim());
      if (!r.ok || !r.out.trim()) throw new ApsError('ConfigurationError', 'The vault key cannot be read on this computer (it was protected for another user or another computer)', { suggestions: [`Set ${VAULT_PASSPHRASE_ENV} to use a passphrase instead, or delete ${KEY_FILE} and ${VAULT_FILE} in the app folder to start an empty vault.`] });
      return Buffer.from(r.out.trim(), 'base64');
    },
    store: (key) => {
      const r = ps('Protect', key.toString('base64'));
      if (!r.ok || !r.out.trim()) throw new ApsError('ConfigurationError', `Windows could not protect the vault key: ${r.err.trim().slice(0, 200) || 'PowerShell did not answer'}`, { suggestions: [`Set ${VAULT_PASSPHRASE_ENV} to use a passphrase instead.`] });
      atomicWrite(file, `${r.out.trim()}\n`, { mode: 0o600 });
    },
  };
}

/** macOS: the login Keychain through `security`. Commands go on standard input (`security -i`), so the key is never an argument. */
function keychainKeyring(): VaultKeyring {
  return {
    name: 'macOS Keychain',
    available: () => (run('security', ['help']).err || run('security', ['help']).out ? { ok: true } : { ok: false, why: 'the `security` tool was not found' }),
    read: () => {
      const r = run('security', ['find-generic-password', '-a', 'testpion', '-s', SERVICE, '-w']);
      return r.ok && r.out.trim() ? Buffer.from(r.out.trim(), 'base64') : undefined;
    },
    store: (key) => {
      const r = run('security', ['-i'], `add-generic-password -a testpion -s "${SERVICE}" -w ${key.toString('base64')} -U\n`);
      if (!r.ok) throw new ApsError('ConfigurationError', `The Keychain did not take the vault key: ${r.err.trim().slice(0, 200)}`, { suggestions: [`Set ${VAULT_PASSPHRASE_ENV} to use a passphrase instead.`] });
    },
  };
}

/** Linux: the Secret Service (GNOME Keyring, KWallet) through `secret-tool`, which reads the secret from standard input. */
function secretServiceKeyring(): VaultKeyring {
  const attrs = ['application', 'testpion', 'purpose', 'vault-key'];
  return {
    name: 'Secret Service (secret-tool)',
    available: () =>
      run('secret-tool', ['--version']).ok || run('sh', ['-c', 'command -v secret-tool']).ok
        ? { ok: true }
        : { ok: false, why: `\`secret-tool\` is not installed (package libsecret-tools), or no keyring is unlocked. Set ${VAULT_PASSPHRASE_ENV} to use a passphrase instead.` },
    read: () => {
      const r = run('secret-tool', ['lookup', ...attrs]);
      return r.ok && r.out.trim() ? Buffer.from(r.out.trim(), 'base64') : undefined;
    },
    store: (key) => {
      const r = run('secret-tool', ['store', `--label=${SERVICE}`, ...attrs], key.toString('base64'));
      if (!r.ok) throw new ApsError('ConfigurationError', `The keyring did not take the vault key: ${r.err.trim().slice(0, 200) || 'secret-tool failed'}`, { suggestions: [`Unlock the keyring, or set ${VAULT_PASSPHRASE_ENV} to use a passphrase instead.`] });
    },
  };
}

/** This system's keyring. */
export function osKeyring(dir: string, platform: string = process.platform): VaultKeyring {
  return platform === 'win32' ? dpapiKeyring(dir) : platform === 'darwin' ? keychainKeyring() : secretServiceKeyring();
}

const CHECK = 'testpion vault';

function seal(key: Buffer, name: string, value: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(name, 'utf8'));
  const body = Buffer.concat([c.update(value, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

function open(key: Buffer, name: string, sealed: string): string {
  const raw = Buffer.from(sealed, 'base64');
  const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAAD(Buffer.from(name, 'utf8'));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

export interface VaultOptions {
  /** The passphrase (default: TESTPION_VAULT_PASSPHRASE of `env`). */
  passphrase?: string;
  env?: Record<string, string | undefined>;
  /** The keyring (default: this system's); tests give their own. */
  keyring?: VaultKeyring;
}

export interface VaultStatus {
  file: string;
  exists: boolean;
  /** Where the key comes from: 'passphrase', or the keyring's name. */
  key: string;
  /** Whether values can be read and written here; when not, why. */
  usable: boolean;
  why?: string;
  count: number;
}

export class VaultSecretStore implements SecretStore {
  readonly kind = 'vault';
  readonly writable = true;
  private readonly file: string;
  private readonly passphrase?: string;
  private readonly keyring: VaultKeyring;
  private data?: VaultFile;
  private key?: Buffer;
  private cache = new Map<string, string>();
  /** Why the vault cannot be opened here (said once, by whoever asks). */
  problem?: string;

  constructor(dir: string, o: VaultOptions = {}) {
    this.file = join(dir, VAULT_FILE);
    this.passphrase = o.passphrase ?? (o.env ?? process.env)[VAULT_PASSPHRASE_ENV] ?? undefined;
    this.keyring = o.keyring ?? osKeyring(dir);
  }

  private load(): VaultFile | undefined {
    if (this.data) return this.data;
    if (!existsSync(this.file)) return undefined;
    const d = readJson<Partial<VaultFile>>(this.file, {});
    if (!d.key || typeof d.check !== 'string' || !d.secrets || typeof d.secrets !== 'object') throw new ApsError('ConfigurationError', `${VAULT_FILE} is not a vault file (it was changed by hand, or is damaged)`, { suggestions: ['Restore it from a backup, or delete it to start an empty vault (its values are then lost).'] });
    return (this.data = d as VaultFile);
  }

  /** The master key: of the file that is there, or a new one (with `create`). */
  private unlock(create: boolean): Buffer | undefined {
    if (this.key) return this.key;
    const data = this.load();
    if (!data && !create) return undefined;
    let key: Buffer | undefined;
    if (data) {
      if (data.key.from === 'passphrase') {
        if (!this.passphrase) throw new ApsError('ConfigurationError', `The vault is protected with a passphrase: set ${VAULT_PASSPHRASE_ENV}`, { suggestions: [] });
        key = scryptSync(this.passphrase, Buffer.from(data.key.salt, 'base64'), 32);
      } else {
        const can = this.keyring.available();
        if (!can.ok) throw new ApsError('ConfigurationError', `The vault key is kept by ${data.key.keyring}, which cannot be used here: ${can.why}`, { suggestions: [] });
        key = this.keyring.read();
        if (!key) throw new ApsError('ConfigurationError', `The vault key is not in ${this.keyring.name} (the vault was made by another user or on another computer)`, { suggestions: [`Delete ${VAULT_FILE} in the app folder to start an empty vault, or copy the secrets again with \`testpion vault set\`.`] });
      }
      try {
        if (open(key, 'check', data.check) !== CHECK) throw new Error('check');
      } catch {
        throw new ApsError('ConfigurationError', data.key.from === 'passphrase' ? `The vault does not open with this passphrase (${VAULT_PASSPHRASE_ENV})` : 'The vault does not open with the key this computer keeps (the vault file comes from another computer or user)', { suggestions: [] });
      }
    } else if (this.passphrase) {
      const salt = randomBytes(16);
      key = scryptSync(this.passphrase, salt, 32);
      this.data = { schemaVersion: '1.0', note: NOTE, key: { from: 'passphrase', salt: salt.toString('base64') }, check: seal(key, 'check', CHECK), secrets: {} };
    } else {
      const can = this.keyring.available();
      if (!can.ok) throw new ApsError('ConfigurationError', `No place to keep the vault key: ${can.why}`, { suggestions: [`Set ${VAULT_PASSPHRASE_ENV} (a passphrase you keep) and run the command again.`] });
      key = this.keyring.read() ?? randomBytes(32);
      this.keyring.store(key);
      this.data = { schemaVersion: '1.0', note: NOTE, key: { from: 'os', keyring: this.keyring.name }, check: seal(key, 'check', CHECK), secrets: {} };
    }
    return (this.key = key);
  }

  get(name: string): string | undefined {
    if (this.cache.has(name)) return this.cache.get(name);
    if (this.problem) return undefined;
    try {
      const sealed = this.load()?.secrets[name];
      if (!sealed) return undefined;
      const value = open(this.unlock(false)!, name, sealed);
      this.cache.set(name, value);
      return value;
    } catch (e) {
      // a read never throws (a secret that cannot be read is "not set"); the reason is kept for whoever reports it
      this.problem = e instanceof Error ? e.message : String(e);
      return undefined;
    }
  }

  async set(name: string, value: string): Promise<void> {
    if (!name || /[\r\n]/.test(name)) throw new ApsError('ValidationError', 'A secret needs a name of one line');
    const key = this.unlock(true)!;
    this.data!.secrets[name] = seal(key, name, value);
    this.cache.set(name, value);
    this.flush();
  }

  async delete(name: string): Promise<void> {
    const data = this.load();
    if (!data || !(name in data.secrets)) return;
    delete data.secrets[name];
    this.cache.delete(name);
    this.flush();
  }

  list(): string[] {
    try {
      return Object.keys(this.load()?.secrets ?? {});
    } catch {
      return [];
    }
  }

  /** Where the vault is, where its key comes from, and whether it opens here (nothing is created). */
  status(): VaultStatus {
    const exists = existsSync(this.file);
    let data: VaultFile | undefined;
    try {
      data = this.load();
    } catch (e) {
      return { file: this.file, exists, key: 'unknown', usable: false, why: (e as Error).message, count: 0 };
    }
    const key = data ? (data.key.from === 'passphrase' ? 'passphrase' : data.key.keyring) : this.passphrase ? 'passphrase' : this.keyring.name;
    const count = Object.keys(data?.secrets ?? {}).length;
    try {
      if (data) this.unlock(false);
      else if (!this.passphrase) {
        const can = this.keyring.available();
        if (!can.ok) return { file: this.file, exists, key, usable: false, why: can.why, count };
      }
      return { file: this.file, exists, key, usable: true, count };
    } catch (e) {
      return { file: this.file, exists, key, usable: false, why: (e as Error).message, count };
    }
  }

  private flush(): void {
    atomicWrite(this.file, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
  }
}

const NOTE = 'TestPion vault: every value is encrypted (AES-256-GCM). The key is kept by the operating system or derived from your passphrase; this file alone opens nothing.';
