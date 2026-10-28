import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { sessionStats, DeepSearchCache, inSlices } from '../../apps/desktop/backend/handlers/debugger-stats.js';
import { expectWithin } from '../perf-budget';

/**
 * The Debugger's Statistics tab and deep search on a long session (performance review 2026-10-27, item 10): the statistics are
 * one pass (and kept until something changes), and a search in headers and bodies reads only what changed since the last one
 * and gives the main process a turn every few milliseconds.
 */
const home = mkdtempSync(join(tmpdir(), 'tp-dbg-stats-'));
const be = new Backend({ appDir: home, emit: () => undefined });
afterAll(async () => {
  await be.dispose();
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

const T0 = Date.parse('2026-10-01T10:00:00Z');
const har = (n: number, bodyChars = 0) =>
  JSON.stringify({
    log: {
      version: '1.2',
      creator: { name: 't', version: '1' },
      entries: Array.from({ length: n }, (_, i) => {
        const status = i % 17 === 0 ? 500 : i % 9 === 0 ? 404 : 200;
        const body = bodyChars ? `{"i":${i},"pad":"${'x'.repeat(bodyChars)}"${i === n - 3 ? ',"needle":"zebra-crossing"' : ''}}` : `{"id":${i}}`;
        return {
          startedDateTime: new Date(T0 + i * 37).toISOString(),
          time: 20 + (i % 300),
          request: { method: ['GET', 'POST', 'PUT', 'DELETE'][i % 4], url: `https://api-${i % 40}.example.test/v1/items/${i}?page=${i % 7}&token=abc${i}`, httpVersion: 'HTTP/1.1', headers: [{ name: 'accept', value: 'application/json' }], queryString: [], cookies: [], headersSize: -1, bodySize: 0 },
          response: { status, statusText: 'x', httpVersion: 'HTTP/1.1', headers: [{ name: 'content-type', value: i % 5 ? 'application/json; charset=utf-8' : 'text/html' }], cookies: [], content: { size: body.length, mimeType: 'application/json', text: body }, redirectURL: '', headersSize: -1, bodySize: body.length },
          cache: {},
          timings: { send: 1, wait: 10 + (i % 200), receive: 5 },
        };
      }),
    },
  });

/** The statistics as the handler computed them before (several passes and two sorts), for comparison. */
function oldStats(ex: any[], redactUrl: (u: string) => string) {
  const statusClass = (e: any) => (e.error ? 'error' : !e.status ? 'pending' : e.status < 300 ? '2xx' : e.status < 400 ? '3xx' : e.status < 500 ? '4xx' : '5xx');
  const by = (key: (e: any) => string | undefined) => {
    const m = new Map<string, { count: number; bytes: number; ms: number }>();
    for (const e of ex) {
      const k = key(e);
      if (!k) continue;
      const v = m.get(k) ?? { count: 0, bytes: 0, ms: 0 };
      v.count++;
      v.bytes += e.responseBodyBytes;
      v.ms += e.durationMs ?? 0;
      m.set(k, v);
    }
    return [...m.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.bytes - a.bytes);
  };
  const done = ex.filter((e) => e.durationMs !== undefined);
  const times = ex.map((e) => Date.parse(e.startedAt)).filter((t) => !Number.isNaN(t));
  const first = times.length ? Math.min(...times) : 0;
  const last = times.length ? Math.max(...times) : 0;
  const span = Math.max(1000, last - first);
  const buckets = Math.min(60, Math.max(10, Math.ceil(span / 1000)));
  const slice = span / buckets;
  const timeline = Array.from({ length: buckets }, (_, i) => ({ t: new Date(first + i * slice).toISOString(), count: 0, errors: 0 }));
  for (const e of ex) {
    const t = Date.parse(e.startedAt);
    if (Number.isNaN(t)) continue;
    const b = timeline[Math.min(buckets - 1, Math.floor((t - first) / slice))]!;
    b.count++;
    if (e.error || (e.status ?? 0) >= 400) b.errors++;
  }
  const statuses: Record<string, number> = {};
  for (const e of ex) statuses[statusClass(e)] = (statuses[statusClass(e)] ?? 0) + 1;
  return {
    total: ex.length,
    bytes: ex.reduce((n, e) => n + e.responseBodyBytes, 0),
    errors: ex.filter((e) => e.error || (e.status ?? 0) >= 400).length,
    firstAt: first ? new Date(first).toISOString() : undefined,
    lastAt: last ? new Date(last).toISOString() : undefined,
    timeline,
    statuses,
    hosts: by((e) => e.host).slice(0, 20),
    contentTypes: by((e) => e.contentType?.split(';')[0]?.trim()).slice(0, 20),
    applications: by((e) => e.application).slice(0, 20),
    largest: [...done].sort((a, b) => b.responseBodyBytes - a.responseBodyBytes).slice(0, 10).map((e) => ({ id: e.id, method: e.method, url: redactUrl(e.url), bytes: e.responseBodyBytes })),
    slowest: [...done].sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0)).slice(0, 10).map((e) => ({ id: e.id, method: e.method, url: redactUrl(e.url), ms: e.durationMs })),
  };
}

