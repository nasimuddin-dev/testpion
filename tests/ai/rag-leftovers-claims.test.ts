/**
 * Claim-level follow-ups with the offline mock provider: Ragas' noise_sensitivity `mode:` mapping and a jury on the
 * claim-level verdict passes. No real model is ever called.
 */
import { describe, expect, it } from 'vitest';
import { ProviderRegistry, createRagJudgeHost, metricToCheck, runChecks, type AppSettings, type CheckContext, type MockRule, type ProviderConfig } from '../../packages/core/src/index.js';
import { harness, mockProvider } from './harness.js';

const v = (items: Array<[string, boolean, number?]>, reasoning = 'checked') => JSON.stringify({ reasoning, items: items.map(([text, verdict, rating]) => ({ text, verdict, reason: `because ${text}`, ...(rating !== undefined ? { rating } : {}) })) });

const CLAIM_RULES: MockRule[] = [
  { match: 'version claims-v1\\)', response: v([['A1', true], ['A2', true], ['A3', true], ['A4', true], ['A5', true]]) },
  { match: 'version claims-reference-v1\\)', response: v([['R1', true], ['R2', true], ['R3', true], ['R4', true]]) },
  { match: 'claims-vs-reference-v1', response: v([['A1', true], ['A2', true], ['A3', true], ['A4', false], ['A5', false]]) },
  { match: 'reference-claims-vs-answer-v1', response: v([['R1', true], ['R2', true], ['R3', true], ['R4', false]]) },
  { match: 'reference-claims-in-contexts-v1', response: v([['R1', true], ['R2', true], ['R3', true], ['R4', true]]) },
  { match: 'chunk-relevance-v1', response: v([['c1', true], ['c2', true], ['c3', true], ['c4', false]]) },
  { match: 'faithfulness-claims-v1[\\s\\S]*REL-[\\s\\S]*IRR-', response: v([['A1', true], ['A2', true], ['A3', true], ['A4', true], ['A5', false]]) },
  { match: 'faithfulness-claims-v1[\\s\\S]*REL-', response: v([['A1', true], ['A2', true], ['A3', true], ['A4', true], ['A5', false]]) },
  { match: 'faithfulness-claims-v1[\\s\\S]*IRR-', response: v([['A1', false], ['A2', false], ['A3', false], ['A4', false], ['A5', false]]) },
];
const CONTEXTS = [
  { id: 'c1', text: 'REL-1 holds R1' },
  { id: 'c2', text: 'REL-2 holds R2' },
  { id: 'c3', text: 'REL-3 holds R3 and R4' },
  { id: 'c4', text: 'IRR-1 is about something else' },
];

describe('Ragas noise_sensitivity: one name, mode: relevant | irrelevant', () => {
  it('the mode picks the metric, by the Ragas name and by either id', async () => {
    const h = harness({ rules: CLAIM_RULES });
    const host = createRagJudgeHost({ store: h.store, providers: h.deps.providers, redactor: h.redactor, settings: h.deps.settings as AppSettings, surface: 'cli' });
    const run = async (cfg: Record<string, unknown>) =>
      (await runChecks([cfg as never], { testType: 'rag', body: '', text: 'answer', question: 'q', expected: 'reference', contexts: CONTEXTS, ragRun: { strict: true, metrics: [] }, services: { providers: h.deps.providers, ragJudge: host } }))[0]!;
    try {
      expect((await run({ type: 'noise_sensitivity' })).score).toBe(0.2);
      expect((await run({ type: 'noise_sensitivity', mode: 'relevant' })).score).toBe(0.2);
      expect((await run({ type: 'noise_sensitivity', mode: 'irrelevant' })).score).toBe(0);
      expect((await run({ type: 'noise-sensitivity-relevant', mode: 'irrelevant' })).score).toBe(0);
      expect((await run({ type: 'noise-sensitivity-irrelevant', mode: 'relevant' })).score).toBe(0.2);
      expect((await run({ type: 'noise-sensitivity-irrelevant' })).score).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  it('metricToCheck resolves the mode to the metric, so a matrix column has its own name', () => {
    expect(metricToCheck('noise_sensitivity', { mode: 'irrelevant' })).toMatchObject({ type: 'noise-sensitivity-irrelevant' });
    expect(metricToCheck('noise_sensitivity', { mode: 'irrelevant' })).not.toHaveProperty('mode');
    expect(metricToCheck('noise-sensitivity', {})).toMatchObject({ type: 'noise-sensitivity-relevant' });
  });
});

describe('a jury on the claim-level passes', () => {
  const claimJudge = (id: string, againstReference: boolean[]): ProviderConfig => ({
    ...mockProvider(
      [...CLAIM_RULES.filter((r) => r.match !== 'claims-vs-reference-v1'), { match: 'claims-vs-reference-v1', response: v(againstReference.map((ok, i) => [`A${i + 1}`, ok])) }],
      id,
    ),
    name: id,
  });
  const jury = () => {
    const providers: ProviderConfig[] = [claimJudge('judge-a', [true, true, true, false, false]), claimJudge('judge-b', [true, true, true, true, false]), claimJudge('judge-c', [true, true, false, false, false])];
    const h = harness({ rules: [] });
    const reg = new ProviderRegistry(providers, h.vars, h.redactor);
    const host = createRagJudgeHost({ store: h.store, providers: reg, redactor: h.redactor, settings: h.deps.settings as AppSettings, surface: 'cli' });
    const run = async (judge: object) => {
      const ctx: CheckContext = {
        testType: 'rag',
        body: '',
        text: 'answer',
        question: 'q',
        expected: 'reference',
        contexts: CONTEXTS,
        ragRun: { strict: true, metrics: [] },
        services: { providers: reg, ragJudge: host },
        judge: { judges: [{ provider: 'judge-a' }, { provider: 'judge-b' }, { provider: 'judge-c' }], ...judge } as never,
      };
      return (await runChecks([{ type: 'claim-precision' }], ctx))[0]!;
    };
    return { h, run };
  };

  it('each claim is voted on by the judges (majority, mean, min), and the result carries every judge', async () => {
    const { h, run } = jury();
    try {
      // A1, A2: yes for all; A3: a, b yes (2 of 3); A4: b only (1 of 3); A5: none
      const majority = await run({});
      expect(majority.score).toBe(0.6);
      const panel = (majority.metadata as { panel: { judges: Array<{ provider: string; score: number }>; aggregate: string; agreement: number } }).panel;
      expect(panel.judges.map((j) => [j.provider, j.score])).toEqual([['judge-a', 0.6], ['judge-b', 0.8], ['judge-c', 0.4]]);
      expect(panel.aggregate).toBe('majority');
      // the judges agree on A1, A2 and A5
      expect(panel.agreement).toBe(0.6);
      expect((await run({ aggregate: 'min' })).score).toBe(0.4);
      expect((await run({ aggregate: 'mean' })).score).toBe(0.6);
    } finally {
      h.cleanup();
    }
  });
});
