/**
 * Every row of the catalogue is runnable (planning/rag-testing.md R3, "after R3 every row of §2.3 is runnable"): this test
 * walks `metricCatalogue()` and runs each metric on one fixture sample that holds every input a metric can read. Judged
 * metrics are answered by the offline mock judge (a verdict for any prompt), the classifier is a local server, the reward model
 * a mock provider, the pictures a data URI. A metric that is registered but does not run — an unknown check type, a "needs …"
 * for an input the fixture has, an exception — fails here, so a new row cannot be added without being runnable. No real model
 * is ever called, and no key is read.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRagJudgeHost, metricCatalogue, metricToCheck, runChecks, sampleInputs, type AppSettings, type CheckContext, type MockRule } from '../../packages/core/src/index.js';
import { harness } from '../ai/harness.js';

// 1x1 PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const verdict = JSON.stringify({
  reasoning: 'checked',
  items: [
    { text: 'goal', verdict: true, reason: 'the user wanted the opening hours', rating: 1 },
    { text: 'end state', verdict: true, reason: 'the hours were given', rating: 1 },
    { text: 'verdict', verdict: true, reason: 'ok', rating: 1 },
  ],
});
const nvidiaRating = verdict.replace(/"rating":1/g, '"rating":2');

/** Answers any verdict prompt; the NVIDIA accuracy prompt rates 0, 2 or 4; anything else (a reward model's turn) gets a rating line. */
const RULES: MockRule[] = [
  { match: 'rating` is 0, 2 or 4', response: nvidiaRating },
  { match: 'Evaluation task', response: verdict },
  { match: '.', response: 'helpfulness:3.2,correctness:3.0,coherence:3.5,complexity:1.0,verbosity:2.0' },
];

/** What a metric needs beside the sample: the options that have no default. */
const OPTIONS: Record<string, (url: string) => Record<string, unknown>> = {
  'role-adherence': () => ({ role: 'a polite clinic receptionist' }),
  'topic-adherence': () => ({ topics: ['clinic opening hours', 'billing'] }),
  misuse: () => ({ domain: 'answering questions about the clinic' }),
  'role-violation': () => ({ role: 'a polite clinic receptionist' }),
  'off-topic': () => ({ topics: ['the clinic'] }),
  'policy-adherence': () => ({ rules: ['Never quote a price', 'Offer a human handover for complaints'] }),
  'g-eval': () => ({ criteria: 'The answer is polite and gives the hours.' }),
  'conversational-g-eval': () => ({ criteria: 'The assistant stays polite.' }),
  dag: () => ({ tree: { root: 'a', nodes: { a: { type: 'binary', question: 'Does the answer give the hours?', yes: { score: 10 }, no: { score: 2 } } } } }),
  'faithfulness-hhem': (url) => ({ classifier: { url } }),
  'reward-score': () => ({ provider: 'mock-ai' }),
  'mcp-use': () => ({ tools: ['search', 'open'] }),
  'pass-fail': () => ({ criteria: 'The answer is polite.' }),
  'simple-criteria': () => ({ criteria: 'How polite the answer is.', scale: [0, 5] }),
  'rubric-score': () => ({ rubric: { 1: 'rude', 5: 'polite' } }),
  checklist: () => ({ items: ['Mentions the opening hours', 'Is polite'] }),
  'prompt-alignment': () => ({ instructions: ['Answer in one sentence'] }),
  'per-turn': () => ({ metric: 'faithfulness' }),
  'answer-regex': () => ({ pattern: 'clinic' }),
  'answer-length': () => ({ max: 200 }),
};

/** The few metrics that read another shape of answer than prose. */
const CONTEXT: Record<string, Partial<CheckContext>> = {
  'datacompy-score': { text: 'id,name\n1,Ann\n2,Bo', expected: 'id,name\n1,Ann\n2,Bo' },
  'sql-equivalence': { text: 'SELECT COUNT(*) FROM visits', expected: 'SELECT COUNT(*) FROM visits', referenceContexts: ['CREATE TABLE visits (id INTEGER PRIMARY KEY, day TEXT)'] },
  'json-diff': { text: '{"a":1,"b":"x"}', expected: '{"a":1,"b":"y"}' },
  'numeric-diff': { text: '95', expected: '100' },
  'label-f1': { text: '["a","c"]', expected: '["a","b"]' },
};

