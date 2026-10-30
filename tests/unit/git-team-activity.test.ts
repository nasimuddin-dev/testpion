import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runGit, teamActivity } from '../../packages/core/src/index.js';
import { makeRepo, type TestRepo } from '../helpers-git';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/** What other people changed lately, by meaning: the commits of others, not mine, each with its items in words. */
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
  // mine: the base commit (as the repo's own identity, tester@example.com)
  r.write('mcp-servers.json', servers([weather, search('https://s.example.com/v1')]));
  await r.commit('mine: add search');
  // Ana changes the search server's URL, Ben adds a server
  r.write('mcp-servers.json', servers([weather, search('https://s.example.com/v2')]));
  await commitAs('Ana', 'Point search at v2');
  r.write('mcp-servers.json', servers([weather, search('https://s.example.com/v2'), { id: 'files', name: 'Files', transport: 'http', url: 'https://f.example.com' }]));
  await commitAs('Ben', 'Add the files server');
});
afterAll(() => r.cleanup());

describe('teamActivity', () => {
  it('lists the commits of others, newest first, each with what it changed in words, and leaves mine out', async () => {
    const a = await teamActivity(r.ws, { days: 14, limit: 8 });
    expect(a.me).toBe('tester@example.com');
    expect(a.commits.map((c) => `${c.author}: ${c.subject}`)).toEqual(['Ben: Add the files server', 'Ana: Point search at v2']);
    expect(a.commits[1]!.changes).toEqual([expect.objectContaining({ change: 'changed', title: 'MCP server Search', details: ['URL'] })]);
    expect(a.commits[0]!.changes[0]).toMatchObject({ change: 'added', title: 'MCP server Files' });
    expect(a.commits[0]!.more).toBe(0);
    expect(a.text).toBe('2 commits by 2 people in the last 14 days.');
  });

  it('says so when nobody else changed anything, and respects the limit', async () => {
    expect((await teamActivity(r.ws, { limit: 1 })).commits).toHaveLength(1);
    const quiet = await makeRepo();
    try {
      const a = await teamActivity(quiet.ws, { days: 7 });
      expect(a.commits).toEqual([]);
      expect(a.text).toBe('Nobody else has changed this workspace in the last 7 days.');
    } finally {
      await quiet.cleanup();
    }
  });
});
