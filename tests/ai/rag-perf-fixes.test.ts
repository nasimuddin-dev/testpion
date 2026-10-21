/**
 * Review 2, performance findings 5, 8, 11 and 15 of the RAG paths, each with a counted operation (or a retained-memory
 * measure) beside the clock, with the offline mock provider only:
 *  - the exact estimate keeps counts, not the prompt of every dry judge call;
 *  - a real judge call builds its prompt once, and the judge's route is resolved once per run;
 *  - the custom metric files are read once while the folder is unchanged (every request, run and estimate asks the engine
 *    for a context, which syncs them);
 *  - judge_cache has an index on `at` (the prune at 200,000 rows sorts by it);
 *  - the trace files of a search are read without blocking the event loop.
 */
import { DatabaseSync } from 'node:sqlite';
import { runInNewContext } from 'node:vm';
import { setFlagsFromString } from 'node:v8';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MemorySecretStore,
  WorkspaceStore,
  createEngineContext,
  createRagJudgeHost,
  contextOfSample,
  dryHost,
  estimateRagRunExact,
  forgetSyncedMetrics,
  parseSearchQuery,
  prepareStats,
  removeMetricFile,
  resolveMetric,
  runSearchQuery,
  scoreRagSample,
  stringifyYaml,
  syncCustomMetrics,
  syncStats,
  writeMetricFile,
  type AppSettings,
  type MockRule,
  type TrySample,
} from '../../packages/core/src/index.js';
import { customMetricTemplate } from '@testpion/shared';
import { tempDir } from '../helpers.js';
import { harness } from './harness.js';

const verdict = JSON.stringify({ reasoning: 'ok', items: [{ text: 'The clinic opens at 8am.', verdict: true, reason: '[doc-1]' }] });
const RULES: MockRule[] = [{ match: 'faithfulness-v1', response: verdict }];

const sample = (i: number): TrySample => ({
  question: `What time does branch ${i} open?`,
  answer: `Branch ${i} opens at 8am and has free parking number ${i}.`,
  contexts: [
    { id: 'doc-1', text: `Branch ${i} opens at 8am on weekdays. ${'The clinic keeps its hours on the door. '.repeat(20)}` },
    { id: 'doc-2', text: `Appointments at branch ${i} can be cancelled up to 24 hours before. ${'Call the desk for changes. '.repeat(20)}` },
  ],
  reference: `Branch ${i} opens at 8am.`,
});

function setup() {
  const h = harness({ rules: RULES });
  const host = createRagJudgeHost({ store: h.store, providers: h.deps.providers, redactor: h.redactor, settings: h.deps.settings as AppSettings, surface: 'cli' });
  return { h, host };
}

// a heap number that means something: collect first (V8's gc is exposed on the fly, no node flag needed)
setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
const heapMb = () => {
  gc();
  gc();
  return process.memoryUsage().heapUsed / 1_048_576;
};

describe('the exact estimate keeps counts, not prompts (finding 5)', () => {
  it('the same totals as listing every dry call, in a fraction of the retained memory', async () => {
    const { h, host } = setup();
    try {
      const stored = Array.from({ length: 1200 }, (_, i) => sample(i));
      const evaluators = [{ type: 'faithfulness' }];
      // the old way: every dry call kept with its full prompt until the estimate ends
      const base0 = heapMb();
      const old = dryHost(host);
      for (const s of stored) await scoreRagSample(evaluators, contextOfSample(s, { providers: h.deps.providers, ragJudge: old }));
      const keptMb = heapMb() - base0;
      const oldCalls = old.dry.length;
      const oldTokens = old.dry.reduce((a, c) => a + c.preview.estimate.inputTokens, 0);
      old.dry.length = 0;
      // the new way
      const base1 = heapMb();
      const e = await estimateRagRunExact(host, h.store, { evaluators, samples: stored.length, stored });
      const retainedMb = heapMb() - base1;
      console.log(`exact estimate of ${stored.length} samples (${oldCalls} judge calls): listing the calls retains ${keptMb.toFixed(1)} MB, counting them ${retainedMb.toFixed(2)} MB`);
      expect(e.total.llmCalls).toBe(oldCalls);
      expect(e.total.inputTokens).toBe(oldTokens);
      expect(e.cache).toEqual({ hits: 0, of: oldCalls, exact: true });
      expect(oldCalls).toBeGreaterThan(stored.length - 1);
      expect(retainedMb).toBeLessThan(Math.max(2, keptMb / 4));
      expect(keptMb).toBeGreaterThan(4);
    } finally {
      h.cleanup();
    }
  }, 120_000);

  it('a dry host with a tally lists nothing', async () => {
    const { h, host } = setup();
    try {
      const d = dryHost(host, { tally: true });
      for (let i = 0; i < 10; i++) await scoreRagSample([{ type: 'faithfulness' }], contextOfSample(sample(i), { providers: h.deps.providers, ragJudge: d }));
      expect(d.dry).toEqual([]);
      expect(d.tally).toMatchObject({ calls: 10, cached: 0 });
      expect(d.tally!.inputTokens).toBe(d.tally!.freshInputTokens);
      expect(d.tally!.inputTokens).toBeGreaterThan(0);
    } finally {
      h.cleanup();
    }
  });
});

