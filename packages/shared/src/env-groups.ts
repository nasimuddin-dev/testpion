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
