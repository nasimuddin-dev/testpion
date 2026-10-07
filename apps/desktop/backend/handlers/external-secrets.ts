/**
 * RPC handlers: secrets kept in a secret manager (1Password, HashiCorp Vault, AWS Secrets Manager, Azure Key Vault,
 * Google Secret Manager), referenced by an environment variable's value (op://…, vault://…). Reading one runs the
 * manager's command-line tool, so a workspace's references run only once the person allows them on this computer
 * (the trust list, like a stdio MCP server); then they are read before any request or run with that environment.
 */
import { ApsError, environmentSecretRefs, externalSecrets, isCommandTrusted, prefetchEnvironmentSecrets, secretRefCommand, commandLine, trustCommand } from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';

/** References already reported as not allowed in this session (one message each, not one per request). */
const told = new Set<string>();

/** Before an RPC call with an environment: read its trusted references; say once which ones wait to be allowed. */
export async function prefetchSecretsFor(be: Backend, params: unknown): Promise<void> {
  const env = (params as { environment?: unknown } | undefined)?.environment;
  if (typeof env !== 'string' || !env) return;
  let store;
  try {
    store = be.ws;
  } catch {
    return;
  }
  const r = await prefetchEnvironmentSecrets(store, env);
  const fresh = r.blocked.filter((b) => !told.has(b.ref));
  for (const b of fresh) told.add(b.ref);
  if (fresh.length) be.host.emit('secrets.blocked', { environment: env, refs: fresh });
  for (const f of r.failed) be.logger.warn(`Secret reference ${f.ref}: ${f.error}`);
}

export function externalSecretsHandlers(be: Backend): Handlers {
  const envOf = (environment: string) => {
    const e = be.ws.getEnvironment(environment);
    if (!e) throw new ApsError('ValidationError', `No environment "${environment}"`);
    return e;
  };
  return {
    /** An environment's references: the manager, the command that reads them, whether they're allowed and read. */
    'secrets.refs': ({ environment }: { environment: string }) =>
      envOf(environment)
        .variables.filter((v) => environmentSecretRefs({ variables: [v] }).length)
        .map((v) => {
          try {
            const c = secretRefCommand(v.value);
            return {
              key: v.key,
              ref: v.value.trim(),
              label: c.label,
              commandLine: commandLine(c.command, c.args),
              allowed: isCommandTrusted(be.ws, c.command, c.args),
              read: externalSecrets.get(v.value) !== undefined,
            };
          } catch (e) {
            return { key: v.key, ref: v.value.trim(), label: '', commandLine: '', allowed: false, read: false, error: (e as Error).message };
          }
        }),
    /** Allow an environment's references on this computer (all, or the given ones) and read them now. */
    'secrets.allow': async ({ environment, refs }: { environment: string; refs?: string[] }) => {
      for (const ref of environmentSecretRefs(envOf(environment))) {
        if (refs && !refs.includes(ref)) continue;
        const c = secretRefCommand(ref);
        trustCommand(be.ws, c.command, c.args);
        told.delete(ref);
      }
      return prefetchEnvironmentSecrets(be.ws, environment);
    },
    /** Forget the values read (they are read again on the next request), e.g. after rotating a secret. */
    'secrets.refresh': async ({ environment }: { environment?: string }) => {
      externalSecrets.clear();
      return environment ? prefetchEnvironmentSecrets(be.ws, environment) : { fetched: [], blocked: [], failed: [] };
    },
  };
}
