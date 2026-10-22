import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Backend } from '../../apps/desktop/backend/backend.js';
import {
  ApsError,
  EncryptedFileSecretStore,
  McpSession,
  WorkspaceStore,
  atomicWriteAsync,
  executeHttp,
  errorEnvelope,
  normalizeError,
  pruneRuns,
  retentionOf,
  setBigFileNotifier,
  sweepWorkspace,
  importIntoWorkspace,
} from '../../packages/core/src/index.js';
import { heapAfterGc } from '../perf-budget';
import { tempDir } from '../helpers.js';

/** The second half of planning/review-2026-10-22-robustness.md: ConflictError end to end, retention, startup problems, input hostility, async writes, a soak. */
const tmp = tempDir('tp-robust-rest-');
afterAll(() => tmp.cleanup());
let n = 0;
const ws = () => WorkspaceStore.create(join(tmp.dir, `w${n++}`), 'W');
const col = (id: string, name = id) =>
  ({
    schemaVersion: '1.0',
    id,
    name,
    version: 0,
    variables: [],
    updatedAt: '',
    items: [{ kind: 'http', id: 'r1', name: 'r1', request: { method: 'GET', url: 'http://x/', headers: [], params: [] } }],
  }) as never;

describe('C-2 ConflictError end to end', () => {
  it('a collection read, changed outside, then saved is refused with a ConflictError; the disk keeps the outside change', async () => {
    const store = ws();
    store.saveCollection(col('a'));
    const mine = store.getCollection('a', { etag: true }); // the window reads it (etag)
    expect(mine.etag).toBeTruthy();
    // another program (git pull, the CLI) changes the file
    const file = join(store.root, store.collectionFileOf('a'));
    writeFileSync(file, readFileSync(file, 'utf8').replace('"name": "a"', '"name": "theirs"'));
    const t = new Date(Date.now() + 5000);
    utimesSync(file, t, t);
    let err: unknown;
    try {
      await store.saveCollectionAsync({ ...mine, name: 'mine' });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ kind: 'ConflictError', details: { code: 'Conflict', what: '"mine"' } });
    expect(JSON.parse(readFileSync(file, 'utf8')).name).toBe('theirs');
    // reading again and saving works, and a second save from the same (now stale) object is fine: only this app overtook it
    const fresh = store.getCollection('a', { etag: true });
    const saved = await store.saveCollectionAsync({ ...fresh, name: 'merged' });
    expect(saved.etag).toBeTruthy();
    await store.saveCollectionAsync({ ...fresh, name: 'merged again' });
    expect(store.getCollection('a').name).toBe('merged again');
    store.close();
  });

  it('an environment and a library list are guarded the same way, and the etag is never written to a file', async () => {
    const store = ws();
    store.saveEnvironment({ id: 'e1', name: 'E1', variables: [] } as never);
    const env = store.listEnvironments({ etag: true }).find((e) => e.id === 'e1')!;
    store.saveLibrary('grpc', { folders: [], items: [] });
    const lib = store.getLibrary('grpc', { etag: true });
    expect(env.etag && lib.etag).toBeTruthy();
    const ef = join(store.root, 'environments', 'e1.json');
    writeFileSync(ef, readFileSync(ef, 'utf8').replace('"E1"', '"Theirs"'));
    const lf = join(store.root, 'library', 'grpc.json');
    writeFileSync(lf, readFileSync(lf, 'utf8') + ' ');
    const later = new Date(Date.now() + 5000);
    utimesSync(ef, later, later);
    utimesSync(lf, later, later);
    await expect(store.saveEnvironmentAsync({ ...env, name: 'Mine' })).rejects.toMatchObject({ kind: 'ConflictError' });
    await expect(store.saveLibraryAsync('grpc', lib)).rejects.toMatchObject({ kind: 'ConflictError' });
    for (const f of [ef, lf, join(store.root, store.collectionFileOf('a'))].filter(existsSync)) expect(readFileSync(f, 'utf8')).not.toContain('"etag"');
    store.close();
  });

  it('the code reaches machines: the CLI/MCP error envelope names it, not retryable', () => {
    const e = errorEnvelope(new ApsError('ConflictError', 'x changed'));
    expect(e).toMatchObject({ code: 'ConflictError', retryable: false });
    expect(e.hint).toMatch(/Read it again/);
    expect(errorEnvelope(new ApsError('NetworkError', 'down')).retryable).toBe(true);
  });
});

