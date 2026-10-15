import type { Collection, Environment } from '../model/types.js';
import type { WorkspaceStore } from './workspace.js';
import { ApsError } from '../errors.js';
import { slugify } from '../util/ids.js';
import { secretKeys, type SecretStore } from './secrets.js';

/**
 * Set or remove plain (non-secret) variables of an environment from the CLI or an AI agent. Secret
 * variables are refused: their values live in the OS secret store and are set in the app (or passed to
 * the CLI as TESTPION_SECRET_* environment variables), never through here.
 */
export function findEnvironment(store: Pick<WorkspaceStore, 'listEnvironments'>, ref: string): Environment | undefined {
  if (typeof ref !== 'string') return undefined;
  const envs = store.listEnvironments();
  return envs.find((e) => e.id === ref) ?? envs.find((e) => e.name.toLowerCase() === ref.toLowerCase());
}

/** The environment, or a configuration error naming the ones there are (or saying why its file cannot be read). */
export function requireEnvironment(store: Pick<WorkspaceStore, 'listEnvironments'>, ref: string): Environment {
  const env = findEnvironment(store, ref);
  if (!env) throw new ApsError('ConfigurationError', `No environment "${ref}". Available: ${store.listEnvironments().map((e) => e.name).join(', ') || 'none'}`);
  if (env.problem) throw brokenEnvironmentError(env);
  return env;
}

/** Using an environment whose file cannot be read: say so (sending without its variables would be silently wrong). */
export function brokenEnvironmentError(env: Pick<Environment, 'name' | 'problem'>): ApsError {
  return new ApsError('ConfigurationError', `Environment "${env.name}" is broken: ${env.problem}`, {
    why: 'Its file is not valid JSON, so none of its variables can be used.',
    suggestions: ['Fix the environment file by hand, or restore it from version control.', 'Or choose another environment.'],
  });
}

/** The collection `ref` names in a list: its id as given, then its id or name ignoring case. */
export function matchCollection<C extends Pick<Collection, 'id' | 'name'>>(collections: C[], ref: string): C | undefined {
  const r = ref.trim().toLowerCase();
  return collections.find((c) => c.id === ref) ?? collections.find((c) => c.id.toLowerCase() === r) ?? collections.find((c) => c.name.toLowerCase() === r);
}

/**
 * A collection by id or name (ignoring case). `loadable` leaves out the collections whose file cannot be read
 * (`problem`), for callers that go on to run or edit it.
 */
export function findCollection(store: Pick<WorkspaceStore, 'listCollections'>, ref: string, opts: { loadable?: boolean } = {}): Collection | undefined {
  const all = store.listCollections();
  return matchCollection(opts.loadable ? all.filter((c) => !c.problem) : all, ref);
}

/** The collection, or a configuration error naming the ones there are. */
export function requireCollection(store: Pick<WorkspaceStore, 'listCollections'>, ref: string, opts: { loadable?: boolean } = {}): Collection {
  const c = findCollection(store, ref, opts);
  if (!c && opts.loadable) {
    // a collection whose file cannot be read: say so and why, not "No collection"
    const broken = findCollection(store, ref) as (Collection & { problem?: string }) | undefined;
    if (broken?.problem)
      throw new ApsError('ConfigurationError', `Collection "${broken.name}" is broken: ${broken.problem}`, {
        why: 'Its file is not valid JSON, so it cannot be run or edited.',
        suggestions: ['Fix the collection file by hand, or restore it from version control.'],
      });
  }
  if (!c) {
    const all = store.listCollections();
    throw new ApsError('ConfigurationError', `No collection "${ref}". Available: ${(opts.loadable ? all.filter((x) => !x.problem) : all).map((x) => x.name).join(', ') || 'none'}`);
  }
  return c;
}

/** A variable name: letters, digits, _ . $ - */
export const VARIABLE_NAME = /^[\w.$-]+$/;

