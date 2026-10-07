import { execFile } from 'node:child_process';
import { ApsError } from '../errors.js';
import type { Environment } from '../model/types.js';
import { commandLine, isCommandTrusted } from '../storage/trust.js';
import type { WorkspaceStore } from '../storage/workspace.js';

/**
 * Secrets kept in a secret manager, not in TestPion: an environment variable whose value is a reference
 * (`op://Clinic/API/key`, `vault://secret/clinic#apiKey`, `aws-sm://prod/clinic#apiKey`, `azure-kv://clinic-kv/api-key`,
 * `gcp-sm://my-project/api-key`) is read with the manager's own command-line tool, signed in the usual way (op, vault,
 * aws, az, gcloud), when a request or run needs it. The reference is safe to commit; the value is kept in memory for a
 * few minutes and never written anywhere. Reading one runs a program, so in the app a workspace's references are
 * allowed per computer (the trust list, like stdio MCP servers); the CLI reads them, as it reads $env.
 */
export type SecretManager = '1password' | 'vault' | 'aws' | 'azure' | 'gcp';

export interface SecretRefCommand {
  manager: SecretManager;
  /** For people: "1Password", "HashiCorp Vault" … */
  label: string;
  command: string;
  args: string[];
  /** A key inside a JSON secret (aws-sm://name#key). */
  jsonKey?: string;
}

const REF = /^(op|vault|aws-sm|azure-kv|gcp-sm):\/\/\S/;
/** Characters a reference part may have when the tool must go through a shell (az and gcloud are .cmd files on Windows). */
const PLAIN = /^[\w.@=:/+-]+$/;

/** Whether a variable's value is a secret manager reference rather than a value. */
export function isSecretRef(value: unknown): value is string {
  return typeof value === 'string' && REF.test(value.trim()) && !/\s{2,}|[\r\n]/.test(value.trim());
}

const plain = (part: string, what: string, ref: string) => {
  if (!part || !PLAIN.test(part)) throw new ApsError('ValidationError', `${what} in ${ref} may only have letters, digits and . _ - / @ = : +`);
  return part;
};

/** The program that reads a reference, and its arguments (no shell is involved for op, vault and aws). */
export function secretRefCommand(ref0: string): SecretRefCommand {
  const ref = ref0.trim();
  const m = /^([\w-]+):\/\/(.*)$/.exec(ref);
  if (!m || !isSecretRef(ref))
    throw new ApsError('ValidationError', `Not a secret reference: ${ref}`, {
      suggestions: ['op://vault/item/field, vault://mount/path#field, aws-sm://name#key, azure-kv://vault/secret or gcp-sm://project/secret'],
    });
  const [, scheme, rest] = m as unknown as [string, string, string];
  const [pathPart, hash = ''] = rest.split('#', 2) as [string, string?];
  const [path, query = ''] = pathPart.split('?', 2) as [string, string?];
  const params = new URLSearchParams(query);
  switch (scheme) {
    case 'op':
      // 1Password's own secret reference syntax, read as it is
      if (path.split('/').filter(Boolean).length < 3) throw new ApsError('ValidationError', `A 1Password reference is op://vault/item/field: ${ref}`);
      return { manager: '1password', label: '1Password', command: 'op', args: ['read', '--no-newline', ref.split('#')[0]!] };
    case 'vault': {
      if (!hash) throw new ApsError('ValidationError', `Name the field after #: vault://secret/clinic#apiKey (${ref})`);
      return { manager: 'vault', label: 'HashiCorp Vault', command: 'vault', args: ['kv', 'get', `-field=${plain(hash, 'The field', ref)}`, plain(path, 'The path', ref)] };
    }
    case 'aws-sm': {
      const args = ['secretsmanager', 'get-secret-value', '--secret-id', plain(path, 'The secret id', ref), '--query', 'SecretString', '--output', 'text'];
      const region = params.get('region');
      if (region) args.push('--region', plain(region, 'The region', ref));
      return { manager: 'aws', label: 'AWS Secrets Manager', command: 'aws', args, jsonKey: hash || undefined };
    }
    case 'azure-kv': {
      const [vault, name, version] = path.split('/');
      if (!vault || !name) throw new ApsError('ValidationError', `An Azure Key Vault reference is azure-kv://vault-name/secret-name: ${ref}`);
      const args = ['keyvault', 'secret', 'show', '--vault-name', plain(vault, 'The vault name', ref), '--name', plain(name, 'The secret name', ref), '--query', 'value', '-o', 'tsv'];
      if (version) args.push('--version', plain(version, 'The version', ref));
      return { manager: 'azure', label: 'Azure Key Vault', command: 'az', args, jsonKey: hash || undefined };
    }
    case 'gcp-sm': {
      const [project, secret] = path.split('/');
      if (!project || !secret) throw new ApsError('ValidationError', `A Google Secret Manager reference is gcp-sm://project/secret(#version): ${ref}`);
      return {
        manager: 'gcp',
        label: 'Google Secret Manager',
        command: 'gcloud',
        args: ['secrets', 'versions', 'access', plain(hash || 'latest', 'The version', ref), `--secret=${plain(secret, 'The secret', ref)}`, `--project=${plain(project, 'The project', ref)}`],
      };
    }
    default:
      throw new ApsError('ValidationError', `Unknown secret manager "${scheme}"`);
  }
}

