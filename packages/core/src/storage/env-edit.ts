import type { Collection, Environment } from '../model/types.js';
import type { WorkspaceStore } from './workspace.js';
import { ApsError } from '../errors.js';
import { slugify } from '../util/ids.js';
import { secretKeys, type SecretStore } from './secrets.js';
import { environmentLabel, environmentRef, environmentsOfGroup, matchEnvironment } from '@testpion/shared';

/**
 * Set or remove plain (non-secret) variables of an environment from the CLI or an AI agent. Secret
 * variables are refused: their values live in the OS secret store and are set in the app (or passed to
 * the CLI as TESTPION_SECRET_* environment variables), never through here.
 */
export function findEnvironment(store: Pick<WorkspaceStore, 'listEnvironments'> & Partial<Pick<WorkspaceStore, 'environmentList'>>, ref: string, cached = false): Environment | undefined {
  if (typeof ref !== 'string') return undefined;
  // `cached`: the shared frozen list (nothing is read or parsed unless an environment file changed); the caller must not change what it gets
  const envs = (cached && store.environmentList ? store.environmentList() : store.listEnvironments()) as Environment[];
  return matchEnvironment(envs, ref);
}

/** The environment, or a configuration error naming the ones there are (or saying why its file cannot be read). */
export function requireEnvironment(store: Pick<WorkspaceStore, 'listEnvironments'> & Partial<Pick<WorkspaceStore, 'environmentList'>>, ref: string, cached = false): Environment {
  const env = findEnvironment(store, ref, cached);
  if (!env) throw new ApsError('ConfigurationError', `No environment "${ref}". Available: ${store.listEnvironments().map((e) => environmentLabel(e)).join(', ') || 'none'}`);
  if (env.problem) throw brokenEnvironmentError(env);
  return env;
}

