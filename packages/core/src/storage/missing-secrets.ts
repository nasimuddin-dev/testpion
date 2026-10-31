/**
 * The secrets this computer still has to fill in: a variable marked secret keeps its value in the OS secret store, never in the
 * workspace files, so after a clone (or on a new computer or in CI) every one of them is empty until its person enters it. This lists
 * them: environment variables and workspace (global) variables that are secret, enabled, and have no value in the secret store.
 * Values are never read out: only whether one exists.
 */
import type { SecretReader } from '../vars/variables.js';
import { envNameForSecret, secretKeys } from './secrets.js';
import type { WorkspaceStore } from './workspace.js';

export interface MissingSecret {
  scope: 'environment' | 'globals';
  /** The environment's name (environments only). */
  environment?: string;
  key: string;
  /** The environment variable that gives the value to the CLI and CI. */
  envVar: string;
}

export interface MissingSecrets {
  count: number;
  items: MissingSecret[];
  /** "3 secrets have no value on this computer: Staging: apiKey, token; globals: signingKey." or "Every secret has a value." */
  text: string;
}

export function missingSecrets(store: Pick<WorkspaceStore, 'id' | 'listEnvironments' | 'workspace'>, secrets: SecretReader): MissingSecrets {
  const items: MissingSecret[] = [];
  for (const env of store.listEnvironments()) {
    for (const v of env.variables) if (v.secret && v.enabled !== false && !secrets.get(secretKeys.envVar(env.id, v.key))) items.push({ scope: 'environment', environment: env.name, key: v.key, envVar: envNameForSecret(secretKeys.envVar(env.id, v.key)) });
  }
  for (const v of store.workspace.variables) {
    if ((v as { secret?: boolean }).secret && v.enabled !== false && !secrets.get(secretKeys.workspaceVar(store.id, v.key))) items.push({ scope: 'globals', key: v.key, envVar: envNameForSecret(secretKeys.workspaceVar(store.id, v.key)) });
  }
  const groups = new Map<string, string[]>();
  for (const i of items) groups.set(i.environment ?? 'globals', [...(groups.get(i.environment ?? 'globals') ?? []), i.key]);
  const text = items.length ? `${items.length} ${items.length === 1 ? 'secret has' : 'secrets have'} no value on this computer: ${[...groups].map(([g, keys]) => `${g}: ${keys.join(', ')}`).join('; ')}.` : 'Every secret has a value.';
  return { count: items.length, items, text };
}
