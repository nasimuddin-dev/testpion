import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitMarksOf, gitFolderKey, gitRefKey, gitSectionKey, type ItemRef } from '@testpion/shared';
import { WorkspaceStore, describeGitChanges, describeItemDiff, describeRevChanges, gitStatus, runGit } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers';

/**
 * Release A of "Everything under Git": the Git view names a change by its item ("MCP server Weather: URL"), never by its
 * file, for every kind; each change carries its ref, its registry kind and the keys of the marks it makes on its containers.
 */

const FIXTURE = join(__dirname, '..', 'fixtures', 'kinds', 'workspace');
const t = tempDir('tp-git-by-item-');
let store: WorkspaceStore;
let ws: string;
const git = (...args: string[]) => runGit(ws, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args]);
const edit = (path: string, change: (text: string) => string) => writeFileSync(join(ws, path), change(readFileSync(join(ws, path), 'utf8')));
const changes = async () => describeGitChanges(ws, (await gitStatus(ws)).files);

beforeAll(async () => {
  store = WorkspaceStore.create(join(t.dir, 'ws'), 'Kinds');
  ws = store.root;
  cpSync(FIXTURE, ws, { recursive: true });
  await git('init', '-b', 'main');
  await git('add', '.');
  await git('commit', '-m', 'base');
});
afterAll(() => {
  store?.close();
  t.cleanup();
});

