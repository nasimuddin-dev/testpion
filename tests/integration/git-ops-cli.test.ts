import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { WorkspaceStore } from '../../packages/core/src/index.js';
import { cliData, runCliSync, tempDir } from '../helpers';
import { makeRepo, type TestRepo } from '../helpers-git';

/**
 * Release B of "Everything under Git" on the command line: history, blame, restore, discard-item, stage-item, undo, stash,
 * conflicts of every kind (items with fields, text hunks), and the commit that scans what is staged. A scripted repository
 * (no network); every command is also run with --json.
 */
const home = tempDir('tp-git-ops-home-');
let r: TestRepo;
let c1 = '';
const cli = (...args: string[]) => runCliSync([...args, '-w', r.ws], { home: home.dir });
const json = (p: string) => JSON.parse(r.read(p));
const servers = (list: unknown[]) => JSON.stringify({ schemaVersion: '1.0', servers: list }, null, 2) + '\n';
const weather = { id: 'weather', name: 'Weather mock', transport: 'mock', mockFile: 'mocks/weather.mcp-mock.yaml' };
const search = (url: string, name = 'Search') => ({ id: 'search', name, transport: 'http', url });

beforeAll(async () => {
  r = await makeRepo();
  r.write('mcp-servers.json', servers([weather, search('https://s.example.com/v1')]));
  await r.commit('add search');
  c1 = (await r.git('rev-parse', 'HEAD')).trim();
  r.write('mcp-servers.json', servers([weather, search('https://s.example.com/v2')]));
  await r.commit('search v2');
  // not committed: a new URL for search and a new name for weather
  r.write('mcp-servers.json', servers([{ ...weather, name: 'Weather live' }, search('https://s.example.com/v3')]));
}, 120_000);
afterAll(() => {
  r.cleanup();
  home.cleanup();
});

describe('history and blame of one item', () => {
  it('history lists the commits that changed the item, newest first, with what each changed', () => {
    const run = cli('git', 'history', 'mcp-server:search', '--json');
    expect(run.status, run.err).toBe(0);
    const h = cliData<{ title: string; file: string; itemId: string; versions: Array<{ commit: { hash: string; subject: string }; changed: string[] }> }>(run.out);
    expect(h).toMatchObject({ file: 'mcp-servers.json', itemId: 'search' });
    expect(h.versions.map((v) => v.commit.subject)).toEqual(['search v2', 'add search']);
    expect(h.versions[0]!.changed.join(' ')).toMatch(/url/i);
    // the same through the file#id form, in words, with -n
    const text = cli('git', 'history', 'mcp-servers.json#search', '-n', '1');
    expect(text.status, text.err).toBe(0);
    expect(text.out).toMatch(/search v2/);
    expect(text.out).not.toMatch(/add search/);
  });

  it('blame says which field is not committed yet and who changed the others', () => {
    const run = cli('git', 'blame', 'mcp-server:search', '--json');
    expect(run.status, run.err).toBe(0);
    const b = cliData<{ fields: Array<{ field: string; uncommitted?: boolean; commit?: { author: string } }> }>(run.out);
    expect(b.fields.some((f) => f.uncommitted)).toBe(true);
    expect(b.fields.some((f) => f.commit?.author === 'Tester')).toBe(true);
    expect(cli('git', 'blame', 'mcp-server:search').out).toMatch(/not committed yet/);
  });

  it('an unknown item or a malformed one is a clear message with exit 2', () => {
    const run = cli('git', 'history', 'no-such-kind:x');
    expect(run.status).toBe(2);
    expect(run.err).toMatch(/testpion:\/\/ link|short ref|kind:id|not in|No /i);
  });
});