export type SecretRunner = (command: string, args: string[], timeoutMs: number) => Promise<string>;

const SHELL_TOOLS = new Set(['az', 'gcloud']);
const defaultRunner: SecretRunner = (command, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    // az and gcloud are .cmd scripts on Windows, which only a shell starts: their arguments were checked to be plain
    const shell = process.platform === 'win32' && SHELL_TOOLS.has(command);
    if (shell && !args.every((a) => PLAIN.test(a) || /^-[\w-]+(=[\w.@:/+-]+)?$/.test(a))) return reject(new ApsError('ValidationError', 'A secret reference has characters a shell would read'));
    execFile(command, args, { timeout: timeoutMs, windowsHide: true, shell, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(String(stdout));
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT')
        return reject(
          new ApsError('ConfigurationError', `The ${command} command was not found`, { suggestions: [`Install it and sign in (${command}), or put it on the PATH TestPion starts with.`] }),
        );
      reject(
        new ApsError(
          'ConfigurationError',
          `${command} could not read the secret: ${String(stderr || err.message)
            .trim()
            .split('\n')[0]!
            .slice(0, 300)}`,
          { suggestions: [`Check that you are signed in (${command}) and that the reference is right.`] },
        ),
      );
    });
  });
let runner: SecretRunner = defaultRunner;

/** Replace how the tools are run (tests). Returns a function that puts the real one back. */
export function setSecretRunner(r: SecretRunner): () => void {
  const before = runner;
  runner = r;
  return () => {
    runner = before;
  };
}

/** Read one reference now (no cache). */
export async function fetchSecretRef(ref: string, opts: { timeoutMs?: number } = {}): Promise<string> {
  const c = secretRefCommand(ref);
  let out = await runner(c.command, c.args, opts.timeoutMs ?? 30_000);
  if (c.manager !== '1password') out = out.replace(/\r?\n$/, '');
  if (c.jsonKey) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(out);
    } catch {
      throw new ApsError('ValidationError', `${ref}: the secret is not JSON, so it has no key "${c.jsonKey}"`);
    }
    const v = (parsed as Record<string, unknown>)?.[c.jsonKey];
    if (v === undefined) throw new ApsError('ValidationError', `${ref}: the secret has no key "${c.jsonKey}"`);
    out = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return out;
}

const TTL_MS = 10 * 60_000;
const cache = new Map<string, { value: string; at: number }>();

export interface PrefetchResult {
  fetched: string[];
  /** References the workspace isn't allowed to read on this computer yet, with the command that would run. */
  blocked: Array<{ ref: string; label: string; commandLine: string }>;
  failed: Array<{ ref: string; error: string }>;
}

export const externalSecrets = {
  /** The value read for a reference in the last few minutes, if any. */
  get(ref: string): string | undefined {
    const hit = cache.get(ref.trim());
    if (!hit) return undefined;
    if (Date.now() - hit.at > TTL_MS) {
      cache.delete(ref.trim());
      return undefined;
    }
    return hit.value;
  },
  clear(): void {
    cache.clear();
  },
  /** Read the references that are not in memory yet, those `allow` lets run, in parallel. */
  async prefetch(refs: string[], opts: { allow(ref: string, cmd: SecretRefCommand): boolean; timeoutMs?: number }): Promise<PrefetchResult> {
    const out: PrefetchResult = { fetched: [], blocked: [], failed: [] };
    await Promise.all(
      [...new Set(refs.map((r) => r.trim()))].map(async (ref) => {
        if (externalSecrets.get(ref) !== undefined) return;
        let cmd: SecretRefCommand;
        try {
          cmd = secretRefCommand(ref);
        } catch (e) {
          out.failed.push({ ref, error: (e as Error).message });
          return;
        }
        if (!opts.allow(ref, cmd)) {
          out.blocked.push({ ref, label: cmd.label, commandLine: commandLine(cmd.command, cmd.args) });
          return;
        }
        try {
          cache.set(ref, { value: await fetchSecretRef(ref, { timeoutMs: opts.timeoutMs }), at: Date.now() });
          out.fetched.push(ref);
        } catch (e) {
          out.failed.push({ ref, error: (e as Error).message });
        }
      }),
    );
    return out;
  },
};

/** The secret references among an environment's variables. */
export function environmentSecretRefs(env: Pick<Environment, 'variables'> | undefined): string[] {
  return (env?.variables ?? []).filter((v) => v.enabled !== false && isSecretRef(v.value)).map((v) => v.value.trim());
}

/**
 * Read an environment's references before a request or run. `trustAll` (the CLI) reads every one; otherwise only those
 * the workspace was allowed to run on this computer (`.local/trust.json`).
 */
export async function prefetchEnvironmentSecrets(store: WorkspaceStore, environment: string | undefined, opts: { trustAll?: boolean } = {}): Promise<PrefetchResult> {
  const empty: PrefetchResult = { fetched: [], blocked: [], failed: [] };
  if (!environment) return empty;
  let env: Environment | undefined;
  try {
    env = store.getEnvironment(environment);
  } catch {
    return empty;
  }
  const refs = environmentSecretRefs(env);
  if (!refs.length) return empty;
  return externalSecrets.prefetch(refs, { allow: (_ref, cmd) => !!opts.trustAll || isCommandTrusted(store, cmd.command, cmd.args) });
}
