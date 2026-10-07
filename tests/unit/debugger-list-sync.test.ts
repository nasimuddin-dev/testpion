import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { Backend } from '../../apps/desktop/backend/backend.js';

// The Debugger's list stays in sync by changes: the first call brings every row (lean: header sizes, no bodies),
// later calls only the rows added or changed since; replacing or clearing the session resets the list once; the
// mock servers' requests are kept for the Incoming tab.
const home = mkdtempSync(join(tmpdir(), 'tp-dbg-sync-'));
const events: Array<{ name: string; data: any }> = [];
const be = new Backend({ appDir: home, emit: (name: string, data: unknown) => void events.push({ name, data }) });
let api: Server;
let apiPort = 0;
beforeAll(async () => {
  api = createServer((req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'));
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
  apiPort = (api.address() as { port: number }).port;
  await be.invoke('debug.start', { port: 0 });
});
afterAll(async () => {
  await be.invoke('debug.stop');
  await be.dispose();
  await new Promise<void>((r) => api.close(() => r()));
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

type Changes = { epoch: number; rev: number; reset: boolean; rows: Array<Record<string, any>>; total: number; firstSeq?: number };
const har = (n: number) =>
  JSON.stringify({
    log: {
      version: '1.2',
      creator: { name: 't', version: '1' },
      entries: Array.from({ length: n }, (_, i) => ({
        startedDateTime: new Date(Date.parse('2026-10-01T10:00:00Z') + i * 1000).toISOString(),
        time: 10,
        request: {
          method: 'GET',
          url: `http://api.test/items/${i}`,
          httpVersion: 'HTTP/1.1',
          headers: [{ name: 'authorization', value: 'Bearer secret-token' }],
          queryString: [],
          cookies: [],
          headersSize: -1,
          bodySize: 0,
        },
        response: {
          status: 200,
          statusText: 'OK',
          httpVersion: 'HTTP/1.1',
          headers: [{ name: 'content-type', value: 'application/json' }],
          cookies: [],
          content: { size: 9, mimeType: 'application/json', text: '{"id":' + i + '}' },
          redirectURL: '',
          headersSize: -1,
          bodySize: 9,
        },
        cache: {},
        timings: { send: 1, wait: 5, receive: 4 },
      })),
    },
  });

describe('the Debugger list by changes', () => {
  it('a session opens as one reset of lean rows, with # and Offset', async () => {
    await be.invoke('debug.openSession', { text: har(3) });
    const d = (await be.invoke('debug.changes', {})) as Changes;
    expect(d.reset).toBe(true);
    expect(d.rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(d.rows.map((r) => r.offsetSec)).toEqual([0, 1, 2]);
    // lean: no bodies, no header values (a captured token never travels with the list), their sizes instead
    expect(d.rows[0]!.responseBody).toBeUndefined();
    expect(d.rows[0]!.requestHeaders).toEqual({});
    expect(d.rows[0]!.requestHeaderBytes).toBeGreaterThan(20);
    expect(JSON.stringify(d)).not.toMatch(/secret-token/);
    // nothing changed: nothing comes back
    const again = (await be.invoke('debug.changes', { epoch: d.epoch, since: d.rev })) as Changes;
    expect(again).toMatchObject({ reset: false, rows: [], total: 3 });
  });

  it('a captured request comes as one row; a bookmark as that row again', async () => {
    const base = (await be.invoke('debug.changes', {})) as Changes;
    events.length = 0;
    await be.invoke('debug.selfTest', { url: `http://127.0.0.1:${apiPort}/live` });
    await new Promise((r) => setTimeout(r, 100));
    // the event is a signal, not the exchange
    const signal = events.find((e) => e.name === 'debug.exchange')!;
    expect(Object.keys(signal.data).sort()).toEqual(['id', 'phase']);
    const d = (await be.invoke('debug.changes', { epoch: base.epoch, since: base.rev })) as Changes;
    expect(d.reset).toBe(false);
    expect(d.rows).toHaveLength(1);
    expect(d.rows[0]).toMatchObject({ seq: 4, status: 200 });
    await be.invoke('debug.bookmark', { id: d.rows[0]!.id, on: true });
    const b = (await be.invoke('debug.changes', { epoch: d.epoch, since: d.rev })) as Changes;
    expect(b.rows.map((r) => [r.id, r.bookmarked])).toEqual([[d.rows[0]!.id, true]]);
  });

  it('deleting or clearing resets the list once', async () => {
    const base = (await be.invoke('debug.changes', {})) as Changes;
    await be.invoke('debug.delete', { ids: [base.rows[0]!.id] });
    const d = (await be.invoke('debug.changes', { epoch: base.epoch, since: base.rev })) as Changes;
    expect(d.reset).toBe(true);
    expect(d.rows).toHaveLength(base.rows.length - 1);
    await be.invoke('debug.clear');
    const c = (await be.invoke('debug.changes', { epoch: d.epoch, since: d.rev })) as Changes;
    expect(c).toMatchObject({ reset: true, rows: [], total: 0 });
  });

  it('rules that cannot be decided before the request goes out are refused', async () => {
    await expect(be.invoke('debug.saveRule', { rule: { kind: 'only', name: 'by ip', match: { where: { column: 'ip', op: 'equals', value: '1.2.3.4:80' } } } })).rejects.toThrow(/not known yet/);
    await expect(be.invoke('debug.saveRule', { rule: { kind: 'highlight', name: 'bad', match: { where: { column: 'url', op: 'matches', value: '(' } } } })).rejects.toThrow(/regular expression/);
    const ok = (await be.invoke('debug.saveRule', { rule: { kind: 'highlight', name: 'by ip', match: { where: { column: 'ip', op: 'equals', value: '1.2.3.4:80' } } } })) as { rule: { id: string } };
    await be.invoke('debug.deleteRule', { id: ok.rule.id });
  });

  it('a search in bodies returns ids; the list filters by program and type', async () => {
    await be.invoke('debug.openSession', { text: har(5) });
    expect(await be.invoke('debug.exchanges', { text: '"id":3', deep: true, idsOnly: true })).toHaveLength(1);
    expect(await be.invoke('debug.exchanges', { type: 'application/json', idsOnly: true })).toHaveLength(5);
    expect(await be.invoke('debug.exchanges', { type: 'text/html', idsOnly: true })).toHaveLength(0);
  });
});
