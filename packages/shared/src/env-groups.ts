/**
 * Environment groups: a tenant, a customer or a deployment (`group` on the environment, "Acme"). Lists and pickers show
 * "Acme ▸ Staging" and keep a group's environments together; environments without a group come first, as before.
 * One place for the order and the label, for the app, the CLI and the status page.
 */
export interface GroupedEnvironment {
  name: string;
  group?: string;
  order?: number;
}

/** "Acme ▸ Staging", or the name alone without a group. */
export const environmentLabel = (e: Pick<GroupedEnvironment, 'name' | 'group'>): string => (e.group?.trim() ? `${e.group.trim()} ▸ ${e.name}` : e.name);

/** The groups in the order they first appear (ungrouped first), each with its environments in list order. */
export function groupEnvironments<T extends GroupedEnvironment>(envs: T[]): Array<{ group: string | undefined; environments: T[] }> {
  const out: Array<{ group: string | undefined; environments: T[] }> = [];
  for (const e of envs) {
    const group = e.group?.trim() || undefined;
    let g = out.find((x) => x.group === group);
    if (!g) {
      g = { group, environments: [] };
      if (group === undefined) out.unshift(g);
      else out.push(g);
    }
    g.environments.push(e);
  }
  return out;
}

/** The environments of one group (its name as written, case-insensitively). */
export const environmentsOfGroup = <T extends GroupedEnvironment>(envs: T[], group: string): T[] => envs.filter((e) => (e.group?.trim() ?? '').toLowerCase() === group.trim().toLowerCase());

/**
 * The environment a reference names, for every lookup by name: its id; else its label "Acme ▸ Staging" (case not mattering);
 * else its bare name when one environment has it, or when exactly one of those that have it is in no group (two tenants may
 * both have a Staging: a bare "Staging" then names the ungrouped one, or nothing, never the first by chance).
 */
export function matchEnvironment<T extends GroupedEnvironment & { id?: string }>(envs: readonly T[], ref: string): T | undefined {
  if (typeof ref !== 'string') return undefined;
  const byId = envs.find((e) => e.id !== undefined && e.id === ref);
  if (byId) return byId;
  const want = ref.trim().toLowerCase();
  const byLabel = envs.find((e) => environmentLabel(e).toLowerCase() === want);
  if (byLabel) return byLabel;
  const named = envs.filter((e) => e.name.toLowerCase() === want);
  if (named.length === 1) return named[0];
  const ungrouped = named.filter((e) => !e.group?.trim());
  return ungrouped.length === 1 ? ungrouped[0] : undefined;
}

/** What to write to name this environment where a name is expected: its label when another environment has its name, else its name. */
export const environmentRef = <T extends GroupedEnvironment>(envs: readonly T[], e: T): string => (nameIsShared(envs, e) ? environmentLabel(e) : e.name);

/** Whether another environment has this one's name (then its label tells them apart). */
export const nameIsShared = <T extends GroupedEnvironment>(envs: readonly T[], e: T): boolean => envs.some((x) => x !== e && x.name.toLowerCase() === e.name.toLowerCase());
