import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The renderer's git store (review: performance, finding 2). It is read two seconds after every save, so a read that finds
 * nothing new must change nothing (no new state, no render), marks that did not change keep their object, and reads never
 * overlap: one runs at a time and requests that come meanwhile make one more run, not several.
 */
const calls: Array<{ resolve: (v: unknown) => void }> = [];
const handlers = new Map<string, (e?: unknown) => void>();
vi.mock('../../apps/desktop/src/api', () => ({
  call: vi.fn(() => new Promise((resolve) => calls.push({ resolve }))),
  on: vi.fn((event: string, h: (e?: unknown) => void) => (handlers.set(event, h), () => handlers.delete(event))),
}));

import { call } from '../../apps/desktop/src/api';
import { gitSnapshot, refreshGit, resetGitForTest, startGitLive } from '../../apps/desktop/src/lib/git';
import { gitRefKey } from '@testpion/shared';

const status = (over: object = {}) => ({ available: true, repository: true, branch: 'main', ahead: 0, behind: 0, files: [], conflicted: false, ...over });
const change = (id: string, kind: 'changed' | 'added' = 'changed') => ({
  file: 'collections/c.json',
  kind: 'collection',
  change: kind,
  title: id,
  details: [],
  ref: { kind: 'request', collectionId: 'c', requestId: id },
  containers: [gitRefKey({ kind: 'collection', collectionId: 'c' })],
});
/** Answers the oldest pending `git.changes` call. */
const answer = (value: unknown) => calls.shift()!.resolve(value);
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  calls.length = 0;
  vi.mocked(call).mockClear();
  resetGitForTest();
});

describe('git store', () => {
  it('reads at once after a git event, also when the watcher reports a file change right after it (Undo shows the file again without a wait)', async () => {
    vi.useFakeTimers();
    try {
      const stop = startGitLive();
      answer({ ...status(), changes: [] }); // the first read
      await vi.advanceTimersByTimeAsync(0);
      calls.length = 0;
      // Undo: git.changed first, then the file watcher's report of the written file
      handlers.get('git.changed')!();
      handlers.get('workspace.changedOnDisk')!();
      handlers.get('data.changed')!({ method: 'disk' });
      await vi.advanceTimersByTimeAsync(5);
      expect(calls.length, 'one read started at once, not two seconds later').toBe(1);
      answer({ ...status(), changes: [change('r1')] });
      await vi.advanceTimersByTimeAsync(0);
      expect(gitSnapshot().changes.length).toBe(1);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the state (and renders nothing) when a read finds the same answer', async () => {
    const first = refreshGit();
    answer({ ...status(), changes: [change('r1')] });
    await first;
    const before = gitSnapshot();
    expect(before.changes.length).toBe(1);
    const second = refreshGit();
    answer({ ...status(), changes: [change('r1')] });
    await second;
    // the very same object: a component that took something from it has nothing to render again
    expect(gitSnapshot()).toBe(before);
  });

  it('keeps the object of every mark that did not change', async () => {
    const first = refreshGit();
    answer({ ...status(), changes: [change('r1'), change('r2')] });
    await first;
    const marks = gitSnapshot().marks;
    const r1 = marks.get(gitRefKey({ kind: 'request', collectionId: 'c', requestId: 'r1' }));
    const collection = marks.get(gitRefKey({ kind: 'collection', collectionId: 'c' }));
    expect(collection?.count).toBe(2);
    const second = refreshGit();
    answer({ ...status({ branch: 'dev' }), changes: [change('r1'), change('r2'), change('r3', 'added')] });
    await second;
    const next = gitSnapshot().marks;
    expect(next).not.toBe(marks);
    expect(next.get(gitRefKey({ kind: 'request', collectionId: 'c', requestId: 'r1' }))).toBe(r1);
    // the collection's count went from 2 to 3: a new mark
    expect(next.get(gitRefKey({ kind: 'collection', collectionId: 'c' }))?.count).toBe(3);
    expect(gitSnapshot().status?.branch).toBe('dev');
  });

  it('reuses the marks map itself when only the rest of the state changed', async () => {
    const first = refreshGit();
    answer({ ...status(), changes: [change('r1')] });
    await first;
    const marks = gitSnapshot().marks;
    const second = refreshGit();
    answer({ ...status({ ahead: 2 }), changes: [change('r1')] });
    await second;
    expect(gitSnapshot().status?.ahead).toBe(2);
    expect(gitSnapshot().marks).toBe(marks);
  });

  it('runs one read at a time: requests that come meanwhile make one more run, not several', async () => {
    const all = [refreshGit(), refreshGit(), refreshGit(), refreshGit(), refreshGit()];
    await tick();
    expect(vi.mocked(call)).toHaveBeenCalledTimes(1);
    answer({ ...status({ branch: 'old' }), changes: [] });
    await tick();
    // the trailing run, for the four requests that came during the first
    expect(vi.mocked(call)).toHaveBeenCalledTimes(2);
    answer({ ...status({ branch: 'new' }), changes: [] });
    await Promise.all(all);
    expect(vi.mocked(call)).toHaveBeenCalledTimes(2);
    // the newer answer is the one that stays
    expect(gitSnapshot().status?.branch).toBe('new');
  });

  it('a failed read empties the state once, and a second failure changes nothing', async () => {
    const first = refreshGit();
    answer({ ...status(), changes: [change('r1')] });
    await first;
    const failing = refreshGit();
    calls.shift()!.resolve(Promise.reject(new Error('git is gone')));
    await failing;
    const empty = gitSnapshot();
    expect(empty.status).toBeUndefined();
    const again = refreshGit();
    calls.shift()!.resolve(Promise.reject(new Error('git is gone')));
    await again;
    expect(gitSnapshot()).toBe(empty);
  });
});
