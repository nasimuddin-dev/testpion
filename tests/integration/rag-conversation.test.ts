/**
 * RAG R3 end to end against local mock servers (no key, no network beyond 127.0.0.1, the judge is the offline mock): a
 * conversation is replayed turn by turn against a target that keeps the history (stateless) or a session id (server-side),
 * the transcript, the tool calls and the retrieved chunks of every turn reach the metrics, `per-turn:` metrics score each
 * turn, `when` / `unless` route metrics by another metric's result, the seeded probe sets run through a refusing system, and
 * a picture a system returns is sent to the judge as data and never kept in the result.
 */
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MemorySecretStore,
  WorkspaceStore,
  assertEvaluationRunnable,
  createEngineContext,
  defaultSettings,
  evaluationTests,
  runTests,
  saveRagTarget,
  seedProbeSets,
  targetProblems,
  type EngineContext,
  type MockRule,
  type RagTarget,
  type SavedEvaluation,
  type TestResult,
} from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const t = tempDir('tp-rag-conv-');
let server: Server;
let base = '';
let store: WorkspaceStore;
const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
const sessions = new Map<string, number>();

const verdicts = (xs: boolean[], names = 'turn') => JSON.stringify({ reasoning: 'checked', items: xs.map((v, i) => ({ text: `${names} ${i + 1}`, verdict: v, reason: v ? 'fine' : 'not fine' })) });

/** The offline judge: one scripted answer per prompt kind. */
const RULES: MockRule[] = [
  { match: 'knowledge-retention-v1', response: verdicts([true, false, true]) },
  { match: 'conversation-completeness-v1', response: JSON.stringify({ reasoning: 'r', items: [{ text: 'say hello', verdict: true, reason: 'done' }, { text: 'ask the name', verdict: true, reason: 'done' }] }) },
  // per-turn faithfulness: one answer per turn, in order
  { match: 'faithfulness-v1', responses: [verdicts([true, true], 'claim'), verdicts([true, false], 'claim'), verdicts([false, false], 'claim')] },
  { match: 'answer-relevance-v1', response: verdicts([true, true], 'statement') },
  { match: 'context-recall-judge-v1', response: verdicts([true, true], 'statement') },
  { match: 'multimodal-faithfulness-v1', response: JSON.stringify({ reasoning: 'the picture shows it', items: [{ text: 'verdict', verdict: true, reason: 'image 1 shows it' }] }) },
];

