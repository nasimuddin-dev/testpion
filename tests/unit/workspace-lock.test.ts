import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireWorkspaceLock, lockFileOf, lockHolder, lockMessage } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';

// C-4: a second TestPion on the same workspace is told (review 2026-10-27, robustness).
const tmp = tempDir('tp-lock-');
afterAll(() => tmp.cleanup());
const app = join(tmp.dir, 'app');
const ws = (n: string) => {
  const d = join(tmp.dir, n);
  mkdirSync(d, { recursive: true });
  return d;
};
const foreign = (workspace: string, pid: number, ageMs = 0) => {
  const f = lockFileOf(app, workspace);
  mkdirSync(join(app, 'locks'), { recursive: true });
  writeFileSync(f, JSON.stringify({ pid, by: 'app', since: '2026-10-28T09:00:00Z', workspace }));
  const t = new Date(Date.now() - ageMs);
  utimesSync(f, t, t);
};

describe('workspace lock', () => {
  it('takes the lock, shows it to others, and release removes it', () => {
    const w = ws('a');
    const mine = acquireWorkspaceLock(app, w, 'app');
    expect(mine.heldBy).toBeUndefined();
    expect(JSON.parse(readFileSync(lockFileOf(app, w), 'utf8')).pid).toBe(process.pid);
    expect(lockHolder(app, w)).toBeUndefined(); // this process is not "another"
    mine.release();
    expect(existsSync(lockFileOf(app, w))).toBe(false);
  });

  it('a live holder is reported and not displaced; a dead pid or a stale heartbeat is taken over', () => {
    const w = ws('b');
    foreign(w, 4242);
    const alive = (pid: number) => pid === 4242;
    const second = acquireWorkspaceLock(app, w, 'cli', { isAlive: alive });
    expect(second.heldBy).toMatchObject({ pid: 4242, by: 'app' });
    expect(JSON.parse(readFileSync(lockFileOf(app, w), 'utf8')).pid).toBe(4242); // untouched
    second.release();
    expect(existsSync(lockFileOf(app, w))).toBe(true); // not ours: release leaves it

    const dead = acquireWorkspaceLock(app, w, 'cli', { isAlive: () => false }); // dead pid
    expect(dead.heldBy).toBeUndefined();
    dead.release();
    foreign(w, 4242, 5 * 60_000);
    const taken = acquireWorkspaceLock(app, w, 'app', { isAlive: alive }); // alive pid but no heartbeat for 5 minutes
    expect(taken.heldBy).toBeUndefined();
    taken.release();
  });

  it('the same folder through a different spelling is the same lock; two folders are two locks', () => {
    const w = ws('c');
    expect(lockFileOf(app, w)).toBe(lockFileOf(app, join(w, '..', 'c')));
    expect(lockFileOf(app, w)).not.toBe(lockFileOf(app, ws('d')));
  });

  it('says in plain words who has it', () => {
    expect(lockMessage({ pid: 7, by: 'app', since: '2026-10-28T09:01:02Z', workspace: 'w' })).toMatch(/Another TestPion window.*process 7.*Close it first/);
  });
});
