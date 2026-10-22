import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { CRASH_WINDOW_MS, crashMessage, onRendererCrash } from '../../apps/desktop/electron/crash-recovery.js';
import { ApsError, WorkspaceStore, isDeviceFileName, normalizeError, openMetaStore, slugify } from '../../packages/core/src/index.js';
import { AI_TIMEOUT_DEFAULTS, doFetch, postJson, setAiTimeouts, sseEvents } from '../../packages/core/src/ai/http.js';
import { runCliSync, tempDir } from '../helpers.js';

/** The robustness review of 2026-10-22 (planning/review-2026-10-22-robustness.md): one test per fix. */
const open: Backend[] = [];
type Event = { channel: string; payload: Record<string, unknown> };
function fresh() {
  const home = mkdtempSync(join(tmpdir(), 'tp-robust-fix-'));
  const events: Event[] = [];
  const be = new Backend({ appDir: home, emit: (channel, payload) => events.push({ channel, payload: payload as Record<string, unknown> }), noMonitors: true });
  open.push(be);
  const root = (be as unknown as { store: { root: string } }).store.root;
  const call = (m: string, p: unknown = {}) => Promise.resolve().then(() => be.invoke(m, p));
  return { be, root, call, home, events };
}
afterEach(async () => {
  for (const be of open.splice(0)) await be.dispose();
});

let server: Server | undefined;
afterAll(() => {
  server?.closeAllConnections();
  server?.close();
});
async function slowServer(): Promise<string> {
  server = createServer((req, res) => {
    if (req.url?.startsWith('/stall')) {
      // an event stream that sends one event and then nothing
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"n":1}\n\n');
    } else if (req.url?.startsWith('/ok')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    }
    /* /hang: never answers */
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const col = (id: string, url: string) => ({
  schemaVersion: '1.0',
  id,
  name: id,
  version: 0,
  variables: [],
  updatedAt: '',
  items: [{ kind: 'http', id: 'r1', name: 'r1', request: { method: 'GET', url, headers: [], params: [] } }],
});

describe('C-1 a workspace switch during a run', () => {
  it('stops the run, lets it write its results and history row, and only then closes the store', async () => {
    const base = await slowServer();
    const { be, root, call, home, events } = fresh();
    await call('col.save', col('slow', `${base}/hang`));
    const { runId } = (await call('col.run', { collectionId: 'slow' })) as { runId: string };
    await new Promise((r) => setTimeout(r, 300)); // the request is in flight
    const other = WorkspaceStore.create(join(home, 'other-ws'), 'Other');
    const unhandled: unknown[] = [];
    const onRejection = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onRejection);
    be.openStore(other.root);
    other.close();
    const t0 = Date.now();
    while (!events.some((e) => e.channel === 'run.finished' && e.payload.runId === runId) && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 25));
    await new Promise((r) => setTimeout(r, 200)); // the old store is closed right after
    process.off('unhandledRejection', onRejection);
    const finished = events.find((e) => e.channel === 'run.finished' && e.payload.runId === runId);
    expect(finished?.payload.cancelled).toBe(true);
    expect(events.filter((e) => e.channel === 'run.error')).toEqual([]);
    expect(unhandled).toEqual([]);
    // the run is in the old workspace's history (reopened to look)
    const old = WorkspaceStore.open(root);
    expect(old.meta.listRuns().items.map((r) => r.id)).toContain(runId);
    old.close();
  }, 30_000);
});

