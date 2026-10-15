/**
 * The bottom panel's Terminal: real shells in pseudo-terminals, owned by the backend (the window only draws them).
 *
 * The pty itself comes from the host (`BackendHost.terminal`): the desktop app passes node-pty, loaded when the first
 * terminal opens. A host without it (the browser bridge, a cloud server) has no shells at all: `terminal.create`
 * refuses, so a server can never spawn one, whatever a client asks.
 *
 * Output is batched (one `terminal.data` event per session every 16 ms, or sooner at 64 KB) and the last 1 MB of each
 * session is kept, so a window that reloads gets its terminals back as they were.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { ApsError } from '@testpion/core';

/** The part of a node-pty process the manager uses (tests pass a fake). */
export interface PtyProcess {
  readonly pid: number;
  onData(cb: (data: string) => void): unknown;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  /** Stop / start reading the shell's output (flow control: a shell that writes faster than the window draws waits). */
  pause?(): void;
  resume?(): void;
}

export interface PtySpawnOptions {
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

/** What a host that can run shells provides (the desktop app: node-pty). */
export interface TerminalHost {
  spawn(file: string, args: string[], opts: PtySpawnOptions): PtyProcess;
}

export interface ShellInfo {
  id: string;
  label: string;
  path: string;
  args: string[];
}

export interface TerminalSession {
  id: string;
  shell: string;
  label: string;
  pid: number;
  cwd: string;
  /** Set once the shell has exited (the session stays listed, with its output, until it is closed). */
  exitCode?: number;
  /** Flow control: the shell's output waits until the window draws what it has (`undrawn` characters). */
  paused?: boolean;
  undrawn?: number;
  /** Characters of output sent to the window so far (what terminal.ack counts against). */
  sent?: number;
  /** The window stopped drawing (hidden, reloading, gone): the shell runs on and only its last 1 MB is kept for it. */
  detached?: boolean;
}

export const MAX_SESSIONS = 8;
export const FLUSH_MS = 16;
export const FLUSH_BYTES = 64 * 1024;
export const SCROLLBACK_BYTES = 1024 * 1024;
/** One write from the window (a paste) can't be larger than this. */
export const MAX_WRITE = 1024 * 1024;
/**
 * Flow control: output sent to the window and not yet drawn (acknowledged with terminal.ack). Above HIGH the shell's
 * output stops being read, so the shell itself waits (a `cat` of 50 MB goes at the speed the window draws, and neither
 * process buffers more than this); below LOW it is read again.
 */
export const FLOW_HIGH = 512 * 1024;
export const FLOW_LOW = 128 * 1024;
/**
 * A paused shell whose window acknowledges nothing for this long (the window is hidden and its timers throttled, it is
 * reloading, its renderer died) is not left waiting: the session detaches, the shell is read again at full speed and
 * only the last 1 MB is kept, and the window gets that (terminal.replay) as soon as it acknowledges again. So no state
 * of the window can stop a shell, and memory stays bounded either way.
 */
export const STALL_MS = 5000;

interface Session extends TerminalSession {
  pty?: PtyProcess;
  pending: string;
  /** Characters sent to the window in all, and how many of them it said it drew (absolute counts: a lost or late ack is harmless). */
  sent: number;
  acked: number;
  paused: boolean;
  detached: boolean;
  /** Replays sent: the window counts what it draws within the latest one only. */
  epoch: number;
  timer?: ReturnType<typeof setTimeout>;
  stallTimer?: ReturnType<typeof setTimeout>;
  scrollback: string[];
  scrollbackBytes: number;
}

export interface TerminalManagerOptions {
  host?: TerminalHost;
  emit(channel: string, payload: unknown): void;
  /** The open workspace's folder (the default working directory), if any. */
  workspaceRoot(): string | undefined;
  /** Where the `testpion` command for the shells is written. */
  binDir: string;
  /** How to start this app's command line: `<command> <args> --cli …` (from `BackendHost.mcpCommand`). */
  cli?: { command: string; args: string[] };
  /** The shells of this machine (detected once; tests pass their own). */
  shells?: () => ShellInfo[];
  /** The environment the shells start from (default: this process's). */
  baseEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/** Variables of this process that must not reach the user's shell: they would change what the app does when started from it. */
const PRIVATE_ENV = /^(TESTPION_CAPTURE_SCRIPT|ELECTRON_RUN_AS_NODE|ELECTRON_NO_ATTACH_CONSOLE|VITE_DEV_SERVER_URL|E2E_[A-Z_]+|NODE_OPTIONS)$/;

const clampInt = (v: unknown, min: number, max: number, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback);

export class TerminalManager {
  private sessions = new Map<string, Session>();
  private seq = 0;
  private shellList?: ShellInfo[];
  private shimWritten?: string;

  constructor(private o: TerminalManagerOptions) {}

