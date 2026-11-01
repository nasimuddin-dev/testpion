import { describe, expect, it } from 'vitest';
import { environmentLabel, environmentsOfGroup, groupEnvironments } from '../../packages/core/src/index.js';

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
