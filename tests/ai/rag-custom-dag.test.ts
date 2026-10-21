/**
 * The `dag` kind of a custom metric (a decision tree in metrics/<id>.yaml) with the offline mock judge: the file is checked
 * like the built-in dag metric's tree, the examples run through the same walk, only the path the answers lead to is asked, a
 * tree of rules needs no model, and the catalogue row says what it costs. No real model.
 */
import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { compileCustomMetric, createRagJudgeHost, parseCustomMetric, resolveMetric, runChecks, runMetricExamples, validateCustomMetric, type AppSettings, type CheckContext, type MockRule } from '../../packages/core/src/index.js';
import { customMetricTemplate } from '@testpion/shared';
import { harness } from './harness.js';

const v = (items: Array<[string, boolean, number?]>) => JSON.stringify({ reasoning: 'checked', items: items.map(([text, verdict, rating]) => ({ text, verdict, reason: `because ${text}`, ...(rating !== undefined ? { rating } : {}) })) });

const TREE = {
  root: 'cites',
  nodes: {
    cites: { type: 'binary', question: 'Does the answer cite a source?', yes: 'which', no: { score: 0, reason: 'no citation' } },
    which: { type: 'choice', question: 'Which document does it cite?', options: { 'the right one': { score: 10 }, 'a wrong one': { score: 4, reason: 'wrong document' } } },
  },
};
const FILE = { id: 'cites-right', version: 2, kind: 'dag', inputs: ['question', 'answer'], tree: TREE, threshold: 0.6 } as const;

function setup(rules: MockRule[]) {
  const h = harness({ rules });
  const host = createRagJudgeHost({ store: h.store, providers: h.deps.providers, redactor: h.redactor, settings: h.deps.settings as AppSettings, surface: 'cli' });
  const ctx = (over: Partial<CheckContext> = {}): CheckContext => ({ testType: 'rag', body: '', text: 'See the handbook, section 2.', question: 'When does the clinic open?', ragRun: { strict: true, metrics: [] }, services: { providers: h.deps.providers, ragJudge: host }, ...over });
  return { h, host, ctx };
}

describe('the file', () => {
  it('a valid tree parses; the starting file of the kind is valid', () => {
    expect(parseCustomMetric(stringify(FILE), { fileId: 'cites-right' }).metric).toMatchObject({ kind: 'dag', tree: { root: 'cites' } });
    const tpl = customMetricTemplate('dag', 'starter');
    expect(validateCustomMetric(tpl, { fileId: 'starter' }).filter((p) => p.level === 'error')).toEqual([]);
  });

  it('says what is wrong with the tree, field and all: a missing node, a cycle, a leaf out of range, a rule that needs a model', () => {
    const errs = (tree: unknown) => validateCustomMetric({ id: 'x', kind: 'dag', tree }, { fileId: 'x' }).filter((p) => p.level === 'error' && p.field === 'tree').map((p) => p.message);
    expect(errs(undefined).join(' ')).toMatch(/The tree: the tree is empty/);
    expect(errs({ root: 'a', nodes: { a: { type: 'binary', question: 'q', yes: 'ghost', no: { score: 0 } } } }).join(' ')).toMatch(/leads to "ghost", which is not a node/);
    expect(errs({ root: 'a', nodes: { a: { type: 'binary', question: 'q', yes: 'a', no: { score: 0 } } } }).join(' ')).toMatch(/has a cycle/);
    expect(errs({ root: 'a', nodes: { a: { type: 'binary', question: 'q', yes: { score: 11 }, no: { score: 0 } } } }).join(' ')).toMatch(/from 0 to 10/);
    expect(errs({ root: 'a', nodes: { a: { type: 'rule', check: { type: 'faithfulness' }, yes: { score: 10 }, no: { score: 0 } } } }).join(' ')).toMatch(/node "a" \(rule\).*needs a model/);
    // a tree of rules only is allowed, with a note that a rule metric says the same
    const notes = validateCustomMetric({ id: 'x', kind: 'dag', tree: { root: 'a', nodes: { a: { type: 'rule', check: { type: 'contains', expected: 'x' }, yes: { score: 10 }, no: { score: 0 } } } } }, { fileId: 'x' });
    expect(notes.filter((p) => p.level === 'error')).toEqual([]);
    expect(notes.some((p) => p.level === 'warning' && /Every node is a rule/.test(p.message))).toBe(true);
  });

  it('the tree is part of what a score depends on: a changed question is a new hash, a changed name is not', () => {
    const a = compileCustomMetric(FILE as never);
    const changed = compileCustomMetric({ ...FILE, tree: { ...TREE, nodes: { ...TREE.nodes, cites: { ...TREE.nodes.cites, question: 'Does the answer name a document?' } } } } as never);
    const renamed = compileCustomMetric({ ...FILE, name: 'Another name' } as never);
    expect(changed.hash).not.toBe(a.hash);
    expect(renamed.hash).toBe(a.hash);
  });
});