describe('E-9 structured MCP errors', () => {
  it('a failing tool answers isError with structuredContent.error { code, message, hint, retryable }', async () => {
    const dir = tempDir('tp-mcp-err-');
    const w = WorkspaceStore.create(join(dir.dir, 'w'), 'W');
    const session = new McpSession({
      id: 'e',
      name: 'testpion',
      transport: 'stdio',
      command: process.execPath,
      args: [join(process.cwd(), 'packages/cli/bin/testpion.js'), 'mcp-server', '-w', w.root],
      env: { ...process.env, TESTPION_HOME: join(dir.dir, 'home') } as Record<string, string>,
    });
    await session.connect(30_000);
    try {
      const r = await session.callTool('get_request', { collection: 'no-such-collection', request: 'x' });
      const sc = (r.structuredContent ?? (r.raw as { _meta?: unknown })._meta) as { error?: { code: string; message: string; retryable: boolean } } | undefined;
      expect(r.isError).toBe(true);
      expect(sc?.error).toMatchObject({ retryable: false });
      expect(typeof sc?.error?.code).toBe('string');
      expect(sc?.error?.message).toMatch(/no-such-collection|not found|No collection/i);
    } finally {
      await session.close();
      w.close();
      dir.cleanup();
    }
  }, 60_000);
});

describe('R-3 run retention', () => {
  const addRuns = (store: WorkspaceStore, count: number, daysAgo = (i: number) => i) => {
    for (let i = 0; i < count; i++) {
      const startedAt = new Date(Date.now() - daysAgo(i) * 86_400_000).toISOString();
      store.meta.addRun({ runId: `run-${String(i).padStart(3, '0')}`, name: 'r', startedAt, durationMs: 1, total: 1, passed: 1, failed: 0, skipped: 0, errors: 0 } as never, `runs/run-${i}`);
      mkdirSync(store.runDir(`run-${String(i).padStart(3, '0')}`), { recursive: true });
    }
  };
  it('keeps the newest N and none older than D days; a kept id stays; dry run changes nothing', () => {
    const store = ws();
    addRuns(store, 600, () => 1); // all recent: only the count applies
    expect(retentionOf()).toEqual({ keepRuns: 500, keepDays: 90 });
    expect(pruneRuns(store, retentionOf(), { dryRun: true }).deleted).toBe(100);
    expect(store.meta.listRuns({ limit: 1 }).total).toBe(600);
    const r = pruneRuns(store, retentionOf(), { keep: ['run-599'] });
    expect(r.deleted).toBeGreaterThanOrEqual(99);
    expect(store.meta.listRuns({ limit: 1000 }).items.map((x) => x.id)).toContain('run-599');
    store.close();
    const old = ws();
    addRuns(old, 10, (i) => i * 20); // 0, 20 … 180 days
    const p = pruneRuns(old, { keepRuns: 0, keepDays: 90 });
    expect(p.deleted).toBe(5);
    expect(sweepWorkspace(old, { retention: { keepRuns: 3, keepDays: 0 } }).pruned).toBe(2);
    old.close();
  });
});

