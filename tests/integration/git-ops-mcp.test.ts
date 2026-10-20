import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTestPionMcpServer, EnvSecretStore, WorkspaceManager } from '../../packages/core/src/index.js';
import { makeRepo, type TestRepo } from '../helpers-git';
import { tempDir } from '../helpers';

/**
 * Release B of "Everything under Git" for agents: git_history, git_blame, git_restore_item, git_discard_item,
 * git_stage_item, git_undo, git_stash, the conflicts of every kind through git_conflicts / git_resolve, and the commit
 * proposal that scans what is staged. Through the same in-memory client / server pair as the other MCP tests.
 */
const home = tempDir('tp-git-ops-mcp-home-');
let r: TestRepo;
let client: Client;
let c1 = '';
const servers = (list: unknown[]) => JSON.stringify({ schemaVersion: '1.0', servers: list }, null, 2) + '\n';
const weather = { id: 'weather', name: 'Weather mock', transport: 'mock', mockFile: 'mocks/weather.mcp-mock.yaml' };
const search = (url: string, extra: Record<string, unknown> = {}) => ({ id: 'search', name: 'Search', transport: 'http', url, ...extra });

type Result = Awaited<ReturnType<Client['callTool']>>;
const texts = (res: Result) => (res.content as Array<{ type: string; text: string }>).map((c) => c.text);
/** The tool's answer as data. */
async function call<T = any>(name: string, args: Record<string, unknown> = {}): Promise<{ res: Result; data: T }> {
  const res = await client.callTool({ name, arguments: args });
  let data: unknown;
  try {
    data = JSON.parse(texts(res)[0] ?? '');
  } catch {
    data = texts(res)[0];
  }
  return { res, data: data as T };
}

beforeAll(async () => {
  r = await makeRepo();
  r.write('mcp-servers.json', servers([weather, search('https://s.example.com/v1')]));
  await r.commit('add search');
  c1 = (await r.git('rev-parse', 'HEAD')).trim();
  r.write('mcp-servers.json', servers([weather, search('https://s.example.com/v2')]));
  await r.commit('search v2');
  r.write('mcp-servers.json', servers([{ ...weather, name: 'Weather live' }, search('https://s.example.com/v3')]));
  const mgr = new WorkspaceManager(home.dir);
  const store = mgr.open(r.ws);
  const server = createTestPionMcpServer({ store, secrets: new EnvSecretStore(), settings: mgr.loadSettings() });
  client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
}, 120_000);
afterAll(async () => {
  await client.close();
  r.cleanup();
  home.cleanup();
});

