import { describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock('../../apps/desktop/src/api', () => ({ call: vi.fn(), on: vi.fn() }));
vi.mock('../../apps/desktop/src/store', () => ({ useApp: { getState: () => ({ toast: vi.fn() }) } }));

import { createServer } from 'node:http';
import { compileWhere, parseCommand, parseWhere, selectRows, whereText, COMMAND_HELP, isReplayLocalHost, type SelectRow } from '@testpion/shared';
import { cleanReplayOptions, replayMany, requestOfExchange, summarizeReplay, REPLAY_MAX, groupPrograms, parseLsof, parseNetstat, parseTasklist, type DebuggerExchange } from '@testpion/core';
import { debuggerTools } from '../../packages/core/src/mcp-server/tools/debugger-tools';
import { Redactor } from '../../packages/core/src/util/redact';
import { cachingOf, headerValues } from '../../apps/desktop/backend/handlers/debugger-grid';
import { COLUMNS, columnShown, headerColumn, plainCell, DEFAULT_HIDDEN } from '../../apps/desktop/src/components/debugger/grid-columns';
import { groupKeyOf, groupRows } from '../../apps/desktop/src/components/debugger/grouping';
import type { Exchange } from '../../apps/desktop/src/components/debugger/model';
import { quickOpenRows, type QuickSources } from '../../apps/desktop/src/lib/quick-open';

const row = (o: Partial<SelectRow> = {}): SelectRow => ({ method: 'GET', url: 'http://api.test/items', host: 'api.test', responseBodyBytes: 0, ...o });
const ex = (o: Partial<DebuggerExchange> = {}): DebuggerExchange => ({
  id: 'e1',
  startedAt: '2026-10-28T10:00:00.000Z',
  kind: 'http',
  method: 'GET',
  url: 'http://api.test/items',
  host: 'api.test',
  clientPort: 1,
  requestHeaders: {},
  requestBodyBytes: 0,
  responseBodyBytes: 0,
  ...o,
});
const lean = (o: Partial<Exchange> = {}) => ex(o) as unknown as Exchange;

describe('FG-3 select by condition: the grammar', () => {
  it('reads clauses joined by and, &&, & or ;', () => {
    const p = parseWhere('status>=400 and host~api && size>200kb; method=POST');
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.clauses.map((c) => `${c.field}${c.op}${c.value}`)).toEqual(['status>=400', 'host~api', 'size>200kb', 'method=POST']);
  });

  it('says what is wrong in words a person can fix', () => {
    const bad = (t: string) => {
      const p = parseWhere(t);
      return p.ok ? '' : p.error;
    };
    expect(bad('')).toMatch(/Write a condition/);
    expect(bad('flavour=red')).toMatch(/not a field/);
    expect(bad('status')).toMatch(/operator/);
    expect(bad('status=')).toMatch(/needs a value/);
    expect(bad('size>big')).toMatch(/not a number/);
    expect(bad('host>3')).toMatch(/text/);
    expect(bad('status=404 host=x')).toMatch(/Join conditions with "and"/);
    expect(bad('status=404 and')).toMatch(/missing/);
    expect(bad('url="abc')).toMatch(/not closed/);
  });

  it('compares numbers as numbers, sizes with units, statuses by class, text without case', () => {
    const rows: SelectRow[] = [
      row({ status: 200, responseBodyBytes: 100, durationMs: 50 }),
      row({ status: 404, responseBodyBytes: 300 * 1024, durationMs: 2500, host: 'Cdn.Test' }),
      row({ status: 503, error: undefined, responseBodyBytes: 5, durationMs: 10, method: 'POST', application: 'Chrome' }),
      row({ error: 'ECONNRESET' }),
    ];
    const n = (w: string) => selectRows(rows, w).length;
    expect(n('status>=400')).toBe(2);
    expect(n('status=4xx')).toBe(1);
    expect(n('status=5xx')).toBe(1);
    expect(n('status=error')).toBe(1);
    expect(n('size>200kb')).toBe(1);
    expect(n('time>2s')).toBe(1);
    expect(n('time<=50ms')).toBe(2);
    expect(n('host=cdn.test')).toBe(1);
    expect(n('app~chro')).toBe(1);
    expect(n('method!=GET')).toBe(1);
    expect(n('url^=http://api')).toBe(4);
    expect(n('url$=/items and status<300')).toBe(1);
    expect(n('url!~zzz')).toBe(4);
    // a row without a status is not "not 200" in a way that hides it from !=
    expect(n('status!=200')).toBe(3);
  });

  it('whereText writes the conditions the parser reads back', () => {
    const p = parseWhere('note~"two words" and status>=400');
    expect(p.ok && whereText(p.clauses)).toBe('note~"two words" and status>=400');
    expect(selectRows([row({ note: 'has two words in it' }), row({ note: 'one' })], 'note~"two words"')).toHaveLength(1);
  });

  it('compiles once and tests many rows fast', () => {
    const p = parseWhere('status>=400 and host~api and size>1kb');
    if (!p.ok) throw new Error(p.error);
    const test = compileWhere(p.clauses);
    const rows = Array.from({ length: 50_000 }, (_, i) => row({ status: i % 2 ? 500 : 200, responseBodyBytes: i, host: 'api.test' }));
    const t = performance.now();
    const hits = rows.filter(test).length;
    expect(performance.now() - t).toBeLessThan(250);
    expect(hits).toBeGreaterThan(20_000);
  });
});

