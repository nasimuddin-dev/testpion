import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { setFlagsFromString } from 'node:v8';
import { FLOW_HIGH, FLUSH_BYTES, TerminalManager } from '../../apps/desktop/backend/terminal.js';
import { nodePtyHost, type NodePty } from '../../apps/desktop/backend/node-pty-host.js';

// The Terminal panel's sessions with a real pty (node-pty, as the desktop app runs it): a shell answers, a flood of
// output is held back by flow control (neither process buffers it), and closing a terminal leaves no process behind.
const require = createRequire(import.meta.url);
const win = process.platform === 'win32';
const dir = mkdtempSync(join(tmpdir(), 'tp-pty-'));
const managers: TerminalManager[] = [];
afterAll(() => {
  // every shell ends, whatever a test did, before its folder goes
  for (const m of managers) m.dispose();
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    /* Windows releases a dead shell's working folder a moment later; the temp folder is the OS's to clean */
  }
});

function manager() {
  // the output's size and its last 64 KB (the test keeps no more than a window would)
  let output = '';
  let total = 0;
  // what a window would acknowledge: the backend's count (from the start, or from a replay) within the replay's epoch
  let parsed = 0;
  let epoch = 0;
  const events: Array<[string, any]> = [];
  const m = new TerminalManager({
    host: nodePtyHost(() => require('@lydell/node-pty') as NodePty),
    emit: (c, p) => {
      if (c === 'terminal.replay') {
        // the window was too slow (a loaded machine): it gets the kept output and counts from there
        ((parsed = p.sent), (epoch = p.epoch), (output = p.output.slice(-64 * 1024)));
        return void events.push([c, p]);
      }
      // as the panel does: say it draws again (once it has parsed what it has), and the kept output comes back
      if (c === 'terminal.detached') setTimeout(() => m.ack(p.id, parsed, epoch), 0);
      if (c !== 'terminal.data') return void events.push([c, p]);
      total += p.data.length;
      if ((p.epoch ?? 0) === epoch) parsed += p.data.length;
      output = (output + p.data).slice(-64 * 1024);
    },
    workspaceRoot: () => dir,
    binDir: join(dir, 'bin'),
    shells: () => [win ? { id: 'cmd', label: 'cmd', path: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', args: [] } : { id: 'sh', label: 'sh', path: '/bin/sh', args: [] }],
  });
  managers.push(m);
  return { m, events, out: () => output, size: () => total, ack: (id: string) => m.ack(id, parsed, epoch), clear: () => ((output = ''), (total = 0)) };
}

const until = async (ok: () => boolean, ms: number) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (ok()) return true;
  return ok();
};

/** A full collection before a heap reading (without it, heapUsed depends on when V8 last ran: the number measured is the garbage, not the leak). */
function heapNow(): number {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  gc();
  gc();
  return process.memoryUsage().heapUsed;
}

/** Waits until `read()` has not changed for `quietMs` (an event-driven settle instead of a fixed sleep). */
async function settled(read: () => number, quietMs = 300, maxMs = 20000): Promise<number> {
  let last = read();
  let since = Date.now();
  for (const end = Date.now() + maxMs; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) {
    const now = read();
    if (now !== last) (last = now), (since = Date.now());
    else if (Date.now() - since >= quietMs) break;
  }
  return last;
}

/** Processes whose command line has `marker` (other than the one asking). */
function processesWith(marker: string): number {
  if (win) {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' -and $_.Name -eq 'node.exe' }).Count`],
      { encoding: 'utf8' },
    );
    return Number(out.trim());
  }
  const out = execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' });
  return out.split('\n').filter((l) => l.includes(marker) && !l.includes('ps -eo')).length;
}

