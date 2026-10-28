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

/** What `killProcessTree` uses (replaced in tests). */
export interface TreeKillDeps {
  platform?: NodeJS.Platform;
  /** Runs `taskkill` (Windows). */
  taskkill?: (args: string[]) => void;
  /** `process.kill`. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

/**
 * End a program and everything it started. Killing only the program leaves its children running: on Windows `cmd.exe /c npx …` or a
 * `shell: true` command is a shell whose child is the real work, and a timeout that ends the shell leaves that work behind, once per
 * reconnect. Windows: `taskkill /PID <pid> /T /F` (while the parent is alive, so the tree can still be walked). POSIX: the process
 * group (negative pid) when the program leads one, else the program alone.
 */
export function killProcessTree(pid: number | null | undefined, deps: TreeKillDeps = {}): void {
  if (!pid || pid <= 0) return;
  const platform = deps.platform ?? process.platform;
  try {
    if (platform === 'win32') {
      (deps.taskkill ?? ((args) => void execFileChecked('process tree kill', 'taskkill', args, { windowsHide: true }, () => undefined)))(['/PID', String(pid), '/T', '/F']);
      return;
    }
    const kill = deps.kill ?? ((p, sig) => void process.kill(p, sig));
    try {
      kill(-pid, 'SIGKILL');
    } catch {
      kill(pid, 'SIGKILL'); // not the leader of a group
    }
  } catch {
    /* already gone */
  }
}
