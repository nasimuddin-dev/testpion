/**
 * RAG targets over every protocol (R1a): the local demo RAG system (examples/servers/rag-server.mjs) is probed over HTTP,
 * SSE, WebSocket, gRPC and an MCP tool; its answers and retrieved contexts are read by click-to-map style mappings; a saved
 * evaluation runs a dataset through the target and scores it with deterministic and judged metrics (mock judge, never a
 * real model). No key, no network beyond 127.0.0.1.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  MemorySecretStore,
  WorkspaceStore,
  assertEvaluationRunnable,
  createEngineContext,
  defaultSettings,
  evaluationTests,
  findRagTarget,
  listRagTargets,
  probeRagTarget,
  runTests,
  saveRagTarget,
  type EngineContext,
  type MockRule,
  type RagTarget,
  type SavedEvaluation,
  type TestResult,
} from '../../packages/core/src/index.js';
// @ts-expect-error - plain JS example module
import { startRagServer } from '../../examples/servers/rag-server.mjs';
import { tempDir } from '../helpers.js';

const t = tempDir('tp-rag-');
let server: { httpUrl: string; wsUrl: string; grpcTarget: string; close(): Promise<void> };
let store: WorkspaceStore;

/** The mock judge: one rule per sample, matched on the answer text inside the prompt (the unfaithful answer first). */
const RULES: MockRule[] = [
  { match: 'faithfulness-v1[\\s\\S]*Parking is free', response: JSON.stringify({ reasoning: 'The parking claim is in no document.', items: [{ text: 'The clinic opens at 8am on weekdays.', verdict: true, reason: '[doc-1] "opens at 8am"' }, { text: 'Parking is free for two hours.', verdict: false, reason: 'no document mentions parking' }] }) },
  { match: 'faithfulness-v1', response: JSON.stringify({ reasoning: 'All claims are in the documents.', items: [{ text: 'The clinic opens at 8am on weekdays.', verdict: true, reason: '[doc-1] "opens at 8am"' }] }) },
  { match: 'answer-relevance-v1', response: JSON.stringify({ reasoning: 'Both statements address the question.', items: [{ text: 'It opens at 8am.', verdict: true, reason: 'answers the question' }, { text: 'Saturdays at 9am.', verdict: true, reason: 'a needed qualification' }] }) },
];

function context(rules: MockRule[] = RULES): EngineContext {
  store.saveProviders([{ id: 'judge', name: 'Mock judge', kind: 'mock', baseUrl: 'mock://local', defaultModel: 'mock-model', headers: [{ key: 'x-mock-rules', value: JSON.stringify(rules) }] }]);
  const settings = { ...defaultSettings(), assistantProvider: 'judge', assistantModel: 'mock-model', pricing: [{ provider: '*', model: 'mock-model', inputPerMillion: 1, outputPerMillion: 2, version: 'test' }] };
  return createEngineContext({ store, secrets: new MemorySecretStore(), settings, aiSurface: 'cli' });
}

const TARGETS: Record<string, () => RagTarget> = {
  http: () => ({
    protocol: 'http',
    step: { type: 'http', method: 'POST', url: `${server.httpUrl}/query`, headers: { 'Content-Type': 'application/json' }, json: { question: '{{question}}' } },
    mapping: { answer: '$.answer', contexts: '$.sources[*]', context: { text: '$.text', id: '$.id', score: '$.score', source: '$.metadata.source' }, usage: { input: '$.usage.prompt_tokens', output: '$.usage.completion_tokens' } },
  }),
  sse: () => ({
    protocol: 'sse',
    step: { type: 'http', method: 'POST', url: `${server.httpUrl}/stream`, headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, json: { question: '{{question}}' } },
    mapping: { answer: '$.events[*].data.delta', contexts: '$.events[0].data.sources[*]', context: { text: '$.text', id: '$.id' } },
  }),
  websocket: () => ({
    protocol: 'websocket',
    step: { type: 'websocket', url: server.wsUrl, waitMs: 600, send: [{ question: '{{question}}' }] },
    mapping: { answer: '$.received[*].delta', contexts: '$.received[0].sources[*]', context: { text: '$.text', id: '$.id' } },
  }),
  grpc: () => ({
    protocol: 'grpc',
    step: { type: 'grpc', target: server.grpcTarget, method: 'rag.v1.Rag/Ask', protos: ['rag.proto'], message: { question: '{{question}}' } },
    mapping: { answer: '$.answer', contexts: '$.sources[*]', context: { text: '$.text', id: '$.id', score: '$.score' } },
  }),
  mcp: () => ({
    protocol: 'mcp',
    step: { type: 'mcp', server: 'rag-mcp', tool: 'ask', arguments: { question: '{{question}}' } },
    mapping: { answer: '$.answer', contexts: '$.sources[*]', context: { text: '$.text', id: '$.id' } },
  }),
};

