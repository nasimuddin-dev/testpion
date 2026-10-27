import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { WorkspaceStore, deleteRunsBefore, deleteRunsBeforeAsync, pruneRuns, retentionOf, sweepWorkspace } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';

const tmp = tempDir('tp-finish-robust-');
afterAll(() => tmp.cleanup());
let n = 0;
const ws = () => WorkspaceStore.create(join(tmp.dir, `w${n++}`), 'W');

const addRuns = (store: WorkspaceStore, count: number, daysAgo = (i: number) => i) => {
  for (let i = 0; i < count; i++) {
    const id = `run-${String(i).padStart(3, '0')}`;
    const startedAt = new Date(Date.now() - daysAgo(i) * 86_400_000).toISOString();
    store.meta.addRun({ runId: id, name: 'r', startedAt, durationMs: 1, total: 1, passed: 1, failed: 0, skipped: 0, errors: 0 } as never, `runs/${id}`);
    mkdirSync(store.runDir(id), { recursive: true });
  }
};
const baseline = (runId: string, name = `base ${runId}`) => ({
  schemaVersion: '1.0' as const,
  name,
  createdAt: new Date().toISOString(),
  runId,
  summary: {} as never,
  tests: { t: { status: 'passed' as const } },
});

describe('retention never prunes a run a baseline points at', () => {
  it('by count and by age, in the sweep, and in "delete runs before"', async () => {
    const store = ws();
    addRuns(store, 12, (i) => i * 20); // 0, 20 ... 220 days old
    store.saveBaseline(baseline('run-011')); // the oldest
    store.saveBaseline(baseline('run-009'));
    const dry = pruneRuns(store, { keepRuns: 3, keepDays: 0 }, { dryRun: true });
    expect(dry.ids).not.toContain('run-011');
    expect(dry.ids).not.toContain('run-009');
    expect(dry.deleted).toBe(7); // 12 - the newest 3 - the 2 baselines
    const old = pruneRuns(store, { keepRuns: 0, keepDays: 90 });
    expect(old.ids.sort()).toEqual(['run-005', 'run-006', 'run-007', 'run-008', 'run-010']); // 100 days and older, but 009 and 011
    expect(store.meta.listRuns({ limit: 100 }).items.map((r) => r.id)).toEqual(expect.arrayContaining(['run-009', 'run-011']));
    expect(sweepWorkspace(store, { retention: { keepRuns: 1, keepDays: 0 } }).pruned).toBeGreaterThan(0);
    expect(store.meta.listRuns({ limit: 100 }).items.map((r) => r.id)).toEqual(expect.arrayContaining(['run-011', 'run-009', 'run-000']));
    const before = new Date().toISOString();
    expect(deleteRunsBefore(store, before).deleted).toBe(1); // run-000 only
    expect(
      store.meta
        .listRuns({ limit: 100 })
        .items.map((r) => r.id)
        .sort(),
    ).toEqual(['run-009', 'run-011']);
    expect((await deleteRunsBeforeAsync(store, before)).deleted).toBe(0);
    store.close();
  });
});

describe('E-2 the etag tells two same-size writes in one clock tick apart', () => {
  it('a file rewritten with other bytes of the same size and the same modified time has another etag', async () => {
    const store = ws();
    store.saveCollection({ schemaVersion: '1.0', id: 'a', name: 'aaaa', version: 0, variables: [], items: [], updatedAt: '' } as never);
    const file = join(store.root, store.collectionFileOf('a'));
    const mine = store.getCollection('a', { etag: true });
    const before = statSync(file);
    writeFileSync(file, readFileSync(file, 'utf8').replace('"name": "aaaa"', '"name": "bbbb"')); // the same length
    utimesSync(file, before.atime, before.mtime); // and the same time
    expect(statSync(file).size).toBe(before.size);
    let err: unknown;
    try {
      await store.saveCollectionAsync({ ...mine, name: 'mine' });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ kind: 'ConflictError' });
    expect(JSON.parse(readFileSync(file, 'utf8')).name).toBe('bbbb');
    store.close();
  });
});

describe('E-8 a workspace that cannot be opened at the start stays named until another opens', () => {
  it('ws.openProblem answers while nothing is open and is null once a workspace is', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tp-e8-'));
    const first = new Backend({ appDir: home, emit: () => {}, noMonitors: true });
    const root = (first as unknown as { store: { root: string } }).store.root;
    await first.dispose();
    writeFileSync(join(root, 'workspace.json'), '{');
    const be = new Backend({ appDir: home, emit: () => {}, noMonitors: true });
    try {
      const p = (await be.invoke('ws.openProblem', {})) as { path?: string; message: string } | null;
      expect(p?.message).toMatch(/Could not open/);
      expect(p?.path).toBe(root);
      const other = WorkspaceStore.create(join(tmp.dir, 'other'), 'Other');
      other.close();
      await be.invoke('ws.open', { ref: join(tmp.dir, 'other') });
      expect(await be.invoke('ws.openProblem', {})).toBeNull();
    } finally {
      await be.dispose();
    }
  });
});
