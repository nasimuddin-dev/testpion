import { describe, expect, it } from 'vitest';
import { HISTORY_KINDS, REQUEST_HISTORY_KINDS, historyOk, isRequestEntry, summarizeActivity } from '@testpion/core';

const now = Date.parse('2026-10-01T12:00:00Z');

describe('workspace activity', () => {
  it('decides which statuses failed', () => {
    expect(historyOk(200)).toBe(true);
    expect(historyOk('304')).toBe(true);
    expect(historyOk(404)).toBe(false);
    expect(historyOk('network')).toBe(false);
    expect(historyOk('OK')).toBe(true);
    expect(historyOk('UNAVAILABLE')).toBe(false);
    expect(historyOk('error')).toBe(false);
    expect(historyOk(undefined)).toBe(true);
  });

  it('buckets requests and runs per day, oldest first', () => {
    const a = summarizeActivity(
      [
        { timestamp: '2026-10-01T10:00:00Z', kind: 'http', name: 'a', status: 200, durationMs: 100 },
        { timestamp: '2026-10-01T11:00:00Z', kind: 'http', name: 'a', status: 500, durationMs: 300 },
        { timestamp: '2026-09-30T11:00:00Z', kind: 'grpc', name: 'b', status: 'OK', durationMs: 50 },
        { timestamp: '2026-08-01T11:00:00Z', kind: 'http', name: 'old', status: 200 },
      ],
      [{ startedAt: '2026-10-01T09:00:00Z', total: 10, passed: 8, failed: 1, errors: 1 }],
      { days: 7, now },
    );
    expect(a.days).toHaveLength(7);
    expect(a.days[6]).toMatchObject({ day: '2026-10-01', requests: 2, failedRequests: 1, medianMs: 200, runs: 1, failedRuns: 1, tests: 10, failedTests: 2 });
    expect(a.days[5]).toMatchObject({ day: '2026-09-30', requests: 1, failedRequests: 0, medianMs: 50 });
    expect(a.medianMs).toBe(100);
    expect(a.byKind).toEqual({ http: 2, grpc: 1 });
    expect(a.slowest[0]).toEqual({ name: 'a', kind: 'http', durationMs: 200, count: 2 });
  });

  it('follows the caller time zone', () => {
    // 2026-10-01T02:00Z is still Sep 30 in PDT (offset 420)
    const a = summarizeActivity([{ timestamp: '2026-10-01T02:00:00Z', kind: 'http', name: 'x', status: 200 }], [], { days: 3, tzOffsetMin: 420, now });
    expect(a.days.map((d) => d.day)).toEqual(['2026-09-29', '2026-09-30', '2026-10-01']);
    expect(a.days[1]!.requests).toBe(1);
  });
});

describe('request stats', () => {
  it('summarises the responses of each saved request, newest first', async () => {
    const { summarizeRequestStats } = await import('@testpion/core');
    const out = summarizeRequestStats([
      { requestId: 'a', timestamp: '2026-10-01T03:00:00Z', status: 500, durationMs: 300 },
      { requestId: 'a', timestamp: '2026-10-01T02:00:00Z', status: 200, durationMs: 100 },
      { requestId: 'b', timestamp: '2026-10-01T01:00:00Z', status: 200, durationMs: 50 },
      { timestamp: '2026-10-01T00:00:00Z', status: 200 },
    ]);
    expect(out).toEqual([
      { requestId: 'a', count: 2, failed: 1, lastStatus: 500, lastAt: '2026-10-01T03:00:00Z', lastOk: false, medianMs: 200, recent: ['passed', 'failed'] },
      { requestId: 'b', count: 1, failed: 0, lastStatus: 200, lastAt: '2026-10-01T01:00:00Z', lastOk: true, medianMs: 50, recent: ['passed'] },
    ]);
  });
});