describe('the Git view names every changed item', () => {
  it('an MCP server and an AI provider, item by item, with field-level details and no secret values', async () => {
    store.saveMcpServers([
      { id: 'weather', name: 'Weather mock', transport: 'mock', mockFile: 'mocks/weather.mcp-mock.yaml' },
      { id: 'search', name: 'Search', folder: 'Team', transport: 'http', url: 'https://search.example.com/mcp', headers: [{ key: 'Authorization', value: 'Bearer abcdef0123456789abcdef0123456789' }] },
    ] as never);
    store.saveProviders([{ id: 'demo', name: 'Demo model', kind: 'mock', baseUrl: 'mock://local', defaultModel: 'demo-2', headers: [{ key: 'X-Team', value: 'a' }] }] as never);
    const got = await changes();
    const search = got.find((c) => c.itemId === 'search')!;
    expect(search).toMatchObject({ kindId: 'mcp-server', change: 'added', title: 'MCP server Search', ref: { kind: 'mcp-server', serverId: 'search' } });
    // its folder in the list and the section show the change too
    expect(search.containers).toEqual([gitFolderKey('mcp-server', 'Team'), gitSectionKey('mcp-server')]);
    const demo = got.find((c) => c.kindId === 'provider')!;
    expect(demo).toMatchObject({ change: 'changed', title: 'AI provider Demo model', ref: { kind: 'provider', providerId: 'demo' } });
    expect(demo.details).toEqual(['model', 'headers (added X-Team)']);
    // the weather server did not change: the file is rewritten in the stable form, that is not a change of the item
    expect(got.some((c) => c.itemId === 'weather')).toBe(false);
    // the side by side view hides a token and names the header
    const diff = await describeItemDiff(ws, 'mcp-servers.json', 'search');
    expect(diff.title).toBe('MCP server Search');
    expect(diff.parts.find((p) => p.part === 'Headers')!.after).toBe('Authorization: •••• (hidden)');
    const dp = await describeItemDiff(ws, 'providers.json', 'demo');
    expect(dp.parts.filter((p) => p.differs).map((p) => p.part)).toEqual(['Model', 'Headers']);
    await git('add', '.');
    await git('commit', '-m', 'servers');
  });

  it('a library item (prompt, load test, connection) by name, with the folder and the section as containers', async () => {
    const lib = store.getLibrary<{ text?: string }>('ai-prompts');
    store.saveLibrary('ai-prompts', { folders: [], items: lib.items.map((i) => ({ ...i, folder: 'greetings', data: { ...(i.data as object), text: 'changed' } })) });
    const got = await changes();
    const c = got.find((x) => x.kindId === 'prompt')!;
    expect(c).toMatchObject({ change: 'changed', title: 'Prompt Greeting prompt', ref: { kind: 'saved', library: 'ai-prompts', itemId: 'p-greet' } });
    expect(c.details).toEqual(['moved', 'settings']);
    expect(c.containers).toEqual([gitFolderKey('prompt', 'greetings'), gitSectionKey('prompt')]);
    const diff = await describeItemDiff(ws, 'library/ai-prompts.json', 'p-greet');
    expect(diff.title).toBe('Prompt Greeting prompt');
    expect(diff.parts.some((p) => p.differs)).toBe(true);
    await git('add', '.');
    await git('commit', '-m', 'prompt');
  });

  it('a request names its folders and collection as containers; the collection, folder and request marks add up', async () => {
    const c = store.getCollection('api');
    const first = (c.items as Array<{ kind: string; id: string; name: string; items?: unknown[]; request?: { url: string } }>).flatMap((n) =>
      n.kind === 'folder' ? (n.items as typeof c.items) : [n],
    ) as Array<{ kind: string; id: string; request?: { url: string } }>;
    const req = first.find((n) => n.kind === 'http')!;
    req.request!.url = 'https://changed.example.com';
    store.saveCollection(c);
    const got = await changes();
    const change = got.find((x) => x.itemId === req.id)!;
    expect(change.kindId).toBe('request');
    expect(change.containers).toContain(gitRefKey({ kind: 'collection', collectionId: 'api' }));
    expect(change.containers).toContain(gitSectionKey('collection'));
    const marks = gitMarksOf(got);
    expect(marks.get(gitRefKey(change.ref as ItemRef))).toEqual({ change: 'changed' });
    expect(marks.get(gitRefKey({ kind: 'collection', collectionId: 'api' }))).toMatchObject({ change: 'changed', count: 1 });
    expect(marks.get(gitSectionKey('collection'))).toMatchObject({ count: expect.any(Number) });
    await git('add', '.');
    await git('commit', '-m', 'request');
  });

  it('a dataset by its rows and columns, an API definition by its operations, a database by its size', async () => {
    edit('datasets/users.csv', (t) => t.replace(/\n$/, '') + '\n99,new@example.com,zed\n');
    edit('specs/petstore.yaml', (t) => t + '\n');
    writeFileSync(join(ws, 'datasets', 'big.sqlite'), Buffer.alloc(2048, 1));
    const got = await changes();
    const ds = got.find((c) => c.file === 'datasets/users.csv')!;
    expect(ds).toMatchObject({ kindId: 'dataset', title: 'Dataset users.csv', change: 'changed', ref: { kind: 'dataset', name: 'users.csv' } });
    expect(ds.details).toEqual(['1 row added']);
    const db = got.find((c) => c.file === 'datasets/big.sqlite')!;
    expect(db).toMatchObject({ kindId: 'dataset', change: 'added' });
    // a changed file with the same operations: lines say it
    const spec = got.find((c) => c.file === 'specs/petstore.yaml')!;
    expect(spec).toMatchObject({ kindId: 'spec', title: 'API definition petstore.yaml', ref: { kind: 'spec', path: 'specs/petstore.yaml' } });
    // the side by side view of a database is its size, never its bytes
    const dbDiff = await describeItemDiff(ws, 'datasets/big.sqlite');
    expect(dbDiff.parts[0]!.after).toBe('2048 bytes');
  });

  it('a new operation in an API definition and a column in a dataset are said in words', async () => {
    await git('add', '.');
    await git('commit', '-m', 'wip');
    edit('specs/petstore.yaml', (t) => t.replace(/\n$/, '') + '\n  /owners:\n    get:\n      operationId: listOwners\n      responses:\n        "200":\n          description: ok\n');
    edit('datasets/users.csv', (t) => t.replace(/^[^\n]*/, (h) => h + ',age'));
    const got = await changes();
    const spec = got.find((c) => c.file === 'specs/petstore.yaml')!;
    expect(spec.details.join(' ')).toMatch(/1 operation added|line/);
    const ds = got.find((c) => c.file === 'datasets/users.csv')!;
    expect(ds.details.join(' ')).toMatch(/column age added/);
  });

  it('the workspace settings and the plain documents have a name too', async () => {
    store.updateWorkspace({
      description: 'A new description',
      variables: [
        { key: 'appName', value: 'Kinds' },
        { key: 'region', value: 'eu' },
      ],
    });
    edit('packages/helpers.js', (t) => t + '\nmodule.exports.extra = 1;\n');
    edit('tests/smoke/login.yaml', (t) => t + '# a note\n');
    const got = await changes();
    expect(got.find((c) => c.kindId === 'workspace')).toMatchObject({ title: 'Workspace settings', details: ['description', 'variables (added region; changed appName)'] });
    expect(got.find((c) => c.file === 'packages/helpers.js')).toMatchObject({ kindId: 'script-package', title: 'Script package helpers', details: ['2 lines added'] });
    const test = got.find((c) => c.file === 'tests/smoke/login.yaml')!;
    expect(test.kindId).toBe('test');
    // a test file marks the folder it is in
    expect(test.containers).toContain(gitFolderKey('test', 'smoke'));
  });

  it('between two commits it says the same', async () => {
    await git('add', '.');
    await git('commit', '-m', 'more');
    const got = await describeRevChanges(ws, 'HEAD~5', 'HEAD');
    expect(got.map((c) => c.title)).toEqual(expect.arrayContaining(['MCP server Search', 'Prompt Greeting prompt', 'Dataset users.csv', 'Workspace settings']));
    expect(got.every((c) => c.kindId)).toBe(true);
  });
});
