import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore, describeRevChanges, gitCommit, gitInit, gitStatus, gitVersion, runGit, type Collection } from '@testpion/core';

// A workspace reached through a link (a symlink, a Windows junction, an 8.3 short name like C:\Users\RUNNER~1): git
// reports the real path of the repository, and the files must still be related to the workspace (on CI's Windows and
// macOS runners the temporary folder is such a path, and every file came out as ../../../../real/path).
const root = mkdtempSync(join(tmpdir(), 'tp-git-link-'));
// best effort: Windows may still hold the workspace's files for a moment (a temp folder is cleaned up anyway)
afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* left for the system's temp cleanup */
  }
});

const collection = (url: string): Collection =>
  ({ schemaVersion: '1.0', id: 'api', name: 'API', version: 0, updatedAt: '', items: [{ kind: 'http', id: 'a', name: 'A', request: { method: 'GET', url } }] }) as Collection;

describe('git through a linked path', () => {
  it('status and the changes between commits name the workspace files', async () => {
    if (!(await gitVersion())) return;
    const real = join(root, 'real');
    mkdirSync(real);
    const linked = join(root, 'linked');
    symlinkSync(real, linked, process.platform === 'win32' ? 'junction' : 'dir');
    const ws = linked;
    const store = WorkspaceStore.create(ws, 'Linked');
    await gitInit(ws);
    await runGit(ws, ['config', 'user.name', 'Tester']);
    await runGit(ws, ['config', 'user.email', 'tester@example.com']);
    await runGit(ws, ['config', 'commit.gpgsign', 'false']);
    store.saveCollection(collection('https://x/a'));
    await runGit(ws, ['add', '-A']);
    await gitCommit(ws, 'first');
    store.saveCollection(collection('https://x/a2'));
    const st = await gitStatus(ws);
    expect(st.files.map((f) => f.path)).toContain('collections/api.json');
    await runGit(ws, ['add', '-A']);
    await gitCommit(ws, 'second');
    const changes = await describeRevChanges(ws, 'HEAD~1', 'HEAD');
    expect(changes.map((c) => c.file)).toContain('collections/api.json');
    store.close();
  });
});