describe('R-1 the collection view cache', () => {
  it('keeps one entry per collection however often it is saved', () => {
    const dir = tempDir('tp-views-');
    const ws = WorkspaceStore.create(join(dir.dir, 'w'), 'W');
    const c = ws.saveCollection({ ...(col('a', 'http://x/') as never) });
    let cur = c;
    for (let i = 0; i < 200; i++) {
      cur = ws.saveCollection({ ...cur, name: `a${i}` });
      expect(ws.collectionView('a').name).toBe(`a${i}`);
    }
    expect(ws.viewCount).toBe(1);
    ws.deleteCollection('a');
    expect(ws.viewCount).toBe(0);
    for (let i = 0; i < 100; i++) (ws.saveCollection({ ...(col(`c${i}`, 'http://x/') as never) }), ws.collectionView(`c${i}`));
    expect(ws.viewCount).toBeLessThanOrEqual(64);
    ws.close();
    dir.cleanup();
  });
});

describe('C-2 a stale whole-collection save', () => {
  it('is refused when the caller says which version it read and a newer one exists', () => {
    const dir = tempDir('tp-stale-');
    const ws = WorkspaceStore.create(join(dir.dir, 'w'), 'W');
    const v1 = ws.saveCollection(col('a', 'http://x/') as never);
    const v2 = ws.saveCollection({ ...v1, name: 'theirs' }); // another window saved meanwhile
    let err: unknown;
    try {
      ws.saveCollection({ ...v1, name: 'mine' }, { expectedVersion: v1.version });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ kind: 'ConflictError', details: { code: 'Conflict', theirs: v2.version, mine: v1.version } });
    expect(ws.getCollection('a').name).toBe('theirs');
    expect(ws.saveCollection({ ...v2, name: 'merged' }, { expectedVersion: v2.version }).name).toBe('merged'); // a current copy saves
    ws.close();
    dir.cleanup();
  });
});

describe('E-4 bookkeeping after a response that arrived', () => {
  it('a full disk while writing the history row does not lose the response, and says so once', async () => {
    const base = await slowServer();
    const { be, call, events } = fresh();
    be.ws.meta.addHistory = () => {
      throw Object.assign(new Error('write failed'), { code: 'ENOSPC' });
    };
    const send = () =>
      call('http.send', { request: { method: 'GET', url: `${base}/ok`, headers: [], params: [] } }) as Promise<{
        response?: { status: number };
        error?: unknown;
        recording?: Array<{ what: string; reason: string }>;
      }>;
    const r = await send();
    expect(r.error).toBeUndefined();
    expect(r.response?.status).toBe(200);
    expect(r.recording?.[0]?.what).toBe('history entry');
    await send();
    expect(events.filter((e) => e.channel === 'workspace.problem')).toHaveLength(1); // not a toast per send
  });

  it('a failure after the body arrived still records a history row that points at the body file', async () => {
    const base = await slowServer();
    const { be, call, root } = fresh();
    const r = (await call('http.send', { request: { method: 'GET', url: `${base}/ok`, headers: [], params: [] }, testScript: 'throw new Error("boom")' })) as { error?: unknown; response?: unknown };
    void r;
    const rows = be.ws.meta.listHistory().items;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) if (row.payloadPath) expect(existsSync(resolve(root, row.payloadPath))).toBe(true);
  });
});

describe('E-6 disk errors are named', () => {
  it.each([
    ['ENOSPC', 'ConfigurationError', /disk is full/i],
    ['EROFS', 'ConfigurationError', /read-only/i],
    ['ENAMETOOLONG', 'ValidationError', /too long/i],
    ['EMFILE', 'ConfigurationError', /too many files/i],
  ])('%s is not a protocol error', (code, kind, text) => {
    const n = normalizeError(Object.assign(new Error('x'), { code, path: 'C:\\w\\collections\\a.json' }));
    expect(n.kind).toBe(kind);
    expect(n.message).toMatch(text);
    expect(n.message).toContain('a.json');
    expect(n.suggestions.length).toBeGreaterThan(0);
  });
});

