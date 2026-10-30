import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore, MemorySecretStore, createEngineContext, ensureBotSample, runRagEvaluation, runResults, BOT_SAMPLE_NAME, BOT_SAMPLE_TARGET, findRagTarget, type TestResult } from '../../packages/core/src/index.js';

/**
 * The bot sample (R-2): one call makes an offline bot (an MCP mock with four clinic documents), the bot as a target, six
 * questions and the evaluation, with the offline demo model as the reviewer; a run needs no key, no network and no server.
 * Two of the six fail on purpose, each for a different reason, so the report has causes to show.
 */
const dir = mkdtempSync(join(tmpdir(), 'tp-ragsample-'));
const store = WorkspaceStore.create(join(dir, 'ws'), 'Sample');
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});
const ctx = () => createEngineContext({ store, secrets: new MemorySecretStore(), settings: { pricing: [] } as never });

describe('the bot sample', () => {
  it('makes the mock bot, the target and the evaluation, and is put back when edited', () => {
    const a = ensureBotSample(store);
    expect(a.created).toBe(true);
    expect(a.providerAdded).toBe(true);
    expect(a.evaluation.name).toBe(BOT_SAMPLE_NAME);
    expect(a.evaluation.type).toBe('rag');
    expect(existsSync(join(dir, 'ws', 'mocks', 'clinic-bot.mcp-mock.yaml'))).toBe(true);
    expect(store.getMcpServers().find((s) => s.id === 'clinic-bot')?.transport).toBe('mock');
    expect(findRagTarget(store, BOT_SAMPLE_TARGET).protocol).toBe('mcp');
    // edited, then put back
    const lib = store.getLibrary<{ dataset: string }>('evaluations');
    store.saveLibrary('evaluations', { ...lib, items: lib.items.map((i) => (i.name === BOT_SAMPLE_NAME ? { ...i, data: { ...i.data, dataset: '' } } : i)) });
    const b = ensureBotSample(store);
    expect(b.created).toBe(false);
    expect(b.evaluation.id).toBe(a.evaluation.id);
    expect(b.evaluation.dataset.split('\n')).toHaveLength(6);
  });

  it('runs 6 questions offline: 4 pass, the parking answer is not backed by the sources, the booster question finds the wrong document', async () => {
    const a = ensureBotSample(store);
    const out = await runRagEvaluation({ store, makeContext: ctx, evaluation: a.evaluation, concurrency: 2 });
    expect(out.summary.total).toBe(6);
    expect(out.summary.errors).toBe(0);
    const results: TestResult[] = [];
    for await (const r of runResults(store, out.runId)) results.push(r);
    const byName = (n: string) => results.find((r) => r.name === n || r.id.endsWith(`:${n}`) || r.name.includes(n));
    const check = (r: TestResult | undefined, type: string) => r?.checks.find((c) => c.type === type);
    const parking = byName('parking');
    const booster = byName('booster');
    expect(parking, 'the parking sample').toBeDefined();
    expect(booster, 'the booster sample').toBeDefined();
    expect(check(parking, 'faithfulness')?.passed, 'parking: not backed by the sources').toBe(false);
    expect(check(booster, 'context-recall-ids')?.passed, 'booster: the right document was not found').toBe(false);
    expect(check(byName('hours'), 'faithfulness')?.passed, 'hours: backed').toBe(true);
    expect(check(byName('hours'), 'context-recall-ids')?.passed, 'hours: found').toBe(true);
    expect(out.summary.passed).toBe(4);
    expect(out.summary.failed).toBe(2);
  }, 60_000);
});
