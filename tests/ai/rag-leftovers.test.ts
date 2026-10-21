/**
 * The RAG follow-up rows (B-30c, B-31b, B-32b, B-33b) with the offline mock provider: the judge mode of negative-rejection,
 * the shared claim pass of the context metrics, the noise-sensitivity `mode:` mapping, a jury on claim-level passes. No real
 * model is ever called.
 */
import { describe, expect, it } from 'vitest';
import { createRagJudgeHost, runChecks, type AppSettings, type CheckContext, type MockRule } from '../../packages/core/src/index.js';
import { harness } from './harness.js';

const v = (items: Array<[string, boolean, number?]>, reasoning = 'checked') => JSON.stringify({ reasoning, items: items.map(([text, verdict, rating]) => ({ text, verdict, reason: `because ${text}`, ...(rating !== undefined ? { rating } : {}) })) });

function setup(rules: MockRule[]) {
  const h = harness({ rules });
  const host = createRagJudgeHost({ store: h.store, providers: h.deps.providers, redactor: h.redactor, settings: h.deps.settings as AppSettings, surface: 'cli' });
  const ctx = (over: Partial<CheckContext> = {}): CheckContext => ({
    testType: 'rag',
    body: '',
    text: 'The clinic opens at 8am.',
    question: 'When does the clinic open?',
    expected: 'The clinic opens at 8am.',
    contexts: [{ id: 'doc-1', text: 'The clinic opens at 8am.' }],
    ragRun: { strict: true, metrics: [] },
    services: { providers: h.deps.providers, ragJudge: host },
    ...over,
  });
  const run = async (cfg: Record<string, unknown>, over: Partial<CheckContext> = {}) => (await runChecks([cfg as never], ctx(over)))[0]!;
  return { h, host, ctx, run };
}

describe('negative-rejection judge mode', () => {
  it('the wording decides by default; mode: judge asks the judge and counts a false or a missed refusal', async () => {
    const { run, h } = setup([{ match: 'refusal-judge-v1', response: v([['verdict', true]]) }]);
    try {
      // regex mode: no judge call
      expect(await run({ type: 'negative-rejection' }, { text: 'I cannot answer that.', record: { answerable: false } })).toMatchObject({ score: 1, source: 'heuristic' });
      expect(h.rec.requests).toHaveLength(0);
      // a refusal in words the pattern does not know: the judge reads it as a refusal -> correct for an unanswerable question
      const a = await run({ type: 'negative-rejection', mode: 'judge' }, { text: 'Hmm, let us talk about something else.', record: { answerable: false } });
      expect(a).toMatchObject({ score: 1, source: 'ai-judge' });
      expect((a.metadata as { mode: string; metric: string }).mode).toBe('judge');
      expect(h.rec.requests).toHaveLength(1);
      // the same refusal of an answerable question is a false refusal
      const b = await run({ type: 'negative-rejection', mode: 'judge' }, { text: 'Hmm, let us talk about something else.', record: { answerable: true } });
      expect(b).toMatchObject({ score: 0 });
      expect((b.metadata as { kind: string }).kind).toBe('false-refusal');
    } finally {
      h.cleanup();
    }
  });
});
