import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// scripted repositories spawn many git processes: slow machines (CI, parallel runs) need room
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalText, gitConflictDetail, gitResolve, gitStatus, runGit } from '../../packages/core/src/index.js';
import { makeRepo, type TestRepo } from '../helpers-git';

/**
 * Conflict resolution for every versioned kind (release B): scripted branches that change the same thing differently,
 * a real `git merge` that stops, then the conflict detail and each way to settle it (Keep mine, Keep theirs, Edit, per
 * item, per field, per hunk), the result written in the stable form and marked resolved.
 */

let r: TestRepo;
beforeAll(async () => {
  r = await makeRepo();
  r.write('collections/api.json', canonicalText('collections/api.json', r.read('collections/api.json'))!);
  r.write('providers.json', JSON.stringify({ schemaVersion: '1.0', providers: [{ id: 'demo', name: 'Demo', kind: 'mock', baseUrl: 'mock://local', defaultModel: 'demo-1' }] }, null, 2) + '\n');
  r.write('mcp-servers.json', JSON.stringify({ schemaVersion: '1.0', servers: [{ id: 'search', name: 'Search', transport: 'http', url: 'https://s/v1' }] }, null, 2) + '\n');
  r.write('specs/x.yaml', 'title: Pets\nversion: 1\nservers: a\n');
  r.write('datasets/people.csv', 'id,name\n1,Ada\n2,Bo\n');
  writeFileSync(join(r.ws, 'datasets', 'data.sqlite'), Buffer.from([1, 2, 3, 0, 4]));
  await r.commit('base files');
});
afterAll(() => r.cleanup());

/** Two branches change `path` differently; merging `theirs` into main stops on a conflict. */
async function conflict(path: string, ours: (t: string) => string, theirs: (t: string) => string) {
  const base = r.read(path);
  await r.git('checkout', '-b', 'theirs');
  r.write(path, theirs(base));
  await r.commit('theirs');
  await r.git('checkout', 'main');
  r.write(path, ours(base));
  await r.commit('ours');
  await r.git('merge', 'theirs').catch(() => undefined);
  const st = await gitStatus(r.ws);
  expect(st.files.find((f) => f.path === path)?.state).toBe('conflicted');
}
async function reset() {
  await runGit(r.ws, ['reset', '--hard', 'HEAD']);
  await runGit(r.ws, ['reset', '--hard', 'HEAD~1']);
  await runGit(r.ws, ['branch', '-D', 'theirs']);
}
const unmerged = async () => (await runGit(r.ws, ['ls-files', '-u'])).trim();
const json = (p: string) => JSON.parse(r.read(p));

