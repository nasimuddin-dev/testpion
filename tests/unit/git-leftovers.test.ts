import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// scripted repositories spawn many git processes: slow machines (CI, parallel runs) need room
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { addNestedItem, addressOf, describeGitChanges, fixGitSetup, gitStatus, runGit, stageItem, textconvText, type Collection } from '../../packages/core/src/index.js';
import { makeRepo, type TestRepo } from '../helpers-git';

/**
 * B-26b / B-27b leftovers: staging one item when the item is new (a request, in a folder that may be new too), when its
 * file is new or deleted. Scripted repositories; the index copy is read back with git itself.
 */

let r: TestRepo;
beforeAll(async () => {
  r = await makeRepo();
  // the fixture's collection is hand-written: the app's own form is what the index copy can be edited in
  r.store.saveCollection(r.store.getCollection('api'));
  await r.commit('collection in the stable form');
});
afterAll(() => r.cleanup());

const req = (id: string, name: string) => ({ kind: 'http', id, name, request: { method: 'GET', url: `{{baseUrl}}/${id}`, headers: [], params: [] }, assertions: [] });
const colDoc = () => JSON.parse(r.read('collections/api.json')) as Collection;
const writeCol = (c: unknown) => r.write('collections/api.json', JSON.stringify(c, null, 2) + '\n');
const indexOf = async (file: string) => (await runGit(r.ws, ['show', `:${file}`])).toString();
const ids = (c: { items: Array<{ id: string; items?: unknown[] }> }): string[] => c.items.flatMap((n) => [n.id, ...(Array.isArray(n.items) ? ids({ items: n.items as Array<{ id: string }> }) : [])]);
const reset = async () => {
  await runGit(r.ws, ['reset', '-q', 'HEAD', '--', '.']);
  await runGit(r.ws, ['checkout', 'HEAD', '--', '.']);
  await runGit(r.ws, ['clean', '-fdq', '--', 'collections']);
};

describe('the readable-diff driver prints test and flow files step by step', () => {
  const flow = 'name: Checkout\nretries: 2\nsteps:\n  - id: pay\n    name: Pay\n    request:\n      method: POST\n      url: "{{baseUrl}}/pay"\n  - id: ship\n    name: Ship\n    request:\n      method: POST\n      url: "{{baseUrl}}/ship"\n';

  it('a flow gets its settings, then each step under its own heading (the hunk header names the step)', () => {
    const t = textconvText(flow)!;
    expect(t).toContain('== Checkout [flow] ==');
    expect(t).toContain('retries: 2');
    expect(t).toContain('== Checkout ▸ Pay [step pay] ==');
    expect(t).toContain('== Checkout ▸ Ship [step ship] ==');
    expect(t.indexOf('[step pay]')).toBeLessThan(t.indexOf('[step ship]'));
    expect(t).toContain('url: "{{baseUrl}}/pay"');
    // a test file (tests:) is read the same way
    expect(textconvText('name: Login works\ntests:\n  - name: Login\n    request:\n      method: GET\n      url: /login\n')).toContain('== Login works ▸ Login [step] ==');
  });

  it('a YAML file that is not a test or flow, a broken one and an empty list print as they are', () => {
    expect(textconvText('openapi: 3.1.0\ninfo:\n  title: x\n')).toBeUndefined();
    expect(textconvText('name: a\ntests:\n  - [unclosed\n')).toBeUndefined();
    expect(textconvText('name: a\nsteps:\n')).toBeUndefined();
    expect(textconvText('name: a\nsteps:\n  - just text\n')).toBeUndefined();
  });

  it('the git setup writes the diff attribute for test files', async () => {
    const { GITATTRIBUTES_LINES } = await import('../../packages/core/src/index.js');
    expect(GITATTRIBUTES_LINES).toContain('tests/**/*.yaml diff=testpion');
    expect(GITATTRIBUTES_LINES.some((l) => l.startsWith('tests/') && l.includes('merge='))).toBe(false);
  });
});