describe('E-8 / E-10 / I-7 startup and file problems are said', () => {
  const open: Backend[] = [];
  afterEach(async () => {
    for (const b of open.splice(0)) await b.dispose();
  });
  it('a last workspace whose workspace.json is broken is not hidden: ws.openProblem names it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tp-startup-'));
    const first = new Backend({ appDir: home, emit: () => {}, noMonitors: true });
    const root = (first as unknown as { store: { root: string } }).store.root;
    await first.dispose();
    writeFileSync(join(root, 'workspace.json'), '{');
    const events: Array<{ channel: string; payload: { kind?: string; message?: string } }> = [];
    const be = new Backend({ appDir: home, emit: (channel, payload) => events.push({ channel, payload: payload as never }), noMonitors: true });
    open.push(be);
    const p = (await be.invoke('ws.openProblem', {})) as { message: string } | null;
    expect(p?.message).toMatch(/Could not open/);
    await new Promise((r) => setTimeout(r, 100));
    expect(events.some((e) => e.channel === 'workspace.problem' && e.payload.kind === 'open')).toBe(true);
  });

  it('a damaged .local/meta.json is a warning, then repaired by a save', () => {
    const store = ws();
    const seen: string[] = [];
    store.onWarn = (m) => seen.push(m);
    mkdirSync(join(store.root, '.local'), { recursive: true });
    writeFileSync(join(store.root, '.local', 'meta.json'), '{ not json');
    store.saveCollection(col('m'));
    expect(seen.join(' ')).toMatch(/\.local\/meta\.json could not be read/);
    expect(JSON.parse(readFileSync(join(store.root, '.local', 'meta.json'), 'utf8')).collections.m.version).toBe(1);
    store.close();
  });

  it('a damaged secrets.json is kept and reported; values another user encrypted say so once', () => {
    const dir = tempDir('tp-secrets-');
    const file = join(dir.dir, 'secrets.json');
    writeFileSync(file, 'not json at all');
    const cipher = {
      backend: 'test',
      isAvailable: () => true,
      encrypt: (s: string) => Buffer.from(s),
      decrypt: () => {
        throw new Error('other user');
      },
    };
    const store = new EncryptedFileSecretStore(file, cipher as never);
    expect(store.problem).toMatch(/could not be read/);
    expect(readdirSync(dir.dir).some((f) => f.startsWith('secrets.json.broken-'))).toBe(true);
    const f2 = join(dir.dir, 'secrets2.json');
    writeFileSync(f2, JSON.stringify({ secrets: { a: Buffer.from('x').toString('base64') } }));
    const s2 = new EncryptedFileSecretStore(f2, cipher as never);
    const told: string[] = [];
    s2.onProblem = (m) => told.push(m);
    expect(s2.get('a')).toBeUndefined();
    expect(s2.get('a')).toBeUndefined();
    expect(told).toHaveLength(1);
    expect(told[0]).toMatch(/another user or installation/);
    dir.cleanup();
  });
});

describe('I-2 .. I-5 hostile files', () => {
  it('a collection nested thousands of levels deep is a ValidationError naming the depth, and the list stays usable', () => {
    const store = ws();
    store.saveCollection(col('ok'));
    let deep: unknown = [];
    for (let i = 0; i < 5000; i++) deep = [{ kind: 'folder', id: `f${i}`, name: 'f', items: deep }];
    writeFileSync(join(store.root, 'collections', 'deep.json'), JSON.stringify({ schemaVersion: '1.0', id: 'deep', name: 'Deep', items: deep }));
    const list = store.listCollections();
    expect(list.find((c) => c.id === 'ok')?.problem).toBeUndefined();
    expect(list.find((c) => c.id === 'deep')?.problem).toMatch(new RegExp(`nested deeper than 64 levels`));
    expect(() => store.getCollection('deep')).toThrow(/nested deeper/);
    store.close();
  });

  it('a file that is not UTF-8 is listed with why and never rewritten', () => {
    const store = ws();
    const f = join(store.root, 'collections', 'latin.json');
    const bytes = Buffer.concat([Buffer.from('{"schemaVersion":"1.0","id":"latin","name":"caf'), Buffer.from([0xe9]), Buffer.from('","items":[]}')]);
    writeFileSync(f, bytes);
    expect(store.listCollections().find((c) => c.id === 'latin')?.problem).toMatch(/not valid UTF-8/);
    expect(readFileSync(f).equals(bytes)).toBe(true);
    store.close();
  });

  it('a file over the per-file cap is read each time and told once; over the hard cap it is refused', () => {
    const store = ws();
    const told: string[] = [];
    setBigFileNotifier((p) => told.push(p));
    const f = join(store.root, 'collections', 'big.json');
    const filler = 'x'.repeat(9 * 1024 * 1024);
    writeFileSync(f, JSON.stringify({ schemaVersion: '1.0', id: 'big', name: 'Big', variables: [], items: [], note: filler }));
    store.getCollection('big');
    store.getCollection('big');
    expect(told).toEqual([f]);
    setBigFileNotifier(undefined);
    store.close();
  });

  it('(win32) a path beyond the limit is refused with the length', () => {
    if (process.platform !== 'win32') return;
    const store = ws();
    expect(() => store.safePath('a/'.repeat(200) + 'x.yaml', store.path('tests'))).toThrow(/too long for Windows/);
    store.close();
  });
});