describe('stage-item names what comes along', () => {
  it('a file with two changed items stages as one file: the message names the other', async () => {
    const dry = cli('git', 'stage-item', 'mcp-server:weather', '--dry-run', '--json');
    expect(dry.status, dry.err).toBe(0);
    const d = cliData<{ applied: boolean; alsoStages: string[]; message: string }>(dry.out);
    expect(d.applied).toBe(false);
    expect(d.alsoStages.join(' ')).toMatch(/Search/);
    expect(d.message).toMatch(/also holds 1 other changed item/);
    expect(await r.git('diff', '--cached', '--name-only')).toBe('');
    const real = cli('git', 'stage-item', 'mcp-server:weather');
    expect(real.status, real.err).toBe(0);
    expect(real.out).toMatch(/Staged mcp-servers\.json \(it also holds 1 other changed item/);
    expect((await r.git('diff', '--cached', '--name-only')).trim()).toBe('mcp-servers.json');
    const back = cli('git', 'unstage-item', 'mcp-server:weather', '--json');
    expect(cliData<{ applied: boolean }>(back.out).applied).toBe(true);
    expect(await r.git('diff', '--cached', '--name-only')).toBe('');
  });
});

describe('restore, discard and undo', () => {
  it('restore --dry-run prints the plan and writes nothing', () => {
    const before = r.read('mcp-servers.json');
    const run = cli('git', 'restore', 'mcp-server:search', '--rev', c1, '--dry-run', '--json');
    expect(run.status, run.err).toBe(0);
    const plan = cliData<{ applied: boolean; changed: boolean; action: string; title: string; parts: Array<{ part: string; before?: string; after?: string }>; undoId?: string }>(run.out);
    expect(plan).toMatchObject({ applied: false, changed: true, action: 'replace-item' });
    expect(plan.title).toMatch(/Search/);
    expect(plan.undoId).toBeUndefined();
    expect(JSON.stringify(plan.parts)).toContain('/v1');
    expect(r.read('mcp-servers.json')).toBe(before);
    expect(cli('git', 'restore', 'mcp-server:search', '--rev', c1, '--dry-run').out).toMatch(/Would restore/);
  });

  it('restore writes just that item back and gives an undo id; undo puts the file back exactly', () => {
    const before = r.read('mcp-servers.json');
    const run = cli('git', 'restore', 'mcp-server:search', '--rev', c1, '--json');
    expect(run.status, run.err).toBe(0);
    const res = cliData<{ applied: boolean; undoId: string }>(run.out);
    expect(res.applied).toBe(true);
    expect(res.undoId).toBeTruthy();
    const now = json('mcp-servers.json').servers;
    expect(now.find((s: { id: string }) => s.id === 'search').url).toBe('https://s.example.com/v1');
    // the other item's uncommitted rename stays
    expect(now.find((s: { id: string }) => s.id === 'weather').name).toBe('Weather live');
    const list = cliData<Array<{ id: string }>>(cli('git', 'undo', '--list', '--json').out);
    expect(list[0]!.id).toBe(res.undoId);
    expect(cli('git', 'undo', '--list').out).toMatch(/Restore/);
    const undo = cli('git', 'undo', '--json');
    expect(undo.status, undo.err).toBe(0);
    expect(r.read('mcp-servers.json')).toBe(before);
    expect(cli('git', 'undo').err).toMatch(/Nothing to undo/);
  });

  it('discard-item throws away one item\'s change and keeps the other\'s', () => {
    const dry = cli('git', 'discard-item', 'mcp-server:search', '--dry-run', '--json');
    expect(cliData<{ applied: boolean; changed: boolean }>(dry.out)).toMatchObject({ applied: false, changed: true });
    expect(json('mcp-servers.json').servers[1].url).toBe('https://s.example.com/v3');
    const run = cli('git', 'discard-item', 'mcp-server:search', '--json');
    expect(run.status, run.err).toBe(0);
    expect(cliData<{ applied: boolean; undoId: string }>(run.out).applied).toBe(true);
    const now = json('mcp-servers.json').servers;
    expect(now.find((s: { id: string }) => s.id === 'search').url).toBe('https://s.example.com/v2');
    expect(now.find((s: { id: string }) => s.id === 'weather').name).toBe('Weather live');
    expect(cli('git', 'discard-item', 'mcp-server:search').out).toMatch(/nothing to change/i);
  });
});

describe('stash', () => {
  it('push (dry run first), list, show, pop', () => {
    const dry = cli('git', 'stash', 'push', '-m', 'Before the rewrite', '--dry-run', '--json');
    expect(dry.status, dry.err).toBe(0);
    expect(cliData<{ applied: boolean; changes: unknown[] }>(dry.out)).toMatchObject({ applied: false });
    expect(json('mcp-servers.json').servers[0].name).toBe('Weather live');

    const push = cli('git', 'stash', 'push', '-m', 'Before the rewrite', '--json');
    expect(push.status, push.err).toBe(0);
    expect(cliData<{ applied: boolean; stash: { name: string } }>(push.out)).toMatchObject({ applied: true, stash: { name: 'Before the rewrite' } });
    expect(json('mcp-servers.json').servers[0].name).toBe('Weather mock');

    const list = cliData<Array<{ index: number; name: string; ours: boolean }>>(cli('git', 'stash', 'list', '--json').out);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ index: 0, name: 'Before the rewrite', ours: true });
    expect(cli('git', 'stash', 'list').out).toMatch(/Before the rewrite/);

    const show = cliData<{ stash: { name: string }; changes: Array<{ title: string }> }>(cli('git', 'stash', 'show', '0', '--json').out);
    expect(show.stash.name).toBe('Before the rewrite');
    expect(show.changes.map((c) => c.title).join(' ')).toMatch(/Weather/);

    const pop = cli('git', 'stash', 'pop', '--json');
    expect(pop.status, pop.err).toBe(0);
    expect(cliData<{ dropped: boolean; conflicted: boolean }>(pop.out)).toMatchObject({ dropped: true, conflicted: false });
    expect(json('mcp-servers.json').servers[0].name).toBe('Weather live');
    expect(cliData<unknown[]>(cli('git', 'stash', 'list', '--json').out)).toEqual([]);
  });

  it('drop removes a stash for good; a missing one says what exists', () => {
    expect(cli('git', 'stash', 'push', '-m', 'second').status).toBe(0);
    const drop = cli('git', 'stash', 'drop', '0', '--json');
    expect(cliData<{ dropped: { name: string } }>(drop.out).dropped.name).toBe('second');
    const none = cli('git', 'stash', 'apply');
    expect(none.status).toBe(2);
    expect(none.err).toMatch(/No such stash/);
  });
});

