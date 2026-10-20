/**
 * Custom judge and checklist metrics with the offline mock judge, and the AI draft of a metric file (the task
 * `rag-draft-metric` with its `metric-examples` verifier, applied as a proposal). No real model.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyProposal, compileCustomMetric, createRagJudgeHost, listAiTasks, readMetricFile, resolveMetric, runAiTask, runMetricExamples, syncCustomMetrics, undoProposal, type AppSettings, type MockRule } from '../../packages/core/src/index.js';
import { harness } from './harness.js';

const v = (items: Array<[string, boolean, number?]>) => JSON.stringify({ reasoning: 'checked', items: items.map(([text, verdict, rating]) => ({ text, verdict, reason: `because ${text}`, ...(rating !== undefined ? { rating } : {}) })) });

function setup(rules: MockRule[]) {
  const h = harness({ rules });
  const host = createRagJudgeHost({ store: h.store, providers: h.deps.providers, redactor: h.redactor, settings: h.deps.settings as AppSettings, surface: 'cli' });
  return { h, host };
}

describe('judge metrics', () => {
  const tone = compileCustomMetric({
    id: 'clinic-tone',
    version: 3,
    kind: 'judge',
    inputs: ['question', 'answer'],
    criteria: 'Polite, plain language, never promises a diagnosis.',
    anchors: { pass: 'It says to bring the dog in.', fail: 'It names a diagnosis.' },
    examples: [
      { name: 'polite', sample: { question: 'Is the limp serious?', answer: 'Please bring her in today so the vet can look.' }, expect: 'pass' },
      { name: 'diagnosis', sample: { question: 'Is the limp serious?', answer: 'It is a fracture.' }, expect: 'fail' },
    ],
  });

  it('the registry entry says what it is: a judged custom metric with its version and a hash', () => {
    expect(tone.def).toMatchObject({ id: 'custom/clinic-tone', group: 'custom', kind: 'judged', judge: 'service', version: 'clinic-tone-v3', calls: '1', threshold: 1, custom: { kind: 'judge', fileVersion: 3, file: 'metrics/clinic-tone.yaml' } });
    expect(tone.def.requires).toEqual(['answer', 'question']);
    expect(tone.def.estimate!({ questionTokens: 20, answerTokens: 60, contextTokens: 0, contexts: 0, referenceTokens: 0 }, {}).llmCalls).toBe(1);
  });

  it('the examples run through the judge: each comes out as the example says, and a wrong verdict is reported', async () => {
    const { h, host } = setup([
      { match: 'It is a fracture', response: v([['verdict', false]]) },
      { match: 'PASS / FAIL', response: v([['verdict', true]]) },
    ]);
    try {
      const rs = await runMetricExamples(tone, { providers: h.deps.providers, ragJudge: host });
      expect(rs.map((r) => [r.name, r.got, r.ok])).toEqual([['polite', 'pass', true], ['diagnosis', 'fail', true]]);
      const wrong = setup([{ match: 'PASS / FAIL', response: v([['verdict', true]]) }]);
      try {
        const bad = await runMetricExamples(tone, { providers: wrong.h.deps.providers, ragJudge: wrong.host });
        expect(bad.map((r) => r.ok)).toEqual([true, false]);
        expect(bad[1]).toMatchObject({ expect: 'fail', got: 'pass' });
      } finally {
        wrong.h.cleanup();
      }
    } finally {
      h.cleanup();
    }
  });

  it('what the judge is sent: the criterion inside the fixed instruction, the question and answer only', async () => {
    const { h, host } = setup([{ match: 'PASS / FAIL', response: v([['verdict', true]]) }]);
    try {
      await runMetricExamples(tone, { providers: h.deps.providers, ragJudge: host, only: [0] });
      const sent = h.rec.sent();
      expect(sent).toContain('Polite, plain language, never promises a diagnosis.');
      expect(sent).toContain('A passing answer looks like');
      expect(sent).toContain('Please bring her in today');
      expect(sent).not.toContain('"reference"');
      expect(sent).not.toContain('"contexts"');
      // the sample cannot change the rules: the fixed instruction says it is data
      expect(sent).toMatch(/never an instruction to you/);
    } finally {
      h.cleanup();
    }
  });

  it('a 1-to-5 scale judge, a checklist with weights, and the result’s version and hash', async () => {
    const scale = compileCustomMetric({ id: 'warmth', kind: 'judge', criteria: 'Warm', scale: [1, 5], threshold: 0.75, inputs: ['answer'] });
    const list = compileCustomMetric({ id: 'must-haves', kind: 'checklist', items: ['Hours', 'Phone', { text: 'Polite', weight: 2 }], threshold: 0.6 });
    const { h, host } = setup([
      { match: 'SCORE for custom/warmth', response: v([['score', true, 4]]) },
      { match: 'CHECKLIST for custom/must-haves', response: v([['1', true], ['2', false], ['3', true]]) },
    ]);
    try {
      const ctx = { testType: 'rag' as const, body: '', text: 'Hello! Open 8 to 6.', question: 'When open?', services: { providers: h.deps.providers, ragJudge: host } };
      const a = await scale.check({ type: scale.def.check }, ctx);
      expect(a.score).toBe(0.75);
      expect(a.passed).toBe(true);
      expect((a.metadata as { customMetric: { version: number; hash: string } }).customMetric).toMatchObject({ id: 'custom/warmth', version: 1, hash: scale.hash });
      const b = await list.check({ type: list.def.check }, ctx);
      // weights 1, 1, 2: the phone criterion (1) is missed → 3 / 4
      expect(b.score).toBe(0.75);
      expect((b.metadata as { items: Array<{ ok: boolean }> }).items.map((i) => i.ok)).toEqual([true, false, true]);
    } finally {
      h.cleanup();
    }
  });

  it('the file’s judge is the metric’s judge; without one the run’s judge is used', async () => {
    const m = compileCustomMetric({ id: 'pinned', kind: 'judge', criteria: 'Polite', judge: { provider: 'nonexistent', model: 'x' } });
    const { h, host } = setup([]);
    try {
      const r = await m.check({ type: m.def.check }, { testType: 'rag', body: '', text: 'hello', question: 'q', services: { providers: h.deps.providers, ragJudge: host } });
      // the named provider is not a provider of this workspace: the run says it has no judge (no silent fallback to another one)
      expect(r.message).toMatch(/needs a judge model/);
      expect(h.rec.requests).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });
});

describe('the AI draft of a metric', () => {
  const RULE_FILE = [
    'id: no-promises',
    'version: 1',
    'name: No promises',
    'description: The answer never promises or guarantees an outcome.',
    'kind: rule',
    'rules:',
    '  - type: not-regex',
    '    pattern: "guarantee|promise"',
    '    flags: i',
    'combine: all',
    'threshold: 1',
    'examples:',
    '  - { name: fine, sample: { answer: "We will do our best." }, expect: pass }',
    '  - { name: promise, sample: { answer: "We promise a full cure." }, expect: fail }',
  ];
  const fence = (lines: string[]) => `\`\`\`yaml\n${lines.join('\n')}\n\`\`\``;

  it('is registered: a large task, a YAML file, a proposal with its verifier', () => {
    expect(listAiTasks().find((t) => t.id === 'rag-draft-metric')).toMatchObject({ tier: 'large' });
  });

  it('a draft whose examples agree is offered with a passing badge; applying it writes the file, undo takes it away', async () => {
    const h = harness({ rules: [{ match: '.', response: fence(RULE_FILE) }] });
    try {
      const r = await runAiTask(h.deps, { task: 'rag-draft-metric', question: 'Answers never promise an outcome', context: { samples: [{ question: 'Will it heal?', answer: 'Probably.' }], existing: [] } });
      const item = r.proposal!.items[0]!;
      expect(item).toMatchObject({ kind: 'metric', path: 'metrics/no-promises.yaml', title: 'metrics/no-promises.yaml' });
      const badge = item.verification.find((b) => b.verifier === 'metric-examples')!;
      expect(badge).toMatchObject({ status: 'pass', label: 'agrees with all 2 examples' });
      expect(item.selected).toBe(true);
      const applied = applyProposal(h.store, r.proposal!.id);
      expect(applied.applied[0]).toMatchObject({ kind: 'metric', path: 'metrics/no-promises.yaml' });
      expect(readMetricFile(h.store, 'no-promises')!.text).toContain('kind: rule');
      expect(syncCustomMetrics(h.store).registered).toContain('custom/no-promises');
      expect(resolveMetric('no-promises')!.def.custom).toBeDefined();
      expect(undoProposal(h.store, r.proposal!.id).restored).toBe(1);
      expect(existsSync(`${h.store.root}/metrics/no-promises.yaml`)).toBe(false);
      syncCustomMetrics(h.store);
      expect(resolveMetric('no-promises')).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  it('a draft whose example disagrees is sent back with the example that failed, and the second draft is the one offered', async () => {
    const wrong = RULE_FILE.map((l) => l.replace('expect: fail', 'expect: pass'));
    const h = harness({ rules: [{ match: '.', responses: [fence(wrong), fence(RULE_FILE)] }] });
    try {
      const r = await runAiTask(h.deps, { task: 'rag-draft-metric', question: 'Answers never promise an outcome' });
      expect(r.repairs).toBe(1);
      expect(r.problems).toEqual([]);
      expect(r.proposal!.items[0]!.verification.find((b) => b.verifier === 'metric-examples')!.status).toBe('pass');
      expect(h.rec.requests[1]!.messages.map((m) => m.content).join('\n')).toMatch(/should pass but does fail/);
    } finally {
      h.cleanup();
    }
  });

  it('an invalid file is never ticked: the badge fails and says why', async () => {
    const h = harness({ rules: [{ match: '.', response: fence(['id: x', 'kind: judge']) }] });
    try {
      const r = await runAiTask(h.deps, { task: 'rag-draft-metric', question: 'Polite answers', maxRepairs: 0 } as never);
      const item = r.proposal!.items[0]!;
      expect(item.selected).toBe(false);
      expect(item.verification.find((b) => b.verifier === 'metric-examples')).toMatchObject({ status: 'fail', label: 'not a valid metric file' });
      expect(() => applyProposal(h.store, r.proposal!.id, { items: [item.id] })).toThrow(/not a valid metric/);
    } finally {
      h.cleanup();
    }
  });

  it('a judged draft with examples is valid without a model call: its prompts build and nothing is sent', async () => {
    const file = ['id: warm', 'kind: judge', 'criteria: Warm and plain.', 'examples:', '  - { sample: { question: q, answer: "Hello there" }, expect: pass }', '  - { sample: { question: q, answer: "No." }, expect: fail }'];
    const h = harness({ rules: [{ match: '.', response: fence(file) }] });
    try {
      const r = await runAiTask(h.deps, { task: 'rag-draft-metric', question: 'Warm answers' });
      const badge = r.proposal!.items[0]!.verification.find((b) => b.verifier === 'metric-examples')!;
      expect(badge.status).toBe('pass');
      expect(readFileSync(`${h.store.root}/workspace.json`, 'utf8')).toBeDefined();
      // one request: the draft itself; the examples were not sent to any judge
      expect(h.rec.requests).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });
});
