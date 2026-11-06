/**
 * The active environment is kept as text: an environment's name, or its label ("Acme ▸ Staging") when another one has
 * the same name. Every place that asks "is this the active one?" or "which environment is that?" asks here, so a label
 * and a shared name mean the same thing everywhere (the top bar, the sidebar, Quick Open, the dialogs).
 */
import { environmentRef, matchEnvironment } from '@testpion/shared';

interface Env {
  id?: string;
  name: string;
  group?: string;
}

/** The environment a reference (id, label or name) stands for; undefined: none, or nothing has it. */
export const environmentOf = <T extends Env>(envs: readonly T[] | undefined, ref: string | undefined | null): T | undefined => (ref && envs ? matchEnvironment(envs, ref) : undefined);

/** Whether `e` is the environment the reference stands for. */
export const isActiveEnvironment = <T extends Env>(envs: readonly T[] | undefined, e: T, ref: string | undefined | null): boolean => {
  const active = environmentOf(envs, ref);
  return !!active && (active === e || (active.id !== undefined && active.id === e.id));
};

/** What to keep as the active environment for `e`: its label when its name is shared, else its name. */
export const activeRef = <T extends Env>(envs: readonly T[], e: T): string => environmentRef(envs, e);