describe('debug.stats', () => {
  it('gives what the several passes gave, for 5,000 exchanges, in one pass and under 5 ms; unchanged, it is kept', async () => {
    await be.invoke('debug.openSession', { text: har(5000) });
    const list = (await be.invoke('debug.exchanges', { limit: 0 })) as any[];
    expect(list).toHaveLength(5000);
    // the handler's exchanges (not the lean rows)
    const exchanges = (be as any).debugger.exchanges as any[];
    const redact = (u: string) => u.replace(/token=[^&]*/, 'token=***');
    expect(sessionStats(exchanges, redact)).toEqual(JSON.parse(JSON.stringify(oldStats(exchanges, redact))));
    const times: number[] = [];
    for (let i = 0; i < 6; i++) {
      const t0 = performance.now();
      sessionStats(exchanges, redact);
      times.push(performance.now() - t0);
    }
    console.log('sessionStats of 5,000 exchanges (ms):', times.map((t) => t.toFixed(1)).join(', '));
    expectWithin(Math.min(...times), 5, 'debug.stats on 5,000 exchanges (best of 6)');
    const first = await be.invoke('debug.stats');
    expect(await be.invoke('debug.stats')).toBe(first); // nothing changed: the same answer, not computed again
    await be.invoke('debug.bookmark', { id: exchanges[0].id, on: true });
    expect(await be.invoke('debug.stats')).not.toBe(first);
  });

  it('an empty session and exchanges without a duration', () => {
    const redact = (u: string) => u;
    expect(sessionStats([], redact)).toEqual(JSON.parse(JSON.stringify(oldStats([], redact))));
    const pending = [{ id: 'a', startedAt: new Date(T0).toISOString(), kind: 'http', method: 'GET', url: 'http://x.test/', host: 'x.test', requestBodyBytes: 0, responseBodyBytes: 0, clientPort: 1, requestHeaders: {} }] as any[];
    expect(sessionStats(pending, redact)).toEqual(JSON.parse(JSON.stringify(oldStats(pending, redact))));
  });
});

describe('deep search', () => {
  it('finds the text in a body, reads only what changed the next time, and gives the loop a turn while it reads', async () => {
    await be.invoke('debug.openSession', { text: har(1500, 20_000) });
    const exchanges = (be as any).debugger.exchanges as any[];
    expect(exchanges.length).toBe(1500);
    const turns: number[] = [];
    let last = performance.now();
    const probe = setInterval(() => {
      const now = performance.now();
      turns.push(now - last);
      last = now;
    }, 5);
    const t0 = performance.now();
    const ids = (await be.invoke('debug.exchanges', { text: 'zebra-crossing', deep: true, idsOnly: true })) as string[];
    const first = performance.now() - t0;
    clearInterval(probe);
    expect(ids).toEqual([exchanges[1497].id]);
    const longest = Math.max(...turns);
    console.log(`deep search over 1,500 x 20 KB bodies: ${first.toFixed(0)} ms, longest block between ticks ${longest.toFixed(0)} ms`);
    // a second search of the same text: nothing changed, nothing is read
    const t1 = performance.now();
    expect(await be.invoke('debug.exchanges', { text: 'zebra-crossing', deep: true, idsOnly: true })).toEqual(ids);
    const second = performance.now() - t1;
    console.log(`the same search again: ${second.toFixed(1)} ms`);
    expectWithin(second, 15, 'the same deep search again');
    expect(longest).toBeLessThan(first > 100 ? first / 2 : 100);
    // a change to one exchange: it is read again, the answer follows
    await be.invoke('debug.bookmark', { id: exchanges[3].id, on: true });
    expect(await be.invoke('debug.exchanges', { text: 'zebra-crossing', deep: true, idsOnly: true })).toEqual(ids);
  });

  it('DeepSearchCache reads an exchange once per revision, again after a change or after its bodies were let go', () => {
    const c = new DeepSearchCache();
    const e = { id: 'a' } as any;
    let reads = 0;
    const scan = () => (reads++, true);
    expect(c.hit('x', e, 1, scan)).toBe(true);
    expect(c.hit('x', e, 1, scan)).toBe(true);
    expect(reads).toBe(1);
    c.hit('x', e, 2, scan);
    expect(reads).toBe(2);
    e.bodiesDropped = true;
    c.hit('x', e, 2, scan);
    expect(reads).toBe(3);
    c.hit('y', e, 2, scan); // another text starts over
    expect(reads).toBe(4);
  });

  it('inSlices hands the loop a turn while a long job runs', async () => {
    let turns = 0;
    const tick = setInterval(() => turns++, 1);
    await inSlices(Array.from({ length: 40 }), () => {
      const t = performance.now();
      while (performance.now() - t < 2);
    }, 10);
    clearInterval(tick);
    expect(turns).toBeGreaterThan(0);
  });
});
