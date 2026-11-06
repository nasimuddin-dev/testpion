import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkedSource, removeItem, renameVariable, sharedDirs, WorkspaceStore } from '../../packages/core/src/index.js';
import { runCliSync, tempDir } from '../helpers.js';

// A team with a repository of its own still uses another workspace's environments, read-only, without copying them:
// workspace.json `shared: [{ path: "../platform-shared", kinds: ["environments"] }]`.
const tmp = tempDir('tp-shared-envs-');
afterAll(() => tmp.cleanup());

describe('environments shared from another workspace', () => {
  const platform = WorkspaceStore.create(join(tmp.dir, 'platform-shared'), 'Platform');
  platform.saveEnvironment({ id: 'shared-staging', name: 'Shared staging', group: 'Platform', variables: [{ key: 'baseUrl', value: 'https://staging.example.com' }] });
  platform.saveEnvironment({ id: 'development', name: 'Platform dev', variables: [] }); // the same id as the team's own
  platform.close();
  const team = WorkspaceStore.create(join(tmp.dir, 'payments'), 'Payments');
  afterAll(() => team.close());

  it('checks the folder: relative, another workspace, with the kind named', () => {
    expect(() => checkedSource(team.root, join(tmp.dir, 'platform-shared'), ['environments'])).toThrow(/absolute path/);
    expect(() => checkedSource(team.root, '.', ['environments'])).toThrow(/from itself/);
    expect(() => checkedSource(team.root, '../nowhere', ['environments'])).toThrow(/is not a workspace|has no environments folder/);
    expect(() => checkedSource(team.root, '../platform-shared', ['collections'])).toThrow(/What can be shared: environments/);
    expect(checkedSource(team.root, '..\\platform-shared', ['environments'])).toEqual({ path: '../platform-shared', kinds: ['environments'] });
  });

  it('lists them after its own, named with the folder, read-only; an id of its own wins; they cannot be changed here', () => {
    const own = team.listEnvironments().map((e) => e.id);
    team.updateWorkspace({ shared: [{ path: '../platform-shared', kinds: ['environments'] }] });
    const all = team.listEnvironments();
    expect(all.slice(0, own.length).map((e) => e.id)).toEqual(own);
    const staging = all.find((e) => e.id === 'shared-staging')!;
    expect(staging).toMatchObject({ name: 'Shared staging', group: 'Platform', shared: 'platform-shared', readOnly: true, variables: [{ key: 'baseUrl' }] });
    expect(all.find((e) => e.name === 'Platform dev')?.problem).toMatch(/same id as one of this workspace's/);
    // found by name, and its file named from the workspace (it lives outside it)
    expect(team.getEnvironment('Shared staging')?.id).toBe('shared-staging');
    expect(team.environmentFileOf('shared-staging')).toBe('../platform-shared/environments/shared-staging.json');
    // the frozen view sees a change in the shared folder
    expect(team.environmentList().some((e) => e.id === 'shared-staging')).toBe(true);
    expect(() => team.saveEnvironment({ ...staging, name: 'Mine now' })).toThrow(/"Shared staging" is shared from platform-shared: change it there/);
    expect(() => team.deleteEnvironment('shared-staging')).toThrow(/delete it there/);
    // reordering keeps to the workspace's own files
    team.reorderEnvironments(['shared-staging', ...own]);
    expect(team.listEnvironments().map((e) => e.id).slice(0, own.length)).toEqual(own);
    // a copy is the workspace's own, without the marks
    const copy = team.saveEnvironment({ ...staging, id: 'my-staging', name: 'My staging' });
    expect(copy).not.toHaveProperty('shared');
    expect(team.listEnvironments().find((e) => e.id === 'my-staging')?.shared).toBeUndefined();
  });

  it('a delete through the item ops, a variable rename and a pulled absolute path leave the other workspace alone', async () => {
    const file = join(tmp.dir, 'platform-shared', 'environments', 'shared-staging.json');
    expect(() => removeItem(team, { kind: 'environment', environmentId: 'shared-staging' })).toThrow(/delete it there/);
    expect(existsSync(file)).toBe(true);
    // renaming a variable renames it in this workspace's environments only
    team.saveEnvironment({ id: 'mine', name: 'Mine', variables: [{ key: 'baseUrl', value: 'http://localhost' }] });
    await renameVariable(team, 'baseUrl', 'apiBase');
    expect(team.getEnvironment('Mine')!.variables.map((v) => v.key)).toEqual(['apiBase']);
    expect(readFileSync(file, 'utf8')).toContain('"baseUrl"');
    // a workspace.json with an absolute path, or a folder that is not a workspace, is not read
    expect(sharedDirs({ shared: [{ path: join(tmp.dir, 'platform-shared'), kinds: ['environments'] }] }, team.root, 'environments')).toEqual([]);
    expect(sharedDirs({ shared: [{ path: '..', kinds: ['environments'] }] }, team.root, 'environments')).toEqual([]);
    expect(() => checkedSource(team.root, '..', ['environments'])).toThrow(/not a workspace|no environments folder/);
  });

  it('testpion workspace share adds and removes a folder; env list says where one comes from', () => {
    const home = join(tmp.dir, 'home');
    const cli = (args: string[]) => runCliSync([...args, '--json', '--non-interactive'], { home, cwd: tmp.dir, env: { CI: '1' } });
    const ws = join(tmp.dir, 'payments');
    const removed = cli(['workspace', 'share', '--remove', '../platform-shared', '-w', ws]);
    expect(removed.status, removed.out + removed.err).toBe(0);
    expect(JSON.parse(removed.out).data.shared).toEqual([]);
    const added = cli(['workspace', 'share', '--add', '../platform-shared', '-w', ws]);
    expect(added.status, added.out + added.err).toBe(0);
    expect(JSON.parse(added.out).data.environments.map((e: { name: string }) => e.name)).toContain('Shared staging');
    const list = cli(['env', 'list', '-w', ws]);
    expect(JSON.parse(list.out).data.find((e: { name: string }) => e.name === 'Shared staging')).toMatchObject({ shared: 'platform-shared' });
    const wrong = cli(['workspace', 'share', '--add', '../platform-shared', '--kinds', 'collections', '-w', ws]);
    expect(wrong.status).toBe(2);
  });
});
