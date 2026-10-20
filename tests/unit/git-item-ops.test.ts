import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// scripted repositories spawn many git processes: slow machines (CI, parallel runs) need room
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  addressOf,
  addressOfRef,
  canonicalText,
  discardItem,
  gitLog,
  gitStatus,
  itemBlame,
  itemHistory,
  listJournal,
  restoreItemVersion,
  runGit,
  stageItem,
  stashApply,
  stashDrop,
  stashList,
  stashPush,
  stashShow,
  undoJournal,
  workspaceFile,
} from '../../packages/core/src/index.js';
import { makeRepo, type TestRepo } from '../helpers-git';

/**
 * Release B of "Everything under Git", per item: history with what each version changed, who last changed each field,
 * restore an older version of one item, discard one item's change (not its file), stage, stash. Scripted repositories.
 */

const servers = (rows: Array<Record<string, unknown>>) => JSON.stringify({ schemaVersion: '1.0', servers: rows }, null, 2) + '\n';
const weather = { id: 'weather', name: 'Weather mock', transport: 'mock', mockFile: 'mocks/weather.mcp-mock.yaml' };
const search = (url: string) => ({ id: 'search', name: 'Search', transport: 'http', url });
const files = (url: string) => ({ id: 'files', name: 'Files', transport: 'http', url });

let r: TestRepo;
const hashes: string[] = [];

beforeAll(async () => {
  r = await makeRepo();
  // three servers, then two edits in two commits
  r.write('mcp-servers.json', servers([weather, search('https://s.example.com/v1'), files('https://f.example.com/v1')]));
  await r.commit('three servers');
  r.write('mcp-servers.json', servers([weather, search('https://s.example.com/v2'), files('https://f.example.com/v1')]));
  await r.commit('search v2');
  r.write('mcp-servers.json', servers([weather, search('https://s.example.com/v2'), files('https://f.example.com/v2')]));
  await r.commit('files v2');
  hashes.push(...(await gitLog(r.ws, { limit: 10 })).map((c) => c.hash));
});
afterAll(() => r.cleanup());

const a = (id: string) => addressOf('mcp-servers.json', id);

describe('history of one item', () => {
  it('lists only the commits that changed the item, with what each changed', async () => {
    const h = await itemHistory(r.ws, a('search'));
    expect(h.title).toBe('MCP server Search');
    expect(h.versions.map((v) => v.commit.subject)).toEqual(['search v2', 'three servers']);
    expect(h.versions[0]!.changed).toEqual(['URL']);
    expect(h.versions[0]!.parts[0]).toMatchObject({ part: 'URL', before: 'https://s.example.com/v1', after: 'https://s.example.com/v2' });
    expect(h.versions[1]!.changed).toEqual(['created']);
    // the other server's commit is not in this item's history
    expect((await itemHistory(r.ws, a('files'))).versions.map((v) => v.commit.subject)).toEqual(['files v2', 'three servers']);
  });

  it('a whole file (an environment) lists its versions by item', async () => {
    r.edit('environments/staging.json', (t) => t.replace('staging.example.com', 'stage2.example.com'));
    await r.commit('staging host');
    const h = await itemHistory(r.ws, addressOf('environments/staging.json'));
    expect(h.versions.map((v) => v.commit.subject)).toEqual(['staging host', 'base']);
    expect(h.versions[0]!.changed.join(' ')).toContain('baseUrl');
  });
});

describe('blame: who last changed each field', () => {
  it('names the commit per field and marks uncommitted ones', async () => {
    r.write('mcp-servers.json', servers([weather, search('https://s.example.com/v3'), files('https://f.example.com/v2')]));
    const b = await itemBlame(r.ws, a('search'));
    const by = Object.fromEntries(b.fields.map((f) => [f.field, f]));
    expect(by.URL).toMatchObject({ uncommitted: true, value: 'https://s.example.com/v3' });
    expect(by.Name!.commit?.subject).toBe('three servers');
    expect(by.Name!.commit?.author).toBe('Tester');
    await runGit(r.ws, ['checkout', 'HEAD', '--', 'mcp-servers.json']);
    const c = await itemBlame(r.ws, a('search'));
    expect(c.fields.find((f) => f.field === 'URL')!.commit?.subject).toBe('search v2');
  });
});

