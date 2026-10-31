import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore, MemorySecretStore, createEngineContext, ensureBotSample, runRagEvaluation, embeddingMap, pca2 } from '../../packages/core/src/index.js';

/** R-12: the questions and documents of a run placed by meaning, and the two findings read from the distances. */
const dir = mkdtempSync(join(tmpdir(), 'tp-embedding-map-'));
const store = WorkspaceStore.create(join(dir, 'ws'), 'EM');
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});
const ctx = () => createEngineContext({ store, secrets: new MemorySecretStore(), settings: { pricing: [] } as never });

describe('pca2', () => {
  it('puts the widest spread on the first axis, within -1..1, and is repeatable', () => {
    const rows = [[0, 0, 0], [10, 1, 0], [20, 2, 0], [30, 3, 0]];
    const a = pca2(rows);
    expect(a).toEqual(pca2(rows));
    expect(a.every(([x, y]) => Math.abs(x) <= 1 && Math.abs(y) <= 1)).toBe(true);
    expect(Math.abs(a[0]![0] - a[3]![0])).toBeGreaterThan(1.5);
    expect(pca2([])).toEqual([]);
  });
});

describe('the embedding map of a run', () => {
  it('places every question and document of the offline sample and reads the findings', async () => {
    const made = ensureBotSample(store);
    const out = await runRagEvaluation({ store, makeContext: ctx, evaluation: made.evaluation, concurrency: 2 });
    const c = ctx();
    try {
      const m = await embeddingMap(store, { run: out.runId, embedder: made.evaluation.judge?.provider ?? 'mock', providers: c.services.providers });
      expect(m.points.filter((p) => p.kind === 'question')).toHaveLength(6);
      expect(m.points.some((p) => p.kind === 'right')).toBe(true);
      expect(m.points.every((p) => Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1)).toBe(true);
      expect(m.text).toMatch(/6 questions and \d+ documents placed by meaning/);
      // a threshold of 0 makes every question "near", a threshold of 1 makes every question "far"
      const none = await embeddingMap(store, { run: out.runId, embedder: made.evaluation.judge?.provider ?? 'mock', providers: c.services.providers, farBelow: 0 });
      expect(none.farQuestions).toEqual([]);
      const all = await embeddingMap(store, { run: out.runId, embedder: made.evaluation.judge?.provider ?? 'mock', providers: c.services.providers, farBelow: 1.01 });
      expect(all.farQuestions).toHaveLength(6);
      // a provider that cannot embed, or no embedder at all, says what to configure
      await expect(embeddingMap(store, { run: out.runId, embedder: 'nope', providers: c.services.providers })).rejects.toThrow();
    } finally {
      await c.dispose();
    }
  }, 120_000);
});

describe('testpion rag map', () => {
  it('prints the map as JSON and in words, and refuses a run that is not there', async () => {
    const { runCli, cliData, tempDir } = await import('../helpers.js');
    const tmp = tempDir('tp-rag-map-cli-');
    try {
      const ws = join(tmp.dir, 'ws');
      WorkspaceStore.create(ws, 'MAP').close();
      const env = { ...process.env, TESTPION_HOME: join(tmp.dir, 'home') };
      const sample = await runCli(['rag', 'sample', '-w', ws, '--json'], { env });
      expect([0, 1]).toContain(sample.status);
      const runId = cliData<{ runId: string }>(sample.out).runId;
      const m = cliData<{ points: unknown[]; text: string; embedder: string }>((await runCli(['rag', 'map', runId, '-w', ws, '--embedder', 'mock', '--json'], { env })).out);
      expect(m.points.length).toBeGreaterThan(6);
      expect(m.text).toMatch(/6 questions/);
      const words = await runCli(['rag', 'map', runId, '-w', ws, '--embedder', 'mock', '--far', '1.01'], { env });
      expect(words.out).toMatch(/far /);
      expect((await runCli(['rag', 'map', 'run-nope', '-w', ws, '--embedder', 'mock'], { env })).status).not.toBe(0);
    } finally {
      tmp.cleanup();
    }
  }, 120_000);
});
