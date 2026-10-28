import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceManager, WorkspaceStore, lockFileOf } from '../../packages/core/src/index.js';
import { refuseWhenOpenElsewhere } from '../../packages/cli/src/workspace-guard.js';
import { tempDir } from '../helpers.js';

// C-4: a CLI command that writes refuses while another TestPion has the workspace open, unless --force / --yes (review 2026-10-27).
const tmp = tempDir('tp-guard-');
afterAll(() => tmp.cleanup());

function setup() {
  const app = join(tmp.dir, `app${Math.random().toString(16).slice(2)}`);
  const mgr = new WorkspaceManager(app);
  const dir = join(tmp.dir, `w${Math.random().toString(16).slice(2)}`);
  WorkspaceStore.create(dir, 'W').close();
  // the parent process is alive and is not this one: a stand-in for the window
  mkdirSync(join(app, 'locks'), { recursive: true });
  writeFileSync(lockFileOf(app, dir), JSON.stringify({ pid: process.ppid, by: 'app', since: '2026-10-28T09:00:00Z', workspace: dir }));
  return { mgr, dir };
}

describe('refuseWhenOpenElsewhere', () => {
  it('refuses with a plain-words message and a way out; --force, --yes and --dry-run go through', () => {
    const { mgr, dir } = setup();
    expect(() => refuseWhenOpenElsewhere({ workspace: dir }, mgr)).toThrow(/Another TestPion window.*has this workspace open/);
    try {
      refuseWhenOpenElsewhere({ workspace: dir }, mgr);
    } catch (e) {
      expect((e as { hint?: string }).hint).toMatch(/--force/);
      expect((e as { exitCode?: number }).exitCode).toBe(2);
    }
    expect(() => refuseWhenOpenElsewhere({ workspace: dir, force: true }, mgr)).not.toThrow();
    expect(() => refuseWhenOpenElsewhere({ workspace: dir, yes: true }, mgr)).not.toThrow();
    expect(() => refuseWhenOpenElsewhere({ workspace: dir, dryRun: true }, mgr)).not.toThrow();
  });

  it('a workspace nobody holds, or one that cannot be found, is not refused', () => {
    const { mgr } = setup();
    const other = join(tmp.dir, 'free');
    WorkspaceStore.create(other, 'Free').close();
    expect(() => refuseWhenOpenElsewhere({ workspace: other }, mgr)).not.toThrow();
    expect(() => refuseWhenOpenElsewhere({ workspace: join(tmp.dir, 'nowhere') }, mgr)).not.toThrow(); // openWorkspace reports that one
  });
});

describe('the app holds the workspace it has open', () => {
  it('a second TestPion on the same workspace is told in plain words (workspace.problem, and lockedBy in ws.current)', async () => {
    const { Backend } = await import('../../apps/desktop/backend/backend.js');
    const dir = join(tmp.dir, `app-${Math.random().toString(16).slice(2)}`);
    const events: Array<{ channel: string; payload: unknown }> = [];
    const be = new Backend({ appDir: dir, emit: (channel, payload) => events.push({ channel, payload }), noMonitors: true });
    try {
      const root = be.store!.root;
      expect((await be.invoke('ws.current', {})) as { lockedBy?: string }).toMatchObject({ lockedBy: undefined });
      // another process takes over the lock (a live pid that is not this one), then this window opens the workspace again
      writeFileSync(lockFileOf(dir, root), JSON.stringify({ pid: process.ppid, by: 'app', since: '2026-10-28T09:00:00Z', workspace: root }));
      be.openStore(root);
      const cur = (await be.invoke('ws.current', {})) as { lockedBy?: string };
      expect(cur.lockedBy).toMatch(/Another TestPion window.*has this workspace open/);
      await new Promise((r) => setTimeout(r, 50));
      expect(events.some((e) => e.channel === 'workspace.problem' && (e.payload as { kind?: string }).kind === 'locked')).toBe(true);
    } finally {
      await be.dispose();
    }
  });
});
