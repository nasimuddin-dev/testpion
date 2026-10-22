import { describe, it, expect, afterAll, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { FLOW_HIGH, FLOW_LOW, FLUSH_BYTES, MAX_SESSIONS, SCROLLBACK_BYTES, shimFiles, TerminalManager, type PtyProcess, type PtySpawnOptions } from '../../apps/desktop/backend/terminal.js';
import { checkRpcParams } from '../../apps/desktop/backend/rpc-params.js';
import { Backend } from '../../apps/desktop/backend/backend.js';

// The Terminal panel's session manager (apps/desktop/backend/terminal.ts) with a fake pty: what the window sees of
// a shell (batched output, exit, the cap, kill-all), and the capability gate of hosts without shells.
class FakePty implements PtyProcess {
  static all: FakePty[] = [];
  pid = 1000 + FakePty.all.length;
  written: string[] = [];
  size: [number, number];
  killed = false;
  paused = false;
  private dataCb?: (d: string) => void;
  private exitCb?: (e: { exitCode: number }) => void;
  constructor(
    public file: string,
    public args: string[],
    public opts: PtySpawnOptions,
  ) {
    this.size = [opts.cols, opts.rows];
    FakePty.all.push(this);
  }
  onData(cb: (d: string) => void) {
    this.dataCb = cb;
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitCb = cb;
  }
  write(d: string) {
    this.written.push(d);
  }
  resize(c: number, r: number) {
    this.size = [c, r];
  }
  kill() {
    this.killed = true;
  }
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }
  emit(d: string) {
    this.dataCb?.(d);
  }
  exit(code: number) {
    this.exitCb?.({ exitCode: code });
  }
}

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'tp-term-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

function manager(o: { root?: string; host?: boolean; cli?: boolean } = {}) {
  const events: Array<[string, any]> = [];
  const root = o.root ?? tmp();
  const bin = join(tmp(), 'terminal-bin');
  const m = new TerminalManager({
    host: o.host === false ? undefined : { spawn: (f, a, opts) => new FakePty(f, a, opts) },
    emit: (c, p) => void events.push([c, p]),
    workspaceRoot: () => root,
    binDir: bin,
    cli: o.cli === false ? undefined : { command: 'C:\\Program Files\\TestPion\\TestPion.exe', args: [] },
    shells: () => [
      { id: 'powershell', label: 'PowerShell', path: 'powershell.exe', args: ['-NoLogo'] },
      { id: 'cmd', label: 'Command Prompt', path: 'cmd.exe', args: [] },
    ],
    baseEnv: { PATH: '/usr/bin', HOME: root, TESTPION_CAPTURE_SCRIPT: 'x', E2E_PLAN: 'y', ELECTRON_RUN_AS_NODE: '1', KEEP: 'me' },
    platform: 'linux',
  });
  return { m, events, root, bin, last: () => FakePty.all.at(-1)! };
}