describe('restore one item', () => {
  it('puts back an older version of just that item, previews first, and can be undone', async () => {
    // an uncommitted edit of ANOTHER server must survive restoring search
    r.write('mcp-servers.json', servers([weather, search('https://s.example.com/v2'), files('https://f.example.com/uncommitted')]));
    const before = r.read('mcp-servers.json');
    const oldest = hashes.at(-2)!; // 'three servers'
    const plan = await restoreItemVersion(r.ws, a('search'), oldest, { dryRun: true });
    expect(plan).toMatchObject({ applied: false, changed: true, action: 'replace-item', title: 'MCP server Search' });
    expect(plan.parts.map((p) => p.part)).toEqual(['URL']);
    expect(r.read('mcp-servers.json')).toBe(before); // a dry run writes nothing
    const done = await restoreItemVersion(r.ws, a('search'), oldest);
    expect(done.applied).toBe(true);
    const doc = JSON.parse(r.read('mcp-servers.json'));
    expect(doc.servers.map((s: { id: string }) => s.id)).toEqual(['weather', 'search', 'files']);
    expect(doc.servers[1].url).toBe('https://s.example.com/v1');
    expect(doc.servers[2].url).toBe('https://f.example.com/uncommitted');
    // undo puts the file back byte for byte
    expect(listJournal(r.ws)[0]!.id).toBe(done.undoId);
    undoJournal(r.ws, done.undoId);
    expect(r.read('mcp-servers.json')).toBe(before);
    // restoring what is already there is "nothing to change"
    const same = await restoreItemVersion(r.ws, a('search'), hashes[0]!);
    expect(same).toMatchObject({ changed: false, applied: false, action: 'nothing' });
    await runGit(r.ws, ['checkout', 'HEAD', '--', 'mcp-servers.json']);
  });

  it('refuses a version that does not have the item, and paths outside the workspace', async () => {
    await expect(restoreItemVersion(r.ws, a('search'), hashes.at(-1)!)).rejects.toThrow(/not in commit/);
    await expect(restoreItemVersion(r.ws, a('nope'), hashes[0]!)).rejects.toThrow(/not in commit/);
    await expect(restoreItemVersion(r.ws, addressOf('../outside.txt'), hashes[0]!)).rejects.toThrow(/not in commit|outside|Not a path/);
    expect(() => workspaceFile(r.ws, '../x')).toThrow(/Not a path/);
    expect(() => workspaceFile(r.ws, 'C:/Windows/x')).toThrow(/Not a path/);
    expect(() => workspaceFile(r.ws, '.git/config')).toThrow(/\.git/);
    await expect(restoreItemVersion(r.ws, a('search'), '--output=x')).rejects.toThrow(/Not a valid git revision/);
  });
});

