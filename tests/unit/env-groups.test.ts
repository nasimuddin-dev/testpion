import { describe, expect, it } from 'vitest';
import { environmentLabel, environmentsOfGroup, groupEnvironments, matchEnvironment, nameIsShared } from '../../packages/core/src/index.js';

describe('an environment by name when two tenants share one', () => {
  const envs = [
    { id: 'dev', name: 'Dev' },
    { id: 'acme-staging', name: 'Staging', group: 'Acme' },
    { id: 'globex-staging', name: 'Staging', group: 'Globex' },
    { id: 'qa', name: 'QA' },
    { id: 'acme-qa', name: 'QA', group: 'Acme' },
  ];
  it('matches the id, the label "Group ▸ Name" (any case), a unique bare name, or the ungrouped one of a shared name; never the first by chance', () => {
    expect(matchEnvironment(envs, 'acme-staging')?.id).toBe('acme-staging');
    expect(matchEnvironment(envs, 'globex ▸ staging')?.id).toBe('globex-staging');
    expect(matchEnvironment(envs, 'dev')?.id).toBe('dev');
    expect(matchEnvironment(envs, 'Staging')).toBeUndefined();
    expect(matchEnvironment(envs, 'QA')?.id).toBe('qa');
    expect(matchEnvironment(envs, 'Acme ▸ QA')?.id).toBe('acme-qa');
    expect(nameIsShared(envs, envs[1]!)).toBe(true);
    expect(nameIsShared(envs, envs[0]!)).toBe(false);
  });
});

describe('environment groups (a tenant, a customer, a deployment)', () => {
  const envs = [
    { name: 'Dev' },
    { name: 'Staging', group: 'Acme' },
    { name: 'Production', group: 'Acme' },
    { name: 'Staging', group: 'Globex' },
    { name: 'Local', group: ' ' },
  ];
  it('labels "Group ▸ Name" and keeps groups together, the ungrouped first', () => {
    expect(environmentLabel({ name: 'Staging', group: 'Acme' })).toBe('Acme ▸ Staging');
    expect(environmentLabel({ name: 'Dev' })).toBe('Dev');
    expect(environmentLabel({ name: 'Local', group: '  ' })).toBe('Local');
    expect(groupEnvironments(envs).map((g) => [g.group, g.environments.map((e) => e.name)])).toEqual([
      [undefined, ['Dev', 'Local']],
      ['Acme', ['Staging', 'Production']],
      ['Globex', ['Staging']],
    ]);
    expect(environmentsOfGroup(envs, 'acme').map((e) => e.name)).toEqual(['Staging', 'Production']);
    expect(environmentsOfGroup(envs, 'Nobody')).toEqual([]);
  });
});
