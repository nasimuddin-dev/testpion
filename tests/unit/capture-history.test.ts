import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { captureHistoryEntry, resolveItemRef } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';

// History has a capture session per Save to collection, Create flow and Save session in the HTTP Debugger: what was
// captured (exchanges, hosts, proxy or reverse proxy, from when to when) and a ref that opens what it became.
const tmp = tempDir('tp-capture-history-');
const be = new Backend({ appDir: join(tmp.dir, 'app'), emit: () => undefined, noMonitors: true });
afterAll(async () => {
  await be.dispose();
  tmp.cleanup();
});

const har = (n: number, host = 'api.test') =>
  JSON.stringify({
    log: {
      version: '1.2',
      creator: { name: 't', version: '1' },
      entries: Array.from({ length: n }, (_, i) => ({
        startedDateTime: new Date(Date.parse('2026-10-01T10:00:00Z') + i * 1000).toISOString(),
        time: 10,
        request: { method: 'GET', url: `http://${host}/items/${i}`, httpVersion: 'HTTP/1.1', headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: 0 },
        response: {
          status: 200,
          statusText: 'OK',
          httpVersion: 'HTTP/1.1',
          headers: [{ name: 'content-type', value: 'application/json' }],
          cookies: [],
          content: { size: 2, mimeType: 'application/json', text: '{}' },
          redirectURL: '',
          headersSize: -1,
          bodySize: 2,
        },
        cache: {},
        timings: { send: 1, wait: 8, receive: 1 },
      })),
    },
  });

type Row = {
  id: string;
  kind: string;
  name: string;
  status?: string;
  capture?: { result: string; ref: Record<string, string>; exchanges: number; hosts: string[]; sources: string[]; from?: string; to?: string; items?: number };
};

describe('capture sessions in History', () => {
  it('captureHistoryEntry: counts, hosts by use, sources, the time span and the ref', () => {
    const e = captureHistoryEntry(
      [
        { startedAt: '2026-10-01T10:00:05Z', host: 'b.test' },
        { startedAt: '2026-10-01T10:00:00Z', host: 'a.test', source: 'reverse' },
        { startedAt: '2026-10-01T10:00:02Z', host: 'a.test' },
      ],
      { result: 'flow', ref: { kind: 'flow', path: 'recorded/x.yaml' }, target: 'tests/recorded/x.yaml', items: 2 },
    );
    expect(e).toMatchObject({ kind: 'capture', status: 'saved', durationMs: 5000, name: 'Flow created: tests/recorded/x.yaml (3 exchanges)', url: 'a.test, b.test' });
    expect(e.capture).toEqual({
      result: 'flow',
      ref: { kind: 'flow', path: 'recorded/x.yaml' },
      exchanges: 3,
      sources: ['proxy', 'reverse'],
      hosts: ['a.test', 'b.test'],
      from: '2026-10-01T10:00:00Z',
      to: '2026-10-01T10:00:05Z',
      items: 2,
    });
  });

  it('Save to collection, Create flow and Save session each add one, listed (brief) with what they became', async () => {
    await be.invoke('debug.openSession', { text: har(3) });
    const since = '2026-01-01T00:00:00Z';
    const col = (await be.invoke('debug.saveToCollection', { since, name: 'Captured API' })) as { collectionId: string; historyId: string };
    const flow = (await be.invoke('debug.createFlow', { since, name: 'Captured flow' })) as { path: string; historyId: string };
    const ses = (await be.invoke('debug.saveSession', { name: 'morning capture' })) as { name: string; historyId: string };
    const list = (await be.invoke('history.list', { kind: 'capture' })) as { items: Row[] };
    const byId = new Map(list.items.map((r) => [r.id, r]));
    expect(byId.get(col.historyId)?.capture).toMatchObject({
      result: 'collection',
      ref: { kind: 'collection', collectionId: col.collectionId },
      exchanges: 3,
      hosts: ['api.test'],
      sources: ['proxy'],
    });
    expect(byId.get(flow.historyId)?.capture).toMatchObject({ result: 'flow', ref: { kind: 'flow', path: flow.path } });
    expect(byId.get(ses.historyId)?.capture).toMatchObject({ result: 'session', ref: { kind: 'capture', name: 'morning capture' } });
    // a saved session is an outcome, not a failure; the refs resolve (the saved session's HAR file is there)
    const failed = (await be.invoke('history.list', { kind: 'capture', failed: true })) as { items: Row[] };
    expect(failed.items).toEqual([]);
    expect(resolveItemRef(be.ws, { kind: 'capture', name: 'morning capture' })).toMatchObject({ ok: true, label: 'morning capture' });
    expect(resolveItemRef(be.ws, { kind: 'capture', name: 'never saved' })).toMatchObject({ ok: false, reason: 'missing' });
  });

  it('debug.view: a saved session on screen in its tab; the live capture is untouched; selections refer to the one shown', async () => {
    await be.invoke('debug.openSession', { text: har(2, 'live.test') }); // the live capture
    const liveIds = be.debugger!.exchanges.map((e) => e.id);
    expect(await be.invoke('debug.view', { session: 'morning capture' })).toMatchObject({ viewing: expect.stringContaining('morning capture.har') });
    const shown = (await be.invoke('debug.changes', {})) as { reset: boolean; rows: Array<{ id: string; url: string }>; total: number };
    expect(shown.total).toBe(3);
    expect(shown.rows.every((r) => r.url.includes('api.test'))).toBe(true);
    // Create flow / Save to collection take the rows of the session on screen
    const flow = (await be.invoke('debug.createFlow', { ids: shown.rows.map((r) => r.id), dryRun: true })) as { steps: unknown[] };
    expect(flow.steps.length).toBeGreaterThan(0);
    // clearing the saved session's tab clears what is shown, never the live capture or the file
    await be.invoke('debug.clear');
    expect(((await be.invoke('debug.changes', {})) as { total: number }).total).toBe(0);
    await be.invoke('debug.view', {});
    expect(be.debugger!.exchanges.map((e) => e.id)).toEqual(liveIds);
    const back = (await be.invoke('debug.changes', { epoch: 0 })) as { total: number; rows: Array<{ url: string }> };
    expect(back.total).toBe(2);
    expect(back.rows.every((r) => r.url.includes('live.test'))).toBe(true);
    await expect(be.invoke('debug.view', { session: 'never saved' })).rejects.toThrow(/No saved session/);
  });

  it('MCP history_list gives agents the same, and a dry run adds nothing', async () => {
    const before = ((await be.invoke('history.list', { kind: 'capture' })) as { items: Row[] }).items.length;
    await be.invoke('debug.createFlow', { since: '2026-01-01T00:00:00Z', name: 'Preview only', dryRun: true });
    expect(((await be.invoke('history.list', { kind: 'capture' })) as { items: Row[] }).items.length).toBe(before);
    const { historyTools } = await import('../../packages/core/src/mcp-server/history-tools.js');
    const tool = historyTools({ store: be.ws, redactor: be.logger.redactor, findCollection: () => undefined as never, findRequest: () => undefined as never }).find((t) => t.name === 'history_list')!;
    const rows = (await tool.run({ kind: 'capture', limit: 10 })) as Row[];
    expect(rows.length).toBe(before);
    expect(rows.every((r) => r.kind === 'capture' && r.capture?.ref)).toBe(true);
  });
});