describe('FG-3 the command bar', () => {
  it('has the ten verbs and no more', () => {
    expect(COMMAND_HELP).toHaveLength(10);
  });

  it('maps each verb to an action, never a second implementation', () => {
    expect(parseCommand('?login')).toEqual({ ok: true, command: { verb: 'filter', text: 'login' } });
    expect(parseCommand('>200kb')).toMatchObject({ ok: true, command: { verb: 'select', where: 'size>200kb' } });
    expect(parseCommand('<5kb')).toMatchObject({ ok: true, command: { verb: 'select', where: 'size<5kb' } });
    expect(parseCommand('=404')).toMatchObject({ ok: true, command: { verb: 'select', where: 'status=404' } });
    expect(parseCommand('@api.test')).toMatchObject({ ok: true, command: { verb: 'select', where: 'host~api.test' } });
    expect(parseCommand('select status>=400 and host~api')).toMatchObject({ ok: true, command: { verb: 'select', where: 'status>=400 and host~api' } });
    expect(parseCommand('bp /orders')).toEqual({ ok: true, command: { verb: 'breakpoint', url: '/orders' } });
    expect(parseCommand('delete')).toEqual({ ok: true, command: { verb: 'delete' } });
    expect(parseCommand('clear')).toEqual({ ok: true, command: { verb: 'clear' } });
    expect(parseCommand('hosts')).toEqual({ ok: true, command: { verb: 'hosts' } });
  });

  it('refuses what it does not know, with the list', () => {
    const bad = (t: string) => {
      const p = parseCommand(t);
      return p.ok ? '' : p.error;
    };
    expect(bad('')).toMatch(/Type a command/);
    expect(bad('fly')).toMatch(/not a command/);
    expect(bad('?')).toMatch(/needs a text/);
    expect(bad('bp')).toMatch(/needs part of a URL/);
    expect(bad('>big')).toMatch(/not a number/);
    expect(bad('select')).toMatch(/Write a condition/);
  });

  it('is a mode of the command palette: ! lists the verbs, a line becomes one row, and it says to open the Debugger first when it is not on screen', () => {
    const run = vi.fn();
    const sources = (on: boolean): QuickSources => ({
      recent: [],
      commands: [],
      here: [],
      environments: [],
      open: vi.fn(),
      switchEnvironment: vi.fn(),
      ask: vi.fn(),
      setQuery: vi.fn(),
      noun: () => '',
      ...(on ? { debuggerCommands: { describe: (c) => `do ${c.verb}`, run } } : {}),
    });
    const help = quickOpenRows('!', sources(true));
    expect(help.rows).toHaveLength(10);
    const line = quickOpenRows('!=404', sources(true));
    expect(line.rows).toHaveLength(1);
    line.rows[0]!.run();
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ verb: 'select' }));
    expect(quickOpenRows('!fly', sources(true)).empty).toMatch(/not a command/);
    expect(quickOpenRows('!', sources(false)).empty).toMatch(/Open the HTTP Debugger first/);
  });
});

