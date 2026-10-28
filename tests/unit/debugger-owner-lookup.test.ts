import { describe, expect, it } from 'vitest';
import { createOwnerBatcher, parseOwners, psOwnerCommand, windowsOwnerCommand } from '../../packages/core/src/debugger/owner-lookup.js';
import { ownerOfProcess } from '../../packages/core/src/debugger/programs.js';

/**
 * The account of each program in the Debugger's list (performance review 2026-10-27, item 5): a loop of `curl` is a new
 * process per request, and a PowerShell per process was 300-500 ms of CPU each. The ones asked about together go in one query.
 */
describe('owner lookups in batches', () => {
  it('500 new processes asked about at once are 3 queries at most, each id answered from its own line', async () => {
    const queries: number[][] = [];
    const ask = createOwnerBatcher({
      windowMs: 20,
      maxBatch: 256,
      query: async (pids) => {
        queries.push(pids);
        return new Map(pids.filter((p) => p % 10 !== 0).map((p) => [p, { user: 'DOM\\u' + p }]));
      },
    });
    const pids = Array.from({ length: 500 }, (_, i) => 1000 + i);
    const out = await Promise.all(pids.map((p) => ask(p)));
    expect(queries.length).toBeLessThanOrEqual(3);
    expect(queries.flat().sort((a, b) => a - b)).toEqual(pids);
    expect(out[1]).toBe('DOM\\u1001');
    expect(out[0]).toBeUndefined(); // 1000: the system did not know it
  });

  it('the same id asked twice in a window is queried once; a kept answer needs no query; a failing query answers unknown', async () => {
    let calls = 0;
    let t = 0;
    const ask = createOwnerBatcher({ windowMs: 5, keepMs: 1000, now: () => t, query: async (pids) => (calls++, new Map(pids.map((p) => [p, { user: 'me' }]))) });
    expect(await Promise.all([ask(7), ask(7)])).toEqual(['me', 'me']);
    expect(calls).toBe(1);
    expect(await ask(7)).toBe('me');
    expect(calls).toBe(1);
    t = 5000;
    expect(await ask(7)).toBe('me'); // past keepMs: asked again
    expect(calls).toBe(2);
    const bad = createOwnerBatcher({ windowMs: 1, query: async () => Promise.reject(new Error('no shell')) });
    expect(await bad(9)).toBeUndefined();
  });

  it('ids that arrive while a query runs wait for the next one (one query at a time)', async () => {
    let running = 0;
    let most = 0;
    const ask = createOwnerBatcher({
      windowMs: 1,
      query: async (pids) => {
        most = Math.max(most, ++running);
        await new Promise((r) => setTimeout(r, 30));
        running--;
        return new Map(pids.map((p) => [p, { user: 'u' }]));
      },
    });
    const first = ask(1);
    await new Promise((r) => setTimeout(r, 10));
    const second = ask(2);
    expect(await Promise.all([first, second])).toEqual(['u', 'u']);
    expect(most).toBe(1);
  });

  it('builds one command for all the ids and reads both outputs', () => {
    const [file, args] = windowsOwnerCommand([11, 22, 33]);
    expect(file).toBe('powershell');
    expect(args.join(' ')).toContain('ProcessId=11 OR ProcessId=22 OR ProcessId=33');
    expect(psOwnerCommand([4, 5])).toEqual(['ps', ['-o', 'pid=,user=', '-p', '4,5']]);
    expect(parseOwners('11\tDOM\\ann\t2026-10-01T10:00:00.0000000+00:00\r\n22\t\t\r\n33\tbob\t')).toEqual(
      new Map([
        [11, { user: 'DOM\\ann', startedAt: '2026-10-01T10:00:00.0000000+00:00' }],
        [33, { user: 'bob', startedAt: undefined }],
      ]),
    );
    expect(parseOwners('  4 root\n 5 alice\n')).toEqual(
      new Map([
        [4, { user: 'root', startedAt: undefined }],
        [5, { user: 'alice', startedAt: undefined }],
      ]),
    );
  });

  it('asks this machine about this process and about several at once', async () => {
    const [me, same] = await Promise.all([ownerOfProcess(process.pid), ownerOfProcess(process.pid)]);
    expect(me).toBeTruthy();
    expect(same).toBe(me);
  }, 30_000);
});
