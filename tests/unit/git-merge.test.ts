import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { WorkspaceStore, assertGitRef, assertGitRev, assertRemoteUrl, describeRevChanges, changesMarkdown, gitCommit, gitConflictDetail, gitItemHistory, gitInit, gitResolve, gitSetupMergeDriver, gitStatus, gitVersion, mergeCollectionTexts, mergeWorkspaceTexts, pullRequestUrl, runGit, type Collection } from '@testpion/core';

// GIT-301 (merge by id), GIT-304 (pull request links), GIT-401 (semantic diff between commits).
const root = mkdtempSync(join(tmpdir(), 'tp-merge-'));
// best effort: on Windows git can still hold a file for a moment (the temp folder is cleaned up anyway)
afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* left for the system's temp cleanup */
  }
});

const req = (id: string, name: string, url: string, extra: Record<string, unknown> = {}) => ({ kind: 'http', id, name, request: { method: 'GET', url, headers: [] }, ...extra });
const col = (items: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ schemaVersion: '1.0', id: 'api', name: 'API', items, ...extra }, null, 2);

describe('merging collections by id', () => {
  it('combines edits to different requests, additions and deletions', () => {
    const base = col([req('a', 'A', 'https://x/a'), req('b', 'B', 'https://x/b'), req('c', 'C', 'https://x/c')]);
    const ours = col([req('a', 'A', 'https://x/a2'), req('b', 'B', 'https://x/b'), req('c', 'C', 'https://x/c'), req('d', 'D', 'https://x/d')]);
    const theirs = col([req('a', 'A', 'https://x/a'), req('b', 'B', 'https://x/b3'), req('e', 'E', 'https://x/e')]);
    const r = mergeCollectionTexts(base, ours, theirs)!;
    expect(r.conflicts).toEqual([]);
    const items = (JSON.parse(r.text) as Collection).items as Array<{ id: string; request: { url: string } }>;
    expect(items.map((i) => i.id)).toEqual(['a', 'b', 'e', 'd']);
    expect(items.find((i) => i.id === 'a')!.request.url).toBe('https://x/a2');
    expect(items.find((i) => i.id === 'b')!.request.url).toBe('https://x/b3');
  });

  it('merges inside folders and reports a real conflict, keeping ours', () => {
    const folder = (items: unknown[], name = 'F') => ({ kind: 'folder', id: 'f', name, items });
    const base = col([folder([req('a', 'A', 'https://x/a')])]);
    const ours = col([folder([req('a', 'A', 'https://x/mine')], 'Folder')]);
    const theirs = col([folder([req('a', 'A', 'https://x/theirs'), req('n', 'N', 'https://x/n')])]);
    const r = mergeCollectionTexts(base, ours, theirs)!;
    expect(r.conflicts).toEqual(['API ▸ Folder ▸ A: changed on both sides']);
    const f = (JSON.parse(r.text) as { items: Array<{ name: string; items: Array<{ id: string; request: { url: string } }> }> }).items[0]!;
    expect(f.name).toBe('Folder');
    expect(f.items.map((i) => i.id)).toEqual(['a', 'n']);
    expect(f.items[0]!.request.url).toBe('https://x/mine');
  });

  it('keeps a request deleted on one side but changed on the other', () => {
    const base = col([req('a', 'A', 'https://x/a')]);
    const r = mergeCollectionTexts(base, col([]), col([req('a', 'A', 'https://x/changed')]))!;
    expect(r.conflicts[0]).toMatch(/deleted here, changed on the other side/);
    expect((JSON.parse(r.text) as Collection).items).toHaveLength(1);
  });

  it('reports each conflict with its three versions and settles them one by one (GIT-302)', () => {
    const base = col([req('a', 'A', 'https://x/a'), req('b', 'B', 'https://x/b'), req('c', 'C', 'https://x/c')], { auth: { type: 'none' } });
    const ours = col([req('a', 'A', 'https://x/a-mine'), req('b', 'B', 'https://x/b-mine'), req('c', 'C', 'https://x/c-mine')], { auth: { type: 'bearer' } });
    const theirs = col([req('a', 'A', 'https://x/a-theirs'), req('b', 'B', 'https://x/b-theirs')], { auth: { type: 'basic' } });
    const r = mergeCollectionTexts(base, ours, theirs)!;
    expect(r.items.map((i) => [i.key, i.kind])).toEqual([
      ['setting:collection:auth', 'setting'],
      ['item:a', 'changed-both'],
      ['item:b', 'changed-both'],
      ['item:c', 'deleted-theirs'],
    ]);
    expect(r.items[1]).toMatchObject({ where: 'API ▸ A', base: { request: { url: 'https://x/a' } }, ours: { request: { url: 'https://x/a-mine' } }, theirs: { request: { url: 'https://x/a-theirs' } } });
    // the choices: theirs for A and the auth, ours for B (the default), theirs for C (it goes, as they deleted it)
    const settled = mergeCollectionTexts(base, ours, theirs, { 'item:a': 'theirs', 'setting:collection:auth': 'theirs', 'item:c': 'theirs' })!;
    const c = JSON.parse(settled.text) as { auth: { type: string }; items: Array<{ id: string; request: { url: string } }> };
    expect(c.auth.type).toBe('basic');
    expect(c.items.map((i) => `${i.id} ${i.request.url}`)).toEqual(['a https://x/a-theirs', 'b https://x/b-mine']);
    // a request we deleted and they changed: back unless the choice is ours
    const del = mergeCollectionTexts(col([req('a', 'A', 'https://x/a')]), col([]), col([req('a', 'A', 'https://x/a2')]), { 'item:a': 'ours' })!;
    expect((JSON.parse(del.text) as Collection).items).toHaveLength(0);
  });

  it('leaves files that are not collections to git', () => {
    expect(mergeCollectionTexts('x', '{', '{}')).toBeUndefined();
  });
});

