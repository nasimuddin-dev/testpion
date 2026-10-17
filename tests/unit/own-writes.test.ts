import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { OwnWrites } from '../../apps/desktop/backend/own-writes.js';
import { atomicWrite, noteOwnChange, ownWrite, removeOwned, renameOwned, watchWorkspace, type WatchSource, type WorkspaceChange } from '../../packages/core/src/index.js';
import { touchesFiles } from '../../apps/desktop/src/lib/data-changed.js';
import { collectionsTouched } from '../../apps/desktop/src/lib/collections-store.js';
import { tempDir } from '../helpers.js';

vi.mock('../../apps/desktop/src/api', () => ({ call: async () => undefined, on: () => () => undefined }));

// GIT-103: the app's own writes are known by path and content, never by a time window: an outside change right after
// an app write is still reported, and every write the app makes is told to the views (data.changed with its kinds).
const tmp = tempDir('tp-own-writes-');
const backends: Backend[] = [];
afterAll(async () => {
  for (const be of backends) await be.dispose();
  tmp.cleanup();
});
afterEach(() => void vi.useRealTimers());

/** A folder-event source the test drives by hand (no fs.watch timing). */
function fakeSource() {
  let listener: ((event: string, name: string | null) => void) | undefined;
  const source: WatchSource = (_root, l) => ((listener = l), { close: () => (listener = undefined) });
  return { source, fire: (name: string) => listener?.('change', name) };
}

describe('the watcher tells the app’s own writes by path and content (deterministic)', () => {
  it('reports an outside change made right after the app wrote the same file, and not the app’s write', () => {
    vi.useFakeTimers();
    const root = join(tmp.dir, 'w1');
    mkdirSync(join(root, 'tests'), { recursive: true });
    const ev = fakeSource();
    const batches: WorkspaceChange[][] = [];
    const stop = watchWorkspace(root, (b) => batches.push(b), { debounceMs: 100, watch: ev.source });
    try {
      atomicWrite(join(root, 'tests', 'a.yaml'), 'name: A\n'); // the app
      ev.fire('tests/a.yaml');
      vi.advanceTimersByTime(500);
      expect(batches).toEqual([]);
      // 10 ms later (well within any old time window): another program writes the same file
      vi.advanceTimersByTime(10);
      writeFileSync(join(root, 'tests', 'a.yaml'), 'name: B\n');
      ev.fire('tests/a.yaml');
      // and a file the app never wrote, at the same moment
      writeFileSync(join(root, 'tests', 'b.yaml'), 'name: other\n');
      ev.fire('tests/b.yaml');
      vi.advanceTimersByTime(150);
      expect(
        batches
          .flat()
          .map((c) => c.path)
          .sort(),
      ).toEqual(['tests/a.yaml', 'tests/b.yaml']);
    } finally {
      stop();
    }
  });

  it('an outside change back to the bytes the app once wrote is still a change', () => {
    vi.useFakeTimers();
    const root = join(tmp.dir, 'w2');
    mkdirSync(join(root, 'collections'), { recursive: true });
    const file = join(root, 'collections', 'c.json');
    const ev = fakeSource();
    const batches: WorkspaceChange[][] = [];
    const stop = watchWorkspace(root, (b) => batches.push(b), { debounceMs: 50, watch: ev.source });
    try {
      atomicWrite(file, '{"v":1}\n'); // X, the app
      ev.fire('collections/c.json');
      writeFileSync(file, '{"v":2}\n'); // Y, outside
      ev.fire('collections/c.json');
      vi.advanceTimersByTime(100);
      writeFileSync(file, '{"v":1}\n'); // X again, outside
      ev.fire('collections/c.json');
      vi.advanceTimersByTime(100);
      expect(batches.map((b) => b.map((c) => c.path))).toEqual([['collections/c.json'], ['collections/c.json']]);
    } finally {
      stop();
    }
  });

  it('removals and moves by the app are its own; a file created later in a removed folder is not', () => {
    vi.useFakeTimers();
    const root = join(tmp.dir, 'w3');
    mkdirSync(join(root, 'tests', 'suite'), { recursive: true });
    writeFileSync(join(root, 'tests', 'suite', 'x.yaml'), 'x\n');
    writeFileSync(join(root, 'tests', 'm.yaml'), 'm\n');
    const ev = fakeSource();
    const batches: WorkspaceChange[][] = [];
    const stop = watchWorkspace(root, (b) => batches.push(b), { debounceMs: 50, watch: ev.source });
    try {
      removeOwned(join(root, 'tests', 'suite'), { recursive: true });
      ev.fire('tests/suite/x.yaml');
      ev.fire('tests/suite');
      renameOwned(join(root, 'tests', 'm.yaml'), join(root, 'tests', 'n.yaml'));
      ev.fire('tests/m.yaml');
      ev.fire('tests/n.yaml');
      vi.advanceTimersByTime(100);
      expect(batches).toEqual([]);
      expect(ownWrite(join(root, 'tests', 'suite', 'x.yaml'))).toBe('gone');
      mkdirSync(join(root, 'tests', 'suite'));
      writeFileSync(join(root, 'tests', 'suite', 'y.yaml'), 'y\n'); // someone else, in the folder the app removed
      ev.fire('tests/suite/y.yaml');
      vi.advanceTimersByTime(100);
      expect(batches.flat().map((c) => c.path)).toEqual(['tests/suite/y.yaml']);
    } finally {
      stop();
    }
  });

  it('adopt(): files another program changed for the app (git) are the known state', () => {
    vi.useFakeTimers();
    const root = join(tmp.dir, 'w4');
    mkdirSync(join(root, 'environments'), { recursive: true });
    const ev = fakeSource();
    const batches: WorkspaceChange[][] = [];
    const stop = watchWorkspace(root, (b) => batches.push(b), { debounceMs: 50, watch: ev.source });
    try {
      writeFileSync(join(root, 'environments', 'dev.json'), '{"git":1}'); // `git switch`, run by the app
      ev.fire('environments/dev.json'); // its event may come before …
      stop.adopt();
      ev.fire('environments/dev.json'); // … or after the app adopts the new state
      vi.advanceTimersByTime(100);
      expect(batches).toEqual([]);
      writeFileSync(join(root, 'environments', 'dev.json'), '{"editor":1}');
      ev.fire('environments/dev.json');
      vi.advanceTimersByTime(100);
      expect(batches.flat().map((c) => c.path)).toEqual(['environments/dev.json']);
    } finally {
      stop();
    }
  });
});