let server: Server;
let url = '';
beforeAll(async () => {
  // a classifier that finds every claim entailed
  server = createServer((req, res) => {
    req.resume();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ score: 0.93 }));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hhem`;
});
afterAll(() => server.close());

describe('every metric of the catalogue runs', () => {
  const h = harness({ rules: RULES });
  afterAll(() => h.cleanup());
  const host = createRagJudgeHost({ store: h.store, providers: h.deps.providers, redactor: h.redactor, settings: h.deps.settings as AppSettings, surface: 'cli' });

  const ctxFor = (over: Partial<CheckContext> = {}): CheckContext => ({
    testType: 'rag',
    body: '',
    text: 'The clinic opens at 8am. Parking is free for patients.',
    question: 'When does the clinic open?',
    expected: 'The clinic opens at 8am.',
    contexts: [
      { id: 'doc-1', text: 'The clinic opens at 8am on weekdays.', score: 0.91 },
      { id: 'doc-2', text: 'Parking is free for patients.', score: 0.7 },
      { id: 'doc-3', text: '', image: PNG, score: 0.5 },
    ],
    referenceContexts: ['The clinic opens at 8am on weekdays.'],
    referenceIds: ['doc-1'],
    toolCalls: [
      { name: 'search', arguments: { q: 'opening hours' } },
      { name: 'open', arguments: { id: 'doc-1' } },
    ],
    latencyMs: 820,
    record: {
      answerable: true,
      canaries: ['BANANA'],
      source: 'The clinic opens at 8am on weekdays and closes at 6pm. Parking is free for patients. Dogs and cats are treated.',
      rubric: { '1': 'wrong', '5': 'right' },
      goodAnswers: ['We open at 8.'],
      relevance: { 'doc-1': 2 },
      referenceToolCalls: [
        { name: 'search', arguments: { q: 'opening hours' } },
        { name: 'open', arguments: { id: 'doc-1' } },
      ],
      referenceTopics: ['clinic opening hours', 'billing'],
      expectedOutcome: 'The user learns the opening hours.',
      shouldRefuse: false,
      otherAnswer: 'We open at some point.',
      turns: [
        { role: 'user', content: 'When does the clinic open?' },
        { role: 'assistant', content: 'The clinic opens at 8am.', contexts: [{ id: 'doc-1', text: 'The clinic opens at 8am on weekdays.' }] },
        { role: 'user', content: 'And is parking free?' },
        { role: 'assistant', content: 'Parking is free for patients.', contexts: [{ id: 'doc-2', text: 'Parking is free for patients.' }], toolCalls: [{ name: 'search', arguments: { q: 'parking' } }] },
      ],
    },
    judge: { allowImages: true, provider: 'mock-ai', model: 'mock-model' },
    ragRun: { strict: true, metrics: [] },
    services: { providers: h.deps.providers, ragJudge: host },
    ...over,
  });

  it('the fixture holds every input the catalogue reads', () => {
    const c = ctxFor();
    const has = sampleInputs({
      question: c.question,
      answer: c.text,
      reference: c.expected as string,
      contexts: c.contexts,
      referenceIds: c.referenceIds,
      referenceContexts: c.referenceContexts,
      record: c.record,
      toolCalls: c.toolCalls,
      latencyMs: c.latencyMs,
    });
    const wanted = new Set(metricCatalogue().flatMap((m) => m.requires));
    for (const i of wanted) expect(has[i], `the fixture lacks "${i}"`).toBe(true);
  });

  const rows = metricCatalogue().map((m) => [m.id, m] as const);
  it.each(rows)('%s runs', async (id, def) => {
    const cfg = metricToCheck(id, OPTIONS[id]?.(url) ?? {});
    const [r] = await runChecks([cfg], ctxFor(CONTEXT[id] ?? {}));
    expect(r, id).toBeDefined();
    expect(r!.message, id).not.toMatch(/unknown check type/i);
    // the fixture has every input: a "needs …" or a missing judge means the metric did not run
    expect(r!.message, `${id}: ${r!.message}`).not.toMatch(/\bneeds\b|judge failed|no judge model|did not answer in the verdict format|cannot be called|could not read|has a problem/i);
    const na = (r!.metadata as { na?: string } | undefined)?.na;
    // a metric either scores the sample or says why it is n/a; none is left without an outcome
    expect(typeof r!.score === 'number' || !!na || typeof r!.passed === 'boolean', id).toBe(true);
    // a judged metric keeps the judge's identity and what it cost
    if (def.kind === 'judged' && def.judge === 'service' && !na && r!.source === 'ai-judge') expect((r!.metadata as { judgeUsage?: unknown }).judgeUsage, `${id} keeps its usage`).toBeDefined();
  });
});