describe('items: collections, environments, library, MCP servers, providers, workspace settings', () => {
  it('an MCP server changed on both sides: only the field that clashes is a conflict, the others merge', async () => {
    await conflict(
      'mcp-servers.json',
      (t) => t.replace('https://s/v1', 'https://ours'),
      (t) => t.replace('https://s/v1', 'https://theirs').replace('"Search"', '"Search v2"'),
    );
    const d = await gitConflictDetail(r.ws, 'mcp-servers.json');
    expect(d).toMatchObject({ mode: 'items', kind: 'mcp-server' });
    expect(d.items).toHaveLength(1);
    expect(d.items[0]!.key).toBe('item:search');
    expect(d.items[0]!.fields!.map((f) => f.path)).toEqual(['url']);
    expect(d.items[0]!.fields![0]).toMatchObject({ key: 'item:search#url', ours: 'https://ours', theirs: 'https://theirs' });
    // per field: theirs for the URL; their rename (no clash) came along
    await gitResolve(r.ws, 'mcp-servers.json', 'ours', { 'item:search#url': 'theirs' });
    expect(json('mcp-servers.json').servers[0]).toMatchObject({ url: 'https://theirs', name: 'Search v2' });
    expect(await unmerged()).toBe('');
    // the file is in the stable form
    expect(r.read('mcp-servers.json')).toBe(canonicalText('mcp-servers.json', r.read('mcp-servers.json')));
    await reset();
  });

  it('Keep mine, Keep theirs and Edit for a whole item and for one field', async () => {
    const make = () =>
      conflict(
        'mcp-servers.json',
        (t) => t.replace('https://s/v1', 'https://ours'),
        (t) => t.replace('https://s/v1', 'https://theirs'),
      );
    await make();
    await gitResolve(r.ws, 'mcp-servers.json', 'theirs');
    expect(json('mcp-servers.json').servers[0].url).toBe('https://theirs');
    await reset();
    await make();
    await gitResolve(r.ws, 'mcp-servers.json', 'ours');
    expect(json('mcp-servers.json').servers[0].url).toBe('https://ours');
    await reset();
    await make();
    await gitResolve(r.ws, 'mcp-servers.json', 'ours', { 'item:search#url': { edit: JSON.stringify('https://edited') } });
    expect(json('mcp-servers.json').servers[0].url).toBe('https://edited');
    await reset();
    await make();
    await gitResolve(r.ws, 'mcp-servers.json', 'ours', { 'item:search': { edit: JSON.stringify({ id: 'search', name: 'Hand merged', transport: 'http', url: 'https://hand' }) } });
    expect(json('mcp-servers.json').servers[0]).toMatchObject({ name: 'Hand merged', url: 'https://hand' });
    // an edit that is not JSON is refused with a message, nothing is written
    await reset();
    await make();
    await expect(gitResolve(r.ws, 'mcp-servers.json', 'ours', { 'item:search#url': { edit: 'not json' } })).rejects.toThrow(/not valid JSON/);
    await reset();
  });

  it('a request in a collection (by item and field), an environment variable, a library item, a provider', async () => {
    await conflict(
      'collections/api.json',
      (t) => t.replace('{{baseUrl}}/pets"', '{{baseUrl}}/pets-ours"'),
      (t) => t.replace('{{baseUrl}}/pets"', '{{baseUrl}}/pets-theirs"'),
    );
    let d = await gitConflictDetail(r.ws, 'collections/api.json');
    expect(d.items[0]).toMatchObject({ key: 'item:r1', kind: 'changed-both' });
    expect(d.items[0]!.fields![0]!.path).toBe('request.url');
    await gitResolve(r.ws, 'collections/api.json', 'theirs');
    expect(r.read('collections/api.json')).toContain('pets-theirs');
    await reset();

    await conflict(
      'environments/staging.json',
      (t) => t.replace('staging.example.com', 'ours.example.com'),
      (t) => t.replace('staging.example.com', 'theirs.example.com'),
    );
    d = await gitConflictDetail(r.ws, 'environments/staging.json');
    expect(d.mode).toBe('items');
    expect(d.items[0]!.key).toBe('var:baseUrl');
    await gitResolve(r.ws, 'environments/staging.json', 'ours', { 'var:baseUrl': 'theirs' });
    expect(r.read('environments/staging.json')).toContain('theirs.example.com');
    await reset();

    await conflict(
      'library/ai-prompts.json',
      (t) => t.replace('Say hello', 'Say hi'),
      (t) => t.replace('Say hello', 'Say hey'),
    );
    d = await gitConflictDetail(r.ws, 'library/ai-prompts.json');
    expect(d.items[0]!.fields![0]!.path).toBe('data.prompt');
    await gitResolve(r.ws, 'library/ai-prompts.json', 'theirs');
    expect(r.read('library/ai-prompts.json')).toContain('Say hey');
    await reset();

    await conflict(
      'providers.json',
      (t) => t.replace('demo-1', 'demo-ours'),
      (t) => t.replace('demo-1', 'demo-theirs'),
    );
    d = await gitConflictDetail(r.ws, 'providers.json');
    expect(d.kind).toBe('provider');
    await gitResolve(r.ws, 'providers.json', 'ours');
    expect(r.read('providers.json')).toContain('demo-ours');
    await reset();
  });

  it('the workspace settings are resolved field by field', async () => {
    await conflict(
      'workspace.json',
      (t) => t.replace('"name": "Kinds"', '"name": "Ours"'),
      (t) => t.replace('"name": "Kinds"', '"name": "Theirs"'),
    );
    const d = await gitConflictDetail(r.ws, 'workspace.json');
    expect(d).toMatchObject({ mode: 'items', kind: 'workspace' });
    expect(d.items[0]!.key).toBe('setting:workspace:name');
    await gitResolve(r.ws, 'workspace.json', 'ours', { 'setting:workspace:name': 'theirs' });
    expect(json('workspace.json').name).toBe('Theirs');
    await reset();
  });
});