describe('OwnWrites: every write the app makes to the workspace is told, attributed to its RPC', () => {
  it('keeps concurrent calls apart; writes after a call answered (or outside one) come in a settled batch', async () => {
    vi.useFakeTimers();
    const root = join(tmp.dir, 'ow');
    const background: unknown[] = [];
    const ow = new OwnWrites(
      () => root,
      (b) => background.push(b),
      100,
    );
    try {
      const done: Record<string, unknown> = {};
      const later: Array<() => void> = [];
      const a = ow.run(
        async () => {
          atomicWrite(join(root, 'tests', 'a.yaml'), 'a\n');
          await Promise.resolve();
          atomicWrite(join(root, 'runs', 'r.json'), '{}'); // results: not a workspace file the views list
          later.push(() => atomicWrite(join(root, 'tests', 'late.yaml'), 'late\n'));
        },
        (b) => (done.a = b),
      );
      const b = ow.run(
        async () => {
          await Promise.resolve();
          atomicWrite(join(root, 'environments', 'dev.json'), '{}');
        },
        (x) => (done.b = x),
      );
      await Promise.all([a, b]);
      expect(done.a).toEqual({ kinds: ['tests'], paths: ['tests/a.yaml'] });
      expect(done.b).toEqual({ kinds: ['environments'], paths: ['environments/dev.json'] });
      later.forEach((f) => f()); // a run the call started, still writing after it answered
      atomicWrite(join(tmp.dir, 'elsewhere.json'), '{}'); // outside the workspace: nobody's business
      expect(background).toEqual([]);
      vi.advanceTimersByTime(150);
      expect(background).toEqual([{ kinds: ['tests'], paths: ['tests/late.yaml'] }]);
    } finally {
      ow.dispose();
    }
  });

  it('a write noted after the fact (an async write and rename) counts too', async () => {
    const root = join(tmp.dir, 'ow2');
    mkdirSync(join(root, 'datasets'), { recursive: true });
    const ow = new OwnWrites(
      () => root,
      () => undefined,
    );
    try {
      let got: unknown;
      await ow.run(
        async () => {
          writeFileSync(join(root, 'datasets', 'd.csv'), 'id\n1\n');
          noteOwnChange(join(root, 'datasets', 'd.csv'));
        },
        (b) => (got = b),
      );
      expect(got).toEqual({ kinds: ['tests'], paths: ['datasets/d.csv'] });
    } finally {
      ow.dispose();
    }
  });
});