describe('Fix git setup: the untrack list is the one the fix removes', () => {
  it('counts the files the .gitignore lines it is about to write match, in the preview and in the fix', async () => {
    const inner = await makeRepo();
    try {
      // the workspace has an ignore file that knows only one folder; a file of another result folder was committed with -f
      inner.write('.gitignore', 'runs/\n');
      inner.write('traces/t1/trace.json', '{}\n');
      await inner.git('add', '-f', '.');
      await inner.git('commit', '-m', 'tracked traces');
      // today's rules do not match it, the ones the fix writes do
      expect((await inner.git('ls-files', '-ci', '--exclude-standard')).trim()).toBe('');
      const preview = await fixGitSetup(inner.store, { dryRun: true, untrack: true });
      expect(preview.steps.find((s) => s.id === 'untrack')?.detail.join('\n')).toContain('traces/t1/trace.json');
      const fixed = await fixGitSetup(inner.store, { untrack: true });
      expect(fixed.applied).toBe(true);
      expect((await inner.git('ls-files', '--', 'traces')).trim()).toBe('');
      expect(existsSync(join(inner.ws, 'traces', 't1', 'trace.json'))).toBe(true);
    } finally {
      inner.cleanup();
    }
  });
});

describe('stage one item that is new', () => {
  it('a new request in a folder the index copy has: only that request is staged, the other new one stays out', async () => {
    const c = colDoc();
    const pets = c.items[0] as unknown as { items: unknown[] };
    pets.items.push(req('n1', 'New one'), req('n2', 'New two'));
    writeCol(c);
    const res = await stageItem(r.ws, addressOf('collections/api.json', 'n1'));
    expect(res).toMatchObject({ applied: true, partial: true });
    expect(res.message).toMatch(/Staged .*New one.* only; the file's 1 other changed item stays unstaged/);
    const staged = JSON.parse(await indexOf('collections/api.json'));
    expect(ids(staged)).toEqual(['f1', 'r1', 's1', 'n1', 'g1']);
    // the working file keeps both
    expect(ids(colDoc())).toContain('n2');
    // the Git view marks only that item as staged
    const rows = await describeGitChanges(r.ws, (await gitStatus(r.ws)).files);
    expect(rows.filter((x) => x.itemId && x.staged).map((x) => x.itemId)).toEqual(['n1']);
    expect(rows.filter((x) => x.itemId && !x.staged).map((x) => x.itemId)).toContain('n2');
    // unstage it: the index copy is the committed one again
    const un = await stageItem(r.ws, addressOf('collections/api.json', 'n1'), { unstage: true });
    expect(un.partial).toBe(true);
    expect(ids(JSON.parse(await indexOf('collections/api.json')))).toEqual(['f1', 'r1', 's1', 'g1']);
    await reset();
  });

  it('a new request in a new folder: the folder is made in the index copy with only that request, and goes again on unstage', async () => {
    const c = colDoc();
    c.items.push({ kind: 'folder', id: 'f9', name: 'Fresh', headers: [{ key: 'X-F', value: '1', enabled: true }], items: [req('n3', 'Three'), req('n4', 'Four')] } as never);
    writeCol(c);
    const res = await stageItem(r.ws, addressOf('collections/api.json', 'n3'));
    expect(res.partial).toBe(true);
    const staged = JSON.parse(await indexOf('collections/api.json'));
    expect(ids(staged)).toEqual(['f1', 'r1', 's1', 'g1', 'f9', 'n3']);
    expect(staged.items[2].headers).toEqual([{ key: 'X-F', value: '1', enabled: true }]);
    expect(staged.items[2].items).toHaveLength(1);
    const un = await stageItem(r.ws, addressOf('collections/api.json', 'n3'), { unstage: true });
    expect(un.partial).toBe(true);
    expect(ids(JSON.parse(await indexOf('collections/api.json')))).toEqual(['f1', 'r1', 's1', 'g1']);
    await reset();
  });

  it('addNestedItem is exact or nothing: a source that does not hold the item gives undefined', () => {
    const a = addressOf('collections/api.json', 'ghost');
    expect(addNestedItem(a, r.read('collections/api.json'), r.read('collections/api.json'))).toBeUndefined();
    expect(addNestedItem(addressOf('mcp-servers.json', 'weather'), undefined, '{}')).toBeUndefined();
  });
});

describe('stage one item of a file that is new or deleted', () => {
  it('a new file: the item goes in alone under the file’s own header, and unstaging the last one takes the file out of the index', async () => {
    const one = { id: 'weather', name: 'Weather mock', transport: 'mock', mockFile: 'mocks/weather.mcp-mock.yaml' };
    const two = { id: 'search', name: 'Search', transport: 'http', url: 'https://s.example.com' };
    await runGit(r.ws, ['rm', '-q', 'mcp-servers.json']);
    await r.commit('no servers file');
    r.write('mcp-servers.json', JSON.stringify({ schemaVersion: '1.0', servers: [one, two] }, null, 2) + '\n');
    const res = await stageItem(r.ws, addressOf('mcp-servers.json', 'search'));
    expect(res).toMatchObject({ applied: true, partial: true });
    expect(JSON.parse(await indexOf('mcp-servers.json')).servers.map((s: { id: string }) => s.id)).toEqual(['search']);
    const rows = await describeGitChanges(r.ws, (await gitStatus(r.ws)).files.filter((f) => f.path === 'mcp-servers.json'));
    expect(rows.filter((x) => x.itemId && x.staged).map((x) => x.itemId)).toEqual(['search']);
    expect(rows.filter((x) => x.itemId && !x.staged).map((x) => x.itemId)).toEqual(['weather']);
    await stageItem(r.ws, addressOf('mcp-servers.json', 'search'), { unstage: true });
    const status = (await gitStatus(r.ws)).files.find((f) => f.path === 'mcp-servers.json');
    expect(status?.state).toBe('untracked');
    expect(status?.staged).toBeFalsy();
    await r.commit('servers file back');
  });

  it('a new collection file stages one request under the file’s header (the Git view shows a new collection as one row)', async () => {
    r.write('collections/extra.json', JSON.stringify({ schemaVersion: '1.0', id: 'extra', name: 'Extra', version: 0, variables: [{ key: 'k', value: 'v', enabled: true }], updatedAt: '', items: [req('x1', 'X one'), req('x2', 'X two')] }, null, 2) + '\n');
    const res = await stageItem(r.ws, addressOf('collections/extra.json', 'x1'));
    expect(res).toMatchObject({ applied: true, partial: true });
    const staged = JSON.parse(await indexOf('collections/extra.json'));
    expect(staged).toMatchObject({ id: 'extra', name: 'Extra', variables: [{ key: 'k', value: 'v', enabled: true }] });
    expect(ids(staged)).toEqual(['x1']);
    await stageItem(r.ws, addressOf('collections/extra.json', 'x1'), { unstage: true });
    expect((await gitStatus(r.ws)).files.find((f) => f.path === 'collections/extra.json')?.state).toBe('untracked');
    rmSync(join(r.ws, 'collections', 'extra.json'));
  });

  it('a deleted file: one item’s deletion is staged and the index copy keeps the others', async () => {
    const a = (id: string) => addressOf('mcp-servers.json', id);
    r.write('mcp-servers.json', JSON.stringify({ schemaVersion: '1.0', servers: [{ id: 'weather', name: 'Weather mock', transport: 'mock', mockFile: 'mocks/weather.mcp-mock.yaml' }, { id: 'search', name: 'Search', transport: 'http', url: 'https://s.example.com' }] }, null, 2) + '\n');
    await r.commit('two servers').catch(() => undefined); // (already committed when the test before it ran)
    rmSync(join(r.ws, 'mcp-servers.json'));
    const res = await stageItem(r.ws, a('search'));
    expect(res).toMatchObject({ applied: true, partial: true });
    const staged = JSON.parse(await indexOf('mcp-servers.json'));
    expect(staged.servers.map((s: { id: string }) => s.id)).toEqual(['weather']);
    // and the deletion of that one item can be taken back
    const un = await stageItem(r.ws, a('search'), { unstage: true });
    expect(un.partial).toBe(true);
    expect(JSON.parse(await indexOf('mcp-servers.json')).servers.map((s: { id: string }) => s.id)).toEqual(['weather', 'search']);
    await runGit(r.ws, ['reset', '-q', 'HEAD', '--', 'mcp-servers.json']);
    await runGit(r.ws, ['checkout', 'HEAD', '--', 'mcp-servers.json']);
  });
});