describe('the commit scans what is staged', () => {
  const KEY = 'Bearer ' + 'abcdef0123456789abcdef0123456789';

  it('a typed secret refuses the commit, names the item and the variable, and --allow-secrets does not override it', async () => {
    // the working changes are committed first: only the secret is new
    r.write('mcp-servers.json', servers([weather, { ...search('https://s.example.com/v2'), headers: [{ key: 'Authorization', value: KEY }] }]));
    const run = cli('git', 'commit', '-m', 'with a secret', '--json');
    expect(run.status).toBe(1);
    const res = cliData<{ committed: boolean; reason: string; secrets: Array<{ item: string; variable: string; confidence: string }> }>(run.out);
    expect(res).toMatchObject({ committed: false, reason: 'blocked' });
    expect(res.secrets[0]).toMatchObject({ item: 'MCP server Search', variable: '{{SEARCH_AUTHORIZATION}}', confidence: 'high' });
    expect(run.out).not.toContain('abcdef0123456789');
    const text = cli('git', 'commit', '-m', 'x');
    expect(text.status).toBe(1);
    expect(text.out).toMatch(/MCP server Search/);
    expect(text.out).toMatch(/\{\{SEARCH_AUTHORIZATION\}\}/);
    const forced = cli('git', 'commit', '-m', 'x', '--allow-secrets', '--json');
    expect(forced.status).toBe(1);
    expect(cliData<{ committed: boolean }>(forced.out).committed).toBe(false);
    // the index was put back as it was (nothing was staged before)
    expect(await r.git('diff', '--cached', '--name-only')).toBe('');
    expect((await r.git('log', '--oneline')).split('\n').filter(Boolean)).toHaveLength(3);
  });

  it('git check --staged scans the index: exit 1 on a finding, 0 once the fix is staged', async () => {
    await r.git('add', 'mcp-servers.json');
    const bad = cli('git', 'check', '--staged', '--json');
    expect(bad.status).toBe(1);
    const scan = cliData<{ staged: string[]; blocking: Array<{ variable: string }>; confirm: unknown[] }>(bad.out);
    expect(scan.staged).toEqual(['mcp-servers.json']);
    expect(scan.blocking[0]!.variable).toBe('{{SEARCH_AUTHORIZATION}}');
    expect(cli('git', 'check', '--staged').out).toMatch(/commit is refused/);

    r.write('mcp-servers.json', servers([weather, { ...search('https://s.example.com/v2'), headers: [{ key: 'Authorization', value: '{{SEARCH_AUTHORIZATION}}' }] }]));
    await r.git('add', 'mcp-servers.json');
    const ok = cli('git', 'check', '--staged');
    expect(ok.status, ok.out).toBe(0);
    expect(ok.out).toMatch(/safe to commit/);
  });

  it('a clean change commits with the staged scan', async () => {
    const run = cli('git', 'commit', '-m', 'header as a variable', '--staged', '--json');
    expect(run.status, run.err).toBe(0);
    expect(cliData<{ committed: boolean; commit: { subject: string } }>(run.out)).toMatchObject({ committed: true, commit: { subject: 'header as a variable' } });
  });
});