describe('merging environments and library files (GIT-301)', () => {
  const env = (vars: Array<[string, string]>, extra: Record<string, unknown> = {}) => JSON.stringify({ id: 'stg', name: 'Staging', variables: vars.map(([key, value]) => ({ key, value })), ...extra }, null, 2);

  it('merges environments by variable: different variables combine, the same one changed twice is a conflict', () => {
    const base = env([['baseUrl', 'https://a'], ['timeout', '30'], ['old', 'x']]);
    const ours = env([['baseUrl', 'https://mine'], ['timeout', '30'], ['old', 'x'], ['mineOnly', '1']], { color: '#f00' });
    const theirs = env([['baseUrl', 'https://theirs'], ['timeout', '60'], ['theirsOnly', '2']]);
    const r = mergeWorkspaceTexts(base, ours, theirs)!;
    expect(r.items.map((i) => [i.key, i.kind, i.where])).toEqual([['var:baseUrl', 'changed-both', 'environment Staging ▸ {{baseUrl}}']]);
    const merged = JSON.parse(r.text) as { color: string; variables: Array<{ key: string; value: string }> };
    expect(merged.color).toBe('#f00');
    expect(Object.fromEntries(merged.variables.map((v) => [v.key, v.value]))).toEqual({ baseUrl: 'https://mine', timeout: '60', mineOnly: '1', theirsOnly: '2' });
    const theirsWins = JSON.parse(mergeWorkspaceTexts(base, ours, theirs, { 'var:baseUrl': 'theirs' })!.text) as { variables: Array<{ key: string; value: string }> };
    expect(theirsWins.variables.find((v) => v.key === 'baseUrl')!.value).toBe('https://theirs');
  });

  it('merges a library file by item id and keeps its folders', () => {
    const lib = (items: unknown[], folders: string[]) => JSON.stringify({ schemaVersion: '1.0', folders, items }, null, 2);
    const item = (id: string, data: unknown, folder?: string) => ({ id, name: id.toUpperCase(), ...(folder ? { folder } : {}), data });
    const base = lib([item('a', { m: 1 }), item('b', { m: 1 }, 'Old')], ['Old']);
    const ours = lib([item('a', { m: 2 }), item('b', { m: 1 }, 'Old'), item('c', { m: 1 }, 'Mine')], ['Mine', 'Old']);
    const theirs = lib([item('a', { m: 1 }), item('d', { m: 1 })], []);
    const r = mergeWorkspaceTexts(base, ours, theirs)!;
    expect(r.conflicts).toEqual([]);
    const merged = JSON.parse(r.text) as { folders: string[]; items: Array<{ id: string; data: { m: number } }> };
    expect(merged.items.map((i) => `${i.id}:${i.data.m}`)).toEqual(['a:2', 'd:1', 'c:1']);
    expect(merged.folders).toEqual(['Mine']);
  });

  it('still merges collections the same way', () => {
    const r = mergeWorkspaceTexts(col([req('a', 'A', 'https://x/a')]), col([req('a', 'A', 'https://x/a2')]), col([req('a', 'A', 'https://x/a'), req('b', 'B', 'https://x/b')]))!;
    expect((JSON.parse(r.text) as Collection).items.map((i) => i.id)).toEqual(['a', 'b']);
  });
});