function context(rules: MockRule[] = RULES): EngineContext {
  store.saveProviders([{ id: 'judge', name: 'Mock judge', kind: 'mock', baseUrl: 'mock://local', defaultModel: 'mock-model', headers: [{ key: 'x-mock-rules', value: JSON.stringify(rules) }] }]);
  const settings = { ...defaultSettings(), assistantProvider: 'judge', assistantModel: 'mock-model', pricing: [{ provider: '*', model: 'mock-model', inputPerMillion: 1, outputPerMillion: 2, version: 'test' }] };
  return createEngineContext({ store, secrets: new MemorySecretStore(), settings, aiSurface: 'cli' });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const path = req.url ?? '';
      seen.push({ path, body });
      res.setHeader('content-type', 'application/json');
      if (path === '/stateless') {
        const messages = body.messages as Array<{ role: string; content: string }>;
        const last = messages[messages.length - 1]!.content;
        const turn = messages.filter((m) => m.role === 'user').length;
        res.end(JSON.stringify({ answer: `reply ${turn} to: ${last}`, sources: [{ id: `doc-${turn}`, text: `context for turn ${turn}`, score: 0.9 }], tool_calls: [{ function: { name: 'lookup', arguments: JSON.stringify({ q: last }) } }] }));
      } else if (path === '/session') {
        const id = String(body.conversation_id || `c-${sessions.size + 1}`);
        sessions.set(id, (sessions.get(id) ?? 0) + 1);
        res.end(JSON.stringify({ answer: `turn ${sessions.get(id)} in ${id}`, sources: [{ id: 'doc-1', text: 'a chunk' }], conversation_id: id }));
      } else if (path === '/refuse') res.end(JSON.stringify({ answer: 'I can’t help with that.', sources: [] }));
      else if (path === '/picture') res.end(JSON.stringify({ answer: 'It is an electric SUV.', sources: [{ id: 'img-1', text: '', image: PNG }, { id: 'doc-2', text: 'The Model X is an SUV.' }] }));
      else res.end(JSON.stringify({ answer: 'ok', sources: [] }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  store = WorkspaceStore.create(join(t.dir, 'ws'), 'RAG conversation');
});
afterAll(async () => {
  server.close();
  store.close();
  t.cleanup();
});

const mapping: RagTarget['mapping'] = { answer: '$.answer', contexts: '$.sources[*]', context: { text: '$.text', id: '$.id', score: '$.score' }, toolCalls: '$.tool_calls[*]' };
const TARGETS = {
  stateless: (): RagTarget => ({ protocol: 'http', step: { type: 'http', method: 'POST', url: `${base}/stateless`, json: { messages: '{{messages}}' } }, mapping, conversation: { mode: 'stateless-history' } }),
  session: (): RagTarget => ({ protocol: 'http', step: { type: 'http', method: 'POST', url: `${base}/session`, json: { message: '{{question}}', conversation_id: '{{conversationId}}' } }, mapping: { ...mapping, conversationId: '$.conversation_id' }, conversation: { mode: 'server-session' } }),
};

const record = (turns: string[], extra: Record<string, unknown> = {}) => JSON.stringify({ id: 'c1', turns, reference: 'Ann', ...extra });

function evaluation(target: string, dataset: string, evaluators: SavedEvaluation['evaluators'], extra: Partial<SavedEvaluation> = {}): SavedEvaluation {
  return { name: 'Conversations', type: 'rag', provider: '', model: '', prompt: '', format: 'text', datasetFormat: 'jsonl', dataset, expectedField: 'expected', evaluators, concurrency: 1, retries: 0, target, judge: { provider: 'judge', model: 'mock-model' }, ...extra };
}

async function run(ctx: EngineContext, d: SavedEvaluation): Promise<TestResult[]> {
  const results: TestResult[] = [];
  await runTests({ name: d.name, tests: evaluationTests(d, { store }), services: ctx.services, concurrency: d.concurrency, onEvent: (e) => e.type === 'test-end' && results.push(e.result) });
  return results.sort((a, b) => a.id.localeCompare(b.id));
}

const ragOf = (r: TestResult) => (r.metadata as { rag: { record: { turns: Array<{ role: string; content: string; contexts?: unknown[]; toolCalls?: unknown[] }>; toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }> }; sample: { answer: string; toolCalls?: unknown[] }; conversation?: { turns: number; conversationId?: string } } }).rag;
const by = (r: TestResult, name: string) => r.checks.find((c) => c.name === name || c.type === name)!;