describe('conflicts of an MCP server and of a text file', () => {
  /** Two branches change `path` differently; merging `theirs` into main stops. */
  async function conflict(path: string, ours: (t: string) => string, theirs: (t: string) => string) {
    const base = r.read(path);
    await r.git('checkout', '-b', 'theirs');
    r.write(path, theirs(base));
    await r.commit('theirs');
    await r.git('checkout', 'main');
    r.write(path, ours(base));
    await r.commit('ours');
    await r.git('merge', 'theirs').catch(() => undefined);
  }

  it('conflicts prints items with their fields and keys, and text hunks with where; resolve --pick / --edit settle them', async () => {
    await conflict(
      'mcp-servers.json',
      (t) => t.replace('https://s.example.com/v2', 'https://ours.example.com'),
      (t) => t.replace('https://s.example.com/v2', 'https://theirs.example.com'),
    );
    const list = cliData<Array<{ path: string; mode: string; items: Array<{ key: string; fields?: Array<{ key: string }> }> }>>(cli('git', 'conflicts', '--json').out);
    const mcp = list.find((d) => d.path === 'mcp-servers.json')!;
    expect(mcp.mode).toBe('items');
    expect(mcp.items[0]!.key).toBe('item:search');
    expect(mcp.items[0]!.fields![0]!.key).toBe('item:search#url');
    const text = cli('git', 'conflicts');
    expect(text.out).toMatch(/item:search#url/);
    expect(text.out).toMatch(/merged by meaning/);

    // an unknown key names the valid ones; a bad JSON edit is refused; nothing is written
    const bad = cli('git', 'resolve', 'mcp-servers.json', '--pick', 'item:nope=ours');
    expect(bad.status).toBe(2);
    expect(bad.err).toMatch(/item:search#url/);
    expect(cli('git', 'resolve', 'mcp-servers.json', '--edit', 'item:search#url=not json').status).toBe(2);

    const done = cli('git', 'resolve', 'mcp-servers.json', '--edit', 'item:search#url="https://edited.example.com"', '--json');
    expect(done.status, done.err).toBe(0);
    expect(json('mcp-servers.json').servers.find((s: { id: string }) => s.id === 'search').url).toBe('https://edited.example.com');
    expect(cli('git', 'conflicts').out).toMatch(/No conflicts/);
    await r.git('commit', '-m', 'merge');
    await r.git('branch', '-D', 'theirs');
  });

  it('a text (test) file is settled hunk by hunk; --resolve ours settles every file', async () => {
    await conflict(
      'tests/flows/checkout.yaml',
      (t) => t.replace('/pay"', '/pay-ours"'),
      (t) => t.replace('/pay"', '/pay-theirs"'),
    );
    const list = cliData<Array<{ path: string; mode: string; hunks: Array<{ key: string; where: string }> }>>(cli('git', 'conflicts', 'tests/flows/checkout.yaml', '--json').out);
    expect(list[0]).toMatchObject({ path: 'tests/flows/checkout.yaml', mode: 'text' });
    expect(list[0]!.hunks[0]!.key).toBe('hunk:0');
    expect(list[0]!.hunks[0]!.where).toMatch(/near item Pay/);
    expect(cli('git', 'conflicts', 'tests/flows/checkout.yaml').out).toMatch(/hunk:0/);

    const edit = cli('git', 'resolve', 'tests/flows/checkout.yaml', '--edit', 'hunk:0=      url: "{{baseUrl}}/pay-edited"');
    expect(edit.status, edit.err).toBe(0);
    expect(r.read('tests/flows/checkout.yaml')).toContain('/pay-edited"');
    expect(r.read('tests/flows/checkout.yaml')).not.toContain('<<<<<<<');
    await r.git('commit', '-m', 'merge text');
    await r.git('branch', '-D', 'theirs');

    // the shortcut: every conflicted file with one side
    await conflict(
      'tests/flows/checkout.yaml',
      (t) => t.replace('/pay-edited"', '/pay-a"'),
      (t) => t.replace('/pay-edited"', '/pay-b"'),
    );
    const all = cli('git', 'conflicts', '--resolve', 'theirs', '--json');
    expect(all.status, all.err).toBe(0);
    expect(cliData<{ side: string; resolved: string[] }>(all.out)).toEqual({ side: 'theirs', resolved: ['tests/flows/checkout.yaml'] });
    expect(r.read('tests/flows/checkout.yaml')).toContain('/pay-b"');
    expect(cli('git', 'conflicts', '--resolve', 'sideways').status).toBe(2);
    await r.git('commit', '-m', 'merge theirs');
  });
});

describe('not a repository', () => {
  it('every command says so with the core message and exit 2', () => {
    const plain = tempDir('tp-git-ops-plain-');
    try {
      const store = WorkspaceStore.create(join(plain.dir, 'ws'), 'Plain');
      const ws = store.root;
      store.close();
      for (const args of [['history', 'mcp-server:weather'], ['blame', 'mcp-server:weather'], ['stash', 'list'], ['stash', 'push', '-m', 'x'], ['stage-item', 'mcp-server:weather'], ['commit', '-m', 'x']]) {
        const run = runCliSync(['git', ...args, '-w', ws], { home: home.dir });
        expect(run.status, args.join(' ')).toBe(2);
        expect(run.err, args.join(' ')).toMatch(/not in a git repository/);
      }
    } finally {
      plain.cleanup();
    }
  });
});
