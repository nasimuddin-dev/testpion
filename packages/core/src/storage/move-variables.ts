import { ApsError } from '../errors.js';
import type { Environment } from '../model/types.js';
import { secretKeys, type SecretStore } from './secrets.js';
import type { WorkspaceStore } from './workspace.js';

/**
 * Move collection variables into environments. A collection variable wins over every environment, so a base URL kept
 * in an imported Postman collection (`{{bannerManagementBaseUrl}}`) can't differ between Development and Production
 * until it lives in the environments. Each chosen environment gets the variable with the collection's value (an
 * environment that already has it keeps its own value), and the collection loses it, so the environment's applies.
 * A secret variable's value goes to each environment's secret in the secret store; without a writable store (the CLI)
 * secret variables stay in the collection and are reported as not moved, so no value is lost.
 */
export interface MoveVariablesResult {
  moved: string[];
  /** Secret variables left in the collection: there was no secret store to put their values in. */
  notMoved: string[];
  /** Per environment: the variables added, and those it already had (its value kept). */
  environments: Array<{ id: string; name: string; added: string[]; kept: string[] }>;
}

export async function moveCollectionVariablesToEnvironments(
  store: WorkspaceStore,
  o: { collectionId: string; keys?: string[]; environments: string[]; dryRun?: boolean; secrets?: SecretStore },
): Promise<MoveVariablesResult> {
  const c = store.getCollection(o.collectionId);
  const vars = c.variables ?? [];
  const wanted = o.keys?.length ? o.keys : vars.map((v) => v.key);
  const missing = wanted.filter((k) => !vars.some((v) => v.key === k));
  if (missing.length) throw new ApsError('ValidationError', `Not variables of ${c.name}: ${missing.join(', ')}`);
  if (!o.environments.length) throw new ApsError('ValidationError', 'Choose the environments to move the variables to');
  const isSecret = (k: string) => (vars.find((v) => v.key === k) as { secret?: boolean } | undefined)?.secret === true;
  const canStoreSecrets = !!o.secrets?.writable;
  const notMoved = wanted.filter((k) => isSecret(k) && !canStoreSecrets);
  const keys = wanted.filter((k) => !notMoved.includes(k));
  const envs: Environment[] = o.environments.map((ref) => {
    const r = ref.toLowerCase();
    const e = store.listEnvironments().find((x) => x.id.toLowerCase() === r) ?? store.listEnvironments().find((x) => x.name.toLowerCase() === r);
    if (!e) throw new ApsError('ValidationError', `No environment "${ref}"`);
    if (e.problem) throw new ApsError('ConfigurationError', `Environment "${e.name}" is broken: ${e.problem}`);
    return store.getEnvironment(e.id)!;
  });
  const result: MoveVariablesResult = { moved: keys, notMoved, environments: [] };
  for (const env of envs) {
    const added: string[] = [];
    const kept: string[] = [];
    const variables = [...env.variables];
    for (const k of keys) {
      if (variables.some((v) => v.key === k)) {
        kept.push(k);
        continue;
      }
      const v = vars.find((x) => x.key === k)!;
      if (isSecret(k)) {
        // the value in the secret store, never in the environment file
        if (!o.dryRun) await o.secrets!.set(secretKeys.envVar(env.id, k), v.value ?? '');
        variables.push({ key: k, value: '', enabled: v.enabled !== false, secret: true });
      } else variables.push({ key: k, value: v.value, enabled: v.enabled !== false });
      added.push(k);
    }
    result.environments.push({ id: env.id, name: env.name, added, kept });
    if (!o.dryRun && added.length) store.saveEnvironment({ ...env, variables });
  }
  if (!o.dryRun && keys.length) store.saveCollection({ ...c, variables: vars.filter((v) => !keys.includes(v.key)) });
  return result;
}