describe('pull request links', () => {
  it('knows GitHub, GitLab, Bitbucket and Azure DevOps', () => {
    expect(pullRequestUrl('git@github.com:team/api.git', 'feature/x')).toBe('https://github.com/team/api/compare/main...feature%2Fx?expand=1');
    expect(pullRequestUrl('https://github.com/team/api', 'b', 'main', 'hi')).toBe('https://github.com/team/api/compare/main...b?expand=1&body=hi');
    expect(pullRequestUrl('https://gitlab.com/g/sub/api.git', 'b', 'dev')).toBe('https://gitlab.com/g/sub/api/-/merge_requests/new?merge_request[source_branch]=b&merge_request[target_branch]=dev');
    expect(pullRequestUrl('git@bitbucket.org:team/api.git', 'b')).toBe('https://bitbucket.org/team/api/pull-requests/new?source=b&dest=main');
    expect(pullRequestUrl('https://dev.azure.com/org/proj/_git/api', 'b')).toBe('https://dev.azure.com/org/proj/_git/api/pullrequestcreate?sourceRef=b&targetRef=main');
    expect(pullRequestUrl('git@ssh.dev.azure.com:v3/org/proj/api', 'b')).toBe('https://dev.azure.com/org/proj/_git/api/pullrequestcreate?sourceRef=b&targetRef=main');
    expect(pullRequestUrl('https://example.com/x.git', 'b')).toBeUndefined();
  });
});

