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

describe('open comments by team', () => {
  it('carries the CODEOWNERS owners of the item each comment is on, and keeps one team on request', async () => {
    const { addComment, openCommentsByOwner } = await import('../../packages/core/src/index.js');
    r.write('CODEOWNERS', 'tests/ @org/platform\n');
    r.write('tests/smoke.yaml', 'name: Smoke'+String.fromCharCode(10)+'tests: []'+String.fromCharCode(10));
    addComment(r.store, { kind: 'test', path: 'smoke.yaml' }, 'Why v2?', 'Ana');
    addComment(r.store, { kind: 'run', runId: 'r-1' }, 'Orphan', 'Ben');
    const all = await openCommentsByOwner(r.store);
    expect(all.map((c) => [c.text, c.owners])).toEqual([['Orphan', []], ['Why v2?', ['@org/platform']]]);
    expect((await openCommentsByOwner(r.store, 'org/platform')).map((c) => c.text)).toEqual(['Why v2?']);
    expect(await openCommentsByOwner(r.store, '@org/payments')).toEqual([]);
  });
});

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

  it('names the teams of the files a commit touched (CODEOWNERS) and lists one team only on request', async () => {
    r.write('CODEOWNERS', 'mcp-servers.json @org/platform\n');
    await r.commit('mine: owners');
    const a = await teamActivity(r.ws, { days: 14 });
    expect(a.commits.map((c) => c.owners)).toEqual([['@org/platform'], ['@org/platform']]);
    expect((await teamActivity(r.ws, { owner: 'org/platform' })).commits).toHaveLength(2);
    const none = await teamActivity(r.ws, { owner: '@org/payments' });
    expect(none.commits).toEqual([]);
    expect(none.text).toBe("Nobody else has changed @org/payments's part of this workspace in the last 14 days.");
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