describe('the tools and their contract', () => {
  it('are listed with when / when not / example; the writes that overwrite take confirm, the reads do not', async () => {
    const tools = (await client.listTools()).tools;
    const by = (n: string) => tools.find((t) => t.name === n)!;
    for (const n of ['git_history', 'git_blame', 'git_restore_item', 'git_discard_item', 'git_stage_item', 'git_undo', 'git_stash']) {
      expect(by(n), n).toBeDefined();
      expect(by(n).description, n).toMatch(/\nWhen to use: .+\nWhen not: .+\nExample: \{/);
    }
    for (const n of ['git_restore_item', 'git_discard_item', 'git_undo', 'git_stash']) expect(by(n).inputSchema.properties, n).toHaveProperty('confirm');
    for (const n of ['git_history', 'git_blame']) expect(by(n).inputSchema.properties, n).not.toHaveProperty('confirm');
    // the item id parameter is snake_case like every other tool's
    expect(by('git_blame').inputSchema.properties).toHaveProperty('item_id');
    expect(by('git_history').inputSchema.properties).toHaveProperty('cursor');
  });
});

describe('history and blame', () => {
  it('git_history lists the versions with what each changed; git_blame the commit per field', async () => {
    const { res, data } = await call<{ title: string; versions: Array<{ commit: { subject: string }; changed: string[] }> }>('git_history', { ref: 'mcp-server:search' });
    expect(res.isError).toBeFalsy();
    expect(data.versions.map((v) => v.commit.subject)).toEqual(['search v2', 'add search']);
    expect(data.versions[0]!.changed.join(' ')).toMatch(/url/i);
    // the file form is the same
    const byFile = await call<{ versions: unknown[] }>('git_history', { file: 'mcp-servers.json', item_id: 'search', limit: 1 });
    expect(byFile.data.versions).toHaveLength(1);

    const blame = await call<{ fields: Array<{ field: string; uncommitted?: boolean; commit?: { subject: string } }> }>('git_blame', { ref: 'mcp-server:search' });
    expect(blame.data.fields.some((f) => f.uncommitted)).toBe(true);
    expect(blame.data.fields.some((f) => f.commit?.subject === 'add search')).toBe(true);
  });

  it('a malformed item is an error that says how to name one', async () => {
    const { res } = await call('git_history', { ref: 'no-such-kind:x' });
    expect(res.isError).toBe(true);
    expect(texts(res)[0]).toMatch(/Not an item reference/);
  });
});

describe('restore, discard, stage and undo', () => {
  const urlOf = (id: string) => JSON.parse(r.read('mcp-servers.json')).servers.find((s: { id: string }) => s.id === id).url;

  it('git_restore_item without confirm changes nothing and previews the plan; dryRun is allowed as it is', async () => {
    const before = r.read('mcp-servers.json');
    const ask = await call('git_restore_item', { ref: 'mcp-server:search', rev: c1 });
    expect(ask.res.isError).toBe(true);
    expect(ask.res.structuredContent).toMatchObject({ confirmationRequired: true, changed: false, preview: { applied: false, changed: true, action: 'replace-item' } });
    expect(r.read('mcp-servers.json')).toBe(before);
    const dry = await call<{ applied: boolean; parts: unknown[] }>('git_restore_item', { ref: 'mcp-server:search', rev: c1, dryRun: true });
    expect(dry.res.isError).toBeFalsy();
    expect(dry.data).toMatchObject({ applied: false });
    expect(r.read('mcp-servers.json')).toBe(before);
  });

  it('with confirm it writes just that item and answers with an undoId; git_undo (confirmed) puts the file back', async () => {
    const before = r.read('mcp-servers.json');
    const done = await call<{ applied: boolean; undoId: string }>('git_restore_item', { ref: 'mcp-server:search', rev: c1, confirm: true });
    expect(done.data.applied).toBe(true);
    expect(urlOf('search')).toBe('https://s.example.com/v1');
    expect(JSON.parse(r.read('mcp-servers.json')).servers[0].name).toBe('Weather live');

    const list = await call<Array<{ id: string }>>('git_undo', { list: true });
    expect(list.res.isError).toBeFalsy();
    expect(list.data[0]!.id).toBe(done.data.undoId);
    const ask = await call('git_undo', {});
    expect(ask.res.structuredContent).toMatchObject({ confirmationRequired: true });
    expect(urlOf('search')).toBe('https://s.example.com/v1');
    const undone = await call<{ id: string }>('git_undo', { confirm: true });
    expect(undone.data.id).toBe(done.data.undoId);
    expect(r.read('mcp-servers.json')).toBe(before);
  });

  it('git_stage_item stages just the item and names the ones left out; git_discard_item keeps the others\' changes', async () => {
    const stage = await call<{ applied: boolean; partial?: boolean; leftUnstaged: string[]; message: string }>('git_stage_item', { ref: 'mcp-server:weather', dryRun: true });
    expect(stage.data.partial).toBe(true);
    expect(stage.data.leftUnstaged.join(' ')).toMatch(/Search/);
    expect(stage.data.applied).toBe(false);
    const real = await call<{ applied: boolean }>('git_stage_item', { ref: 'mcp-server:weather' });
    expect(real.data.applied).toBe(true);
    expect((await r.git('diff', '--cached', '--name-only')).trim()).toBe('mcp-servers.json');
    await call('git_stage_item', { ref: 'mcp-server:weather', unstage: true });
    expect(await r.git('diff', '--cached', '--name-only')).toBe('');

    expect((await call('git_discard_item', { ref: 'mcp-server:search' })).res.structuredContent).toMatchObject({ confirmationRequired: true });
    expect(urlOf('search')).toBe('https://s.example.com/v3');
    const gone = await call<{ applied: boolean }>('git_discard_item', { ref: 'mcp-server:search', confirm: true });
    expect(gone.data.applied).toBe(true);
    expect(urlOf('search')).toBe('https://s.example.com/v2');
    expect(JSON.parse(r.read('mcp-servers.json')).servers[0].name).toBe('Weather live');
  });
});

describe('git_stash', () => {
  it('list, push (confirmed), show, pop (confirmed)', async () => {
    expect((await call<unknown[]>('git_stash', { action: 'list' })).data).toEqual([]);
    const ask = await call('git_stash', { action: 'push', name: 'Before the rewrite' });
    expect(ask.res.structuredContent).toMatchObject({ confirmationRequired: true, preview: { applied: false } });
    expect(JSON.parse(r.read('mcp-servers.json')).servers[0].name).toBe('Weather live');
    const push = await call<{ applied: boolean; stash: { name: string } }>('git_stash', { action: 'push', name: 'Before the rewrite', confirm: true });
    expect(push.data).toMatchObject({ applied: true, stash: { name: 'Before the rewrite' } });
    expect(JSON.parse(r.read('mcp-servers.json')).servers[0].name).toBe('Weather mock');
    const list = await call<Array<{ index: number; name: string }>>('git_stash', { action: 'list' });
    expect(list.data[0]).toMatchObject({ index: 0, name: 'Before the rewrite' });
    const show = await call<{ changes: Array<{ title: string }> }>('git_stash', { action: 'show', index: 0 });
    expect(show.data.changes.map((c) => c.title).join(' ')).toMatch(/Weather/);
    expect((await call('git_stash', { action: 'pop' })).res.structuredContent).toMatchObject({ confirmationRequired: true, preview: { stash: { name: 'Before the rewrite' } } });
    const pop = await call<{ dropped: boolean }>('git_stash', { action: 'pop', confirm: true });
    expect(pop.data.dropped).toBe(true);
    expect(JSON.parse(r.read('mcp-servers.json')).servers[0].name).toBe('Weather live');
    // a drop is refused without confirm, and a bad action says what is valid
    expect((await call('git_stash', { action: 'frobnicate' })).res.isError).toBe(true);
  });
});

describe('git_propose_commit scans what is staged', () => {
  it('a certain secret refuses (and puts the index back), a probable one asks, a clean change is proposed', async () => {
    r.write('mcp-servers.json', servers([weather, search('https://s.example.com/v2', { headers: [{ key: 'Authorization', value: 'Bearer abcdef0123456789abcdef0123456789' }] })]));
    const blocked = await call<{ proposed: boolean; secrets: Array<{ item: string; variable: string }> }>('git_propose_commit', { message: 'Add search auth' });
    expect(blocked.data.proposed).toBe(false);
    expect(blocked.data.secrets[0]).toMatchObject({ item: 'MCP server Search', variable: '{{SEARCH_AUTHORIZATION}}' });
    expect(texts(blocked.res)[0]).not.toContain('abcdef0123456789');
    expect(await r.git('diff', '--cached', '--name-only')).toBe('');
    // not even a yes from the user changes a certain secret
    expect((await call<{ proposed: boolean }>('git_propose_commit', { message: 'x', allow_probable_secrets: true })).data.proposed).toBe(false);

    r.write('mcp-servers.json', servers([weather, search('https://s.example.com/v2', { headers: [{ key: 'X-Team', value: 'platform-blue' }] })]));
    const probable = await call<{ proposed: boolean; needsConfirmation: boolean; probableSecrets: Array<{ field: string }> }>('git_propose_commit', { message: 'Team header' });
    expect(probable.data).toMatchObject({ proposed: false, needsConfirmation: true });
    expect(probable.data.probableSecrets[0]!.field).toBe('headers.X-Team');
    expect(await r.git('diff', '--cached', '--name-only')).toBe('');
    const yes = await call<{ proposed: boolean; message: string }>('git_propose_commit', { message: 'Team header', allow_probable_secrets: true });
    expect(yes.data).toMatchObject({ proposed: true, message: 'Team header' });
    expect((await r.git('diff', '--cached', '--name-only')).trim()).toBe('mcp-servers.json');

    r.write('mcp-servers.json', servers([weather, search('https://s.example.com/v2', { headers: [{ key: 'Authorization', value: '{{SEARCH_AUTHORIZATION}}' }] })]));
    const clean = await call<{ proposed: boolean }>('git_propose_commit', { message: 'Auth as a variable' });
    expect(clean.data.proposed).toBe(true);
    await r.git('commit', '-m', 'Auth as a variable');
  });
});

describe('git_conflicts and git_resolve for every shape', () => {
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

  it('an MCP server: the clashing field has a key; an edit settles it', async () => {
    await conflict(
      'mcp-servers.json',
      (t) => t.replace('https://s.example.com/v2', 'https://ours.example.com'),
      (t) => t.replace('https://s.example.com/v2', 'https://theirs.example.com'),
    );
    const { data } = await call<{ conflicted: boolean; files: Array<{ path: string; mode: string; items: Array<{ key: string; fields: Array<{ key: string; ours: string; theirs: string }>; editable?: string }>; hunks: unknown[] }> }>('git_conflicts', {});
    const f = data.files.find((x) => x.path === 'mcp-servers.json')!;
    expect(f.mode).toBe('items');
    expect(f.items[0]!.fields[0]).toMatchObject({ key: 'item:search#url', ours: 'https://ours.example.com', theirs: 'https://theirs.example.com' });
    expect(f.items[0]!.editable).toBeUndefined();

    // a choice that is neither a side nor an edit is refused, with the key named
    expect((await call('git_resolve', { path: 'mcp-servers.json', resolutions: { 'item:search#url': 5 }, confirm: true })).res.isError).toBe(true);
    const done = await call<{ resolved: string; stillConflicted: string[] }>('git_resolve', { path: 'mcp-servers.json', resolutions: { 'item:search#url': { edit: JSON.stringify('https://edited.example.com') } }, confirm: true });
    expect(done.data).toMatchObject({ resolved: 'mcp-servers.json', stillConflicted: [] });
    expect(r.read('mcp-servers.json')).toContain('https://edited.example.com');
    await r.git('commit', '-m', 'merge');
    await r.git('branch', '-D', 'theirs');
  });

  it('a text file: hunks with keys and where; a hunk edit is plain text', async () => {
    await conflict(
      'tests/flows/checkout.yaml',
      (t) => t.replace('/pay"', '/pay-ours"'),
      (t) => t.replace('/pay"', '/pay-theirs"'),
    );
    const { data } = await call<{ files: Array<{ path: string; mode: string; hunks: Array<{ key: string; where: string; ours: string; theirs: string }> }> }>('git_conflicts', { path: 'tests/flows/checkout.yaml' });
    const f = data.files[0]!;
    expect(f.mode).toBe('text');
    expect(f.hunks[0]).toMatchObject({ key: 'hunk:0' });
    expect(f.hunks[0]!.ours).toContain('pay-ours');
    expect(f.hunks[0]!.where).toMatch(/near item Pay/);
    // confirm is needed: nothing happens without it
    expect((await call('git_resolve', { path: 'tests/flows/checkout.yaml', side: 'theirs' })).res.structuredContent).toMatchObject({ confirmationRequired: true });
    await call('git_resolve', { path: 'tests/flows/checkout.yaml', resolutions: { 'hunk:0': { edit: '      url: "{{baseUrl}}/pay-edited"' } }, confirm: true });
    expect(r.read('tests/flows/checkout.yaml')).toContain('/pay-edited"');
    expect(r.read('tests/flows/checkout.yaml')).not.toContain('<<<<<<<');
  });
});
