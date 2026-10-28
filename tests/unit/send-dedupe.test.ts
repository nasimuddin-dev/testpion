import { describe, expect, it } from 'vitest';
import { dedupeSend, DEDUPE_MS } from '../../apps/desktop/backend/send-dedupe.js';

// C-5: the same request id sent twice within 250 ms runs once (review 2026-10-27, robustness).
const be = {} as never;
const gate = () => {
  let release!: () => void;
  const open = new Promise<void>((r) => (release = r));
  return { open, release };
};

describe('dedupeSend', () => {
  it('the same id with the same content within 250 ms runs once and both callers get the answer', async () => {
    let runs = 0;
    const g = gate();
    const run = async (p: { id?: string; url: string }) => (runs++, await g.open, `answer ${p.url}`);
    const a = dedupeSend(be, { id: 'r1', url: 'http://x' }, run, () => 1000);
    const b = dedupeSend(be, { id: 'r1', url: 'http://x' }, run, () => 1100);
    g.release();
    expect(await Promise.all([a, b])).toEqual(['answer http://x', 'answer http://x']);
    expect(runs).toBe(1);
  });

  it('another content, another id, no id, or a send after the window is a new send', async () => {
    let runs = 0;
    const run = async (p: { id?: string; url: string }) => (runs++, p.url);
    const t0 = 5000;
    await dedupeSend(be, { id: 'r2', url: 'a' }, run, () => t0);
    await dedupeSend(be, { id: 'r2', url: 'b' }, run, () => t0 + 10); // same id, other content
    await dedupeSend(be, { id: 'r3', url: 'b' }, run, () => t0 + 10); // other id
    await dedupeSend(be, { url: 'b' }, run, () => t0 + 10); // no id
    await dedupeSend(be, { url: 'b' }, run, () => t0 + 10);
    expect(runs).toBe(5);
    await dedupeSend(be, { id: 'r3', url: 'b' }, run, () => t0 + 10 + DEDUPE_MS + 1); // later
    expect(runs).toBe(6);
  });

  it('a failure is shared by the duplicate too', async () => {
    const run = async () => {
      throw new Error('down');
    };
    const a = dedupeSend(be, { id: 'r4' }, run, () => 9000);
    const b = dedupeSend(be, { id: 'r4' }, run, () => 9001);
    await expect(a).rejects.toThrow('down');
    await expect(b).rejects.toThrow('down');
  });
});
