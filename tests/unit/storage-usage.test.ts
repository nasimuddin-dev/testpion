import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { WorkspaceStore, deleteRunsBefore, workspaceStorage, type RunSummary } from '@testpion/core';

const dir = mkdtempSync(join(tmpdir(), 'tp-storage-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const summary = (runId: string, startedAt: string) => ({ runId, name: runId, startedAt, durationMs: 1, total: 1, passed: 1, failed: 0, skipped: 0, errors: 0 }) as unknown as RunSummary;

describe('workspace storage', () => {
  it('measures the kept data and deletes runs older than a date', () => {
    const store = WorkspaceStore.create(join(dir, 'ws'), 'S');
    for (const [id, at] of [
      ['run-old', '2026-01-01T00:00:00Z'],
      ['run-new', '2026-09-30T00:00:00Z'],
    ] as const) {
      const d = store.runDir(id);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'results.jsonl'), 'x'.repeat(1000));
      store.meta.addRun(summary(id, at), d);
    }
    const u = workspaceStorage(store);
    expect(u.runs).toBe(2);
    expect(u.oldestRun).toBe('2026-01-01T00:00:00Z');
    expect(u.parts.find((p) => p.name === 'runs')).toMatchObject({ files: 2, bytes: 2000 });
    expect(u.totalBytes).toBeGreaterThanOrEqual(2000);

    expect(deleteRunsBefore(store, '2026-06-01T00:00:00Z')).toEqual({ deleted: 1, bytes: 1000 });
    expect(existsSync(store.runDir('run-old'))).toBe(false);
    expect(existsSync(store.runDir('run-new'))).toBe(true);
    expect(store.meta.listRuns().items.map((r) => r.id)).toEqual(['run-new']);
    store.close();
  });
});

// D-1: deleting old runs walked and removed every folder synchronously, one autocommitted delete each
describe('deleting old runs without holding the process', () => {
  it('500 runs go with the event loop turning in between, and one transaction per 50 rows', async () => {
    const { deleteRunsBeforeAsync } = await import('@testpion/core');
    const store = WorkspaceStore.create(join(dir, 'ws-async'), 'S');
    for (let i = 0; i < 500; i++) {
      const id = `run-${i}`;
      const d = store.runDir(id);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'results.jsonl'), 'x'.repeat(100));
      store.meta.addRun(summary(id, i < 480 ? '2026-01-01T00:00:00Z' : '2026-09-30T00:00:00Z'), d);
    }
    let batches = 0;
    const realBatch = store.meta.batch.bind(store.meta);
    store.meta.batch = ((fn: () => unknown) => (batches++, realBatch(fn))) as typeof store.meta.batch;
    let turns = 0;
    const timer = setInterval(() => turns++, 0);
    const r = await deleteRunsBeforeAsync(store, '2026-06-01T00:00:00Z');
    clearInterval(timer);
    expect(r).toEqual({ deleted: 480, bytes: 48_000 });
    expect(batches).toBe(10);
    expect(turns).toBeGreaterThan(3); // the loop ran while the folders went
    expect(store.meta.listRuns({ limit: 1000 }).total).toBe(20);
    expect(existsSync(store.runDir('run-0'))).toBe(false);
    expect(existsSync(store.runDir('run-499'))).toBe(true);
    store.close();
  });
});