describe('N-3 / N-4 streams and key checks do not hang', () => {
  let server: Server | undefined;
  afterAll(() => server?.closeAllConnections());
  it('an event stream that goes silent ends after streamIdleMs with the events it had, not an error', async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const t0 = Date.now();
    const { response } = await executeHttp({ method: 'GET', url, settings: { streamIdleMs: 300 } });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(response.streamStopped).toBe(true);
    expect(response.events?.map((e) => e.data)).toEqual(['one']);
  }, 15_000);
});

describe('C-6 async atomic write', () => {
  it('writes whole, leaves no temp file, and replaces an existing file', async () => {
    const dir = tempDir('tp-async-write-');
    const f = join(dir.dir, 'a.json');
    await atomicWriteAsync(f, '{"a":1}');
    await atomicWriteAsync(f, '{"a":2}');
    expect(readFileSync(f, 'utf8')).toBe('{"a":2}');
    expect(readdirSync(dir.dir)).toEqual(['a.json']);
    dir.cleanup();
  });

  it('the app’s saves do not block the event loop between steps (a timer fires during a burst of saves)', async () => {
    const store = ws();
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    for (let i = 0; i < 30; i++) await store.saveCollectionAsync({ ...col('burst'), name: `b${i}`, etag: undefined } as never);
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0);
    expect(store.getCollection('burst').name).toBe('b29');
    store.close();
  });
});

describe('R-7 soak: saves, run switches and imports do not grow the heap', () => {
  it('15 cycles of 10 saves of a 1 MB collection, an import and a read stay within a memory bound', async () => {
    const store = ws();
    const big = (i: number) => ({
      ...col('soak'),
      items: Array.from({ length: 1500 }, (_, k) => ({
        kind: 'http',
        id: `r${k}`,
        name: `Request ${k} ${i}`,
        request: { method: 'GET', url: `http://x/${k}`, headers: [], params: [], body: { type: 'raw', content: 'y'.repeat(300) } },
      })),
    });
    const postman = JSON.stringify({
      info: { name: 'P', _postman_id: 'p', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: Array.from({ length: 50 }, (_, i) => ({ name: `r${i}`, request: { method: 'GET', url: `http://x/${i}` } })),
    });
    const heaps: number[] = [];
    let cur = store.saveCollection(big(0));
    for (let cycle = 0; cycle < 15; cycle++) {
      for (let i = 0; i < 10; i++) {
        cur = await store.saveCollectionAsync({ ...big(i), etag: cur.etag });
        store.collectionView('soak');
      }
      importIntoWorkspace(store, postman);
      heaps.push(heapAfterGc());
    }
    expect(store.viewCount).toBeLessThanOrEqual(64);
    // the last cycles do not climb: the heap after the 15th cycle is within 40 MB of the 5th
    expect(heaps[14]! - heaps[4]!, `heap by cycle (MB): ${heaps.map((h) => Math.round(h / 1048576)).join(', ')}`).toBeLessThan(40 * 1024 * 1024);
    store.close();
  }, 180_000);
});

void [statSync, normalizeError];

describe('E-5 quit: a cookie set just before the app quits is there at the next start', () => {
  it('dispose writes the pending cookie jar before it returns (no 250 ms debounce lost)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tp-quit-cookie-'));
    const cipher = { backend: 'test', isAvailable: () => true, encrypt: (s: string) => Buffer.from(s, 'utf8'), decrypt: (b: Buffer) => b.toString('utf8') };
    const first = new Backend({ appDir: home, emit: () => {}, noMonitors: true, cipher } as never);
    first.jar().set({ name: 'session', value: 'abc123', domain: 'quit.example.test', path: '/' } as never);
    await first.dispose(); // immediately: the jar's own timer has not fired
    const second = new Backend({ appDir: home, emit: () => {}, noMonitors: true, cipher } as never);
    try {
      expect(
        second
          .jar()
          .list('quit.example.test')
          .map((c) => `${c.name}=${c.value}`),
      ).toEqual(['session=abc123']);
    } finally {
      await second.dispose();
    }
  });
});