describe('git with the merge driver', () => {
  let hasGit = false;
  beforeAll(async () => {
    hasGit = !!(await gitVersion());
  });

  it('two branches that change different requests merge without a conflict; the semantic diff between commits', async () => {
    if (!hasGit) return;
    const ws = join(root, 'ws');
    const store = WorkspaceStore.create(ws, 'Merge');
    await gitInit(ws);
    await runGit(ws, ['config', 'user.name', 'T']);
    await runGit(ws, ['config', 'user.email', 't@example.com']);
    await runGit(ws, ['config', 'commit.gpgsign', 'false']);
    // the CLI is the driver (as `testpion git setup` registers it)
    const cli = resolve('packages/cli/bin/testpion.js').split('\\').join('/');
    await gitSetupMergeDriver(ws, `"${process.execPath.split('\\').join('/')}" "${cli}" merge-driver`);
    const save = (items: unknown[]) => store.saveCollection({ schemaVersion: '1.0', id: 'api', name: 'API', version: 0, updatedAt: '', items } as Collection);
    save([req('a', 'A', 'https://x/a'), req('b', 'B', 'https://x/b')]);
    await gitCommit(ws, 'base', { paths: ['.'] });
    const base = (await runGit(ws, ['rev-parse', 'HEAD'])).trim();
    await runGit(ws, ['switch', '-c', 'other']);
    save([req('a', 'A', 'https://x/a'), req('b', 'B', 'https://x/b-theirs')]);
    await gitCommit(ws, 'theirs', { paths: ['.'] });
    await runGit(ws, ['switch', 'main']);
    save([req('a', 'A', 'https://x/a-ours'), req('b', 'B', 'https://x/b')]);
    await gitCommit(ws, 'ours', { paths: ['.'] });
    // the lines next to each other would conflict in a line merge
    await runGit(ws, ['merge', '--no-edit', 'other']);
    expect((await gitStatus(ws)).conflicted).toBe(false);
    const merged = JSON.parse(readFileSync(join(ws, 'collections', 'api.json'), 'utf8')) as { items: Array<{ request: { url: string } }> };
    expect(merged.items.map((i) => i.request.url)).toEqual(['https://x/a-ours', 'https://x/b-theirs']);

    const changes = await describeRevChanges(ws, base, 'HEAD');
    expect(changes.map((c) => `${c.change} ${c.title} ${c.details.join(',')}`).sort()).toEqual(['changed API ▸ A URL', 'changed API ▸ B URL']);
    expect(changesMarkdown(changes)).toContain('**API ▸ A**: URL');
    // working-folder changes after a commit
    writeFileSync(join(ws, 'notes.md'), 'x');
    expect((await describeRevChanges(ws, 'HEAD')).map((c) => c.title)).toEqual([]); // untracked files are not in a diff
    // the CLI prints the same
    const md = execFileSync(process.execPath, [cli, 'diff', base, 'HEAD', '--markdown', '-w', ws], { encoding: 'utf8' });
    expect(md).toContain('API ▸ B');
    // a request's history: only the commits that changed it (the merge and "ours" left B as theirs made it)
    save([req('a', 'A', 'https://x/a-ours'), req('b', 'B', 'https://x/b-theirs'), req('c', 'C', 'https://x/c')]);
    await gitCommit(ws, 'add C', { paths: ['collections'] });
    const hist = await gitItemHistory(ws, 'collections/api.json', 'b');
    expect(hist.map((h) => h.commit.subject)).toEqual(['theirs', 'base']);
    expect((hist[0]!.item as { request: { url: string } }).request.url).toBe('https://x/b-theirs');
    expect((await gitItemHistory(ws, 'collections/api.json', 'c')).map((h) => h.commit.subject)).toEqual(['add C']);

    // a real conflict: A changed on both sides; "theirs" wins only A, our change to C stays
    await runGit(ws, ['switch', '-c', 'other2']);
    save([req('a', 'A', 'https://x/a-2-theirs'), req('b', 'B', 'https://x/b-theirs'), req('c', 'C', 'https://x/c')]);
    await gitCommit(ws, 'theirs 2', { paths: ['collections'] });
    await runGit(ws, ['switch', 'main']);
    save([req('a', 'A', 'https://x/a-2-ours'), req('b', 'B', 'https://x/b-theirs'), req('c', 'C', 'https://x/c-ours')]);
    await gitCommit(ws, 'ours 2', { paths: ['collections'] });
    await runGit(ws, ['merge', '--no-edit', 'other2']).catch(() => undefined);
    expect((await gitStatus(ws)).conflicted).toBe(true);
    // the side-by-side view: A, part by part; only the request line differs
    const detail = await gitConflictDetail(ws, 'collections/api.json');
    expect(detail.collection).toBe(true);
    expect(detail.items.map((i) => [i.key, i.kind, i.where])).toEqual([['item:a', 'changed-both', 'API ▸ A']]);
    expect(detail.items[0]!.parts.filter((p) => p.differs)).toEqual([{ part: 'Request', base: 'GET https://x/a-ours', ours: 'GET https://x/a-2-ours', theirs: 'GET https://x/a-2-theirs', differs: true }]);
    await gitResolve(ws, 'collections/api.json', 'ours', { 'item:a': 'theirs' });
    const settled = JSON.parse(readFileSync(join(ws, 'collections', 'api.json'), 'utf8')) as { items: Array<{ request: { url: string } }> };
    expect(settled.items.map((i) => i.request.url)).toEqual(['https://x/a-2-theirs', 'https://x/b-theirs', 'https://x/c-ours']);
    expect((await gitStatus(ws)).files.find((f) => f.path === 'collections/api.json')).toMatchObject({ staged: true });
    store.close();
  });
});

describe('git arguments from users and agents', () => {
  it('refuses names and revisions git would read as options', () => {
    for (const bad of ['--output=/tmp/x', '-d', '', 'a..b', 'a b', 'feature/', 'x.lock', 'a~{b}'.replace('~{', '@{')]) expect(() => assertGitRef(bad)).toThrow(/Not a valid git/);
    for (const ok of ['main', 'feature/payments-2', 'origin/main', 'v1.0.0', 'release_2026']) expect(assertGitRef(ok)).toBe(ok);
    for (const bad of ['--output=C:/evil', '-p', 'HEAD; rm -rf', 'a..b', '']) expect(() => assertGitRev(bad)).toThrow(/Not a valid git revision/);
    for (const ok of ['HEAD', 'HEAD~2', 'main^', 'origin/main', 'a1b2c3d', 'v0.42.0']) expect(assertGitRev(ok)).toBe(ok);
    expect(() => assertRemoteUrl('--upload-pack=evil')).toThrow();
    expect(assertRemoteUrl('git@github.com:team/api.git')).toBe('git@github.com:team/api.git');
  });
});
