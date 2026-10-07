import { describe, expect, it } from 'vitest';
import { DebuggerSession, type DebuggerExchange } from '../../packages/core/src/index.js';

// The Debugger session's two limits: a count (the oldest go, in blocks) and a budget of body bytes (the oldest lose
// their bodies first, keep the rest); delete, clear and a loaded session go through the same accounting.
const exchange = (id: string, body = ''): DebuggerExchange =>
  ({
    id,
    startedAt: '2026-10-07T00:00:00Z',
    kind: 'http',
    method: 'GET',
    url: `http://h/${id}`,
    host: 'h',
    clientPort: 1,
    requestHeaders: {},
    requestBodyBytes: 0,
    responseBodyBytes: body.length,
    responseBody: body || undefined,
  }) as DebuggerExchange;

describe('DebuggerSession', () => {
  it('keeps at most the cap, the oldest dropped in a block', () => {
    const s = new DebuggerSession({ maxExchanges: 100 });
    for (let i = 0; i < 100; i++) s.add(exchange(`e${i}`));
    expect(s.length).toBe(100);
    for (let i = 100; i < 102; i++) s.add(exchange(`e${i}`));
    // over the cap by a block (a fiftieth) at most: kept until the block is full (one memmove per block, not per request)
    expect(s.length).toBe(102);
    s.add(exchange('e102'));
    expect(s.length).toBe(100);
    expect(s.items[0]!.id).toBe('e3');
    expect(s.items[99]!.id).toBe('e102');
  });

  it('lets the oldest bodies go when the budget is passed, keeps the rest of the exchange', () => {
    const s = new DebuggerSession({ maxBodyBytes: 25 });
    for (let i = 0; i < 5; i++) s.add(exchange(`e${i}`, 'x'.repeat(10)));
    const dropped = s.items.filter((e) => e.bodiesDropped).map((e) => e.id);
    expect(dropped).toEqual(['e0', 'e1', 'e2']);
    expect(s.items[3]!.responseBody).toHaveLength(10);
    expect(s.items[4]!.responseBody).toHaveLength(10);
    expect(s.items[0]!.responseBodyBytes).toBe(10);
  });

  it('a body attached after the exchange was added is charged by account()', () => {
    const s = new DebuggerSession({ maxBodyBytes: 15 });
    const a = exchange('a');
    const b = exchange('b');
    s.add(a);
    s.add(b);
    a.responseBody = 'x'.repeat(10);
    s.account(a);
    b.responseBody = 'y'.repeat(10);
    s.account(b);
    expect(a.bodiesDropped).toBe(true);
    expect(b.responseBody).toHaveLength(10);
    // charging the same exchange again changes nothing
    s.account(b);
    expect(b.bodiesDropped).toBeUndefined();
  });

  it('remove, clear and load recount from what is kept', () => {
    const s = new DebuggerSession({ maxBodyBytes: 25, maxExchanges: 3 });
    for (let i = 0; i < 3; i++) s.add(exchange(`e${i}`, 'x'.repeat(10)));
    expect(s.items[0]!.bodiesDropped).toBe(true);
    s.remove(['e1']);
    expect(s.items.map((e) => e.id)).toEqual(['e0', 'e2']);
    const items = s.items;
    s.clear();
    expect(s.length).toBe(0);
    expect(s.items).toBe(items); // the same array: holders of it see the change
    s.load([exchange('l0', 'x'.repeat(20)), exchange('l1', 'x'.repeat(20)), exchange('l2'), exchange('l3')]);
    expect(s.items.map((e) => e.id)).toEqual(['l1', 'l2', 'l3']); // at most the cap, the newest kept
    s.load([exchange('m0', 'x'.repeat(10))], true);
    expect(s.items.map((e) => e.id)).toEqual(['l2', 'l3', 'm0']);
  });
});
