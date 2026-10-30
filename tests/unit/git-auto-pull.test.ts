import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore, gitClone, gitCommit, gitInit, gitPull, gitPullFastForward, gitPush, gitStatus, gitVersion, runGit } from '@testpion/core';
import { GitAutoFetch } from '../../apps/desktop/backend/git-autofetch.js';
import { gitIdentity } from '../helpers.js';

/**
 * "Pull my team's commits by itself" (Settings ▸ Git ▸ git.autoPull): only a plain fast-forward of a workspace with nothing of
 * the person's in it. A bare repository stands in for the remote; `a` is a teammate, `b` is this computer.
 */
const root = mkdtempSync(join(tmpdir(), 'tp-autopull-'));
afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* left for the system's temp cleanup */
  }
});
const hasGit = !!(await gitVersion());

/** A teammate's clone `a` and this computer's clone `b` of one remote that holds a workspace. */
async function pair(name: string) {
  const remote = join(root, `${name}.git`);
  await runGit(root, ['init', '--bare', '-b', 'main', remote]);
  const a = join(root, `${name}-a`);
  WorkspaceStore.create(a, 'Shared').close();
  await gitInit(a, { remote });
  await gitIdentity(a);
  await runGit(a, ['config', 'user.name', 'Ana']);
  await gitCommit(a, 'Start', { paths: ['.'] });
  await gitPush(a);
  const b = join(root, `${name}-b`);
  await gitClone(remote, b);
  await gitIdentity(b);
  return { a, b };
}

/** The backend's side of the background fetch, with just what it reads. */
function backendOf(ws: string, autoPull: boolean) {
  const events: Array<{ name: string; payload: any }> = [];
  const be = {
    settings: { git: { autoPull } },
    store: { root: ws },
    ws: { reloadWorkspaceFile: () => undefined },
    host: { appDir: root, emit: (name: string, payload: unknown) => void events.push({ name, payload }) },
    logger: { debug: () => undefined, info: () => undefined },
    adoptDiskState: () => undefined,
  };
  return { fetcher: new GitAutoFetch(be as never), events };
}

describe('gitPullFastForward', () => {
  it.skipIf(!hasGit)('brings in a teammate\'s commits and says who wrote them', async () => {
    const { a, b } = await pair('ff');
    writeFileSync(join(a, 'notes.md'), 'one');
    await gitCommit(a, 'Add notes', { paths: ['notes.md'] });
    writeFileSync(join(a, 'notes.md'), 'two');
    await gitCommit(a, 'Tighten notes', { paths: ['notes.md'] });
    await gitPush(a);
    await runGit(b, ['fetch']);
    const r = await gitPullFastForward(b);
    expect(r.pulled).toBe(2);
    expect(r.commits.map((c) => `${c.author}: ${c.subject}`)).toEqual(['Ana: Tighten notes', 'Ana: Add notes']);
    expect(readFileSync(join(b, 'notes.md'), 'utf8')).toBe('two');
    // nothing new: nothing pulled
    expect(await gitPullFastForward(b)).toEqual({ pulled: 0, commits: [] });
  });

  it.skipIf(!hasGit)('refuses when there is something of yours to merge, and changes nothing', async () => {
    const { a, b } = await pair('diverged');
    writeFileSync(join(a, 'notes.md'), 'from a');
    await gitCommit(a, 'A', { paths: ['notes.md'] });
    await gitPush(a);
    writeFileSync(join(b, 'mine.md'), 'mine');
    await gitCommit(b, 'Mine', { paths: ['mine.md'] });
    await runGit(b, ['fetch']);
    const head = (await runGit(b, ['rev-parse', 'HEAD'])).trim();
    await expect(gitPullFastForward(b)).rejects.toBeTruthy();
    expect((await runGit(b, ['rev-parse', 'HEAD'])).trim()).toBe(head);
    expect((await gitStatus(b)).files).toEqual([]);
    void gitPull;
  });
});

describe('the background fetch pulls by itself', () => {
  it.skipIf(!hasGit)('pulls a clean workspace when the setting is on, and tells the views', async () => {
    const { a, b } = await pair('on');
    writeFileSync(join(a, 'notes.md'), 'one');
    await gitCommit(a, 'Add notes', { paths: ['notes.md'] });
    await gitPush(a);
    const { fetcher, events } = backendOf(b, true);
    const r = await fetcher.fetchNow();
    expect(r).toMatchObject({ fetched: true, behind: 0, ahead: 0 });
    expect(readFileSync(join(b, 'notes.md'), 'utf8')).toBe('one');
    const pulled = events.find((e) => e.name === 'git.autoPulled');
    expect(pulled?.payload).toMatchObject({ count: 1, authors: ['Ana'], commits: [{ author: 'Ana', subject: 'Add notes' }] });
    expect(events.map((e) => e.name)).toEqual(expect.arrayContaining(['data.changed', 'git.changed']));
  });

  it.skipIf(!hasGit)('does nothing when the setting is off: it only reports behind', async () => {
    const { a, b } = await pair('off');
    writeFileSync(join(a, 'notes.md'), 'one');
    await gitCommit(a, 'Add notes', { paths: ['notes.md'] });
    await gitPush(a);
    const { fetcher, events } = backendOf(b, false);
    expect(await fetcher.fetchNow()).toMatchObject({ fetched: true, behind: 1 });
    expect(events.some((e) => e.name === 'git.autoPulled')).toBe(false);
    expect(events.find((e) => e.name === 'git.remoteChanged')?.payload).toMatchObject({ behind: 1 });
  });

  it.skipIf(!hasGit)('leaves a workspace with changes of the person\'s alone (even a new file)', async () => {
    const { a, b } = await pair('dirty');
    writeFileSync(join(a, 'notes.md'), 'one');
    await gitCommit(a, 'Add notes', { paths: ['notes.md'] });
    await gitPush(a);
    mkdirSync(join(b, 'tests'), { recursive: true });
    writeFileSync(join(b, 'tests', 'draft.yaml'), 'name: draft\n');
    const { fetcher, events } = backendOf(b, true);
    expect(await fetcher.fetchNow()).toMatchObject({ fetched: true, behind: 1 });
    expect(events.some((e) => e.name === 'git.autoPulled')).toBe(false);
    expect(readFileSync(join(b, 'tests', 'draft.yaml'), 'utf8')).toBe('name: draft\n');
  });

  it.skipIf(!hasGit)('leaves a workspace with commits not yet pushed alone', async () => {
    const { a, b } = await pair('ahead');
    writeFileSync(join(a, 'notes.md'), 'one');
    await gitCommit(a, 'Add notes', { paths: ['notes.md'] });
    await gitPush(a);
    writeFileSync(join(b, 'mine.md'), 'mine');
    await gitCommit(b, 'Mine', { paths: ['mine.md'] });
    const { fetcher, events } = backendOf(b, true);
    expect(await fetcher.fetchNow()).toMatchObject({ fetched: true, ahead: 1, behind: 1 });
    expect(events.some((e) => e.name === 'git.autoPulled')).toBe(false);
  });
});