describe('FG-17 grouping in the grid', () => {
  const rows = [
    lean({ id: 'a', seq: 1, host: 'a.test', status: 200, responseBodyBytes: 10, application: 'chrome', connectionId: 'c-1' }),
    lean({ id: 'b', seq: 2, host: 'b.test', status: 500, responseBodyBytes: 20, application: 'curl', connectionId: 'c-2' }),
    lean({ id: 'c', seq: 3, host: 'a.test', status: 404, responseBodyBytes: 30, application: 'chrome', connectionId: 'c-1' }),
    lean({ id: 'd', seq: 4, host: 'b.test', responseBodyBytes: 0, clientPort: 77 }),
  ];

  it('puts a header line before each group, in order of first appearance, with counts, failures and bytes', () => {
    const g = groupRows(rows, 'domain', new Set());
    expect(g.groups).toBe(2);
    expect(g.items.map((i) => ('group' in i ? `[${i.label} ${i.count} ${i.errors} ${i.bytes}]` : i.id))).toEqual(['[a.test 2 1 40]', 'a', 'c', '[b.test 2 1 20]', 'b', 'd']);
    expect(g.order.map((r) => r.id)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('a collapsed group is its header alone, and the order still lists its rows (arrow keys open it)', () => {
    const g = groupRows(rows, 'domain', new Set(['a.test']));
    expect(g.items.map((i) => ('group' in i ? i.label : i.id))).toEqual(['a.test', 'b.test', 'b', 'd']);
    expect(g.order).toHaveLength(4);
    expect(groupKeyOf(rows[0]!, 'domain')).toBe('a.test');
  });

  it('groups by application (a program that is unknown has a group) and by connection', () => {
    expect(groupRows(rows, 'application', new Set()).items.filter((i) => 'group' in i).map((i) => (i as { label: string }).label)).toEqual(['chrome', 'curl', 'Unknown program']);
    const c = groupRows(rows, 'connection', new Set());
    expect(c.groups).toBe(3);
  });

  it('none leaves the rows as they are, without a copy', () => {
    const g = groupRows(rows, 'none', new Set());
    expect(g.items).toBe(rows);
    expect(g.groups).toBe(0);
  });

  it('50,000 rows group in a few milliseconds, inside the grid budget', () => {
    const big = Array.from({ length: 50_000 }, (_, i) => lean({ id: `r${i}`, seq: i, host: `h${i % 40}.test`, responseBodyBytes: i, status: i % 7 ? 200 : 500 }));
    const t = performance.now();
    const g = groupRows(big, 'domain', new Set());
    const took = performance.now() - t;
    expect(g.groups).toBe(40);
    expect(g.items).toHaveLength(50_040);
    expect(took).toBeLessThan(150);
  });
});

describe('FG-12 columns', () => {
  it('has the missing built-ins, hidden until asked for even when an older choice of hidden columns is saved', () => {
    for (const id of ['caching', 'encoding', 'port', 'protocol', 'tls'] as const) {
      expect(COLUMNS.some((c) => c.id === id)).toBe(true);
      expect(columnShown(id, DEFAULT_HIDDEN, [])).toBe(false);
      expect(columnShown(id, [], [id])).toBe(true);
    }
    expect(columnShown('url', DEFAULT_HIDDEN, [])).toBe(true);
    expect(columnShown('comment', DEFAULT_HIDDEN, [])).toBe(false);
  });

  it('reads the new cells from the row', () => {
    const e = lean({ caching: 'max-age=60', contentEncoding: 'gzip', clientPort: 5123, url: 'https://x.test/a', tls: true });
    expect(plainCell('caching', e)).toBe('max-age=60');
    expect(plainCell('encoding', e)).toBe('gzip');
    expect(plainCell('port', e)).toBe('5123');
    expect(plainCell('protocol', e)).toBe('https');
    expect(plainCell('tls', e)).toBe('decrypted');
    expect(plainCell('tls', lean({ kind: 'tunnel', url: 'x:443' }))).toBe('tunnel');
  });

  it('a header column sorts by the header the backend put on the row', () => {
    const col = headerColumn({ name: 'X-Request-Id', side: 'response' });
    expect(col.id).toBe('h:response:x-request-id');
    expect(col.sort(lean({ headerValues: { 'response:x-request-id': 'abc' } }))).toBe('abc');
    expect(col.sort(lean())).toBe('');
  });

  it('the backend carries header values, masks a secret header and cuts a long one; caching and encoding come from the response', () => {
    const be = { logger: { redactor: new Redactor() } } as never;
    const v = headerValues(be, [{ name: 'X-Request-Id', side: 'response' }, { name: 'Authorization', side: 'request' }, { name: 'X-Missing', side: 'response' }], { authorization: 'Bearer abc' }, { 'x-request-id': 'r-' + 'x'.repeat(300) });
    expect(v['response:x-request-id']).toHaveLength(200);
    expect(v['request:authorization']).toBe('***');
    expect(v['response:x-missing']).toBeUndefined();
    expect(cachingOf({ 'cache-control': 'no-store', 'content-encoding': 'br' })).toEqual({ caching: 'no-store', contentEncoding: 'br' });
    expect(cachingOf({ etag: '"1"' })).toEqual({ caching: 'validator only' });
    expect(cachingOf(undefined)).toEqual({});
  });
});

describe('FG-2 replay many', () => {
  it('clamps what is asked to what is allowed', () => {
    expect(cleanReplayOptions({ count: 5000, concurrency: 99, delayMs: 10_000_000 })).toEqual({ count: REPLAY_MAX, concurrency: 20, delayMs: 60_000, stopOnFailure: false });
    expect(cleanReplayOptions({ count: 0 })).toMatchObject({ count: 1, concurrency: 1 });
    expect(cleanReplayOptions({ count: 3, concurrency: 10 }).concurrency).toBe(3);
    expect(cleanReplayOptions({ count: Number.NaN })).toMatchObject({ count: 1 });
  });

  it('sends N times, starts them in order, never runs more at once than asked, and keeps the results by position', async () => {
    const started: number[] = [];
    let running = 0;
    let peak = 0;
    const s = await replayMany(cleanReplayOptions({ count: 12, concurrency: 3 }), async (i) => {
      started.push(i);
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5 + ((i * 7) % 11)));
      running--;
      return { status: i % 4 === 3 ? 500 : 200, ms: 10 + i };
    });
    expect(started).toEqual([...started].sort((a, b) => a - b));
    expect(peak).toBe(3);
    expect(s.sent).toBe(12);
    expect(s.results.map((r) => r.index)).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(s.statuses).toEqual({ '200': 9, '500': 3 });
    expect(s.failed).toBe(3);
    expect(s.minMs).toBe(10);
    expect(s.maxMs).toBe(21);
    expect(s.p50Ms).toBe(15);
  });

  it('stops starting sends after the first failure when asked, and says how many were skipped', async () => {
    const s = await replayMany(cleanReplayOptions({ count: 10, stopOnFailure: true }), async (i) => ({ status: i === 3 ? 500 : 200, ms: 1 }));
    expect(s.sent).toBe(4);
    expect(s.skipped).toBe(6);
    expect(s.stoppedAt).toBe(4);
    expect(s.failed).toBe(1);
  });

  it('a send that throws is a result with an error, not a crash', async () => {
    const s = await replayMany(cleanReplayOptions({ count: 3 }), async (i) => {
      if (i === 1) throw new Error('boom');
      return { status: 200, ms: 1 };
    });
    expect(s.statuses).toEqual({ '200': 2, error: 1 });
    expect(s.results[1]).toMatchObject({ error: 'boom' });
  });

  it('waits between sends of a lane', async () => {
    const t = Date.now();
    await replayMany(cleanReplayOptions({ count: 3, delayMs: 30 }), async () => ({ status: 200, ms: 0 }));
    expect(Date.now() - t).toBeGreaterThanOrEqual(55);
  });

  it('summarises nothing sent without inventing times', () => {
    const s = summarizeReplay(3, [undefined, undefined, undefined]);
    expect(s).toMatchObject({ sent: 0, skipped: 3, results: [] });
    expect(s.minMs).toBeUndefined();
  });

  it('the request is the exchange without the proxy’s own headers; hosts on this computer are local', () => {
    const r = requestOfExchange(ex({ method: 'POST', requestHeaders: { host: 'x', 'content-length': '2', 'content-type': 'application/json', 'x-a': '1', 'proxy-connection': 'k' }, requestBody: '{}' }));
    expect(r.headers.map((h) => h.key)).toEqual(['content-type', 'x-a']);
    expect(r.body).toEqual({ type: 'json', content: '{}' });
    for (const h of ['localhost:3000', '127.0.0.1', '[::1]:8080', 'api.test', 'a.localhost']) expect(isReplayLocalHost(h)).toBe(true);
    for (const h of ['example.com', 'api.example.com:443', '10.0.0.5']) expect(isReplayLocalHost(h)).toBe(false);
  });
});

describe('FG-16 the process picker', () => {
  it('reads netstat, tasklist and lsof', () => {
    const net = '  Proto  Local Address          Foreign Address        State           PID\n  TCP    10.0.0.2:50000   1.2.3.4:443   ESTABLISHED   42\n  TCP    10.0.0.2:50001   1.2.3.4:443   ESTABLISHED   42\n  TCP    0.0.0.0:80   0.0.0.0:0   LISTENING   7\n  TCP    10.0.0.2:50002   5.6.7.8:443   ESTABLISHED   0\n  TCP    10.0.0.2:50003   5.6.7.8:443   ESTABLISHED   9\n';
    expect([...parseNetstat(net)]).toEqual([
      [42, 2],
      [9, 1],
    ]);
    const names = parseTasklist('"chrome.exe","42","Console","1","10 K"\r\n"node.exe","9","Console","1","1 K"\r\n');
    expect(names.get(42)).toBe('chrome');
    const ps = groupPrograms([...parseNetstat(net)].map(([pid, connections]) => ({ pid, name: names.get(pid)!, connections })));
    expect(ps).toEqual([
      { name: 'chrome', pids: [42], connections: 2 },
      { name: 'node', pids: [9], connections: 1 },
    ]);
    const lsof = 'p100\ncfirefox\nf30\nf31\np200\ncslack\nf9\n';
    expect(parseLsof(lsof)).toEqual([
      { pid: 100, name: 'firefox', connections: 2 },
      { pid: 200, name: 'slack', connections: 1 },
    ]);
  });
  it('groups the processes of a program under one name, the busiest first', () => {
    expect(
      groupPrograms([
        { pid: 1, name: 'chrome', connections: 1 },
        { pid: 2, name: 'chrome', connections: 4 },
        { pid: 3, name: 'curl', connections: 2 },
      ]),
    ).toEqual([
      { name: 'chrome', pids: [1, 2], connections: 5 },
      { name: 'curl', pids: [3], connections: 2 },
    ]);
  });
});

describe('the MCP tools: where, columns, snippet, replay, programs', () => {
  const run = async (tools: ReturnType<typeof debuggerTools>, name: string, args: Record<string, unknown>) => (await tools.find((t) => t.name === name)!.run(args)) as Record<string, any>;
  const session = (): DebuggerExchange[] => [
    ex({ id: 'a', status: 200, responseBodyBytes: 10, responseHeaders: { 'x-request-id': 'r1', 'cache-control': 'no-store' } }),
    ex({ id: 'b', status: 500, responseBodyBytes: 5000, host: 'cdn.test', url: 'http://cdn.test/big', responseHeaders: { 'x-request-id': 'r2' } }),
    ex({ id: 'c', status: 404, method: 'POST', requestHeaders: { authorization: 'Bearer top-secret-value', 'content-type': 'application/json' }, requestBody: '{"a":1}' }),
  ];

  it('debugger_exchanges selects with where, adds header columns and masks secret headers', async () => {
    const t = debuggerTools({ redactor: new Redactor(), session: session() });
    const hit = await run(t, 'debugger_exchanges', { where: 'status>=400 and size>1kb', columns: ['response:X-Request-Id', 'request:authorization'] });
    expect(hit.exchanges.map((e: { id: string }) => e.id)).toEqual(['b']);
    expect(hit.exchanges[0].columns).toEqual({ 'response:x-request-id': 'r2', 'request:authorization': '***' });
    await expect(run(t, 'debugger_exchanges', { where: 'flavour=red' })).rejects.toThrow(/not a field/);
  });

  it('debugger_exchange snippet writes PowerShell, fetch and HTTPie with the secret masked', async () => {
    const t = debuggerTools({ redactor: new Redactor(), session: session() });
    for (const [language, needle] of [['powershell', 'Invoke-RestMethod'], ['fetch', 'await fetch('], ['httpie', 'http POST']] as const) {
      const r = await run(t, 'debugger_exchange', { id: 'c', action: 'snippet', language });
      expect(r.text).toContain(needle);
      expect(r.text).not.toContain('top-secret-value');
    }
    await expect(run(t, 'debugger_exchange', { id: 'c', action: 'snippet', language: 'cobol' })).rejects.toThrow();
  });

  it('debugger_replay sends N times to a local server, counts the statuses, and asks before a host that is not local', async () => {
    let hits = 0;
    const api = createServer((_req, res) => {
      hits++;
      res.writeHead(hits % 5 === 0 ? 500 : 200).end('ok');
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
    const port = (api.address() as { port: number }).port;
    try {
      const s = [ex({ id: 'l', url: `http://127.0.0.1:${port}/x`, host: `127.0.0.1:${port}` }), ex({ id: 'r', url: 'http://example.invalid/x', host: 'example.invalid' })];
      const t = debuggerTools({ redactor: new Redactor(), session: s });
      const out = await run(t, 'debugger_replay', { ids: ['l'], times: 10, concurrency: 2 });
      expect(out.sent).toBe(10);
      expect(hits).toBe(10);
      expect(out.statuses).toEqual({ '200': 8, '500': 2 });
      expect(out.options).toMatchObject({ count: 10, concurrency: 2 });
      await expect(run(t, 'debugger_replay', { ids: ['r'], times: 5 })).rejects.toThrow(/not on this computer/);
      await expect(run(t, 'debugger_replay', { ids: ['nope'] })).rejects.toThrow(/No exchange/);
      const ro = debuggerTools({ redactor: new Redactor(), session: s, readOnly: true });
      await expect(run(ro, 'debugger_replay', { ids: ['l'] })).rejects.toThrow(/read-only/);
    } finally {
      await new Promise((r) => api.close(r));
    }
  });

  it('debugger_programs lists programs by name (the system decides which)', async () => {
    const t = debuggerTools({ redactor: new Redactor(), session: [] });
    const r = await run(t, 'debugger_programs', {});
    expect(Array.isArray(r.programs)).toBe(true);
    for (const p of r.programs) expect(p).toMatchObject({ name: expect.any(String), pids: expect.any(Array), connections: expect.any(Number) });
  });
});
