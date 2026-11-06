import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { isDue, listMonitors, monitorScheduleText, monitorStatus, quietProblem, quietText, quietUntil, saveMonitor, WorkspaceStore, type Monitor } from '../../packages/core/src/index.js';
import { runCliSync, tempDir } from '../helpers.js';

// A maintenance window that comes back (every Sunday 02:00 for two hours): no scheduled run starts inside it, so a
// planned outage pages nobody; Run now still works.
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const tmp = tempDir('tp-monitor-quiet-');
afterAll(() => tmp.cleanup());

describe('maintenance windows', () => {
  const sunday = { cron: '0 2 * * 0', minutes: 120, reason: 'deploy' };

  it('knows whether now is inside one, and until when', () => {
    // Sunday 2026-11-08
    expect(quietUntil(sunday, at(2026, 11, 8, 1, 59))).toBeUndefined();
    expect(quietUntil(sunday, at(2026, 11, 8, 2, 0))).toBe(at(2026, 11, 8, 4, 0));
    expect(quietUntil(sunday, at(2026, 11, 8, 3, 30))).toBe(at(2026, 11, 8, 4, 0));
    expect(quietUntil(sunday, at(2026, 11, 8, 4, 0))).toBeUndefined();
    expect(quietUntil(sunday, at(2026, 11, 9, 2, 30))).toBeUndefined(); // a Monday
    expect(quietUntil(undefined, at(2026, 11, 8, 2, 30))).toBeUndefined();
    expect(quietText(sunday)).toBe('quiet at 02:00 on Sunday for 2 hours (deploy)');
  });

  it('says what is wrong with one', () => {
    expect(quietProblem({ cron: '0 2 * *', minutes: 60 })).toMatch(/5 parts/);
    expect(quietProblem({ cron: '0 2 * * 0', minutes: 0 })).toMatch(/1 minute to 24 hours/);
    expect(quietProblem({ cron: '0 2 * * 0', minutes: 2000 })).toMatch(/1 minute to 24 hours/);
    expect(quietProblem(sunday)).toBeUndefined();
  });

  it('a monitor is not due inside its window, and says so', () => {
    const m = { id: 'm', name: 'Checkout', collectionId: 'c', everyMinutes: 15, enabled: true, quiet: sunday } as Monitor;
    expect(isDue(m, undefined, at(2026, 11, 8, 2, 30))).toBe(false);
    expect(isDue(m, undefined, at(2026, 11, 8, 4, 1))).toBe(true);
    expect(monitorScheduleText(m)).toBe('every 15 minutes · quiet at 02:00 on Sunday for 2 hours (deploy)');
  });

  it('is saved, checked and kept by `testpion monitor add`; --no-maintenance removes it', () => {
    const root = join(tmp.dir, 'ws');
    const s = WorkspaceStore.create(root, 'Quiet');
    s.writeTestFile('smoke.yaml', 'tests:\n  - { id: a, name: A, url: "http://127.0.0.1:9/a" }\n');
    expect(() => saveMonitor(s, { name: 'Bad', testFile: 'smoke.yaml', everyMinutes: 15, enabled: true, quiet: { cron: 'nope', minutes: 10 } } as never)).toThrow(/maintenance window "nope"/);
    s.close();
    const cli = (args: string[]) => runCliSync([...args, '-w', root, '--json', '--non-interactive'], { home: join(tmp.dir, 'home'), cwd: tmp.dir, env: { CI: '1' } });
    const added = cli(['monitor', 'add', 'Night', '--test-file', 'smoke.yaml', '--every', '15m', '--maintenance', '0 2 * * 0', '--maintenance-for', '2h', '--maintenance-reason', 'deploy']);
    expect(added.status, added.out + added.err).toBe(0);
    const again = cli(['monitor', 'add', 'Night', '--test-file', 'smoke.yaml', '--every', '30m']);
    expect(again.status, again.out + again.err).toBe(0);
    const store = WorkspaceStore.open(root);
    try {
      const m = listMonitors(store).find((x) => x.name === 'Night')!;
      expect(m.quiet).toEqual(sunday); // kept by a change that does not name it
      expect(monitorStatus(store, m, at(2026, 11, 8, 3, 0)).schedule).toMatch(/^in its maintenance window until .* \(deploy\)$/);
    } finally {
      store.close();
    }
    const removed = cli(['monitor', 'add', 'Night', '--test-file', 'smoke.yaml', '--every', '30m', '--no-maintenance']);
    expect(removed.status, removed.out + removed.err).toBe(0);
    const after = WorkspaceStore.open(root);
    try {
      expect(listMonitors(after).find((x) => x.name === 'Night')!.quiet).toBeUndefined();
    } finally {
      after.close();
    }
  });
});

describe('a window that comes back often (what the review found)', () => {
  it('every minute for a day is one long quiet time, and asking about it is quick', async () => {
    const { nextRunAt, parseSchedule } = await import('../../packages/core/src/index.js');
    const q = { cron: '* * * * *', minutes: 1440 };
    const t0 = performance.now();
    expect(quietUntil(q, at(2026, 11, 8, 12, 0))).toBeGreaterThan(at(2026, 11, 9, 11, 0));
    const m = { id: 'm', name: 'Busy', collectionId: 'c', ...parseSchedule('*/5 * * * *'), quiet: q, enabled: true } as Monitor;
    nextRunAt(m, { startedAt: new Date(at(2026, 11, 8, 11, 55)).toISOString() } as never, at(2026, 11, 8, 12, 0));
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});
