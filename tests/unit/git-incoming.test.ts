import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { incomingChanges, runGit } from '../../packages/core/src/index.js';
import { makeRepo, type TestRepo } from '../helpers-git';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/** What a pull would bring in, by meaning, before it is pulled; my own unpushed commits are not part of it. */
const servers = (rows: Array<Record<string, unknown>>) => JSON.stringify({ schemaVersion: '1.0', servers: rows }, null, 2) + '\n';
const weather = { id: 'weather', name: 'Weather mock', transport: 'mock', mockFile: 'mocks/weather.mcp-mock.yaml' };
const search = (url: string) => ({ id: 'search', name: 'Search', transport: 'http', url });

let r: TestRepo;
const commitAs = async (name: string, message: string) => {
  await runGit(r.ws, ['add', '-A']);
  await runGit(r.ws, ['-c', `user.name=${name}`, '-c', `user.email=${name.toLowerCase()}@example.com`, '-c', 'commit.gpgsign=false', 'commit', '-m', message]);
};

beforeAll(async () => {
  r = await makeRepo();
  r.write('mcp-servers.json', servers([weather, search('https://s.example.com/v1')]));
  await r.commit('base: search');
  // my branch follows main (as a branch follows its remote one); the team moves main
  await runGit(r.repo, ['checkout', '-b', 'mine']);
  await runGit(r.repo, ['branch', '--set-upstream-to=main', 'mine']);
  await runGit(r.repo, ['checkout', 'main']);
  r.write('mcp-servers.json', servers([weather, search('https://s.example.com/v2')]));
  await commitAs('Ana', 'Point search at v2');
  r.write('mcp-servers.json', servers([weather, search('https://s.example.com/v2'), { id: 'files', name: 'Files', transport: 'http', url: 'https://f.example.com' }]));
  await commitAs('Ben', 'Add the files server');
  await runGit(r.repo, ['checkout', 'mine']);
});
afterAll(() => r.cleanup());

describe('incomingChanges', () => {
  it('lists the commits of the upstream not yet here and what they change in words, newest first', async () => {
    // a commit of mine on the branch: not part of what comes in
    r.write('notes.txt', 'mine');
    await r.commit('mine: a note');
    const inc = (await incomingChanges(r.ws))!;
    expect(inc.upstream).toBe('main');
    expect(inc.commits.map((c) => `${c.author}: ${c.subject}`)).toEqual(['Ben: Add the files server', 'Ana: Point search at v2']);
    expect(inc.changes.map((c) => [c.change, c.title])).toEqual(
      expect.arrayContaining([
        ['changed', 'MCP server Search'],
        ['added', 'MCP server Files'],
      ]),
    );
    expect(inc.changes.some((c) => /notes/.test(c.title))).toBe(false);
    expect(inc.text).toMatch(/^2 commits by 2 people change 2 items: /);
  });

  it('says so when nothing is waiting, and gives nothing without an upstream', async () => {
    await runGit(r.repo, ['merge', '--no-edit', 'main']);
    expect((await incomingChanges(r.ws))!.text).toBe('Nothing is waiting on main.');
    const alone = await makeRepo();
    try {
      expect(await incomingChanges(alone.ws)).toBeUndefined();
    } finally {
      alone.cleanup();
    }
  });
});
