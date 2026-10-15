import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FLOW_HIGH, FLOW_LOW, FLUSH_BYTES, SCROLLBACK_BYTES, STALL_MS, TerminalManager, type PtyProcess } from '../../apps/desktop/backend/terminal.js';
import { AckCounter } from '../../apps/desktop/src/lib/terminal-flow.js';

/**
 * The Terminal's flow control end to end, deterministically: the backend's TerminalManager, a fake pty that produces a
 * flood only while it is not paused (as a real shell blocks on a full pty), and a fake window that draws with the real
 * AckCounter of the renderer and parses its output only when the test lets it (a busy, hidden or reloading window).
 * Each case is one way the window can stop acknowledging: a lost ack, a hidden window, a reload mid-burst, a replay
 * with output still queued. None may leave the shell waiting for good, and memory stays bounded throughout.
 */

class FloodPty implements PtyProcess {
  pid = 4242;
  paused = false;
  produced = 0;
  private onDataCb?: (d: string) => void;
  constructor(
    private total: number,
    private chunk = 16 * 1024,
  ) {}
  onData(cb: (d: string) => void) {
    this.onDataCb = cb;
  }
  onExit() {}
  write() {}
  resize() {}
  kill() {}
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }
  /** Produce while not paused (the OS pipe makes a real shell wait the same way); a line number marks each chunk's end. */
  pump(max = Infinity) {
    let n = 0;
    while (!this.paused && this.produced < this.total && n < max) {
      const size = Math.min(this.chunk, this.total - this.produced);
      this.produced += size;
      this.onDataCb?.('x'.repeat(size - 1) + '\n');
      n++;
    }
  }
}

/** A window: xterm's queue of writes, parsed only when `parse()` runs, acknowledged with the renderer's AckCounter. */
class FakeWindow {
  queue: Array<{ data: string; epoch: number; reset?: number }> = [];
  shown = 0;
  replays = 0;
  acks = 0;
  counter: AckCounter;
  constructor(
    private m: TerminalManager,
    private id: string,
    private lose: () => boolean = () => false,
  ) {
    this.counter = new AckCounter((parsed, epoch) => {
      this.acks++;
      if (this.lose()) return Promise.reject(new Error('lost'));
      try {
        this.m.ack(this.id, parsed, epoch);
        return Promise.resolve();
      } catch (e) {
        return Promise.reject(e);
      }
    });
  }
  event(channel: string, p: any) {
    if (p.id !== this.id) return;
    if (channel === 'terminal.data') this.queue.push({ data: p.data, epoch: p.epoch ?? 0 });
    else if (channel === 'terminal.replay') {
      // as the panel does: count from the replay; what was queued before it parses but no longer counts
      this.counter.reset(p.sent, p.epoch);
      this.replays++;
      // in order after what was queued: the screen starts over with the kept output
      this.queue.push({ data: '', epoch: -2, reset: p.output.length });
    } else if (channel === 'terminal.detached') this.queue.push({ data: '', epoch: -1 }); // write('', () => flush(true))
  }
  /** xterm parses what it was given (all of it, or `max` writes). */
  parse(max = Infinity) {
    let n = 0;
    while (this.queue.length && n++ < max) {
      const w = this.queue.shift()!;
      if (w.epoch === -1) this.counter.flush(true);
      else if (w.reset !== undefined) this.shown = w.reset;
      else {
        this.shown += w.data.length;
        this.counter.parsedChunk(w.data.length, w.epoch);
      }
    }
  }
  queued() {
    return this.queue.reduce((n, w) => n + w.data.length, 0);
  }
}

function setup(total: number, lose?: () => boolean) {
  const windows: FakeWindow[] = [];
  const m = new TerminalManager({
    host: { spawn: () => pty },
    emit: (c, p) => windows.forEach((w) => w.event(c, p)),
    workspaceRoot: () => undefined,
    binDir: join(mkdtempSync(join(tmpdir(), 'tp-flow-')), 'bin'),
    shells: () => [{ id: 'sh', label: 'sh', path: 'sh', args: [] }],
    baseEnv: {},
    platform: 'linux',
  });
  const pty = new FloodPty(total);
  const s = m.create();
  windows.push(new FakeWindow(m, s.id, lose));
  return { m, pty, id: s.id, windows, win: () => windows.at(-1)! };
}