describe('terminal sessions', () => {
  it('creates a shell in the workspace folder with testpion on the PATH and the workspace in the environment', () => {
    const { m, root, bin, last } = manager();
    const s = m.create({ cols: 120, rows: 30 });
    expect(s).toMatchObject({ id: 't1', shell: 'powershell', label: 'PowerShell', cwd: root });
    const p = last();
    expect(p.file).toBe('powershell.exe');
    expect(p.opts).toMatchObject({ cols: 120, rows: 30, cwd: root });
    expect(p.opts.env.PATH).toBe(`${bin}${delimiter}/usr/bin`);
    expect(p.opts.env.TESTPION_WORKSPACE).toBe(root);
    expect(p.opts.env.KEEP).toBe('me');
    // what would change the app when started from the shell never reaches it
    expect(p.opts.env.TESTPION_CAPTURE_SCRIPT).toBeUndefined();
    expect(p.opts.env.E2E_PLAN).toBeUndefined();
    expect(p.opts.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(readFileSync(join(bin, 'testpion'), 'utf8')).toContain('exec \'C:\\Program Files\\TestPion\\TestPion.exe\' --cli "$@"');
    m.dispose();
  });

  it('picks a shell by id, refuses unknown ones and a cwd that is not a folder', () => {
    const { m, last } = manager();
    expect(m.create({ shell: 'cmd' }).shell).toBe('cmd');
    expect(last().opts).toMatchObject({ cols: 80, rows: 24 });
    expect(() => m.create({ shell: 'nope' })).toThrow(/Unknown shell/);
    expect(() => m.create({ cwd: 'relative/dir' })).toThrow(/existing folder/);
    expect(() => m.create({ cwd: join(tmp(), 'missing') })).toThrow(/existing folder/);
    // sizes are clamped
    m.create({ cols: 99999, rows: -5 });
    expect(last().size).toEqual([1000, 1]);
    m.dispose();
  });

  it('batches output (one event per 16 ms, sooner at 64 KB) and keeps the last 1 MB for a window that reloads', () => {
    vi.useFakeTimers();
    try {
      const { m, events, last } = manager();
      const s = m.create();
      const p = last();
      p.emit('a');
      p.emit('b');
      p.emit('c');
      expect(events.filter((e) => e[0] === 'terminal.data')).toHaveLength(0);
      vi.advanceTimersByTime(20);
      expect(events.filter((e) => e[0] === 'terminal.data')).toEqual([['terminal.data', { id: s.id, data: 'abc', epoch: 0 }]]);
      // a flood is sent at once, in 64 KB pieces
      p.emit('x'.repeat(FLUSH_BYTES));
      expect(events.filter((e) => e[0] === 'terminal.data')).toHaveLength(2);
      for (let i = 0; i < 20; i++) p.emit('y'.repeat(FLUSH_BYTES));
      vi.advanceTimersByTime(20);
      const out = m.list(true)[0]!.output!;
      expect(out.length).toBeLessThanOrEqual(SCROLLBACK_BYTES);
      expect(out.endsWith('y')).toBe(true);
      expect(m.list()[0]).not.toHaveProperty('output');
      m.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes and resizes; an exited shell stays listed with its code until it is closed', () => {
    vi.useFakeTimers();
    try {
      const { m, events, last } = manager();
      const s = m.create();
      const p = last();
      expect(m.write(s.id, 'echo hello\r')).toBe(true);
      expect(p.written).toEqual(['echo hello\r']);
      expect(m.resize(s.id, 100, 40)).toBe(true);
      expect(p.size).toEqual([100, 40]);
      expect(() => m.write(s.id, 'x'.repeat(1024 * 1024 + 1))).toThrow(/1 MB/);
      p.emit('bye');
      p.exit(3);
      // the output before the exit is sent first
      expect(events.slice(-2)).toEqual([
        ['terminal.data', { id: s.id, data: 'bye', epoch: 0 }],
        ['terminal.exit', { id: s.id, code: 3 }],
      ]);
      expect(m.list()[0]).toMatchObject({ id: s.id, exitCode: 3 });
      expect(m.write(s.id, 'ls\r')).toBe(false);
      expect(m.resize(s.id, 10, 10)).toBe(false);
      expect(m.kill(s.id)).toBe(true);
      expect(m.list()).toEqual([]);
      expect(() => m.write(s.id, 'x')).toThrow(/No terminal/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flow control: a flood pauses the shell until the window has drawn it, so neither side buffers it all', () => {
    vi.useFakeTimers();
    try {
      const { m, events, last } = manager();
      const s = m.create();
      const p = last();
      const sent = () => events.filter((e) => e[0] === 'terminal.data').reduce((n, e) => n + (e[1].data as string).length, 0);
      // a 50 MB `cat`: the pty keeps producing until it is paused
      let produced = 0;
      while (!p.paused && produced < 50 * 1024 * 1024) (p.emit('z'.repeat(FLUSH_BYTES)), (produced += FLUSH_BYTES));
      expect(p.paused).toBe(true);
      expect(sent()).toBeLessThanOrEqual(FLOW_HIGH + FLUSH_BYTES);
      expect(produced).toBeLessThanOrEqual(FLOW_HIGH + 2 * FLUSH_BYTES);
      // the window drew part of it (counts are absolute): still above the low mark, still paused
      expect(m.ack(s.id, sent() - FLOW_LOW)).toEqual({ paused: true, detached: false });
      expect(p.paused).toBe(true);
      // caught up: reading resumes
      expect(m.ack(s.id, sent())).toEqual({ paused: false, detached: false });
      expect(p.paused).toBe(false);
      expect(() => m.ack(s.id, -1)).toThrow(/parsed/);
      // a window that reloads reads the kept output afresh: nothing is waiting for it any more
      while (!p.paused) p.emit('w'.repeat(FLUSH_BYTES));
      m.list(true);
      expect(p.paused).toBe(false);
      m.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('an exit reported twice (node-pty: error, then close) or after a kill is ignored', () => {
    const { m, events, last } = manager();
    const s = m.create();
    const p = last();
    p.exit(1);
    p.exit(1);
    expect(events.filter((e) => e[0] === 'terminal.exit')).toHaveLength(1);
    const s2 = m.create();
    const p2 = last();
    m.kill(s2.id);
    p2.exit(0);
    expect(events.filter((e) => e[0] === 'terminal.exit')).toHaveLength(1);
    expect(m.list().map((x) => x.id)).toEqual([s.id]);
    m.dispose();
  });

  it('kill ends the shell and drops its pending output', () => {
    vi.useFakeTimers();
    try {
      const { m, events, last } = manager();
      const s = m.create();
      const p = last();
      p.emit('late');
      m.kill(s.id);
      vi.advanceTimersByTime(50);
      expect(p.killed).toBe(true);
      expect(events.some((e) => e[0] === 'terminal.data')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it(`caps the open terminals at ${MAX_SESSIONS}; exited ones make room`, () => {
    const { m } = manager();
    const ptys: FakePty[] = [];
    for (let i = 0; i < MAX_SESSIONS; i++) (m.create(), ptys.push(FakePty.all.at(-1)!));
    expect(() => m.create()).toThrow(/At most 8/);
    ptys[2]!.exit(0);
    expect(m.create().id).toBe(`t${MAX_SESSIONS + 1}`);
    expect(m.list()).toHaveLength(MAX_SESSIONS);
    expect(m.list().some((s) => s.exitCode !== undefined)).toBe(false);
    m.dispose();
  });

  it('dispose kills every shell and tells the window which ones went', () => {
    const { m, events } = manager();
    m.create();
    m.create();
    const ptys = FakePty.all.slice(-2);
    m.dispose('workspace');
    expect(ptys.every((p) => p.killed)).toBe(true);
    expect(m.list()).toEqual([]);
    expect(events.at(-1)).toEqual(['terminal.closed', { ids: ['t1', 't2'], reason: 'workspace' }]);
  });

  it('a host without a pty (browser bridge, cloud) has no shells and never starts one', () => {
    const { m } = manager({ host: false });
    expect(m.available).toBe(false);
    expect(m.shells()).toEqual([]);
    expect(() => m.create()).toThrow(/only available in the TestPion desktop app/);
  });

  it('the testpion command runs the app with --cli: a .cmd for PowerShell and cmd, a script for Git Bash and Unix', () => {
    const win = shimFiles({ command: 'C:\\Apps\\TestPion\\TestPion.exe', args: [] }, true);
    expect(win['testpion.cmd']).toBe('@"C:\\Apps\\TestPion\\TestPion.exe" --cli %*\r\n');
    expect(win.testpion).toContain('exec \'C:/Apps/TestPion/TestPion.exe\' --cli "$@"');
    const dev = shimFiles({ command: '/opt/electron', args: ["/src/it's/app"] }, false);
    expect(Object.keys(dev)).toEqual(['testpion']);
    expect(dev.testpion).toContain(`exec '/opt/electron' '/src/it'\\''s/app' --cli "$@"`);
    // no CLI (a host that is not the app): no shim, the PATH is the user's
    const { m, bin, last } = manager({ cli: false });
    m.create();
    expect(last().opts.env.PATH).toBe('/usr/bin');
    expect(existsSync(bin)).toBe(false);
    m.dispose();
  });
});

describe('terminal RPCs', () => {
  it('validates their parameters before anything runs', () => {
    expect(() => checkRpcParams('terminal.write', { id: 't1' })).toThrow(/missing data/);
    expect(() => checkRpcParams('terminal.write', { id: 't1', data: 5 })).toThrow(/data/);
    expect(() => checkRpcParams('terminal.resize', { id: 't1', cols: '80', rows: 24 })).toThrow(/cols/);
    expect(() => checkRpcParams('terminal.kill', {})).toThrow(/missing id/);
    expect(() => checkRpcParams('terminal.ack', { id: 't1', parsed: 'x' })).toThrow(/parsed/);
    expect(() => checkRpcParams('terminal.ack', { id: 't1', parsed: 5, epoch: 'x' })).toThrow(/epoch/);
    expect(() => checkRpcParams('terminal.create', { cwd: 7 })).toThrow(/cwd/);
    expect(checkRpcParams('terminal.create', { cols: 80, rows: 24 })).toEqual({ cols: 80, rows: 24 });
  });

  it('a backend whose host has no pty reports no shell capability and refuses terminal.create', async () => {
    const home = tmp();
    const be = new Backend({ appDir: home, emit: () => undefined, noMonitors: true });
    try {
      expect(((await be.invoke('app.info', {})) as { capabilities: { shell: boolean } }).capabilities).toEqual({ shell: false, localFiles: true });
      expect(await be.invoke('terminal.shells', {})).toEqual({ available: false, shells: [] });
      await expect(be.invoke('terminal.create', { cols: 80, rows: 24 })).rejects.toThrow(/desktop app/);
      expect(await be.invoke('terminal.list', {})).toEqual([]);
    } finally {
      await be.dispose();
    }
  });

  it('a desktop backend runs shells through its host and kills them all when it is disposed', async () => {
    const home = tmp();
    const spawned: FakePty[] = [];
    const be = new Backend({
      appDir: home,
      emit: () => undefined,
      noMonitors: true,
      mcpCommand: { command: '/app/testpion-app', args: [] },
      terminal: { spawn: (f, a, o) => (spawned.push(new FakePty(f, a, o)), spawned.at(-1)!) },
    });
    try {
      expect(((await be.invoke('app.info', {})) as { capabilities: { shell: boolean } }).capabilities).toEqual({ shell: true, localFiles: true });
      const { shells } = (await be.invoke('terminal.shells', {})) as { shells: Array<{ id: string }> };
      expect(shells.length).toBeGreaterThan(0);
      const s = (await be.invoke('terminal.create', { cols: 90, rows: 20 })) as { id: string; cwd: string };
      expect(s.cwd).toBe(be.ws.root);
      expect(spawned[0]!.opts.env.TESTPION_WORKSPACE).toBe(be.ws.root);
      expect(await be.invoke('terminal.write', { id: s.id, data: 'testpion --version\r' })).toBe(true);
      expect(existsSync(join(home, 'terminal-bin', process.platform === 'win32' ? 'testpion.cmd' : 'testpion'))).toBe(true);
    } finally {
      await be.dispose();
    }
    expect(spawned[0]!.killed).toBe(true);
  });
});
