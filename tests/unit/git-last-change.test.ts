import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { addressOf, itemLastChange, runGit } from '../../packages/core/src/index.js';
import { makeRepo, type TestRepo } from '../helpers-git';
import { cardOf, whenWords } from '../../apps/desktop/src/lib/git-who-text';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/**
 * "Who last changed it" on hover (lib/git-who.ts, the `git.lastChange` RPC): the newest commit that changed the item, its
 * author, when and what, from a scripted repository with two authors.
 */
const servers = (rows: Array<Record<string, unknown>>) => JSON.stringify({ schemaVersion: '1.0', servers: rows }, null, 2) + '\n';
const weather = { id: 'weather', name: 'Weather mock', transport: 'mock', mockFile: 'mocks/weather.mcp-mock.yaml' };
const search = (url: string) => ({ id: 'search', name: 'Search', transport: 'http', url });
const files = (url: string) => ({ id: 'files', name: 'Files', transport: 'http', url });

let r: TestRepo;
/** A commit by another person (the repo helper commits as one author). */
const commitAs = async (name: string, message: string) => {
  await runGit(r.ws, ['add', '-A']);
  await runGit(r.ws, ['-c', `user.name=${name}`, '-c', `user.email=${name.toLowerCase()}@example.com`, '-c', 'commit.gpgsign=false', 'commit', '-m', message]);
};
beforeAll(async () => {
  r = await makeRepo();
  r.write('mcp-servers.json', servers([weather, search('https://s.example.com/v1'), files('https://f.example.com/v1')]));
  await r.commit('three servers');
  r.write('mcp-servers.json', servers([weather, search('https://s.example.com/v2'), files('https://f.example.com/v1')]));
  await commitAs('Ana', 'Point search at v2');
  r.write('mcp-servers.json', servers([weather, search('https://s.example.com/v2'), files('https://f.example.com/v2')]));
  await commitAs('Ben', 'Move files to v2');
});
afterAll(() => r.cleanup());

describe('itemLastChange', () => {
  it('is the newest commit that changed this item, not the newest of the file', async () => {
    const s = await itemLastChange(r.ws, addressOf('mcp-servers.json', 'search'));
    expect(s).toMatchObject({ author: 'Ana', subject: 'Point search at v2', changed: ['URL'] });
    const f = await itemLastChange(r.ws, addressOf('mcp-servers.json', 'files'));
    expect(f).toMatchObject({ author: 'Ben', subject: 'Move files to v2', changed: ['URL'] });
    // an item nobody changed since it was created: the commit that created it
    const w = await itemLastChange(r.ws, addressOf('mcp-servers.json', 'weather'));
    expect(w).toMatchObject({ subject: 'base', changed: ['created'] });
    expect(s!.date).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('has nothing for an item that is not committed yet', async () => {
    r.write('mcp-servers.json', servers([weather, search('https://s.example.com/v2'), files('https://f.example.com/v2'), { id: 'new', name: 'New', transport: 'http', url: 'https://n.example.com' }]));
    expect(await itemLastChange(r.ws, addressOf('mcp-servers.json', 'new'))).toBeUndefined();
  });
});

describe('the card', () => {
  const now = Date.parse('2026-10-30T12:00:00Z');
  it('says when in words a person reads', () => {
    expect(whenWords('2026-10-30T11:59:50Z', now)).toBe('just now');
    expect(whenWords('2026-10-30T09:00:00Z', now)).toBe('3h ago');
    expect(whenWords('2026-10-29T08:00:00Z', now)).toBe('yesterday');
    expect(whenWords('2026-10-27T08:00:00Z', now)).toBe('3 days ago');
    expect(whenWords('2026-08-01T08:00:00Z', now)).toMatch(/^on /);
    expect(whenWords('nonsense', now)).toBe('');
  });

  it('puts who and when first, then why and what', () => {
    const c = cardOf({ author: 'Ana', date: '2026-10-28T08:00:00Z', subject: 'Point search at v2', changed: ['URL', 'Headers'] }, now);
    expect(c).toEqual({ headline: 'Ana, 2 days ago', lines: ['“Point search at v2”', 'Changed: URL, Headers'] });
    const many = cardOf({ author: 'Ben', date: '2026-10-30T11:00:00Z', subject: '', changed: ['a', 'b', 'c', 'd', 'e', 'f'] }, now);
    expect(many.lines).toEqual(['Changed: a, b, c, d and 2 more']);
  });
});