describe('terminal with a real pty', () => {
  it('a shell starts in the workspace folder and answers', async () => {
    const { m, out } = manager();
    const s = m.create({ cols: 100, rows: 30 });
    m.write(s.id, 'echo hello-from-pty\r');
    expect(await until(() => /hello-from-pty[\s\S]*hello-from-pty/.test(out()), 15000)).toBe(true);
    m.dispose();
  }, 30000);

  it('a 20 MB flood is held back until the window draws it, then all of it arrives', async () => {
    const { m, out, size, clear, ack } = manager();
    const script = join(dir, 'flood.cjs');
    const line = 'y'.repeat(99);
    const LINES = 200_000; // 20 MB
    writeFileSync(
      script,
      `const l = ${JSON.stringify(line)} + '\\n'; let i = 0; (function go() { while (i < ${LINES}) { i++; if (!process.stdout.write(l)) return void process.stdout.once('drain', go); } process.stdout.write('FLOOD-DONE\\n'); })();`,
    );
    const s = m.create({ cols: 120, rows: 30 });
    await until(() => out().length > 0, 10000);
    clear();
    const heap0 = heapNow();
    m.write(s.id, `"${process.execPath}" "${script}"\r`);
    // nobody acknowledges: the output stops at the high mark, the producer waits (however slow the machine is)
    expect(await until(() => !!m.list()[0]!.paused, 120000)).toBe(true);
    const held = await settled(size); // the output has stopped growing: held back at the high mark
    expect(m.list()[0]).toMatchObject({ paused: true });
    expect(held).toBeGreaterThan(FLOW_HIGH);
    expect(held).toBeLessThan(FLOW_HIGH + 4 * FLUSH_BYTES);
    expect(out()).not.toContain('FLOOD-DONE');
    // the window draws everything it gets (as xterm acknowledges): the whole flood comes through
    const t0 = Date.now();
    let acked = 0;
    let peakUnacked = 0;
    const done = await until(() => {
      const total = size();
      peakUnacked = Math.max(peakUnacked, total - acked);
      if (total > acked) (ack(s.id), (acked = total));
      return out().includes('FLOOD-DONE');
    }, 120000);
    const seconds = (Date.now() - t0) / 1000;
    expect(done).toBe(true);
    expect(peakUnacked).toBeLessThan(FLOW_HIGH + 4 * FLUSH_BYTES);
    // the kept output is bounded whatever came through
    expect(m.list(true)[0]!.output!.length).toBeLessThanOrEqual(1024 * 1024);
    const heapGrowth = (heapNow() - heap0) / 1024 / 1024;
    // heapUsed depends on when the collector last ran (macOS CI measured 69 MB with the output bounded to 1 MB above): the allowance of the other heap checks
    expect(heapGrowth).toBeLessThan(96);
    console.log(
      `terminal flood: ${(size() / 1024 / 1024).toFixed(1)} MB through the pty in ${seconds.toFixed(1)} s, at most ${(peakUnacked / 1024).toFixed(0)} KB undrawn, heap +${heapGrowth.toFixed(1)} MB`,
    );
    m.dispose();
  }, 180000);

  it('closing a terminal ends what runs in it: no process is left behind', async () => {
    const { m, out } = manager();
    const marker = `tp-orphan-${process.pid}-${Date.now()}`;
    const script = join(dir, `${marker}.cjs`);
    writeFileSync(script, `console.log('${marker}-up'); setInterval(() => {}, 1000);`);
    const s = m.create({ cols: 100, rows: 30 });
    m.write(s.id, `"${process.execPath}" "${script}"\r`);
    expect(await until(() => out().includes(`${marker}-up`), 15000)).toBe(true);
    expect(processesWith(marker)).toBe(1);
    m.kill(s.id);
    expect(await until(() => processesWith(marker) === 0, 15000)).toBe(true);
  }, 60000);

  it('dispose (workspace switch, quit) ends every shell and what runs in them', async () => {
    const { m, out } = manager();
    const marker = `tp-dispose-${process.pid}-${Date.now()}`;
    const script = join(dir, `${marker}.cjs`);
    writeFileSync(script, `console.log('${marker}-up'); setInterval(() => {}, 1000);`);
    for (let i = 0; i < 2; i++) {
      const s = m.create({ cols: 100, rows: 30 });
      m.write(s.id, `"${process.execPath}" "${script}"\r`);
    }
    expect(await until(() => (out().match(new RegExp(`${marker}-up`, 'g')) ?? []).length >= 2, 20000)).toBe(true);
    expect(processesWith(marker)).toBe(2);
    m.dispose('quit');
    expect(m.list()).toEqual([]);
    expect(await until(() => processesWith(marker) === 0, 15000)).toBe(true);
  }, 60000);
});
