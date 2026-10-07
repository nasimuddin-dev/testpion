import { ApsError } from '../errors.js';
import type { Environment } from '../model/types.js';
import type { WorkspaceStore } from './workspace.js';

/**
 * Move collection variables into environments. A collection variable wins over every environment, so a base URL kept
 * in an imported Postman collection (`{{bannerManagementBaseUrl}}`) can't differ between Development and Production
 * until it lives in the environments. Each chosen environment gets the variable with the collection's value (an
 * environment that already has it keeps its own value), and the collection loses it, so the environment's applies.
 * Secret values are never copied: they stay in the secret store under the collection.
 */
export interface MoveVariablesResult {
  moved: string[];
  /** Per environment: the variables added, and those it already had (its value kept). */
  environments: Array<{ id: string; name: string; added: string[]; kept: string[] }>;
}

export function moveCollectionVariablesToEnvironments(store: WorkspaceStore, o: { collectionId: string; keys?: string[]; environments: string[]; dryRun?: boolean }): MoveVariablesResult {
  const c = store.getCollection(o.collectionId);
  const vars = c.variables ?? [];
  const keys = o.keys?.length ? o.keys : vars.map((v) => v.key);
  const missing = keys.filter((k) => !vars.some((v) => v.key === k));
  if (missing.length) throw new ApsError('ValidationError', `Not variables of ${c.name}: ${missing.join(', ')}`);
  if (!o.environments.length) throw new ApsError('ValidationError', 'Choose the environments to move the variables to');
  const envs: Environment[] = o.environments.map((ref) => {
    const r = ref.toLowerCase();
    const e = store.listEnvironments().find((x) => x.id.toLowerCase() === r) ?? store.listEnvironments().find((x) => x.name.toLowerCase() === r);
    if (!e) throw new ApsError('ValidationError', `No environment "${ref}"`);
    return store.getEnvironment(e.id)!;
  });
  const result: MoveVariablesResult = { moved: keys, environments: [] };
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
      const secret = (v as { secret?: boolean }).secret === true;
      variables.push({ key: k, value: secret ? '' : v.value, enabled: v.enabled !== false, ...(secret ? { secret: true } : {}) });
      added.push(k);
    }
    result.environments.push({ id: env.id, name: env.name, added, kept });
    if (!o.dryRun && added.length) store.saveEnvironment({ ...env, variables });
  }
  if (!o.dryRun) store.saveCollection({ ...c, variables: vars.filter((v) => !keys.includes(v.key)) });
  return result;
}
