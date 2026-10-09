import { describe, it, expect, afterAll } from 'vitest';
import { gitIdentity } from '../helpers.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WorkspaceStore, gitAbortMerge, gitClone, gitCommit, gitInit, gitPull, gitPush, gitSetupMergeDriver, gitStatus, gitSync, gitVersion, runGit, type Collection } from '@testpion/core';

// Pull & push (gitSync) and uncommitted work set aside during a pull: two clones of a bare repository stand in for
// two people changing the same collection.
const root = mkdtempSync(join(tmpdir(), 'tp-sync-'));
afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* left for the system's temp cleanup */
  }
});

const hasGit = !!(await gitVersion());
// the CLI is the merge driver, as `testpion git setup` registers it
const cli = resolve('packages/cli/bin/testpion.js').split('\\').join('/');
const driver = `"${process.execPath.split('\\').join('/')}" "${cli}" merge-driver`;

type Urls = Record<string, string>;
const collection = (urls: Urls): Collection =>
  ({
    schemaVersion: '1.0',
    id: 'api',
    name: 'API',
    version: 0,
    updatedAt: '',
    items: Object.entries(urls).map(([id, url]) => ({ kind: 'http', id, name: id.toUpperCase(), request: { method: 'GET', url, headers: [] } })),
  }) as Collection;
const urlsOf = (ws: string): Urls =>
  Object.fromEntries((JSON.parse(readFileSync(join(ws, 'collections', 'api.json'), 'utf8')) as { items: Array<{ id: string; request: { url: string } }> }).items.map((i) => [i.id, i.request.url]));

/** Change some requests' URLs in a clone's collection file (as saving in the app does). */
const edit = (ws: string, change: Urls) => {
  const s = WorkspaceStore.open(ws);
  s.saveCollection(collection({ ...urlsOf(ws), ...change }));
  s.close();
};
const remoteLog = async (remote: string) => (await runGit(remote, ['log', '--format=%s', 'main'])).trim().split('\n');

describe('git sync (Pull & push)', () => {
  it.skipIf(!hasGit)(
    'merges by request and pushes; stops on a real conflict without pushing; uncommitted work survives a pull',
    async () => {
      const remote = join(root, 'remote.git');
      await runGit(root, ['init', '--bare', '-b', 'main', remote]);
      const a = join(root, 'a');
      const sa = WorkspaceStore.create(a, 'Shared');
      sa.saveCollection(collection({ r1: 'https://x/one', r2: 'https://x/two' }));
      sa.close();
      await gitInit(a, { remote });
      await gitIdentity(a);
      await gitSetupMergeDriver(a, driver);
      await gitCommit(a, 'Start', { paths: ['.'] });
      // a first sync pushes and sets the upstream
      expect(await gitSync(a)).toMatchObject({ state: 'pushed', pulled: 0, pushed: 1 });
      expect((await gitStatus(a)).upstream).toBe('origin/main');

      const b = join(root, 'b');
      await gitClone(remote, b);
      await gitIdentity(b);
      await gitSetupMergeDriver(b, driver);
      expect(await gitSync(b)).toMatchObject({ state: 'up-to-date', pulled: 0, pushed: 0 });

      // A and B change different requests of one collection: B's sync pulls, merges by request, pushes
      edit(a, { r1: 'https://x/one-by-a' });
      await gitCommit(a, 'A changes r1', { paths: ['.'] });
      expect(await gitSync(a)).toMatchObject({ state: 'pushed', pushed: 1 });
      edit(b, { r2: 'https://x/two-by-b' });
      await gitCommit(b, 'B changes r2', { paths: ['.'] });
      // a plain push is refused: the remote has A's commit
      await expect(gitPush(b)).rejects.toMatchObject({ suggestions: [expect.stringMatching(/pull first/)] });
      const synced = await gitSync(b);
      expect(synced).toMatchObject({ state: 'pushed', pulled: 1 });
      expect(synced.pushed).toBeGreaterThanOrEqual(2); // B's commit and the merge
      expect(urlsOf(b)).toEqual({ r1: 'https://x/one-by-a', r2: 'https://x/two-by-b' });
      expect(await remoteLog(remote)).toEqual(expect.arrayContaining(['A changes r1', 'B changes r2']));
      expect((await gitStatus(b)).ahead).toBe(0);
      // A only pulls: nothing to push
      expect(await gitSync(a)).toMatchObject({ state: 'pulled-nothing-to-push', pushed: 0 });
      expect(urlsOf(a)).toEqual({ r1: 'https://x/one-by-a', r2: 'https://x/two-by-b' });

      // the same request changed on both sides: conflicts come back, nothing is pushed
      edit(a, { r1: 'https://x/one-again-by-a' });
      await gitCommit(a, 'A again', { paths: ['.'] });
      await gitSync(a);
      const remoteHead = (await runGit(remote, ['rev-parse', 'main'])).trim();
      edit(b, { r1: 'https://x/one-again-by-b' });
      await gitCommit(b, 'B again', { paths: ['.'] });
      const conflicted = await gitSync(b);
      expect(conflicted).toMatchObject({ state: 'conflicts', files: ['collections/api.json'], pushed: 0, message: expect.stringMatching(/Resolve the conflicts, commit, then Push/) });
      expect((await runGit(remote, ['rev-parse', 'main'])).trim()).toBe(remoteHead);
      // a sync while conflicts are open says so again, without pulling or pushing
      expect(await gitSync(b)).toMatchObject({ state: 'conflicts' });
      await gitAbortMerge(b);
      await runGit(b, ['reset', '--hard', 'origin/main']);

      // an uncommitted edit to r1 survives a pull that changed r2 of the same collection
      edit(a, { r2: 'https://x/two-again-by-a' });
      await gitCommit(a, 'A changes r2', { paths: ['.'] });
      await gitSync(a);
      edit(b, { r1: 'https://x/one-uncommitted-by-b' });
      await runGit(b, ['fetch']);
      const pulled = await gitPull(b);
      expect(pulled).toMatchObject({ conflicted: false, setAside: true, message: 'Your uncommitted changes were set aside and put back.' });
      expect(urlsOf(b)).toEqual({ r1: 'https://x/one-uncommitted-by-b', r2: 'https://x/two-again-by-a' });
      const st = await gitStatus(b);
      expect(st.files).toEqual([{ path: 'collections/api.json', state: 'modified', staged: false }]);
      expect((await runGit(b, ['stash', 'list'])).trim()).toBe('');

      // the same through a sync: commit after the pull, then it pushes
      edit(a, { r2: 'https://x/two-third-by-a' });
      await gitCommit(a, 'A changes r2 again', { paths: ['.'] });
      await gitSync(a);
      const viaSync = await gitSync(b);
      expect(viaSync).toMatchObject({ state: 'pulled-nothing-to-push', pulled: 1, setAside: true, message: expect.stringMatching(/set aside and put back/) });
      expect(urlsOf(b)).toEqual({ r1: 'https://x/one-uncommitted-by-b', r2: 'https://x/two-third-by-a' });
    },
    180_000,
  );
});