describe('a conversation is replayed turn by turn', () => {
  it('stateless history: every request carries the earlier messages; the transcript keeps the system’s own answers, chunks and tool calls', async () => {
    saveRagTarget(store, { name: 'Stateless', target: TARGETS.stateless() });
    seen.length = 0;
    const ctx = context();
    try {
      const [r] = await run(ctx, evaluation('Stateless', record(['Hi, I am Ann.', 'What is my name?', 'Thanks']), [{ type: 'latency', max: 5000 }]));
      expect(r!.status).toBe('passed');
      // the history grows: 1, 3, 5 messages (user, assistant, user …)
      expect(seen.filter((s) => s.path === '/stateless').map((s) => (s.body.messages as unknown[]).length)).toEqual([1, 3, 5]);
      const last = seen.at(-1)!.body.messages as Array<{ role: string; content: string }>;
      expect(last.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
      expect(last[1]!.content).toBe('reply 1 to: Hi, I am Ann.');
      const rag = ragOf(r!);
      expect(rag.record.turns.map((x) => x.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
      expect(rag.record.turns[5]).toMatchObject({ role: 'assistant', content: 'reply 3 to: Thanks', contexts: [{ id: 'doc-3' }] });
      // the sample the single-turn metrics score is the last turn
      expect(rag.sample.answer).toBe('reply 3 to: Thanks');
      expect(rag.conversation?.turns).toBe(3);
      // the tool calls the system returned, parsed from OpenAI-style JSON arguments, in order
      expect(rag.record.toolCalls?.map((c) => c.name)).toEqual(['lookup', 'lookup', 'lookup']);
      expect(rag.record.toolCalls?.[1]!.arguments).toEqual({ q: 'What is my name?' });
    } finally {
      await ctx.dispose();
    }
  }, 60_000);

  it('server session: the id the system returns is carried to the next turn, and conversations do not share one', async () => {
    saveRagTarget(store, { name: 'Session', target: TARGETS.session() });
    seen.length = 0;
    sessions.clear();
    const ctx = context();
    try {
      const results = await run(ctx, evaluation('Session', [record(['one', 'two', 'three']), JSON.stringify({ id: 'c2', turns: ['a', 'b'] })].join('\n'), [{ type: 'latency', max: 5000 }]));
      expect(results).toHaveLength(2);
      const bodies = seen.filter((s) => s.path === '/session').map((s) => s.body.conversation_id);
      // the first turn of each conversation has no id; the rest carry the one they were given
      expect(bodies).toEqual(['', 'c-1', 'c-1', '', 'c-2']);
      expect([...sessions.entries()]).toEqual([['c-1', 3], ['c-2', 2]]);
      expect(ragOf(results[0]!).conversation).toMatchObject({ turns: 3, conversationId: 'c-1' });
      expect(ragOf(results[0]!).sample.answer).toBe('turn 3 in c-1');
    } finally {
      await ctx.dispose();
    }
  }, 60_000);

  it('a server-session target without the id mapped is refused with how to fix it', () => {
    const t = { ...TARGETS.session(), mapping };
    expect(targetProblems(t).join(' ')).toMatch(/Conversation id/);
    expect(targetProblems(TARGETS.session())).toEqual([]);
    expect(targetProblems({ ...TARGETS.stateless(), conversation: { mode: 'nonsense' as never } }).join(' ')).toMatch(/stateless-history or server-session/);
  });
});

describe('conversational metrics on the transcript', () => {
  it('score the whole conversation, and per-turn:<metric> scores each turn with its own chunks', async () => {
    const ctx = context();
    try {
      const [r] = await run(
        ctx,
        evaluation('Stateless', record(['Hi, I am Ann.', 'What is my name?', 'Thanks']), [
          { type: 'knowledge-retention' },
          { type: 'conversation-completeness', threshold: 0.8 },
          { type: 'per-turn:faithfulness' },
          { type: 'trajectory-match', mode: 'in-order', expected: ['lookup', 'lookup'] },
        ]),
      );
      expect(by(r!, 'knowledge-retention')).toMatchObject({ score: 0.667, passed: false });
      expect(by(r!, 'conversation-completeness')).toMatchObject({ score: 1, passed: true });
      // turn scores 1, 0.5, 0 → mean 0.5, lowest 0
      const pt = by(r!, 'per-turn');
      expect(pt.score).toBe(0.5);
      expect((pt.metadata as { perTurn: Array<{ turn: number; score: number }> }).perTurn.map((x) => x.score)).toEqual([1, 0.5, 0]);
      // the deterministic trajectory metric reads the tool calls the system made
      expect(by(r!, 'trajectory-match')).toMatchObject({ score: 1, passed: true });
    } finally {
      await ctx.dispose();
    }
  }, 60_000);
});

describe('decision trees: a metric that runs only when another gave a result', () => {
  const evaluators = (): SavedEvaluation['evaluators'] => [
    { type: 'faithfulness', threshold: 0.8 },
    { type: 'context-recall', when: 'faithfulness < 0.8' },
    { type: 'answer-relevance', unless: 'faithfulness < 0.8' },
  ];

  it('the branch that applies runs; the other one is n/a with the reason, and costs nothing', async () => {
    const ctx = context([{ match: 'faithfulness-v1', response: verdicts([true, false], 'claim') }, ...RULES]);
    try {
      const [r] = await run(ctx, evaluation('Stateless', JSON.stringify({ id: 'q1', question: 'What is my name?', reference: 'Ann' }), evaluators()));
      expect(by(r!, 'faithfulness').score).toBe(0.5);
      expect(by(r!, 'context-recall')).toMatchObject({ source: 'ai-judge' });
      expect(typeof by(r!, 'context-recall').score).toBe('number');
      const skipped = by(r!, 'answer-relevance');
      expect(skipped.passed).toBe(true);
      expect((skipped.metadata as { na?: string }).na).toBe('route');
      expect(skipped.message).toMatch(/unless faithfulness < 0\.8/);
    } finally {
      await ctx.dispose();
    }
  }, 60_000);

  it('a circle, an unknown metric and an unreadable condition are refused before the first question', () => {
    const ctx = context();
    try {
      const run1 = (evaluators: SavedEvaluation['evaluators']) => () => assertEvaluationRunnable(store, ctx.services.ragJudge!, evaluation('Stateless', record(['x']), evaluators));
      expect(run1([{ type: 'faithfulness', when: 'answer-relevance < 1' }, { type: 'answer-relevance', when: 'faithfulness < 1' }])).toThrow(/circle/);
      expect(run1([{ type: 'faithfulness', when: 'nothing < 1' }])).toThrow(/not a metric of this evaluation/);
      expect(run1([{ type: 'faithfulness' }, { type: 'answer-relevance', when: 'faithfulness is bad' }])).toThrow(/cannot read the condition/);
    } finally {
      void ctx.dispose();
    }
  });
});

describe('the seeded probe sets', () => {
  it('are written as datasets once, never over a file that is there, and run through a system that refuses everything', async () => {
    const first = seedProbeSets(store, ['jailbreak', 'benign', 'no-such-set']);
    expect(first).toMatchObject({ written: ['datasets/probes-jailbreak.jsonl', 'datasets/probes-benign.jsonl'], skipped: [], unknown: ['no-such-set'] });
    expect(seedProbeSets(store, ['jailbreak'])).toMatchObject({ written: [], skipped: ['datasets/probes-jailbreak.jsonl'] });
    saveRagTarget(store, { name: 'Refuser', target: { protocol: 'http', step: { type: 'http', method: 'POST', url: `${base}/refuse`, json: { q: '{{question}}' } }, mapping: { answer: '$.answer' } } });
    const ctx = context();
    try {
      const mk = (file: string) => evaluation('Refuser', readFileSync(join(store.root, file), 'utf8'), [{ type: 'refusal-correctness' }]);
      const jb = await run(ctx, mk('datasets/probes-jailbreak.jsonl'));
      // every jailbreak should be refused, and is
      expect(jb).toHaveLength(10);
      expect(jb.every((r) => by(r, 'refusal-correctness').score === 1)).toBe(true);
      // the harmless look-alikes should be answered: refusing them is the false refusal the metric exists to count
      const benign = await run(ctx, mk('datasets/probes-benign.jsonl'));
      expect(benign.every((r) => by(r, 'refusal-correctness').score === 0)).toBe(true);
      expect((by(benign[0]!, 'refusal-correctness').metadata as { outcome: string }).outcome).toBe('false-refusal');
    } finally {
      await ctx.dispose();
    }
  }, 60_000);
});

describe('a picture a system returns', () => {
  const picture = (allow: boolean) => evaluation('Pic', JSON.stringify({ id: 'p1', question: 'What about the Tesla Model X?' }), [{ type: 'multimodal-faithfulness' }], { judge: { provider: 'judge', model: 'mock-model', ...(allow ? { allowImages: true } : {}) } });
  const target = (): RagTarget => ({ protocol: 'http', step: { type: 'http', method: 'POST', url: `${base}/picture`, json: { q: '{{question}}' } }, mapping: { answer: '$.answer', contexts: '$.sources[*]', context: { text: '$.text', id: '$.id', image: '$.image' } } });

  it('is not sent unless the evaluation allows images', async () => {
    saveRagTarget(store, { name: 'Pic', target: target() });
    const ctx = context();
    try {
      const [r] = await run(ctx, picture(false));
      const c = by(r!, 'multimodal-faithfulness');
      expect(c.message).toMatch(/does not send images/);
      expect((c.metadata as { na?: string }).na).toBe('images-not-allowed');
      expect(ctx.services.ragJudge!.budget.calls).toBe(0);
    } finally {
      await ctx.dispose();
    }
  }, 60_000);

  it('goes to the vision judge as data, is judged, and is kept in the result by its hash only', async () => {
    const ctx = context();
    try {
      const [r] = await run(ctx, picture(true));
      const c = by(r!, 'multimodal-faithfulness');
      expect(c).toMatchObject({ score: 1, passed: true, source: 'ai-judge' });
      const md = c.metadata as { images: Array<{ sha256: string; bytes: number; from: string; ref: string }>; judgeUsage: { calls: number } };
      expect(md.images).toEqual([expect.objectContaining({ from: 'context img-1', ref: 'data-uri', mime: 'image/png', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })]);
      expect(md.judgeUsage.calls).toBe(1);
      // no image bytes anywhere in what the run kept
      expect(JSON.stringify(r)).not.toContain('iVBORw0KGgo');
      expect(ragOf(r!).sample).toBeDefined();
    } finally {
      await ctx.dispose();
    }
  }, 60_000);
});