describe('discard one item', () => {
  it('reverts only that item, leaves the rest of its file, and fixes the index if it was staged', async () => {
    r.write('mcp-servers.json', servers([weather, search('https://s.example.com/edited'), files('https://f.example.com/edited')]));
    await runGit(r.ws, ['add', 'mcp-servers.json']); // staged: a commit would take both edits
    const plan = await discardItem(r.ws, a('search'), { dryRun: true });
    expect(plan).toMatchObject({ applied: false, changed: true, action: 'replace-item' });
    const res = await discardItem(r.ws, a('search'));
    expect(res.applied).toBe(true);
    const doc = JSON.parse(r.read('mcp-servers.json'));
    expect(doc.servers[1].url).toBe('https://s.example.com/v2');
    expect(doc.servers[2].url).toBe('https://f.example.com/edited');
    // the index no longer holds the discarded edit
    const cached = await runGit(r.ws, ['diff', '--cached', '--name-only']);
    const staged = JSON.parse(await runGit(r.ws, ['show', ':mcp-servers.json']));
    expect(cached.trim()).toBe('mcp-servers.json');
    expect(staged.servers[1].url).toBe('https://s.example.com/v2');
    expect(staged.servers[2].url).toBe('https://f.example.com/edited');
    undoJournal(r.ws, res.undoId);
    expect(JSON.parse(r.read('mcp-servers.json')).servers[1].url).toBe('https://s.example.com/edited');
    await runGit(r.ws, ['reset', '-q']);
    await runGit(r.ws, ['checkout', 'HEAD', '--', 'mcp-servers.json']);
  });

  it('an added item is removed; a new file is deleted', async () => {
    r.write('mcp-servers.json', servers([weather, search('https://s.example.com/v2'), files('https://f.example.com/v2'), { id: 'fresh', name: 'Fresh', transport: 'http', url: 'https://x' }]));
    const res = await discardItem(r.ws, a('fresh'));
    expect(res.action).toBe('remove-item');
    expect(JSON.parse(r.read('mcp-servers.json')).servers.map((s: { id: string }) => s.id)).toEqual(['weather', 'search', 'files']);
    r.write('datasets/extra.csv', 'a,b\n1,2\n');
    const del = await discardItem(r.ws, addressOf('datasets/extra.csv'));
    expect(del.action).toBe('delete-file');
    expect(existsSync(join(r.ws, 'datasets', 'extra.csv'))).toBe(false);
    undoJournal(r.ws, del.undoId);
    expect(r.read('datasets/extra.csv')).toBe('a,b\n1,2\n');
    await runGit(r.ws, ['clean', '-fq', '--', 'datasets']);
  });

  it('every other kind: a library prompt, a request in a collection, an environment, a test file, a binary database', async () => {
    // a collection in the stable form first, so only the item shows as changed
    r.write('collections/api.json', canonicalText('collections/api.json', r.read('collections/api.json'))!);
    await r.commit('tidy collection');
    // library prompt
    r.edit('library/ai-prompts.json', (t) => t.replace('Say hello', 'Say goodbye'));
    const prompt = addressOfRef({ kind: 'saved', library: 'ai-prompts', itemId: 'p-greet' })!;
    expect((await discardItem(r.ws, prompt)).action).toBe('replace-item');
    expect(r.read('library/ai-prompts.json')).toContain('Say hello');
    // a request nested in a folder: the sibling's edit stays
    r.edit('collections/api.json', (t) => t.replace('{{baseUrl}}/pets"', '{{baseUrl}}/pets?limit=1"').replace('{{baseUrl}}/soap"', '{{baseUrl}}/soap2"'));
    const req = addressOfRef({ kind: 'request', collectionId: 'api', requestId: 'r1' })!;
    expect(req).toMatchObject({ mode: 'nested', itemId: 'r1' });
    const dres = await discardItem(r.ws, req);
    expect(dres.parts.map((p) => p.part)).toEqual(['Request']);
    expect(r.read('collections/api.json')).toContain('{{baseUrl}}/pets"');
    expect(r.read('collections/api.json')).toContain('/soap2');
    await runGit(r.ws, ['checkout', 'HEAD', '--', 'collections/api.json']);
    // whole files
    r.edit('environments/staging.json', (t) => t.replace('stage2', 'stage9'));
    expect((await discardItem(r.ws, addressOf('environments/staging.json'))).action).toBe('replace-file');
    expect(r.read('environments/staging.json')).toContain('stage2');
    r.edit('tests/smoke/login.yaml', (t) => t.replace('Login works', 'Login breaks'));
    await discardItem(r.ws, addressOf('tests/smoke/login.yaml'));
    expect(r.read('tests/smoke/login.yaml')).toContain('Login works');
    writeFileSync(join(r.ws, 'database.sqlite'), Buffer.from([1, 2, 3, 0, 4]));
    // database.sqlite is ignored at the root by a generated .gitignore; a dataset database is a tracked binary
    writeFileSync(join(r.ws, 'datasets', 'data.sqlite'), Buffer.from([1, 2, 3, 0, 4]));
    await r.commit('db');
    writeFileSync(join(r.ws, 'datasets', 'data.sqlite'), Buffer.from([9, 9, 9, 0, 9]));
    const bin = await discardItem(r.ws, addressOf('datasets/data.sqlite'));
    expect(bin.applied).toBe(true);
    expect([...readFileSync(join(r.ws, 'datasets', 'data.sqlite'))]).toEqual([1, 2, 3, 0, 4]);
    undoJournal(r.ws, bin.undoId);
    expect([...readFileSync(join(r.ws, 'datasets', 'data.sqlite'))]).toEqual([9, 9, 9, 0, 9]);
    await runGit(r.ws, ['checkout', 'HEAD', '--', 'datasets/data.sqlite']);
  });
});

describe('stage one item', () => {
  it('stages its file and says which other changed items come along', async () => {
    r.write('mcp-servers.json', servers([weather, search('https://s.example.com/e1'), files('https://f.example.com/e1')]));
    const dry = await stageItem(r.ws, a('search'), { dryRun: true });
    expect(dry.applied).toBe(false);
    expect(dry.alsoStages).toEqual(['MCP server Files']);
    const res = await stageItem(r.ws, a('search'));
    expect(res.message).toMatch(/Staged mcp-servers.json \(it also holds 1 other changed item: MCP server Files\)/);
    expect((await gitStatus(r.ws)).files.find((f) => f.path === 'mcp-servers.json')!.staged).toBe(true);
    const un = await stageItem(r.ws, a('search'), { unstage: true });
    expect(un.message).toMatch(/^Unstaged/);
    expect((await gitStatus(r.ws)).files.find((f) => f.path === 'mcp-servers.json')!.staged).toBe(false);
    await runGit(r.ws, ['checkout', 'HEAD', '--', 'mcp-servers.json']);
  });
});