function applyEnvironmentVariables(store: WorkspaceStore, ref: string, values: Record<string, string>, opts: { create?: boolean; secrets?: SecretStore }): { env: Environment; secretValues: Array<[string, string]> } {
  let env = findEnvironment(store, ref);
  if (!env) {
    if (!opts.create) throw new ApsError('ValidationError', `No environment "${ref}". Available: ${store.listEnvironments().map((e) => e.name).join(', ') || 'none'}`, { suggestions: ['Pass --create (create: true) to make it.'] });
    env = { id: slugify(ref) || 'environment', name: ref, variables: [] } as Environment;
  }
  const variables = [...env.variables];
  const secretValues: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(values)) {
    if (!VARIABLE_NAME.test(key)) throw new ApsError('ValidationError', `"${key}" is not a valid variable name (letters, digits, _ . $ -)`);
    const i = variables.findIndex((v) => v.key === key);
    if (i >= 0 && (variables[i] as { secret?: boolean }).secret) {
      // a secret variable's value goes to the secret store (the app); refused where there is none (the CLI, agents)
      if (!opts.secrets) throw new ApsError('ValidationError', `"${key}" is a secret variable: set its value in the app (or as TESTPION_SECRET_* in CI), not here`);
      secretValues.push([secretKeys.envVar(env.id, key), value]);
      continue;
    }
    if (i >= 0) variables[i] = { ...variables[i]!, value, enabled: true };
    else variables.push({ key, value, enabled: true });
  }
  // only secret values: the environment file does not change
  const onlySecrets = secretValues.length > 0 && secretValues.length === Object.keys(values).length;
  return { env: onlySecrets ? env : store.saveEnvironment({ ...env, variables }), secretValues };
}

/**
 * Set variables of an environment. Without `secrets`, a secret variable is refused; with the app's secret store,
 * its value is stored there (the environment file never holds it) and the result is a promise.
 */
export function setEnvironmentVariables(store: WorkspaceStore, ref: string, values: Record<string, string>, opts?: { create?: boolean }): Environment;
export function setEnvironmentVariables(store: WorkspaceStore, ref: string, values: Record<string, string>, opts: { create?: boolean; secrets: SecretStore }): Promise<Environment>;
export function setEnvironmentVariables(store: WorkspaceStore, ref: string, values: Record<string, string>, opts: { create?: boolean; secrets?: SecretStore } = {}): Environment | Promise<Environment> {
  const { env, secretValues } = applyEnvironmentVariables(store, ref, values, opts);
  if (!opts.secrets) return env;
  const secrets = opts.secrets;
  return Promise.all(secretValues.map(([name, value]) => secrets.set(name, value))).then(() => env);
}

export function unsetEnvironmentVariables(store: WorkspaceStore, ref: string, keys: string[]): Environment {
  const env = findEnvironment(store, ref);
  if (!env) throw new ApsError('ValidationError', `No environment "${ref}"`);
  const secret = env.variables.find((v) => keys.includes(v.key) && (v as { secret?: boolean }).secret);
  if (secret) throw new ApsError('ValidationError', `"${secret.key}" is a secret variable: remove it in the app, so its stored value is removed too`);
  return store.saveEnvironment({ ...env, variables: env.variables.filter((v) => !keys.includes(v.key)) });
}

/**
 * WF-14 "also add to the other environments": the variables `keys` of environment `from`, added to each of `to` where
 * they are missing (an existing variable is never changed), empty or with the same value (`copy`). A secret variable
 * stays secret: its value is copied secret store to secret store (with `secrets`), else it is added without a value.
 */
export async function addVariablesToEnvironments(
  store: WorkspaceStore,
  from: string,
  keys: string[],
  to: string[],
  opts: { copy?: boolean; secrets?: SecretStore } = {},
): Promise<Array<{ environment: string; added: string[] }>> {
  const src = requireEnvironment(store, from);
  const wanted = [...new Set(keys)].map((k) => src.variables.find((v) => v.key === k)).filter((v): v is NonNullable<typeof v> => !!v);
  if (!wanted.length) return [];
  const out: Array<{ environment: string; added: string[] }> = [];
  for (const ref of [...new Set(to)]) {
    const env = requireEnvironment(store, ref);
    if (env.id === src.id) continue;
    const have = new Set(env.variables.map((v) => v.key));
    const add = wanted.filter((v) => !have.has(v.key));
    if (!add.length) {
      out.push({ environment: env.name, added: [] });
      continue;
    }
    const secretOf = (v: (typeof add)[number]) => !!(v as { secret?: boolean }).secret;
    store.saveEnvironment({ ...env, variables: [...env.variables, ...add.map((v) => ({ ...v, value: secretOf(v) || !opts.copy ? '' : v.value, enabled: true }))] });
    if (opts.copy && opts.secrets)
      for (const v of add.filter(secretOf)) {
        const value = opts.secrets.get(secretKeys.envVar(src.id, v.key));
        if (value !== undefined) await opts.secrets.set(secretKeys.envVar(env.id, v.key), value);
      }
    out.push({ environment: env.name, added: add.map((v) => v.key) });
  }
  return out;
}
