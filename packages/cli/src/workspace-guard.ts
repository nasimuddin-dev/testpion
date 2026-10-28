import { WorkspaceManager, acquireWorkspaceLock, lockMessage } from '@testpion/core';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CliError, EXIT, findWorkspaceUp } from './shared.js';

/**
 * A command that writes refuses when a TestPion window (or another command) has the same workspace open, unless `--force` or
 * `--yes` says "I know" (the app's lock, core storage/workspace-lock.ts). Two writers on one folder can lose edits, so it is told
 * before anything changed, with exit code 2 and a way out. A workspace the command does not name and cannot find (an ephemeral one) has no lock.
 */
export function refuseWhenOpenElsewhere(o: { workspace?: unknown; force?: unknown; yes?: unknown; dryRun?: unknown }, mgr: WorkspaceManager = new WorkspaceManager()): void {
  if (o.force === true || o.yes === true || o.dryRun === true || process.env.TESTPION_IGNORE_WORKSPACE_LOCK === '1') return;
  const ref = typeof o.workspace === 'string' ? o.workspace : undefined;
  const dir = ref ? (mgr.resolve(ref) ?? (existsSync(join(resolve(ref), 'workspace.json')) ? resolve(ref) : undefined)) : findWorkspaceUp(process.cwd());
  if (!dir) return;
  const lock = acquireWorkspaceLock(mgr.appDir, dir, 'cli');
  lock.release(); // only asking: the command's own run does not hold the lock
  if (lock.heldBy) throw Object.assign(new CliError(lockMessage(lock.heldBy), EXIT.CONFIG_ERROR), { hint: 'Run it again with --force to change the workspace anyway, or close the other TestPion first.' });
}