describe('text: test files, API definitions, datasets', () => {
  it('a test file: the clashing lines are hunks that name the step; Keep mine / theirs / Edit per hunk', async () => {
    const make = () =>
      conflict(
        'tests/smoke/login.yaml',
        (t) => t.replace('{{baseUrl}}/login', '{{baseUrl}}/login-ours'),
        (t) => t.replace('{{baseUrl}}/login', '{{baseUrl}}/login-theirs').replace('Login works', 'Login works!'),
      );
    await make();
    const d = await gitConflictDetail(r.ws, 'tests/smoke/login.yaml');
    expect(d).toMatchObject({ mode: 'text', kind: 'test' });
    expect(d.hunks).toHaveLength(1);
    expect(d.hunks[0]).toMatchObject({ key: 'hunk:0' });
    expect(d.hunks[0]!.where).toMatch(/near (step|item) Login/);
    expect(d.hunks[0]!.ours).toContain('login-ours');
    expect(d.hunks[0]!.theirs).toContain('login-theirs');
    await gitResolve(r.ws, 'tests/smoke/login.yaml', 'ours', { 'hunk:0': 'theirs' });
    let text = r.read('tests/smoke/login.yaml');
    expect(text).toContain('login-theirs');
    expect(text).toContain('Login works!'); // the clean change of their side came along
    expect(text).not.toContain('<<<<<<<');
    expect(await unmerged()).toBe('');
    await reset();
    await make();
    await gitResolve(r.ws, 'tests/smoke/login.yaml', 'theirs', { 'hunk:0': { edit: '      url: "{{baseUrl}}/login-edited"' } });
    text = r.read('tests/smoke/login.yaml');
    expect(text).toContain('login-edited');
    expect(text).not.toContain('login-ours');
    await reset();
    await make();
    await gitResolve(r.ws, 'tests/smoke/login.yaml', 'ours');
    expect(r.read('tests/smoke/login.yaml')).toContain('login-ours');
    await reset();
  });

  it('an API definition and a dataset (CSV) are text too', async () => {
    await conflict(
      'specs/x.yaml',
      (t) => t.replace('version: 1', 'version: 2'),
      (t) => t.replace('version: 1', 'version: 3'),
    );
    let d = await gitConflictDetail(r.ws, 'specs/x.yaml');
    expect(d).toMatchObject({ mode: 'text', kind: 'spec' });
    await gitResolve(r.ws, 'specs/x.yaml', 'ours', { 'hunk:0': 'theirs' });
    expect(r.read('specs/x.yaml')).toContain('version: 3');
    await reset();
    await conflict(
      'datasets/people.csv',
      (t) => t.replace('1,Ada', '1,Ada L'),
      (t) => t.replace('1,Ada', '1,Ada B'),
    );
    d = await gitConflictDetail(r.ws, 'datasets/people.csv');
    expect(d).toMatchObject({ mode: 'text', kind: 'dataset' });
    await gitResolve(r.ws, 'datasets/people.csv', 'theirs');
    expect(r.read('datasets/people.csv')).toContain('Ada B');
    await reset();
  });
});

describe('binary: a database is taken whole', () => {
  it('shows the sizes and takes one side', async () => {
    const p = 'datasets/data.sqlite';
    await r.git('checkout', '-b', 'theirs');
    writeFileSync(join(r.ws, p), Buffer.from([7, 7, 7, 0, 7, 7]));
    await r.commit('theirs db');
    await r.git('checkout', 'main');
    writeFileSync(join(r.ws, p), Buffer.from([5, 5, 0, 5]));
    await r.commit('ours db');
    await r.git('merge', 'theirs').catch(() => undefined);
    const d = await gitConflictDetail(r.ws, p);
    expect(d).toMatchObject({ mode: 'binary', sizes: { ours: 4, theirs: 6 } });
    await gitResolve(r.ws, p, 'theirs');
    expect([...readFileSync(join(r.ws, p))]).toEqual([7, 7, 7, 0, 7, 7]);
    expect(await unmerged()).toBe('');
    await reset();
  });
});