beforeAll(async () => {
  server = await startRagServer({ port: 0, grpcPort: 0 });
  store = WorkspaceStore.create(join(t.dir, 'ws'), 'RAG');
  copyFileSync(resolve('examples/servers/rag.proto'), join(store.root, 'rag.proto'));
  store.saveMcpServers([{ id: 'rag-mcp', name: 'rag-mcp', transport: 'stdio', command: process.execPath, args: [resolve('examples/servers/rag-server.mjs'), '--mcp'] }]);
});
afterAll(async () => {
  await server.close();
  store.close();
  t.cleanup();
});

describe('probe: every protocol gives the same sample', () => {
  for (const protocol of Object.keys(TARGETS)) {
    it(protocol, async () => {
      const ctx = context();
      try {
        const p = await probeRagTarget(ctx, TARGETS[protocol]!(), 'What time does the clinic open?');
        expect(p.sample.warnings).toEqual([]);
        expect(p.sample.answer).toBe('The clinic opens at 8am on weekdays and 9am on Saturdays.');
        expect(p.sample.contexts[0]).toMatchObject({ id: 'doc-1', text: expect.stringContaining('opens at 8am') });
        expect(p.sample.contexts.length).toBeGreaterThan(0);
        expect(p.latencyMs).toBeGreaterThanOrEqual(0);
        if (protocol === 'http') expect(p.sample.usage?.outputTokens).toBeGreaterThan(0);
        if (protocol === 'sse') expect(p.response.kind).toBe('sse');
      } finally {
        await ctx.dispose();
      }
    }, 30_000);
  }

  it('a probe works before there is a mapping, and says what is missing', async () => {
    const ctx = context();
    try {
      const target = { ...TARGETS.http!(), mapping: { answer: '' } };
      const p = await probeRagTarget(ctx, target, 'What time does the clinic open?');
      expect(p.response.kind).toBe('json');
      expect((p.response.doc as { answer: string }).answer).toContain('8am');
      expect(p.sample.answer).toBe('');
      expect(p.sample.warnings[0]).toContain('no answer path');
    } finally {
      await ctx.dispose();
    }
  });

  it('a question with quotes stays a string in a json body', async () => {
    const ctx = context();
    try {
      const p = await probeRagTarget(ctx, TARGETS.http!(), 'Can appointments be "cancelled" now? \\ ok');
      expect(p.sample.contexts.map((d) => d.id)).toContain('doc-3');
    } finally {
      await ctx.dispose();
    }
  });
});

