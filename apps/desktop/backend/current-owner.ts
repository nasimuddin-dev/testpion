/**
 * Whose current values these are. An environment's current values (set by scripts, kept on this computer) are kept by
 * the environment's id: two tenants may both have a "Staging", and a token a script set for one must never be applied
 * to the other. Older versions kept them by name; those of a name only one environment has move to its id when the
 * workspace opens (a name several share is left alone: nobody can say whose they were).
 */
import type { CurrentValues, WorkspaceStore } from '@testpion/core';
import type { Backend } from './backend.js';

type Scope = 'environment' | 'globals' | 'collectionVariables';

/** The owner key of a scope: an environment by its id (whatever names it: id, label or name), a collection by its id. */
export function currentOwner(be: Backend, scope: Scope, owner?: string): string {
  if (scope !== 'environment' || !owner) return owner ?? '';
  try {
    return be.ws.getEnvironment(owner)?.id ?? owner;
  } catch {
    return owner;
  }
}

/** Move the values an older version kept by environment name to the environment's id. */
export function adoptCurrentValues(cv: CurrentValues, store: WorkspaceStore): void {
  try {
    const envs = store.listEnvironments().filter((e) => !e.problem);
    for (const e of envs) {
      if (e.name === e.id || envs.some((x) => x !== e && (x.name === e.name || x.id === e.name))) continue;
      cv.moveOwner('environment', e.name, e.id);
    }
  } catch {
    /* the values stay where they are: nothing is lost, and the next open tries again */
  }
}
