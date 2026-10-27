import * as cp from 'node:child_process';
import { assertProcessesAllowed } from './process-policy.js';

/**
 * The one place the engine starts programs on the computer it runs on (git, secret-manager CLIs, browsers, `netstat`, `icacls`,
 * `certutil` …). Every call names what it is for and passes through the process policy first, so
 * `TESTPION_ALLOW_PROCESSES=0` (the setting of a shared server) refuses all of them, not only MCP stdio servers. A test
 * (architecture.test.ts) fails when any other module of the engine imports `child_process`.
 */

type ExecOptions = cp.ExecFileOptions & { encoding?: string | null };

/** `execFile` after the process policy; `what` says why ("git", "secret manager op", "browser launch") for the refusal. */
export function execFileChecked(what: string, file: string, args: readonly string[], options: ExecOptions, callback: (error: cp.ExecFileException | null, stdout: any, stderr: any) => void): cp.ChildProcess {
  assertProcessesAllowed(what);
  return cp.execFile(file, args, options as never, callback as never);
}

/** `execFileSync` after the process policy. */
export function execFileSyncChecked(what: string, file: string, args: readonly string[], options: cp.ExecFileSyncOptions = {}): any {
  assertProcessesAllowed(what);
  return cp.execFileSync(file, args, options);
}

/** `spawn` after the process policy. */
export function spawnChecked(what: string, command: string, args: readonly string[], options: cp.SpawnOptions = {}): cp.ChildProcess {
  assertProcessesAllowed(what);
  return cp.spawn(command, args, options);
}

/** `spawnSync` after the process policy. */
export function spawnSyncChecked(what: string, command: string, args: readonly string[], options: cp.SpawnSyncOptions = {}): cp.SpawnSyncReturns<any> {
  assertProcessesAllowed(what);
  return cp.spawnSync(command, args, options);
}