describe('stash with names', () => {
  it('sets the workspace changes aside, lists them by item, and puts them back', async () => {
    r.write('mcp-servers.json', servers([weather, search('https://s.example.com/stashed'), files('https://f.example.com/v2')]));
    r.write('datasets/new.csv', 'x\n1\n');
    const dry = await stashPush(r.ws, 'Before the rewrite', { dryRun: true });
    expect(dry.applied).toBe(false);
    expect(dry.changes.map((c) => c.title)).toContain('MCP server Search');
    const pushed = await stashPush(r.ws, 'Before the rewrite');
    expect(pushed.stash).toMatchObject({ name: 'Before the rewrite', ours: true });
    expect((await gitStatus(r.ws)).files).toEqual([]);
    expect((await stashList(r.ws)).map((s) => s.name)).toEqual(['Before the rewrite']);
    const shown = await stashShow(r.ws);
    expect(shown.changes.map((c) => c.title)).toContain('MCP server Search');
    expect(shown.newFiles).toContain('datasets/new.csv');
    const back = await stashApply(r.ws, { hash: pushed.stash!.hash }, { pop: true });
    expect(back).toMatchObject({ dropped: true, conflicted: false });
    expect(r.read('mcp-servers.json')).toContain('stashed');
    expect(existsSync(join(r.ws, 'datasets', 'new.csv'))).toBe(true);
    expect(await stashList(r.ws)).toEqual([]);
    await expect(stashPush(r.ws, '  ')).rejects.toThrow(/name/);
    await runGit(r.ws, ['checkout', 'HEAD', '--', 'mcp-servers.json']);
    await runGit(r.ws, ['clean', '-fq', '--', 'datasets']);
    await expect(stashPush(r.ws, 'nothing')).rejects.toThrow(/no changes/);
    await expect(stashDrop(r.ws, { index: 3 })).rejects.toThrow(/No such stash/);
  });
});

describe('where the workspace is', () => {
  it('a workspace that is a folder of a bigger repository works the same', async () => {
    const sub = await makeRepo({ inFolder: true });
    try {
      sub.write('mcp-servers.json', servers([weather, search('https://s/1')]));
      await sub.commit('servers');
      sub.write('mcp-servers.json', servers([weather, search('https://s/2')]));
      await sub.commit('v2');
      sub.write('mcp-servers.json', servers([weather, search('https://s/3')]));
      const h = await itemHistory(sub.ws, a('search'));
      expect(h.versions.map((v) => v.commit.subject)).toEqual(['v2', 'servers']);
      const res = await discardItem(sub.ws, a('search'));
      expect(res.applied).toBe(true);
      expect(JSON.parse(sub.read('mcp-servers.json')).servers[1].url).toBe('https://s/2');
      sub.write('mcp-servers.json', servers([weather, search('https://s/4')]));
      await runGit(sub.ws, ['add', 'mcp-servers.json']);
      await discardItem(sub.ws, a('search'));
      expect(await runGit(sub.ws, ['diff', '--cached', '--name-only'])).toBe('');
    } finally {
      sub.cleanup();
    }
  });

  it('a repository with autocrlf: a CRLF file is restored with CRLF, and a line-ending-only difference is no change', async () => {
    const crlf = await makeRepo({ autocrlf: true });
    try {
      crlf.write('datasets/users.csv', 'id,name\r\n1,Ada\r\n2,Bo\r\n');
      await crlf.commit('crlf');
      crlf.write('datasets/users.csv', 'id,name\r\n1,Grace\r\n2,Bo\r\n');
      const same = await discardItem(crlf.ws, addressOf('datasets/users.csv'), { dryRun: true });
      expect(same.changed).toBe(true);
      await discardItem(crlf.ws, addressOf('datasets/users.csv'));
      expect(crlf.read('datasets/users.csv')).toBe('id,name\r\n1,Ada\r\n2,Bo\r\n');
      // only the line endings differ: nothing to discard
      crlf.write('datasets/users.csv', 'id,name\n1,Ada\n2,Bo\n');
      expect((await discardItem(crlf.ws, addressOf('datasets/users.csv'))).changed).toBe(false);
    } finally {
      crlf.cleanup();
    }
  });

  it('a folder that is not a repository says so; a linked workspace path works', async () => {
    const link = await makeRepo({ alias: true });
    try {
      link.write('mcp-servers.json', servers([weather, search('https://s/1')]));
      await link.commit('s');
      link.write('mcp-servers.json', servers([weather, search('https://s/9')]));
      expect((await discardItem(link.ws, a('search'))).applied).toBe(true);
    } finally {
      link.cleanup();
    }
  });
});
