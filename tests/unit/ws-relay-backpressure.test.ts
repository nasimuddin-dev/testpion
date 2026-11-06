import { describe, expect, it } from 'vitest';
import { BACKLOG_HIGH, createFrameRelay, encodeFrame } from '../../packages/core/src/debugger/ws-relay.js';
import { sharedPause } from '../../packages/core/src/debugger/http-util.js';

// The Debugger's WebSocket relay: a sender faster than the rules (a delay, a held frame) or than the reader waits,
// instead of its frames piling up in memory.
describe('WebSocket relay back-pressure', () => {
  it('frames held by the rules past the high mark make the sender wait, and it goes on once they are written', async () => {
    const seen: boolean[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const written: Buffer[] = [];
    const relay = createFrameRelay({
      direction: 'received',
      decide: async () => (await gate, {}), // every frame waits for the rules
      write: (b) => void written.push(b),
      onFrame: () => undefined,
      onBacklog: (full) => seen.push(full),
    });
    const frame = encodeFrame(1, Buffer.alloc(1024 * 1024, 'a'), false); // 1 MB text frames from the server
    let pushed = 0;
    for (; pushed * frame.length <= BACKLOG_HIGH; pushed++) relay.push(frame);
    expect(seen).toEqual([true]);
    expect(written).toHaveLength(0);
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual([true, false]);
    expect(written).toHaveLength(pushed); // every frame forwarded, in order
  });

  it('a source paused for two reasons runs again only when neither holds it', () => {
    const calls: string[] = [];
    const src = { pause: () => calls.push('pause'), resume: () => calls.push('resume') };
    const why = sharedPause(src);
    const full = why('full');
    const rules = why('rules');
    full.pause();
    rules.pause();
    full.resume();
    expect(calls).toEqual(['pause']);
    rules.resume();
    expect(calls).toEqual(['pause', 'resume']);
    rules.resume(); // not holding: nothing
    expect(calls).toEqual(['pause', 'resume']);
  });
});
