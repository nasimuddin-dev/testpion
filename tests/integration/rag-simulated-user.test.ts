/**
 * A simulated user (planning/ai-research-2026-11-11.md N-1) end to end against a local server, with the offline mock as
 * the model that plays the user: a record with a persona and a goal is a conversation the model drives until the goal is
 * met, it gives up, or the turn limit is reached. No key, no network beyond 127.0.0.1.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MemorySecretStore,
  PERSONAS,
  WorkspaceStore,
  createEngineContext,
  defaultSettings,
  evaluationTests,
  runTests,
  saveRagTarget,
  simulationOf,
  type EngineContext,
  type MockRule,
  type RagTarget,
  type SavedEvaluation,
  type SimulationOutcome,
  type TestResult,
} from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';

const t = tempDir('tp-rag-sim-');
let server: Server;
let base = '';
let store: WorkspaceStore;
const seen: Array<Array<{ role: string; content: string }>> = [];

const move = (status: string, message = '', reason = 'because') => JSON.stringify({ status, message, reason });

function context(rules: MockRule[]): EngineContext {
  store.saveProviders([{ id: 'judge', name: 'Mock judge', kind: 'mock', baseUrl: 'mock://local', defaultModel: 'mock-model', headers: [{ key: 'x-mock-rules', value: JSON.stringify(rules) }] }]);
  const settings = { ...defaultSettings(), assistantProvider: 'judge', assistantModel: 'mock-model', pricing: [{ provider: '*', model: 'mock-model', inputPerMillion: 1, outputPerMillion: 2, version: 'test' }] };
  return createEngineContext({ store, secrets: new MemorySecretStore(), settings, aiSurface: 'cli' });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const messages = (JSON.parse(raw) as { messages: Array<{ role: string; content: string }> }).messages;
      seen.push(messages);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ answer: `reply ${messages.filter((m) => m.role === 'user').length} to: ${messages.at(-1)!.content}`, sources: [] }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  store = WorkspaceStore.create(join(t.dir, 'ws'), 'Simulated user');
  const target: RagTarget = { protocol: 'http', step: { type: 'http', method: 'POST', url: `${base}/chat`, json: { messages: '{{messages}}' } }, mapping: { answer: '$.answer' }, conversation: { mode: 'stateless-history' } };
  saveRagTarget(store, { name: 'Bot', target });
});
afterAll(async () => {
  server.close();
  store.close();
  t.cleanup();
});

function evaluation(dataset: string, extra: Partial<SavedEvaluation> = {}): SavedEvaluation {
  return { name: 'Simulated', type: 'rag', provider: '', model: '', prompt: '', format: 'text', datasetFormat: 'jsonl', dataset, expectedField: 'expected', evaluators: [{ type: 'latency', max: 60_000 }], concurrency: 1, retries: 0, target: 'Bot', judge: { provider: 'judge', model: 'mock-model' }, ...extra };
}

async function run(ctx: EngineContext, d: SavedEvaluation): Promise<TestResult[]> {
  const results: TestResult[] = [];
  await runTests({ name: d.name, tests: evaluationTests(d, { store }), services: ctx.services, concurrency: d.concurrency, onEvent: (e) => e.type === 'test-end' && results.push(e.result) });
  return results.sort((a, b) => a.id.localeCompare(b.id));
}

const ragOf = (r: TestResult) => (r.metadata as { rag: { record: { turns: Array<{ role: string; content: string }>; simulated?: SimulationOutcome }; sample: { answer: string }; conversation?: { turns: number; simulated?: string } } }).rag;

describe('a record with a persona and a goal is played by a simulated user', () => {
  it('the question opens, the model writes the next messages, and the conversation ends when the goal is met', async () => {
    seen.length = 0;
    const ctx = context([{ match: 'book a visit for Rex', responses: [move('continue', 'Tuesday morning please'), move('continue', 'Yes, Rex is a dog'), move('goal-met', '', 'the visit is booked')] }]);
    try {
      const [r] = await run(ctx, evaluation(JSON.stringify({ id: 's1', question: 'I need a visit', persona: 'terse', goal: 'book a visit for Rex on Tuesday' })));
      expect(r!.status, JSON.stringify(r!.error)).toBe('passed');
      const rag = ragOf(r!);
      expect(rag.record.turns.filter((x) => x.role === 'user').map((x) => x.content)).toEqual(['I need a visit', 'Tuesday morning please', 'Yes, Rex is a dog']);
      expect(rag.record.turns.at(-1)).toMatchObject({ role: 'assistant', content: 'reply 3 to: Yes, Rex is a dog' });
      expect(rag.record.simulated).toMatchObject({ personaId: 'terse', goal: 'book a visit for Rex on Tuesday', ended: 'goal-met', reason: 'the visit is booked', userTurns: 3 });
      expect(rag.conversation).toMatchObject({ turns: 3, simulated: 'goal-met' });
      // the system under test saw a growing history, as with a scripted conversation
      expect(seen.map((m) => m.length)).toEqual([1, 3, 5]);
    } finally {
      await ctx.dispose();
    }
  }, 60_000);

  it('stops at the turn limit, and when the user gives up; without a question the model writes the opening', async () => {
    seen.length = 0;
    const ctx = context([
      { match: 'never satisfied', response: move('continue', 'and then?') },
      { match: 'refund for order 7', responses: [move('continue', 'I want my money back'), move('gave-up', '', 'the bot went in circles')] },
    ]);
    try {
      const rows = [JSON.stringify({ id: 'a', question: 'hello', simulate: true, goal: 'never satisfied', max_turns: 3 }), JSON.stringify({ id: 'b', persona: 'An angry customer who writes in capitals.', goal: 'refund for order 7' })].join('\n');
      const [a, b] = await run(ctx, evaluation(rows));
      expect(ragOf(a!).record.simulated).toMatchObject({ ended: 'turn-limit', userTurns: 3, personaId: 'plain' });
      expect(ragOf(a!).conversation?.turns).toBe(3);
      expect(ragOf(b!).record.simulated).toMatchObject({ ended: 'gave-up', reason: 'the bot went in circles', userTurns: 1, persona: 'An angry customer who writes in capitals.' });
      expect(ragOf(b!).record.turns[0]).toMatchObject({ role: 'user', content: 'I want my money back' });
    } finally {
      await ctx.dispose();
    }
  }, 60_000);

  it('a model that does not answer in the format fails the sample with what to do; a persona without a goal is refused', async () => {
    const ctx = context([{ match: 'broken model', response: 'I am the assistant, how can I help?' }]);
    try {
      const [r] = await run(ctx, evaluation(JSON.stringify({ id: 'x', question: 'hi', persona: 'plain', goal: 'broken model' })));
      expect(r!.status).not.toBe('passed');
      expect(JSON.stringify(r!.error)).toMatch(/simulated user/);
    } finally {
      await ctx.dispose();
    }
    expect(() => simulationOf({ persona: 'terse' }, undefined)).toThrow(/needs a goal/);
    // scripted turns are replayed, never simulated; no persona means no simulation
    expect(simulationOf({ persona: 'terse' }, { turns: [{ role: 'user', content: 'hi' }], expectedOutcome: 'x' })).toBeUndefined();
    expect(simulationOf({ question: 'hi' }, { expectedOutcome: 'x' })).toBeUndefined();
    expect(simulationOf({ persona: 'IMPATIENT', max_turns: 99 }, { expectedOutcome: 'x' })).toMatchObject({ personaId: 'impatient', maxTurns: 30 });
    expect(new Set(PERSONAS.map((p) => p.id)).size).toBe(PERSONAS.length);
  }, 60_000);
});