describe('a RAG evaluation', () => {
  const dataset = [
    { id: 'hours', question: 'What time does the clinic open?', reference: 'The clinic opens at 8am on weekdays.', reference_ids: ['doc-1'], tags: ['hours'] },
    { id: 'parking', question: 'Is there parking at the clinic?', reference: 'I do not know.', reference_ids: ['doc-1'], tags: ['parking'] },
  ]
    .map((r) => JSON.stringify(r))
    .join('\n');

  const evaluation = (extra: Partial<SavedEvaluation> = {}): SavedEvaluation => ({
    name: 'Clinic RAG',
    type: 'rag',
    provider: '',
    model: '',
    prompt: '',
    format: 'text',
    datasetFormat: 'jsonl',
    dataset,
    expectedField: 'expected',
    evaluators: [
      { type: 'token-f1', threshold: 0.5 },
      { type: 'rouge', rouge: 'rougeL', threshold: 0.5 },
      { type: 'context-recall-ids', threshold: 1 },
      { type: 'context-precision-ids', threshold: 0.1 },
      { type: 'rag-faithfulness', threshold: 0.8 },
      { type: 'rag-answer-relevance' },
      { type: 'latency', max: 5000 },
    ],
    concurrency: 2,
    retries: 0,
    target: 'Clinic HTTP',
    judge: { provider: 'judge', model: 'mock-model' },
    ...extra,
  });

  async function run(ctx: EngineContext, d: SavedEvaluation): Promise<TestResult[]> {
    const results: TestResult[] = [];
    await runTests({ name: d.name, tests: evaluationTests(d, { store }), services: ctx.services, concurrency: d.concurrency, onEvent: (e) => e.type === 'test-end' && results.push(e.result) });
    return results.sort((a, b) => a.id.localeCompare(b.id));
  }

  it('calls the target per record, maps it and scores it; the unfaithful answer is found', async () => {
    saveRagTarget(store, { name: 'Clinic HTTP', target: TARGETS.http!() });
    expect(listRagTargets(store)).toEqual([expect.objectContaining({ name: 'Clinic HTTP', protocol: 'http', problems: [] })]);
    const ctx = context();
    try {
      const results = await run(ctx, evaluation());
      expect(results.map((r) => r.id)).toEqual(['clinic-rag:hours', 'clinic-rag:parking']);
      const [hours, parking] = results as [TestResult, TestResult];
      const by = (r: TestResult, type: string) => r.checks.find((c) => c.type === type)!;
      // the answer is the best document: it contains the reference (precision 1/2 tokens… recall 1)
      expect(by(hours, 'token-f1').score).toBeGreaterThan(0.7);
      expect(by(hours, 'context-recall-ids').score).toBe(1);
      expect(by(hours, 'rag-faithfulness')).toMatchObject({ passed: true, score: 1, source: 'ai-judge' });
      expect(by(hours, 'rag-faithfulness').metadata).toMatchObject({ judge: { promptVersion: 'faithfulness-v1', cached: false } });
      expect(by(hours, 'rag-answer-relevance').score).toBe(1);
      // the seeded defect: a claim no document supports
      expect(by(parking, 'rag-faithfulness')).toMatchObject({ passed: false, score: 0.5 });
      expect((by(parking, 'rag-faithfulness').metadata as { items: Array<{ ok: boolean }> }).items.map((i) => i.ok)).toEqual([true, false]);
      expect(hours.status).toBe('passed');
      expect(parking.status).toBe('failed');
      // what the system returned travels with the result
      expect((hours.metadata as { rag: { sample: { answer: string; contexts: unknown[] } } }).rag.sample.contexts.length).toBeGreaterThan(0);
      expect(hours.latencyMs).toBeGreaterThanOrEqual(0);
    } finally {
      await ctx.dispose();
    }
  }, 60_000);

  it('a second run costs nothing: the verdicts come from the cache, and the ledger counts only the first', async () => {
    const before = store.meta.listAiCalls({ limit: 1000 }).filter((c) => c.task === 'rag-judge').length;
    const ctx = context();
    try {
      const again = await run(ctx, evaluation());
      for (const r of again) for (const c of r.checks.filter((x) => x.source === 'ai-judge')) expect((c.metadata as { judge: { cached: boolean } }).judge.cached).toBe(true);
      expect(ctx.services.ragJudge!.budget.calls).toBe(0);
      expect(ctx.services.ragJudge!.budget.cached).toBe(4);
      expect(store.meta.listAiCalls({ limit: 1000 }).filter((c) => c.task === 'rag-judge').length).toBe(before);
    } finally {
      await ctx.dispose();
    }
  }, 60_000);

  it('the ledger holds the first run’s judge calls', () => {
    const rows = store.meta.listAiCalls({ limit: 1000 }).filter((c) => c.task === 'rag-judge');
    expect(rows.length).toBe(4);
    expect(rows.every((r) => r.provider === 'Mock judge' && r.outcome === 'ok')).toBe(true);
  });

  it('a limit of calls stops the judging, and what it did not judge is n/a, not a score', async () => {
    store.meta.clearJudgeCache();
    const ctx = context();
    try {
      const results = await run(ctx, evaluation({ maxJudgeCalls: 1, concurrency: 1 }));
      const judged = results.flatMap((r) => r.checks.filter((c) => c.source === 'ai-judge'));
      expect(judged.filter((c) => c.score !== undefined).length).toBe(1);
      expect(judged.filter((c) => (c.metadata as { na?: string } | undefined)?.na === 'budget').length).toBe(3);
    } finally {
      await ctx.dispose();
    }
  }, 60_000);

  it('without a judge the run is refused before it starts, with what to configure', () => {
    const settings = { ...defaultSettings(), assistantProvider: undefined, assistantModel: undefined };
    const ctx = createEngineContext({ store, secrets: new MemorySecretStore(), settings });
    try {
      expect(() => assertEvaluationRunnable(store, ctx.services.ragJudge!, evaluation({ judge: undefined }))).toThrow(/needs a judge model/);
      try {
        assertEvaluationRunnable(store, ctx.services.ragJudge!, evaluation({ judge: undefined }));
      } catch (e) {
        expect((e as { suggestions?: string[] }).suggestions?.join('\n')).toMatch(/Settings ▸ AI assistant/);
        expect((e as { suggestions?: string[] }).suggestions?.join('\n')).toMatch(/--judge/);
      }
      // free metrics alone need none
      expect(assertEvaluationRunnable(store, ctx.services.ragJudge!, evaluation({ evaluators: [{ type: 'token-f1' }], judge: undefined })).judged).toEqual([]);
    } finally {
      void ctx.dispose();
    }
  });

  it('every protocol works as an evaluation target', async () => {
    for (const protocol of ['sse', 'websocket', 'grpc', 'mcp']) {
      saveRagTarget(store, { name: `Clinic ${protocol}`, target: TARGETS[protocol]!() });
      const ctx = context();
      try {
        const results = await run(ctx, evaluation({ target: `Clinic ${protocol}`, evaluators: [{ type: 'token-f1', threshold: 0.7 }, { type: 'context-recall-ids' }], dataset: dataset.split('\n')[0]! }));
        expect(results.map((r) => r.status), protocol).toEqual(['passed']);
      } finally {
        await ctx.dispose();
      }
    }
    expect(findRagTarget(store, 'clinic grpc').protocol).toBe('grpc');
  }, 120_000);

  it('a target whose mapping finds no answer fails the test with the reason', async () => {
    saveRagTarget(store, { name: 'Broken', target: { ...TARGETS.http!(), mapping: { answer: '$.nope' } } });
    const ctx = context();
    try {
      const [r] = await run(ctx, evaluation({ target: 'Broken', evaluators: [{ type: 'token-f1' }], dataset: dataset.split('\n')[0]! }));
      expect(r!.status).toBe('error');
      expect(r!.error?.message).toMatch(/found no answer.*\$\.nope/);
    } finally {
      await ctx.dispose();
    }
  });
});
