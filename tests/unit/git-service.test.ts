import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WorkspaceStore,
  describeGitChanges,
  gitBranches,
  gitClone,
  gitCommit,
  gitDiscard,
  gitInit,
  gitLog,
  gitPull,
  gitPush,
  gitShow,
  gitStage,
  gitStatus,
  gitSwitch,
  gitVersion,
  runGit,
  type Collection,
} from '@testpion/core';

// GIT-201 / GIT-205: the git service against real temporary repositories (a bare one stands in for the remote).
const root = mkdtempSync(join(tmpdir(), 'tp-git-'));
// best effort: on Windows git can still hold a file for a moment (the temp folder is cleaned up anyway)
afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* left for the system's temp cleanup */
  }
});

const identity = async (dir: string) => {
  await runGit(dir, ['config', 'user.name', 'Tester']);
  await runGit(dir, ['config', 'user.email', 'tester@example.com']);
  await runGit(dir, ['config', 'commit.gpgsign', 'false']);
};

const collection = (items: Collection['items']): Collection => ({ schemaVersion: '1.0', id: 'api', name: 'API', version: 0, updatedAt: '', items }) as Collection;

let hasGit = false;
beforeAll(async () => {
  hasGit = !!(await gitVersion());
});

describe('git service', () => {
  it('status, commit, log, show, discard, semantic changes', async () => {
    if (!hasGit) return;
    const ws = join(root, 'ws');
    const store = WorkspaceStore.create(ws, 'Git');
    expect((await gitStatus(ws)).repository).toBe(false);
    await gitInit(ws);
    await identity(ws);
    store.saveCollection(collection([{ kind: 'http', id: 'r1', name: 'List', request: { method: 'GET', url: 'https://x/list', headers: [] } }] as Collection['items']));
    let st = await gitStatus(ws);
    expect(st.repository).toBe(true);
    expect(st.branch).toBe('main');
    expect(st.files.map((f) => f.path)).toContain('collections/api.json');
    expect(st.files.every((f) => !f.path.startsWith('.local'))).toBe(true);
    const c1 = await gitCommit(ws, 'First', { paths: ['.'] });
    expect(c1.subject).toBe('First');
    expect((await gitStatus(ws)).files).toEqual([]);

    // change a request, add one, and see the meaning
    store.saveCollection(
      collection([
        { kind: 'http', id: 'r1', name: 'List', request: { method: 'GET', url: 'https://x/items', headers: [{ key: 'A', value: '1', enabled: true }] } },
        { kind: 'http', id: 'r2', name: 'Create', request: { method: 'POST', url: 'https://x/items', headers: [] } },
      ] as Collection['items']),
    );
    st = await gitStatus(ws);
    expect(st.files).toEqual([{ path: 'collections/api.json', state: 'modified', staged: false }]);
    const meaning = await describeGitChanges(ws, st.files);
    expect(meaning.find((m) => m.itemId === 'r1')).toMatchObject({ change: 'changed', title: 'API ▸ List' });
    expect(meaning.find((m) => m.itemId === 'r1')!.details).toEqual(expect.arrayContaining(['URL', 'headers (0 → 1)']));
    expect(meaning.find((m) => m.itemId === 'r2')).toMatchObject({ change: 'added' });
    expect(JSON.parse((await gitShow(ws, 'collections/api.json'))!).items).toHaveLength(1);

    await gitDiscard(ws, st.files);
    expect((await gitStatus(ws)).files).toEqual([]);
    expect(JSON.parse(readFileSync(join(ws, 'collections', 'api.json'), 'utf8')).items).toHaveLength(1);

    // a new file is discarded by deleting it
    writeFileSync(join(ws, 'notes.txt'), 'x');
    await gitDiscard(ws, [{ path: 'notes.txt', state: 'untracked' }]);
    expect(existsSync(join(ws, 'notes.txt'))).toBe(false);

    await gitCommit(ws, 'Second', { paths: ['.'] }).catch(() => undefined); // nothing to commit is an error
    expect((await gitLog(ws)).map((c) => c.subject)).toEqual(['First']);
    store.close();
  });

  it('a workspace inside a bigger repository sees only its own files', async () => {
    if (!hasGit) return;
    const repo = join(root, 'mono');
    mkdirSync(repo);
    await gitInit(repo);
    await identity(repo);
    writeFileSync(join(repo, 'README.md'), 'hi');
    const ws = join(repo, 'api-tests');
    WorkspaceStore.create(ws, 'Inside').close();
    const st = await gitStatus(ws);
    expect(st.files.length).toBeGreaterThan(0);
    expect(st.files.some((f) => f.path.includes('README'))).toBe(false);
    expect(st.files.every((f) => !f.path.startsWith('api-tests/'))).toBe(true);
  });

  it('branches, push, clone and pull through a remote', async () => {
    if (!hasGit) return;
    const remote = join(root, 'remote.git');
    await runGit(root, ['init', '--bare', '-b', 'main', remote]);
    const a = join(root, 'a');
    WorkspaceStore.create(a, 'Shared').close();
    await gitInit(a, { remote });
    await identity(a);
    await gitCommit(a, 'Start', { paths: ['.'] });
    await gitPush(a);
    expect((await gitStatus(a)).upstream).toBe('origin/main');

    const b = join(root, 'b');
    await gitClone(remote, b);
    await identity(b);
    expect((await gitLog(b)).map((c) => c.subject)).toEqual(['Start']);

    // a feature branch
    await gitSwitch(a, 'feature', { create: true });
    expect((await gitBranches(a)).current).toBe('feature');
    await gitSwitch(a, 'main');

    // a change in a, pulled into b
    writeFileSync(join(a, 'notes.md'), 'one');
    await gitCommit(a, 'Notes', { paths: ['notes.md'] });
    await gitPush(a);
    expect(await gitPull(b)).toEqual({ conflicted: false });
    expect(readFileSync(join(b, 'notes.md'), 'utf8')).toBe('one');

    // both change the same line: a conflict
    writeFileSync(join(a, 'notes.md'), 'from a');
    await gitCommit(a, 'A', { paths: ['notes.md'] });
    await gitPush(a);
    writeFileSync(join(b, 'notes.md'), 'from b');
    await gitCommit(b, 'B', { paths: ['notes.md'] });
    expect(await gitPull(b)).toEqual({ conflicted: true });
    const st = await gitStatus(b);
    expect(st.conflicted).toBe(true);
    expect(st.files).toContainEqual({ path: 'notes.md', state: 'conflicted', staged: false });
    await runGit(b, ['merge', '--abort']);
    // a rejected push says what to do
    await expect(gitPush(b)).rejects.toMatchObject({ suggestions: [expect.stringMatching(/pull first/)] });
    await gitStage(b, []);
  });
});