describe('E-2 / D-2 the history database', () => {
  it('a damaged database is set aside (kept) and a new one started, never a second store', () => {
    const dir = tempDir('tp-meta-bad-');
    writeFileSync(join(dir.dir, 'database.sqlite'), 'this is not a database, it is long enough to look like one'.repeat(40));
    const meta = openMetaStore(dir.dir);
    if (meta.backend !== 'sqlite') return; // no node:sqlite here
    expect(meta.problem?.code).toBe('damaged');
    expect(meta.problem?.backup && existsSync(meta.problem.backup)).toBe(true);
    meta.addHistory({ id: 'h1', timestamp: new Date().toISOString(), kind: 'http', name: 'n', request: {} } as never);
    expect(meta.listHistory().items).toHaveLength(1);
    meta.close?.();
    expect(existsSync(join(dir.dir, 'metadata.jsonl'))).toBe(false);
    // the next open is a normal one
    const again = openMetaStore(dir.dir);
    expect(again.problem).toBeUndefined();
    expect(again.listHistory().items).toHaveLength(1);
    again.close?.();
    dir.cleanup();
  });

  it('a database written by a newer version is not touched and History is not saved to another file', () => {
    const dir = tempDir('tp-meta-new-');
    const db = new DatabaseSync(join(dir.dir, 'database.sqlite'));
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES('schema','99');");
    db.close();
    const meta = openMetaStore(dir.dir);
    expect(meta.problem?.code).toBe('newer');
    expect(meta.problem?.message).toMatch(/newer/);
    meta.close?.();
    expect(existsSync(join(dir.dir, 'metadata.jsonl'))).toBe(false);
    expect(readdirSync(dir.dir).filter((f) => f.includes('broken'))).toEqual([]);
    dir.cleanup();
  });

  it('a version 1 database is copied before it is migrated', () => {
    const dir = tempDir('tp-meta-v1-');
    const db = new DatabaseSync(join(dir.dir, 'database.sqlite'));
    db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES('schema','1');
      CREATE TABLE history (id TEXT PRIMARY KEY, ts TEXT, kind TEXT, name TEXT, method TEXT, url TEXT, status TEXT, duration REAL, size INTEGER, trace_id TEXT, payload TEXT, doc TEXT);
      CREATE TABLE runs (id TEXT PRIMARY KEY, name TEXT, started TEXT, duration REAL, total INTEGER, passed INTEGER, failed INTEGER, skipped INTEGER, errors INTEGER, environment TEXT, dir TEXT);
      CREATE TABLE traces (id TEXT PRIMARY KEY, name TEXT, kind TEXT, status TEXT, start INTEGER, duration REAL, spans INTEGER, run_id TEXT, path TEXT);`);
    db.close();
    const meta = openMetaStore(dir.dir);
    expect(meta.problem).toBeUndefined();
    expect(existsSync(join(dir.dir, 'database.sqlite.bak-v1'))).toBe(true);
    meta.close?.();
    dir.cleanup();
  });
});

describe('N-1 AI provider timeouts', () => {
  it('a provider that never answers ends with a TimeoutError, not a spinner', async () => {
    const base = await slowServer();
    const t0 = Date.now();
    const e = await postJson(`${base}/hang`, {}, {}, { provider: 'Test', timeoutMs: 300 }).catch((x) => x);
    expect(e).toBeInstanceOf(ApsError);
    expect(e.kind).toBe('TimeoutError');
    expect(Date.now() - t0).toBeLessThan(2500);
  });

  it('a stream that goes quiet delivers what it had, then a TimeoutError', async () => {
    const base = await slowServer();
    const res = await doFetch(`${base}/stall`, undefined, {}, { provider: 'Test', method: 'GET', timeoutMs: 5000 });
    const got: string[] = [];
    const e = await (async () => {
      try {
        for await (const ev of sseEvents(res, { idleMs: 300 })) got.push(ev.data);
      } catch (x) {
        return x as ApsError;
      }
    })();
    expect(got).toEqual(['{"n":1}']);
    expect(e?.kind).toBe('TimeoutError');
    expect(e?.message).toMatch(/stopped sending/);
  });

  it('the user cancel still reads as a cancel, and the limits are configurable', async () => {
    const base = await slowServer();
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 100);
    const e = await postJson(`${base}/hang`, {}, {}, { provider: 'Test', signal: ctl.signal }).catch((x) => x);
    expect(e.kind).toBe('CancelledError');
    setAiTimeouts({ requestMs: 250 });
    const t = await postJson(`${base}/hang`, {}, {}, { provider: 'Test' }).catch((x) => x);
    expect(t.kind).toBe('TimeoutError');
    setAiTimeouts(undefined);
    expect(AI_TIMEOUT_DEFAULTS.requestMs).toBeGreaterThan(0);
  });
});

describe('E-1 the CLI on a crash', () => {
  it('a rejection nobody awaits exits 3 (a crash), not 1 (a failed test), with the --json envelope', () => {
    const home = tempDir('tp-crash-');
    const r = runCliSync(['doctor', '--json'], { home: home.dir, env: { TESTPION_TEST_CRASH: 'reject' } });
    expect(r.status).toBe(3);
    const env = JSON.parse(r.out);
    expect(env.status).toBe('error');
    expect(env.errors[0].message).toMatch(/detached rejection/);
    expect(env.metrics.exit_code).toBe(3);
    home.cleanup();
  }, 60_000);
});

describe('I-1 Windows device names', () => {
  it('are never a store file name', () => {
    for (const n of ['CON', 'nul', 'Aux', 'COM1', 'lpt9', 'prn', 'con.json', 'COM0']) expect(isDeviceFileName(n)).toBe(true);
    for (const n of ['console', 'com10', 'my-con', 'nullable']) expect(isDeviceFileName(n)).toBe(false);
    for (const n of ['CON', 'nul', 'com1', 'LPT9', 'Aux.']) expect(isDeviceFileName(slugify(n))).toBe(false);
    expect(slugify('CON')).toBe('con-item');
  });

  it('a collection and an environment called CON save and read back', () => {
    const dir = tempDir('tp-con-');
    const ws = WorkspaceStore.create(join(dir.dir, 'w'), 'W');
    ws.saveCollection(col('CON', 'http://x/') as never);
    expect(ws.getCollection('CON').name).toBe('CON');
    expect(readdirSync(join(ws.root, 'collections'))).toEqual(['con-item.json']);
    ws.saveEnvironment({ id: 'NUL', name: 'NUL', variables: [] } as never);
    expect(readdirSync(join(ws.root, 'environments'))).toContain('nul-item.json');
    ws.close();
    dir.cleanup();
  });
});

describe('E-3 renderer crash recovery policy', () => {
  it('reloads the first crash, asks about a second within a minute, reloads again after a quiet minute', () => {
    const rec = { times: [] as number[] };
    expect(onRendererCrash(rec, 1000, 'crashed')).toBe('reload');
    expect(onRendererCrash(rec, 1000 + 5000, 'oom')).toBe('ask');
    expect(onRendererCrash(rec, 1000 + 5000 + CRASH_WINDOW_MS + 1, 'killed')).toBe('reload');
    expect(onRendererCrash({ times: [] }, 1, 'clean-exit')).toBe('ask');
    expect(crashMessage('renderer', { reason: 'oom', exitCode: 9 }, { heapUsed: 100 * 1048576 })).toBe("The window's page crashed: oom (exit 9) · main heap 100 MB");
  });
});

describe('E-5 quitting', () => {
  it('dispose does not wait for a session that never closes, and still flushes the cookies', async () => {
    const { be } = fresh();
    let flushed = 0;
    const store = (be as unknown as { cookieStore: { flush(): Promise<void> } }).cookieStore;
    const real = store.flush.bind(store);
    store.flush = async () => (flushed++, real());
    be.mcpSessions.set('stuck', { close: () => new Promise(() => undefined) } as never);
    const t0 = Date.now();
    await be.dispose();
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(flushed).toBeGreaterThan(0);
  }, 15_000);
});