describe('the catalogue row', () => {
  it('is a judged custom metric that says how many calls it can cost and which prompts it uses', () => {
    const c = compileCustomMetric(FILE as never);
    expect(c.def).toMatchObject({ id: 'custom/cites-right', kind: 'judged', judge: 'service', threshold: 0.6, version: 'cites-right-v2', custom: { kind: 'dag' } });
    expect(c.def.calls).toMatch(/at most 2/);
    expect(c.def.prompts).toEqual(['dag-binary-v1', 'dag-choice-v1']);
    expect(c.def.requires).toEqual(['answer', 'question']);
    expect(c.def.estimate!({ questionTokens: 20, answerTokens: 60, contextTokens: 0, contexts: 0, referenceTokens: 0 }, {}).llmCalls).toBe(2);
    // a tree of rules asks nobody
    const rules = compileCustomMetric({ id: 'r', kind: 'dag', tree: { root: 'a', nodes: { a: { type: 'rule', check: { type: 'contains', expected: 'x' }, yes: { score: 10 }, no: { score: 0 } } } } } as never);
    expect(rules.def).toMatchObject({ kind: 'deterministic', calls: '0' });
    expect(rules.def.judge).toBeUndefined();
  });
});

describe('scoring', () => {
  it('walks the tree like the built-in dag metric: only the path taken is asked, the leaf is the score', async () => {
    const { h, ctx } = setup([
      { match: 'dag-binary-v1', response: v([['verdict', true]]) },
      { match: 'dag-choice-v1', response: v([['choice', true, 2]]) },
    ]);
    try {
      const c = compileCustomMetric(FILE as never);
      const r = await c.check({ type: 'custom/cites-right' }, ctx());
      // the second option is "a wrong one": 4 of 10
      expect(r).toMatchObject({ score: 0.4, passed: false, type: 'custom/cites-right' });
      expect((r.metadata as { path: string[]; customMetric: { id: string; version: number } }).path).toEqual(['cites', 'which']);
      expect((r.metadata as { customMetric: { id: string; version: number } }).customMetric).toMatchObject({ id: 'custom/cites-right', version: 2 });
      expect(h.rec.requests).toHaveLength(2);
    } finally {
      h.cleanup();
    }
  });

  it('the threshold of the file is the pass mark, and a check can set its own', async () => {
    const { h, ctx } = setup([
      { match: 'dag-binary-v1', response: v([['verdict', true]]) },
      { match: 'dag-choice-v1', response: v([['choice', true, 1]]) },
    ]);
    try {
      const c = compileCustomMetric(FILE as never);
      expect(await c.check({ type: 'custom/cites-right' }, ctx())).toMatchObject({ score: 1, passed: true });
      expect((await c.check({ type: 'custom/cites-right', threshold: 1.1 }, ctx())).passed).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it('the examples of the file run through the same walk', async () => {
    const { h, host } = setup([
      { match: 'It cites nothing', response: v([['verdict', false]]) },
      { match: 'dag-binary-v1', response: v([['verdict', true]]) },
      { match: 'dag-choice-v1', response: v([['choice', true, 1]]) },
    ]);
    try {
      const c = compileCustomMetric({
        ...FILE,
        examples: [
          { name: 'cites the right document', sample: { question: 'When?', answer: 'Handbook section 2.' }, expect: 'pass' },
          { name: 'cites nothing', sample: { question: 'When?', answer: 'It cites nothing.' }, expect: 'fail' },
        ],
      } as never);
      const rs = await runMetricExamples(c, { providers: h.deps.providers, ragJudge: host });
      expect(rs.map((r) => [r.name, r.got, r.ok])).toEqual([['cites the right document', 'pass', true], ['cites nothing', 'fail', true]]);
    } finally {
      h.cleanup();
    }
  });

  it('a tree of rules runs with no judge at all, and a judged tree without one says so instead of scoring', async () => {
    const rules = compileCustomMetric({ id: 'polite-ok', kind: 'dag', inputs: ['answer'], tree: { root: 'a', nodes: { a: { type: 'rule', check: { type: 'contains', expected: 'Please' }, yes: { score: 10 }, no: { score: 3 } } } } } as never);
    const bare: CheckContext = { testType: 'rag', body: '', text: 'Please call us.', question: 'q' };
    expect(await rules.check({ type: 'custom/polite-ok' }, bare)).toMatchObject({ score: 1, passed: true });
    const judged = compileCustomMetric(FILE as never);
    const r = await judged.check({ type: 'custom/cites-right' }, bare);
    expect(r.passed).toBe(false);
    expect(r.message).toMatch(/needs a judge model/);
  });

  it('is found by its name and by custom/<id> like any other custom metric', () => {
    compileCustomMetric(FILE as never);
    // (registered by the workspace sync in a real run; compile alone does not register)
    expect(resolveMetric('custom/cites-right')).toBeUndefined();
  });
});