  /** Whether this host can run shells at all (the window's capability flag). */
  get available(): boolean {
    return !!this.o.host;
  }

  shells(): ShellInfo[] {
    if (!this.available) return [];
    return (this.shellList ??= (this.o.shells ?? (() => detectShells(this.o.platform ?? process.platform, this.o.baseEnv ?? process.env)))());
  }

  list(withOutput = false): Array<TerminalSession & { output?: string; epoch?: number }> {
    return [...this.sessions.values()].map((s) => {
      if (!withOutput) return this.view(s);
      // a window reading the output afresh (it reloaded) has all of it: it counts from here, nothing waits for it
      this.flush(s);
      s.epoch++;
      s.acked = s.sent;
      s.detached = false;
      this.unpause(s);
      return { ...this.view(s), output: s.scrollback.join(''), epoch: s.epoch };
    });
  }

  create(p: { shell?: string; cols?: number; rows?: number; cwd?: string } = {}): TerminalSession {
    const host = this.o.host;
    if (!host)
      throw new ApsError('ConfigurationError', 'The terminal is only available in the TestPion desktop app', {
        suggestions: ['Run testpion commands from your own terminal (npm install -g testpion).'],
      });
    const shells = this.shells();
    const shell = p.shell ? shells.find((s) => s.id === p.shell) : shells[0];
    if (!shell) throw new ApsError('ValidationError', p.shell ? `Unknown shell ${String(p.shell).slice(0, 40)}` : 'No shell was found on this computer');
    const cwd = this.cwdFor(p.cwd);
    if (this.sessions.size >= MAX_SESSIONS) {
      // closed shells make room first (oldest first); running ones never go without the user asking
      const exited = [...this.sessions.values()].find((s) => s.exitCode !== undefined);
      if (!exited) throw new ApsError('ValidationError', `At most ${MAX_SESSIONS} terminals can be open`, { suggestions: ['Close a terminal first.'] });
      this.sessions.delete(exited.id);
    }
    const cols = clampInt(p.cols, 2, 1000, 80);
    const rows = clampInt(p.rows, 1, 500, 24);
    let pty: PtyProcess;
    try {
      pty = host.spawn(shell.path, shell.args, { cols, rows, cwd, env: this.env() });
    } catch (e) {
      throw new ApsError('ConfigurationError', `Could not start ${shell.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const id = `t${++this.seq}`;
    const s: Session = {
      id,
      shell: shell.id,
      label: shell.label,
      pid: pty.pid,
      cwd,
      pty,
      pending: '',
      sent: 0,
      acked: 0,
      paused: false,
      detached: false,
      epoch: 0,
      scrollback: [],
      scrollbackBytes: 0,
    };
    this.sessions.set(id, s);
    pty.onData((d) => this.data(s, d));
    pty.onExit(({ exitCode }) => {
      if (s.exitCode !== undefined || !s.pty) return; // reported twice (node-pty's error and close), or killed
      this.flush(s);
      s.pty = undefined;
      s.exitCode = exitCode;
      if (this.sessions.get(id) === s) this.o.emit('terminal.exit', { id, code: exitCode });
    });
    return this.view(s);
  }

  write(id: string, data: string): boolean {
    const s = this.get(id);
    if (typeof data !== 'string' || data.length > MAX_WRITE) throw new ApsError('ValidationError', 'terminal.write: data must be a string of at most 1 MB');
    if (!s.pty) return false;
    try {
      s.pty.write(data);
    } catch {
      return false; // exited between the check and the write
    }
    return true;
  }

  resize(id: string, cols: number, rows: number): boolean {
    const s = this.get(id);
    if (!s.pty) return false;
    try {
      s.pty.resize(clampInt(cols, 2, 1000, 80), clampInt(rows, 1, 500, 24));
    } catch {
      return false; // exited between the check and the call
    }
    return true;
  }

  /**
   * The window drew the output up to `parsed` characters (counted from the start, within replay `epoch`). An ack that is
   * lost, late or repeated changes nothing the next one doesn't put right. When the window has caught up the shell's
   * output is read again; a detached session's window gets the kept output back (terminal.replay).
   */
  ack(id: string, parsed: number, epoch = 0): { paused: boolean; detached: boolean } {
    const s = this.get(id);
    if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed < 0) throw new ApsError('ValidationError', 'terminal.ack: parsed must be a number of characters');
    // an ack from before the latest replay counts what the window has since thrown away
    if (epoch !== s.epoch) return { paused: s.paused, detached: s.detached };
    if (s.detached) {
      // the window draws again: it gets what was kept, and counts from there
      this.replay(s);
      return { paused: false, detached: false };
    }
    if (parsed > s.acked) {
      s.acked = Math.min(parsed, s.sent);
      if (s.paused) {
        if (s.sent - s.acked < FLOW_LOW) this.unpause(s);
        else this.watchStall(s); // progress: the window is drawing, give it time
      }
    }
    return { paused: s.paused, detached: false };
  }

  /** Read the shell's output again. */
  private unpause(s: Session): void {
    if (s.stallTimer) clearTimeout(s.stallTimer);
    s.stallTimer = undefined;
    if (!s.paused) return;
    s.paused = false;
    try {
      s.pty?.resume?.();
    } catch {
      /* exited meanwhile */
    }
  }

  /** (Re)start the watchdog of a paused session: no ack progress for STALL_MS detaches it. */
  private watchStall(s: Session): void {
    if (s.stallTimer) clearTimeout(s.stallTimer);
    s.stallTimer = setTimeout(() => {
      s.stallTimer = undefined;
      if (!s.paused || this.sessions.get(s.id) !== s) return;
      s.detached = true;
      this.unpause(s);
      // the window acknowledges as soon as it draws again, and then gets the kept output (ack → replay)
      this.o.emit('terminal.detached', { id: s.id });
    }, STALL_MS);
    (s.stallTimer as { unref?(): void }).unref?.();
  }

  /** Send the window the kept output in place of what it has (after it was detached), and count from there. */
  private replay(s: Session): void {
    this.flush(s);
    s.detached = false;
    s.epoch++;
    s.acked = s.sent;
    this.o.emit('terminal.replay', { id: s.id, output: s.scrollback.join(''), sent: s.sent, epoch: s.epoch });
  }

  /** End a session (its shell and everything it started) and forget it. */
  kill(id: string): boolean {
    const s = this.get(id);
    this.end(s);
    return true;
  }

  /** End every session (a workspace switch, the app quitting). The window is told which ones went. */
  dispose(reason = 'closed'): void {
    const ids = [...this.sessions.keys()];
    for (const s of [...this.sessions.values()]) this.end(s);
    if (ids.length) this.o.emit('terminal.closed', { ids, reason });
  }

  private end(s: Session): void {
    this.sessions.delete(s.id);
    if (s.timer) clearTimeout(s.timer);
    if (s.stallTimer) clearTimeout(s.stallTimer);
    s.timer = s.stallTimer = undefined;
    s.pending = '';
    const pty = s.pty;
    s.pty = undefined;
    try {
      pty?.kill();
    } catch {
      /* already gone */
    }
  }

  private get(id: string): Session {
    const s = typeof id === 'string' ? this.sessions.get(id) : undefined;
    if (!s) throw new ApsError('ValidationError', `No terminal ${String(id).slice(0, 40)}`);
    return s;
  }

  private view(s: Session): TerminalSession {
    return {
      id: s.id,
      shell: s.shell,
      label: s.label,
      pid: s.pid,
      cwd: s.cwd,
      ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
      ...(s.paused ? { paused: true } : {}),
      ...(s.detached ? { detached: true } : {}),
      ...(s.sent > s.acked ? { undrawn: s.sent - s.acked } : {}),
      sent: s.sent,
    };
  }

  private data(s: Session, d: string): void {
    if (this.sessions.get(s.id) !== s) return;
    s.pending += d;
    if (s.pending.length >= FLUSH_BYTES) this.flush(s);
    else s.timer ??= setTimeout(() => this.flush(s), FLUSH_MS);
  }

  private flush(s: Session): void {
    if (s.timer) clearTimeout(s.timer);
    s.timer = undefined;
    if (!s.pending) return;
    const data = s.pending;
    s.pending = '';
    s.scrollback.push(data);
    s.scrollbackBytes += data.length;
    while (s.scrollbackBytes > SCROLLBACK_BYTES && s.scrollback.length > 1) s.scrollbackBytes -= s.scrollback.shift()!.length;
    if (s.scrollbackBytes > SCROLLBACK_BYTES) {
      const only = s.scrollback[0]!.slice(-SCROLLBACK_BYTES);
      s.scrollback = [only];
      s.scrollbackBytes = only.length;
    }
    // detached: nobody draws it; it is kept (bounded) for the window to get back
    if (s.detached) return;
    s.sent += data.length;
    this.o.emit('terminal.data', { id: s.id, data, epoch: s.epoch });
    if (!s.paused && s.sent - s.acked > FLOW_HIGH && s.pty?.pause) {
      s.paused = true;
      s.pty.pause();
      this.watchStall(s);
    }
  }

  private cwdFor(cwd?: string): string {
    if (cwd !== undefined) {
      if (typeof cwd !== 'string' || !isAbsolute(cwd) || !isDir(cwd)) throw new ApsError('ValidationError', 'terminal.create: cwd must be an existing folder (an absolute path)');
      return cwd;
    }
    const root = this.o.workspaceRoot();
    if (root && isDir(root)) return root;
    const home = (this.o.baseEnv ?? process.env)[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'];
    return home && isDir(home) ? home : process.cwd();
  }

  /** The user's environment, the `testpion` command first on the PATH, and the open workspace. */
  env(): Record<string, string> {
    const base = this.o.baseEnv ?? process.env;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(base)) if (v !== undefined && !PRIVATE_ENV.test(k)) env[k] = v;
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    const bin = this.writeShim();
    if (bin) env[pathKey] = env[pathKey] ? `${bin}${delimiter}${env[pathKey]}` : bin;
    const root = this.o.workspaceRoot();
    if (root) env.TESTPION_WORKSPACE = root;
    else delete env.TESTPION_WORKSPACE;
    env.TERM_PROGRAM = 'TestPion';
    // Git Bash's login profile stays in the folder it starts in (not $HOME)
    env.CHERE_INVOKING = '1';
    env.COLORTERM = 'truecolor';
    if ((this.o.platform ?? process.platform) !== 'win32') env.TERM = 'xterm-256color';
    return env;
  }

  /**
   * `testpion` in the shells runs this app's own command line (`TestPion --cli …`): nothing to install, and always the
   * version of the app. Written when a terminal opens (only when it changed); undefined when this host has no CLI.
   */
  writeShim(): string | undefined {
    const cli = this.o.cli;
    if (!cli) return undefined;
    const win = (this.o.platform ?? process.platform) === 'win32';
    const dir = this.o.binDir;
    const files = shimFiles(cli, win);
    const key = JSON.stringify(files);
    if (this.shimWritten === key) return dir;
    try {
      mkdirSync(dir, { recursive: true });
      for (const [name, text] of Object.entries(files)) {
        const path = join(dir, name);
        if (!existsSync(path) || readFileSync(path, 'utf8') !== text) writeFileSync(path, text, { mode: 0o755 });
      }
      this.shimWritten = key;
      return dir;
    } catch {
      return undefined;
    }
  }
}

/** The `testpion` command files: a .cmd for PowerShell and cmd, a shell script for Git Bash, macOS and Linux. */
export function shimFiles(cli: { command: string; args: string[] }, win: boolean): Record<string, string> {
  const sh = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`;
  const shLine = `#!/bin/sh\n# TestPion's command line (the app itself, --cli). Written by the app's Terminal.\nexec ${[cli.command, ...cli.args].map((a) => sh(win ? a.replace(/\\/g, '/') : a)).join(' ')} --cli "$@"\n`;
  if (!win) return { testpion: shLine };
  const cmdArg = (a: string) => `"${a.replace(/"/g, '""')}"`;
  return { 'testpion.cmd': `@${[cli.command, ...cli.args].map(cmdArg).join(' ')} --cli %*\r\n`, testpion: shLine };
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const isFile = (p: string | undefined): p is string => {
  try {
    return !!p && statSync(p).isFile();
  } catch {
    return false;
  }
};

/** The first file of that name on the PATH. */
function onPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const path = env.PATH ?? env.Path ?? '';
  for (const dir of path.split(delimiter)) if (dir && isFile(join(dir, name))) return join(dir, name);
  return undefined;
}

/** The shells of this machine, the default first: Windows PowerShell on Windows, the login shell elsewhere. */
export function detectShells(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): ShellInfo[] {
  const out: ShellInfo[] = [];
  const add = (id: string, label: string, path: string | undefined, args: string[] = []) => {
    if (isFile(path) && !out.some((s) => s.id === id || s.path.toLowerCase() === path.toLowerCase())) out.push({ id, label, path, args });
  };
  if (platform === 'win32') {
    const root = env.SystemRoot ?? env.windir ?? 'C:\\Windows';
    add('powershell', 'PowerShell', join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo']);
    add('pwsh', 'PowerShell 7', onPath('pwsh.exe', env) ?? join(env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'), ['-NoLogo']);
    add('cmd', 'Command Prompt', env.ComSpec ?? join(root, 'System32', 'cmd.exe'));
    // Git Bash: next to git.exe (…\Git\cmd\git.exe → …\Git\bin\bash.exe), or where Git for Windows installs
    const git = onPath('git.exe', env);
    const gitRoots = [git && dirname(dirname(git)), join(env.ProgramFiles ?? 'C:\\Program Files', 'Git'), env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'Git')];
    for (const g of gitRoots) if (g) add('gitbash', 'Git Bash', join(g, 'bin', 'bash.exe'), ['--login', '-i']);
    return out;
  }
  const login = env.SHELL;
  if (login) add(login.split('/').pop() || 'shell', login.split('/').pop() || 'Shell', login, ['-l']);
  for (const p of ['/bin/zsh', '/bin/bash', '/usr/bin/fish', '/opt/homebrew/bin/fish', '/bin/sh']) add(p.split('/').pop()!, p.split('/').pop()!, p, p.endsWith('/sh') ? [] : ['-l']);
  return out;
}