describe('request health with checks', () => {
  it("counts a response as fine when its own checks passed (an expected 404), and as failing when they did not", async () => {
    const { summarizeRequestStats } = await import('@testpion/core');
    const out = summarizeRequestStats([
      { requestId: 'notfound', timestamp: '2026-10-01T02:00:00Z', status: 404, checksOk: true },
      { requestId: 'wrong', timestamp: '2026-10-01T01:00:00Z', status: 200, checksOk: false },
    ]);
    expect(out.map((s) => [s.requestId, s.lastOk, s.failed, s.recent])).toEqual([
      ['notfound', true, 0, ['passed']],
      ['wrong', false, 1, ['failed']],
    ]);
  });
});

describe('history: failed only', () => {
  it('lists only the responses that failed (SQLite and JSONL stores agree)', async () => {
    const { openMetaStore } = await import('@testpion/core');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'tp-hist-'));
    try {
      const m = openMetaStore(dir);
      const add = (id: string, status: number | string | undefined) => m.addHistory({ id, timestamp: `2026-10-01T00:00:0${id}Z`, kind: 'http', name: id, status });
      add('1', 200);
      add('2', 404);
      add('3', 'NetworkError');
      add('4', 'OK');
      add('5', 'UNAVAILABLE');
      add('6', 302);
      add('7', undefined);
      expect(m.listHistory({ failed: true }).items.map((h) => h.id).sort()).toEqual(['2', '3', '5']);
      expect(m.listHistory({ failed: true }).total).toBe(3);
      m.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// a Debugger capture session in History (kind `capture`) is not a request sent: request statistics leave it out everywhere
describe('request statistics count requests only', () => {
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const requests = [
    { id: 'r1', timestamp: ago(30), kind: 'http' as const, name: 'List patients', status: 200, durationMs: 120, collectionId: 'c', requestId: 'q1' },
    { id: 'r2', timestamp: ago(25), kind: 'grpc' as const, name: 'Hello', status: 'OK', durationMs: 40, collectionId: 'c', requestId: 'q2' },
  ];
  const capture = { id: 'cap-1', timestamp: ago(5), kind: 'capture' as const, name: 'Saved as a collection: localhost (12 exchanges)', url: 'localhost', status: 'saved', durationMs: 73_000, collectionId: 'c', requestId: 'q1' };

  it('gives the same activity with or without a capture session', () => {
    const at = { days: 7, now: Date.now() };
    expect(summarizeActivity([...requests, capture], [], at)).toEqual(summarizeActivity(requests, [], at));
    expect(summarizeActivity([capture], [], at).byKind).toEqual({});
    expect([isRequestEntry(capture), isRequestEntry(requests[0]!), isRequestEntry({ kind: 'some-future-kind' })]).toEqual([false, true, false]);
    expect(HISTORY_KINDS).toContain('capture');
    expect(REQUEST_HISTORY_KINDS).not.toContain('capture');
  });

  it('in the store: activity, request stats, collection health and requests-only lists agree; the stats cache still sees the change', async () => {
    const { openMetaStore } = await import('@testpion/core');
    const { collectionsHealth } = await import('../../apps/desktop/backend/stats-cache');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dirs = [mkdtempSync(join(tmpdir(), 'tp-cap-a-')), mkdtempSync(join(tmpdir(), 'tp-cap-b-'))];
    try {
      const [withCap, without] = dirs.map((d) => openMetaStore(d));
      for (const e of requests) (withCap!.addHistory(e), without!.addHistory(e));
      const ws = { meta: withCap! } as never;
      const before = collectionsHealth(ws);
      withCap!.addHistory(capture);
      const stats = (m: typeof without) => ({ requests: m!.requestStats('c'), health: m!.historyByCollection(), sent: m!.listHistory({ requests: true }).items.map((h) => h.id) });
      expect(stats(withCap)).toEqual(stats(without));
      const a = withCap!.activity({ days: 30 });
      expect(a.byKind).toEqual({ http: 1, grpc: 1 });
      expect(a.slowest.map((s) => s.kind)).not.toContain('capture');
      // History itself still lists the capture session
      expect(withCap!.listHistory({}).items.map((h) => h.id)).toContain('cap-1');
      // the cached health is worked out again (the history changed) and comes out the same
      const after = collectionsHealth(ws);
      expect(after).not.toBe(before);
      expect(after).toEqual(before);
      withCap!.close();
      without!.close();
    } finally {
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
    }
  });
});
