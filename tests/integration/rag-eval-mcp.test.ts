/**
 * The MCP tools of RAG metrics (rag_metrics, rag_try_metric, rag_estimate, rag_run, rag_rescore, rag_compare) and the
 * `evaluate_rag_system` prompt, over a real stdio MCP server against the local demo RAG system and a mock judge.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpSession, WorkspaceStore, mcpResultBody, type MockRule, type SavedEvaluation } from '../../packages/core/src/index.js';
// @ts-expect-error - plain JS example module
import { startRagServer } from '../../examples/servers/rag-server.mjs';
import { cliPath, tempDir } from '../helpers.js';

const t = tempDir('tp-rag-mcp-');
let server: { httpUrl: string; close(): Promise<void> };
let ws: WorkspaceStore;
let session: McpSession;

const RULES: MockRule[] = [
  { match: 'faithfulness-v1[\\s\\S]*Parking is free', response: JSON.stringify({ reasoning: 'no parking document', items: [{ text: 'The clinic opens at 8am.', verdict: true, reason: '[doc-1]' }, { text: 'Parking is free.', verdict: false, reason: 'none' }] }) },
  { match: 'faithfulness-v1', response: JSON.stringify({ reasoning: 'ok', items: [{ text: 'The clinic opens at 8am.', verdict: true, reason: '[doc-1]' }] }) },
];

const call = async <T>(tool: string, args: Record<string, unknown>): Promise<{ isError?: boolean; data: T; text: string }> => {
  const r = await session.callTool(tool, args);
  const text = mcpResultBody(r).text;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  return { isError: r.isError, data: data as T, text };
};

beforeAll(async () => {
  const home = join(t.dir, 'home');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ pricing: [{ provider: '*', model: 'mock-model', inputPerMillion: 1, outputPerMillion: 2, version: 'test' }] }));
  server = await startRagServer({ port: 0, grpcPort: 0 });
  ws = WorkspaceStore.create(join(t.dir, 'ws'), 'RAG MCP');
  ws.saveProviders([{ id: 'judge', name: 'Mock judge', kind: 'mock', baseUrl: 'mock://local', defaultModel: 'mock-model', headers: [{ key: 'x-mock-rules', value: JSON.stringify(RULES) }] }]);
  ws.saveLibrary('rag-targets', {
    folders: [],
    items: [{ id: 'rag-http', name: 'Clinic HTTP', data: { protocol: 'http', step: { type: 'http', method: 'POST', url: `${server.httpUrl}/query`, json: { question: '{{question}}' } }, mapping: { answer: '$.answer', contexts: '$.sources[*]', context: { text: '$.text', id: '$.id', score: '$.score' } } } }],
  });
  const dataset = [
    { id: 'hours', question: 'What time does the clinic open?', reference: 'The clinic opens at 8am on weekdays.', reference_ids: ['doc-1'] },
    { id: 'parking', question: 'Is there parking at the clinic?', reference: 'The clinic opens at 8am on weekdays.', reference_ids: ['doc-1'] },
  ]
    .map((r) => JSON.stringify(r))
    .join('\n');
  const evaluation: SavedEvaluation = { name: 'Clinic RAG', type: 'rag', provider: '', model: '', prompt: '', format: 'text', datasetFormat: 'jsonl', dataset, expectedField: 'expected', evaluators: [{ type: 'token-f1', threshold: 0.3 }], concurrency: 2, retries: 0, target: 'rag-http', judge: { provider: 'judge', model: 'mock-model' } };
  ws.saveLibrary('evaluations', { folders: [], items: [{ id: 'ev-rag', name: 'Clinic RAG', data: evaluation }] });
  session = new McpSession({ id: 'rag', name: 'testpion', transport: 'stdio', command: process.execPath, args: [cliPath, 'mcp-server', '-w', ws.root], env: { ...process.env, TESTPION_HOME: home } as Record<string, string> });
  await session.connect(30_000);
}, 60_000);
afterAll(async () => {
  await session?.close();
  await server.close();
  ws.close();
  t.cleanup();
});

describe('RAG metric tools over MCP', () => {
  it('rag_metrics lists the catalogue and the presets; a Ragas name finds its metric', async () => {
    const all = (await call<{ count: number; metrics: Array<{ id: string; kind: string }>; presets: Array<{ id: string }> }>('rag_metrics', {})).data;
    expect(all.count).toBe(134);
    expect(all.presets.map((p) => p.id)).toContain('ragas-core');
    expect((await call<{ metrics: Array<{ id: string }> }>('rag_metrics', { search: 'response_relevancy' })).data.metrics.map((m) => m.id)).toContain('answer-relevance');
    expect((await call<{ count: number }>('rag_metrics', { kind: 'deterministic' })).data.count).toBe(51);
  });

  it('rag_try_metric: a dry run shows the prompt and sends nothing; a real run scores; a free metric answers at once', async () => {
    const dry = (await call<{ willSend: Array<{ version: string; preview: { messages: Array<{ content: string }> } }> }>('rag_try_metric', { metric: 'faithfulness', answer: 'The clinic opens at 8am. Parking is free.', contexts: ['The clinic opens at 8am on weekdays.'], dry_run: true, judge: 'judge/mock-model' })).data;
    expect(dry.willSend[0]!.version).toBe('faithfulness-v1');
    expect(dry.willSend[0]!.preview.messages[1]!.content).toContain('Parking is free');
    const real = (await call<{ result: { score: number; passed: boolean }; usage: { calls: number } }>('rag_try_metric', { metric: 'faithfulness', answer: 'The clinic opens at 8am. Parking is free.', contexts: ['The clinic opens at 8am on weekdays.'], judge: 'judge/mock-model' })).data;
    expect(real.result).toMatchObject({ score: 0.5, passed: false });
    const free = (await call<{ result: { score: number } }>('rag_try_metric', { metric: 'recall@1', answer: 'a', contexts: ['text'], reference_ids: ['doc-1'] })).data;
    expect(free.result.score).toBe(1);
    // probing the target scores what it really answers
    const probed = (await call<{ result: { score: number }; sample: { contexts: number } }>('rag_try_metric', { metric: 'context-recall-ids', target: 'Clinic HTTP', question: 'What time does the clinic open?', reference_ids: ['doc-1'] })).data;
    expect(probed.result.score).toBe(1);
    expect(probed.sample.contexts).toBeGreaterThan(0);
    expect((await call('rag_try_metric', { metric: 'nonsense', answer: 'a' })).isError).toBe(true);
  });

  let runId = '';
  it('rag_estimate says the calls and the cost before anything runs', async () => {
    const e = (await call<{ samples: number; total: { llmCalls: number }; costUsd: { low: number; high: number }; judge: { model: string } }>('rag_estimate', { evaluation: 'Clinic RAG', metrics: ['faithfulness', 'recall@3'] })).data;
    expect(e).toMatchObject({ samples: 2, total: { llmCalls: 2 }, judge: { model: 'mock-model' } });
    expect(e.costUsd.high).toBeGreaterThan(e.costUsd.low);
    expect((await call('rag_estimate', {})).isError).toBe(true);
  });

  it('rag_run runs with the metrics and gates, returns why samples failed, and stops without a judge before any question', async () => {
    const r = (await call<{ runId: string; metrics: Array<{ key: string; mean?: number }>; failures: Array<{ class: string }>; gates: Array<{ passed: boolean }>; gatesPassed: boolean; worstSamples: Array<{ failure: { class: string } }>; judgeCostUsd: number }>('rag_run', { evaluation: 'Clinic RAG', metrics: ['faithfulness', 'recall@3', 'token-f1'], min: ['faithfulness=0.7', 'recall@3=1'] })).data;
    runId = r.runId;
    expect(r.metrics.find((m) => m.key === 'faithfulness')!.mean).toBe(0.75);
    expect(r.failures.map((f) => f.class)).toEqual(['unfaithful']);
    expect(r.gates.map((g) => g.passed)).toEqual([true, true]);
    expect(r.gatesPassed).toBe(true);
    expect(r.worstSamples[0]!.failure.class).toBe('unfaithful');
    expect(r.judgeCostUsd).toBeGreaterThan(0);
    const failing = (await call<{ gatesPassed: boolean }>('rag_run', { evaluation: 'Clinic RAG', metrics: ['faithfulness'], min: ['faithfulness=0.9'] })).data;
    expect(failing.gatesPassed).toBe(false);
  });

  it('rag_rescore re-scores the stored answers; rag_compare compares two runs and reads direction', async () => {
    const r = (await call<{ runId: string; rescored: number; metrics: Array<{ key: string; mean?: number }> }>('rag_rescore', { run_id: runId, judge: 'judge/mock-model' })).data;
    expect(r.rescored).toBe(2);
    expect(r.metrics.find((m) => m.key === 'faithfulness')!.mean).toBe(0.75);
    const cmp = (await call<{ metrics: Array<{ key: string; change: string }>; regressions: unknown[] }>('rag_compare', { run_id: r.runId, baseline_run_id: runId })).data;
    expect(cmp.regressions).toEqual([]);
    expect(cmp.metrics.map((m) => m.key)).toContain('faithfulness');
  });

  it('custom metrics: list, save (checked, confirmed), validate with examples, then usable as custom/<id> in rag_try_metric', async () => {
    const empty = (await call<{ count: number; kinds: unknown[] }>('rag_list_custom_metrics', {})).data;
    expect(empty.count).toBe(0);
    expect(empty.kinds).toHaveLength(6);
    const file = ['id: no-promises', 'kind: rule', 'rules:', '  - { type: not-regex, pattern: "guarantee|promise", flags: i }', 'threshold: 1', 'examples:', '  - { name: fine, sample: { answer: "We will do our best." }, expect: pass }', '  - { name: promise, sample: { answer: "We guarantee a cure." }, expect: fail }'].join('\n');
    // an invalid file is refused with the reason, and nothing is written
    const bad = await call('rag_save_custom_metric', { id: 'broken', content: 'id: broken\nkind: judge\n' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/needs criteria/);
    expect((await call<{ count: number }>('rag_list_custom_metrics', {})).data.count).toBe(0);
    const ok = (await call<{ written: boolean; metric: string; registered: boolean }>('rag_save_custom_metric', { id: 'no-promises', content: file })).data;
    expect(ok).toMatchObject({ written: true, metric: 'custom/no-promises', registered: true });
    // a file that exists is replaced only on purpose, and then only with the user's yes
    expect((await call('rag_save_custom_metric', { id: 'no-promises', content: file })).isError).toBe(true);
    const asked = await call<{ confirmationRequired?: boolean }>('rag_save_custom_metric', { id: 'no-promises', content: file, overwrite: true });
    expect(asked.data.confirmationRequired).toBe(true);
    expect((await call<{ written: boolean }>('rag_save_custom_metric', { id: 'no-promises', content: file, overwrite: true, confirm: true })).data.written).toBe(true);
    const v = (await call<{ ok: boolean; examples: Array<{ ok: boolean }> }>('rag_validate_metric', { id: 'no-promises', run_examples: true })).data;
    expect(v.ok).toBe(true);
    expect(v.examples.map((e) => e.ok)).toEqual([true, true]);
    const listed = (await call<{ count: number; metrics: Array<{ id: string; kind: string; registered: boolean; examples: number }> }>('rag_list_custom_metrics', {})).data;
    expect(listed.metrics[0]).toMatchObject({ id: 'no-promises', kind: 'rule', registered: true, examples: 2 });
    // the catalogue lists it in its own group, and it is scored like any metric
    expect((await call<{ metrics: Array<{ id: string; group: string }> }>('rag_metrics', { search: 'no-promises' })).data.metrics[0]).toMatchObject({ id: 'custom/no-promises', group: 'custom' });
    const t = (await call<{ result: { score: number; passed: boolean } }>('rag_try_metric', { metric: 'custom/no-promises', answer: 'We guarantee a full recovery.' })).data;
    expect(t.result).toMatchObject({ score: 0, passed: false });
    // a draft that disagrees with its own example is reported, not written
    const draft = await call<{ ok: boolean; examples: Array<{ ok: boolean; message: string }> }>('rag_validate_metric', { content: file.replace('expect: fail', 'expect: pass'), run_examples: true });
    expect(draft.data.ok).toBe(false);
    expect(draft.data.examples[1]).toMatchObject({ ok: false });
  });

  it('the evaluate_rag_system prompt walks an agent through the tools', async () => {
    const prompt = await session.getPrompt('evaluate_rag_system', { evaluation: 'Clinic RAG', baseline: 'run-1' });
    const text = JSON.stringify(prompt);
    for (const tool of ['rag_probe', 'rag_metrics', 'rag_try_metric', 'rag_estimate', 'rag_run', 'rag_rescore', 'rag_compare']) expect(text).toContain(tool);
    expect(text).toContain('run-1');
  });
});