describe('tests.write and other RPCs that write files send the change the watcher would', () => {
  it('tests.write → data.changed { method, kinds: [tests], paths }; nothing for a call that wrote nothing', async () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    const be = new Backend({ appDir: join(tmp.dir, 'app'), emit: (event: string, payload: unknown) => void events.push({ event, payload }), noMonitors: true });
    backends.push(be);
    events.length = 0;
    await be.invoke('tests.write', { path: 'smoke/new.yaml', content: 'name: New\ntests: []\n' });
    const changed = events.filter((e) => e.event === 'data.changed').map((e) => e.payload);
    expect(changed).toEqual([{ method: 'tests.write', kinds: ['tests'], paths: ['tests/smoke/new.yaml'] }]);
    expect(events.some((e) => e.event === 'workspace.changedOnDisk')).toBe(false); // the app's own: no "changed outside" notice
    events.length = 0;
    await be.invoke('tests.read', { path: 'smoke/new.yaml' });
    expect(events.filter((e) => e.event === 'data.changed')).toEqual([]);
  });
});

describe('the views read a change by the kinds of file it touched', () => {
  it('touchesFiles', () => {
    expect(touchesFiles({ method: 'tests.write', kinds: ['tests'] }, ['tests'])).toBe(true);
    expect(touchesFiles({ method: 'col.save', kinds: ['collections'] }, ['tests'])).toBe(false);
    expect(touchesFiles({ method: 'disk', kinds: ['workspace'] }, ['tests'])).toBe(true);
    expect(touchesFiles({ kind: 'runs' }, ['tests'])).toBe(false);
    expect(touchesFiles({ method: 'git' }, ['environments'])).toBe(true);
    expect(touchesFiles(undefined, ['tests'])).toBe(true);
  });
  it('collections: a test file written is not a collection change', () => {
    expect(collectionsTouched({ method: 'tests.write', kinds: ['tests'] })).toBe('none');
    expect(collectionsTouched({ method: 'write', kinds: ['collections'] })).toBe('all');
    expect(collectionsTouched({ method: 'col.save', collectionId: 'a', kinds: ['collections'] })).toEqual(['a']);
  });
});

// above the 2,000 records the registry once dropped, small enough to stay quick when the whole suite is running
const FILES = 2500;
describe('a large write does not flood the window (2,500 files)', () => {
  it('one RPC, one background stretch and the watcher each say it once, with at most 50 paths, and forget none of the files', async () => {
    // real timers: the debounces run as they do in the app (a fake clock's own bookkeeping would be what is timed)
    const settle = () => new Promise((r) => setTimeout(r, 400));
    const root = join(tmp.dir, 'big');
    mkdirSync(join(root, 'tests'), { recursive: true });
    const ev = fakeSource();
    const outside: WorkspaceChange[][] = [];
    const stop = watchWorkspace(root, (b) => outside.push(b), { debounceMs: 100, watch: ev.source });
    const background: Array<{ kinds: string[]; paths: string[] }> = [];
    const ow = new OwnWrites(
      () => root,
      (b) => background.push(b),
      100,
    );
    // the app's bookkeeping of each write (noteOwnChange, as after an async write) without atomicWrite's fsync per
    // file: what is measured is the events, not the disk
    const write = (path: string, text: string) => (writeFileSync(path, text), noteOwnChange(path));
    try {
      const done: Array<{ kinds: string[]; paths: string[] }> = [];
      await ow.run(
        async () => {
          for (let i = 0; i < FILES; i++) write(join(root, 'tests', `f${i}.yaml`), `name: T${i}\n`);
        },
        (b) => done.push(b),
      );
      // the folder watcher's events come once the import let the event loop go: after all the writes
      for (let i = 0; i < FILES; i++) ev.fire(`tests/f${i}.yaml`);
      await settle();
      expect(done).toHaveLength(1);
      expect(done[0]!.kinds).toEqual(['tests']);
      expect(done[0]!.paths).toHaveLength(50);
      expect(outside.flat().length).toBe(0); // all of them the app's own (none forgotten): no "changed outside TestPion"
      // the same outside an RPC (a run, the assistant): one settled batch, not one event per file
      for (let i = 0; i < FILES; i++) write(join(root, 'tests', `g${i}.yaml`), `name: G${i}\n`);
      for (let i = 0; i < FILES; i++) ev.fire(`tests/g${i}.yaml`);
      expect(background).toEqual([]);
      await settle();
      expect(background).toHaveLength(1);
      expect(background[0]!.paths).toHaveLength(50);
      expect(outside.flat().length).toBe(0);
    } finally {
      ow.dispose();
      stop();
    }
  }, 240_000); // the disk's time: a stat and a read per file of a 2,500-file folder (the bookkeeping itself is O(1) a file)
});