/** Using an environment whose file cannot be read: say so (sending without its variables would be silently wrong). */
function brokenEnvironmentError(env: Pick<Environment, 'name' | 'problem'>): ApsError {
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

/**
 * An id for a new environment that no environment has and whose file (environments/<slug of the id>.json) is free:
 * two names may give the same file name (names in another script all do), and saving would replace the other's file.
 */
export function freeEnvironmentId(store: Pick<WorkspaceStore, 'listEnvironments'>, name: string, taken = new Set<string>()): string {
  for (const e of store.listEnvironments()) (taken.add(e.id), taken.add(slugify(e.id)));
  const base = slugify(name) || 'environment';
  let id = base;
  for (let n = 2; taken.has(id) || taken.has(slugify(id)); n++) id = `${base.slice(0, 56)}-${n}`;
  taken.add(id);
  return id;
}

/** A variable name: letters, digits, _ . $ - */
const VARIABLE_NAME = /^[\w.$-]+$/;

function applyEnvironmentVariables(store: WorkspaceStore, ref: string, values: Record<string, string>, opts: { create?: boolean; secrets?: SecretStore }): { env: Environment; secretValues: Array<[string, string]> } {
  let env = findEnvironment(store, ref);
  if (!env) {
    if (!opts.create) throw new ApsError('ValidationError', `No environment "${ref}". Available: ${store.listEnvironments().map((e) => e.name).join(', ') || 'none'}`, { suggestions: ['Pass --create (create: true) to make it.'] });
    // a name several environments share is not "missing": making another one of that name would only add to the confusion
    const named = store.listEnvironments().filter((e) => e.name.toLowerCase() === ref.trim().toLowerCase());
    if (named.length) throw new ApsError('ValidationError', `Several environments are named "${ref}": name one by its group, e.g. "${environmentLabel(named[0]!)}"`);
    env = { id: freeEnvironmentId(store, ref), name: ref, variables: [] } as Environment;
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
 * Copy one variable from an environment to another (Compare's → and ←, `env copy`): the value, enabled and secret as on the
 * source, replacing what the target has or adding it. A secret's value goes secret store to secret store (with `secrets`);
 * without a store, or with one that cannot be written (the command line's: secrets come from environment variables there),
 * it is added as a secret with no value. The value is stored before the environment file is written, so a store that
 * fails leaves the target as it was. Returns what changed.
 */
export async function copyVariableToEnvironment(
  store: WorkspaceStore,
  from: string,
  to: string,
  key: string,
  opts: { secrets?: SecretStore } = {},
): Promise<{ from: string; to: string; key: string; secret: boolean; replaced: boolean; secretCopied: boolean }> {
  const src = requireEnvironment(store, from);
  const dst = requireEnvironment(store, to);
  if (src.id === dst.id) throw new ApsError('ValidationError', 'Pick two different environments');
  const v = src.variables.find((x) => x.key === key);
  if (!v) throw new ApsError('ValidationError', `"${src.name}" has no variable ${key}`);
  const secret = !!(v as { secret?: boolean }).secret;
  const replaced = dst.variables.some((x) => x.key === key);
  const copy = { ...v, value: secret ? '' : v.value, enabled: v.enabled !== false };
  let secretCopied = false;
  if (secret && opts.secrets?.writable) {
    const value = opts.secrets.get(secretKeys.envVar(src.id, key));
    if (value !== undefined) {
      await opts.secrets.set(secretKeys.envVar(dst.id, key), value);
      secretCopied = true;
    }
  }
  store.saveEnvironment({ ...dst, variables: replaced ? dst.variables.map((x) => (x.key === key ? copy : x)) : [...dst.variables, copy] });
  return { from: src.name, to: dst.name, key, secret, replaced, secretCopied };
}

/**
 * Environment names as a person or a pipeline writes them, with groups unfolded: `group:Acme` (or a group's name that is
 * not an environment's) stands for every environment of that group, in list order. Names that match nothing stay as
 * written (the caller says they are unknown).
 */
export function expandEnvironmentGroups(store: Pick<WorkspaceStore, 'listEnvironments'>, refs: string[]): string[] {
  const envs = store.listEnvironments().filter((e) => !e.problem);
  const out: string[] = [];
  for (const raw of refs) {
    const ref = raw.trim();
    if (!ref) continue;
    const direct = matchEnvironment(envs, ref);
    const groupName = ref.replace(/^group:/i, '');
    const group = direct ? [] : environmentsOfGroup(envs, groupName);
    if (!direct && group.length) out.push(...group.map((e) => environmentRef(envs, e)));
    else out.push(ref);
  }
  return [...new Set(out)];
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
    // shared from another workspace: changed there (listed, with nothing added)
    if (env.shared) {
      out.push({ environment: env.name, added: [] });
      continue;
    }
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

/**
 * A new tenant from an existing one: every environment of `group` copied into `newGroup` (same names, production flag, variables
 * and colour; secret values are not copied: they belong to the tenant). Ids come from the group and the name (acme-staging ▸
 * globex-staging). Returns the new environments. Nothing when the group has none; an error when the new group exists already.
 */
export function duplicateEnvironmentGroup(store: WorkspaceStore, group: string, newGroup: string): Environment[] {
  const want = newGroup.trim();
  if (!want) throw new ApsError('ValidationError', 'Name the new group (the tenant)');
  const envs = store.listEnvironments().filter((e) => !e.problem);
  const from = environmentsOfGroup(envs, group);
  if (!from.length) throw new ApsError('ValidationError', `No environment is in the group "${group}"`);
  if (environmentsOfGroup(envs, want).length) throw new ApsError('ValidationError', `The group "${want}" exists already: its environments would be mixed with the copies`);
  const taken = new Set<string>();
  return from.map((e) => {
    const id = freeEnvironmentId(store, `${want} ${e.name}`, taken);
    const copy: Environment = { ...e, id, group: want, variables: e.variables.map((v) => ((v as { secret?: boolean }).secret ? { ...v, value: '' } : v)) };
    delete (copy as { problem?: string }).problem;
    return store.saveEnvironment(copy);
  });
}