/** Run the system for `ms` of fake time in 16 ms frames: the shell produces, the window parses when `drawing`. */
async function run(t: ReturnType<typeof setup>, ms: number, drawing = true, watch?: () => void) {
  for (let elapsed = 0; elapsed < ms; elapsed += 16) {
    t.pty.pump(8);
    if (drawing) t.win()?.parse();
    await vi.advanceTimersByTimeAsync(16);
    watch?.();
    // done: everything produced, drawn and acknowledged
    const st = t.m.list()[0]!;
    if (drawing && t.pty.produced >= (t.pty as unknown as { total: number }).total && t.win() && !t.win().queue.length && !st.detached && !st.undrawn) return;
  }
}

const state = (t: ReturnType<typeof setup>) => t.m.list()[0]!;

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe('terminal flow control', () => {
  it('a 50 MB flood reaches a window that draws, never more than the high mark undrawn', async () => {
    const t = setup(50 * 1024 * 1024);
    let peak = 0;
    await run(t, 600_000, true, () => (peak = Math.max(peak, state(t).undrawn ?? 0)));
    expect(t.pty.produced).toBe(50 * 1024 * 1024);
    expect(t.win().shown).toBe(50 * 1024 * 1024);
    expect(peak).toBeLessThanOrEqual(FLOW_HIGH + FLUSH_BYTES);
    expect(state(t)).toMatchObject({ sent: 50 * 1024 * 1024 });
    expect(state(t).undrawn).toBeUndefined();
    expect(state(t).paused).toBeUndefined();
    expect(t.win().replays).toBe(0);
    t.m.dispose();
  });

  it('a window that draws slowly holds the shell back (paused), and lets it go as it catches up', async () => {
    const t = setup(4 * 1024 * 1024);
    let pausedSeen = false;
    // the window parses one 16 KB write per frame: slower than the shell
    for (let i = 0; i < 4000 && t.win().shown < 4 * 1024 * 1024; i++) {
      t.pty.pump(8);
      t.win().parse(1);
      await vi.advanceTimersByTimeAsync(16);
      pausedSeen ||= !!state(t).paused;
      expect(t.win().queued()).toBeLessThanOrEqual(FLOW_HIGH + FLUSH_BYTES);
    }
    expect(pausedSeen).toBe(true);
    expect(t.win().shown).toBe(4 * 1024 * 1024);
    // slow is not stalled: it kept drawing, so it was never detached
    expect(t.win().replays).toBe(0);
    t.m.dispose();
  });

  it('lost acks (every other one fails) only delay: the counts are absolute and a failed ack is sent again', async () => {
    let n = 0;
    const t = setup(20 * 1024 * 1024, () => n++ % 2 === 0);
    await run(t, 600_000);
    expect(t.win().shown).toBe(20 * 1024 * 1024);
    expect(state(t).undrawn).toBeUndefined();
    expect(state(t).paused).toBeUndefined();
    t.m.dispose();
  });

  it('every ack lost while paused: the watchdog detaches the session, the shell runs on, and the window gets the kept output when it is heard again', async () => {
    let deaf = true;
    const t = setup(30 * 1024 * 1024, () => deaf);
    await run(t, 3000);
    expect(state(t).paused).toBe(true);
    await run(t, STALL_MS + 100);
    expect(state(t)).toMatchObject({ detached: true });
    expect(state(t).paused).toBeUndefined();
    // the shell is not held back while nobody draws, and nothing piles up for the window
    await run(t, 20_000);
    expect(t.pty.produced).toBe(30 * 1024 * 1024);
    expect(t.win().queued()).toBeLessThanOrEqual(FLOW_HIGH + FLUSH_BYTES);
    expect(t.m.list(false)[0]!.sent).toBeLessThanOrEqual(FLOW_HIGH + FLUSH_BYTES);
    // heard again (the ack retry gets through): the kept output (the last 1 MB) replaces the screen, and it is live again
    deaf = false;
    await run(t, 2000);
    expect(t.win().replays).toBe(1);
    expect(state(t).detached).toBeUndefined();
    expect(t.win().shown).toBeLessThanOrEqual(SCROLLBACK_BYTES);
    t.m.dispose();
  });

  it('a hidden window (it parses nothing for a minute) never stops the shell, and memory stays bounded', async () => {
    const t = setup(40 * 1024 * 1024);
    await run(t, 60_000, false);
    // paused at the high mark, then detached by the watchdog: the shell finished at full speed
    expect(t.pty.produced).toBe(40 * 1024 * 1024);
    expect(state(t)).toMatchObject({ detached: true });
    expect(t.win().queued()).toBeLessThanOrEqual(FLOW_HIGH + FLUSH_BYTES);
    expect(t.m.list(false)[0]!.sent).toBeLessThanOrEqual(FLOW_HIGH + FLUSH_BYTES);
    // shown again: xterm parses its backlog, acknowledges, and gets the kept output in place of it
    await run(t, 2000);
    expect(t.win().replays).toBe(1);
    expect(state(t).detached).toBeUndefined();
    expect(t.win().shown).toBe(SCROLLBACK_BYTES);
    t.m.dispose();
  });

  it('a reload mid-burst: the new window lists the terminals (with their output) and the burst goes on', async () => {
    const t = setup(20 * 1024 * 1024);
    await run(t, 2000);
    const before = t.pty.produced;
    // the window reloads: the old one is gone (it parses and acknowledges nothing more)
    t.windows.length = 0;
    await run(t, 1000, false);
    expect(state(t).paused).toBe(true);
    // the new window's Terminal panel: terminal.list with the output, then it draws from there
    const listed = t.m.list(true)[0]!;
    expect(listed.output!.length).toBeLessThanOrEqual(SCROLLBACK_BYTES);
    const w = new FakeWindow(t.m, t.id);
    w.counter.reset(listed.sent!, listed.epoch!);
    t.windows.push(w);
    expect(state(t).paused).toBeUndefined();
    await run(t, 600_000);
    expect(t.pty.produced).toBe(20 * 1024 * 1024);
    expect(t.pty.produced).toBeGreaterThan(before);
    expect(state(t).undrawn).toBeUndefined();
    t.m.dispose();
  });

  it('a reload after the session was detached also brings it back', async () => {
    const t = setup(10 * 1024 * 1024);
    t.windows.length = 0;
    await run(t, STALL_MS + 2000, false);
    expect(state(t)).toMatchObject({ detached: true });
    const listed = t.m.list(true)[0]!;
    expect(listed.detached).toBeUndefined();
    const w = new FakeWindow(t.m, t.id);
    w.counter.reset(listed.sent!, listed.epoch!);
    t.windows.push(w);
    await run(t, 600_000);
    expect(t.pty.produced).toBe(10 * 1024 * 1024);
    expect(state(t).undrawn).toBeUndefined();
    t.m.dispose();
  });

  it('an ack from before a replay changes nothing; a repeated or late ack is harmless', () => {
    const t = setup(4 * 1024 * 1024);
    t.pty.pump(64);
    expect(state(t).paused).toBe(true);
    const sent = state(t).sent!;
    // late and repeated acks of an older count
    t.m.ack(t.id, 1000, 0);
    t.m.ack(t.id, 1000, 0);
    t.m.ack(t.id, 10, 0);
    expect(state(t).undrawn).toBe(sent - 1000);
    // an ack for more than was sent counts what was sent
    t.m.ack(t.id, sent * 10, 0);
    expect(state(t).undrawn).toBeUndefined();
    expect(state(t).paused).toBeUndefined();
    // after a reload (epoch 1) an ack of the old window (epoch 0) is ignored
    t.pty.pump(64);
    t.m.list(true);
    t.pty.pump(64);
    const undrawn = state(t).undrawn;
    t.m.ack(t.id, Number.MAX_SAFE_INTEGER, 0);
    expect(state(t).undrawn).toBe(undrawn);
    expect(() => t.m.ack(t.id, -1)).toThrow(/parsed/);
    expect(() => t.m.ack(t.id, Number.NaN)).toThrow(/parsed/);
    t.m.dispose();
  });

  it('resumes only below the low mark (no flapping at the high mark)', () => {
    const t = setup(4 * 1024 * 1024);
    t.pty.pump(64);
    const sent = state(t).sent!;
    expect(state(t).paused).toBe(true);
    t.m.ack(t.id, sent - FLOW_LOW, 0);
    expect(state(t).paused).toBe(true);
    t.m.ack(t.id, sent - FLOW_LOW + 1, 0);
    expect(state(t).paused).toBeUndefined();
    t.m.dispose();
  });
});