describe('a real judge call builds its prompt once (finding 11)', () => {
  it('one prepared task per model call, not two; the route is resolved once for the run', async () => {
    const { h, host } = setup();
    try {
      const n = 25;
      const built0 = prepareStats.built;
      for (let i = 0; i < n; i++) await scoreRagSample([{ type: 'faithfulness' }], contextOfSample(sample(i), { providers: h.deps.providers, ragJudge: host }));
      const calls = h.rec.requests.length;
      const built = prepareStats.built - built0;
      console.log(`${calls} model calls built ${built} prompts (it was ${calls * 2})`);
      expect(calls).toBeGreaterThanOrEqual(n);
      expect(built).toBe(calls);
      // a repeat is all cache hits: one build each to read the cache key, no model call
      const before = h.rec.requests.length;
      const b1 = prepareStats.built;
      for (let i = 0; i < n; i++) await scoreRagSample([{ type: 'faithfulness' }], contextOfSample(sample(i), { providers: h.deps.providers, ragJudge: host }));
      expect(h.rec.requests.length).toBe(before);
      expect(prepareStats.built - b1).toBe(calls);
      expect(host.usable?.size).toBe(1);
    } finally {
      h.cleanup();
    }
  }, 60_000);
});

describe('the judge cache is indexed by time (finding 11)', () => {
  it('judge_cache has an index on at, and the prune query walks it instead of sorting the table', () => {
    const t = tempDir('tp-jc-');
    const store = WorkspaceStore.create(join(t.dir, 'ws'), 'Index');
    try {
      store.meta.putJudgeCache('k1', '{}');
      const db = new DatabaseSync(join(store.root, 'database.sqlite'), { readOnly: true });
      const indexes = (db.prepare("PRAGMA index_list('judge_cache')").all() as Array<{ name: string }>).map((r) => r.name);
      expect(indexes).toContain('judge_cache_at');
      const plan = (db.prepare('EXPLAIN QUERY PLAN SELECT rowid AS id, NULL AS file FROM judge_cache ORDER BY at ASC LIMIT 100').all() as Array<{ detail: string }>).map((r) => r.detail).join(' | ');
      db.close();
      expect(plan).toMatch(/judge_cache_at/);
      expect(plan).not.toMatch(/TEMP B-TREE/);
    } finally {
      store.close();
      t.cleanup();
    }
  });
});

describe('custom metric files are read once while the folder is unchanged (finding 8)', () => {
  it('30 files, 200 contexts: one read; an edit, an add and a delete are each seen at the next one', () => {
    const t = tempDir('tp-sync-');
    const store = WorkspaceStore.create(join(t.dir, 'ws'), 'Metrics');
    try {
      for (let i = 0; i < 30; i++) writeMetricFile(store, `metric-${i}`, stringifyYaml(customMetricTemplate('rule', `metric-${i}`)));
      forgetSyncedMetrics();
      const t0 = performance.now();
      for (let i = 0; i < 40; i++) forgetSyncedMetrics(), syncCustomMetrics(store);
      const before = (performance.now() - t0) / 40;
      forgetSyncedMetrics();
      const reads0 = syncStats.reads;
      const t1 = performance.now();
      for (let i = 0; i < 200; i++) syncCustomMetrics(store);
      const after = (performance.now() - t1) / 200;
      console.log(`syncing 30 metric files: ${before.toFixed(2)} ms each when read every time, ${after.toFixed(3)} ms with the folder unchanged`);
      expect(syncStats.reads - reads0, 'reads for 200 syncs').toBe(1);
      expect(after).toBeLessThan(before / 3);
      expect(resolveMetric('custom/metric-7')).toBeDefined();
      // an engine context (every request send, run and estimate) syncs too, and reads nothing more
      const r1 = syncStats.reads;
      for (let i = 0; i < 20; i++) void createEngineContext({ store, secrets: new MemorySecretStore() });
      expect(syncStats.reads).toBe(r1);
      // an edit is seen
      const edited = stringifyYaml({ ...customMetricTemplate('rule', 'metric-7'), name: 'Edited seven' });
      writeMetricFile(store, 'metric-7', edited);
      syncCustomMetrics(store);
      expect(syncStats.reads).toBe(r1 + 1);
      expect(resolveMetric('custom/metric-7')!.def.name).toBe('Edited seven');
      // a new file and a removed one
      writeMetricFile(store, 'metric-new', stringifyYaml(customMetricTemplate('rule', 'metric-new')));
      expect(syncCustomMetrics(store).registered).toContain('custom/metric-new');
      expect(removeMetricFile(store, 'metric-new')).toBe(true);
      expect(syncCustomMetrics(store).registered).not.toContain('custom/metric-new');
    } finally {
      store.close();
      t.cleanup();
      forgetSyncedMetrics();
    }
  });
});

describe('a search reads trace files without blocking the process (finding 15)', () => {
  it('the event loop runs between the reads of 200 trace files', async () => {
    const t = tempDir('tp-search-async-');
    const store = WorkspaceStore.create(join(t.dir, 'ws'), 'Search');
    try {
      const NOW = Date.now();
      for (let i = 0; i < 200; i++)
        store.saveTrace({ traceId: `tr${i}`, name: `run ${i}`, startTime: NOW - i * 1000, endTime: NOW - i * 1000 + 50, status: 'ok', spans: [{ traceId: `tr${i}`, spanId: 's', name: i === 150 ? 'needle.span' : 'tool.call', kind: 'llm', startTime: NOW, status: 'ok', attributes: {} }] }, 'http');
      const parsed = parseSearchQuery({ sources: ['traces'], where: [{ field: 'span', op: 'contains', value: 'needle' }] });
      let ticks = 0;
      let stop = false;
      const spin = () => {
        if (stop) return;
        ticks++;
        setImmediate(spin);
      };
      setImmediate(spin);
      const out = await runSearchQuery(store, parsed.query!, { now: NOW });
      stop = true;
      console.log(`a search over 200 trace files let the event loop run ${ticks} times`);
      expect(out.rows.map((r) => r.id)).toEqual(['tr150']);
      expect(ticks).toBeGreaterThan(50);
    } finally {
      store.close();
      t.cleanup();
    }
  }, 60_000);
});
