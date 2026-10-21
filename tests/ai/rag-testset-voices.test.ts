/**
 * Test-set generation with personas, styles and the comparison by meaning, end to end with the offline mock provider: the
 * voices reach the model in the slots and the rows, the estimate and "what will be sent" show them, and a question that means
 * the same as one of an earlier batch is unticked. No real model, no network.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRagJudgeHost, estimateGeneration, generateTestset, type AiRunDeps, type AppSettings, type ExecServices, type MockRule } from '../../packages/core/src/index.js';
import { harness } from './harness.js';

const DOC = ['Happy Paws is a veterinary clinic. The clinic opens at 8am on weekdays and closes at 6pm.', 'Puppies receive their first vaccine at 8 weeks. The booster costs 45 dollars.'].join('\n\n');
const VERDICT = JSON.stringify({ reasoning: 'checked', items: [{ text: 'claim', verdict: true, reason: '[handbook#1] "opens at 8am"' }] });
const samples = (qs: string[]) => JSON.stringify({ samples: qs.map((question, i) => ({ slot: i + 1, type: 'single-hop', question, reference: 'It opens at 8am on weekdays and closes at 6pm.', chunks: [], answerable: true })) });

function setup(rules: MockRule[]) {
  const h = harness({ rules });
  mkdirSync(join(h.store.root, 'docs'), { recursive: true });
  writeFileSync(join(h.store.root, 'docs', 'handbook.md'), DOC);
  const host = createRagJudgeHost({ store: h.store, providers: h.deps.providers, redactor: h.redactor, settings: h.deps.settings as AppSettings, surface: 'cli' });
  const deps: AiRunDeps = { ...h.deps, services: { providers: h.deps.providers, ragJudge: host } as ExecServices };
  return { h, deps, host };
}

describe('personas and styles in a run', () => {
  it('reach the model in the slots, the rows (tags and generator metadata) and the estimate', async () => {
    const { h, deps, host } = setup([
      { match: 'REFERENCE SUPPORT', response: VERDICT },
      { match: 'slots', response: samples(['When does Happy Paws open on weekdays?', 'wen do u open weekdays']) },
    ]);
    try {
      const o = { paths: ['docs'], count: 2, types: ['single-hop' as const], name: 'voices', seed: 'a', personas: ['a nurse on night shift', 'a student'], styles: ['terse', 'typos'] };
      const e = await estimateGeneration(h.store, host, o);
      expect(e.metrics[0]!.name).toBe('Write the questions');
      const r = await generateTestset(deps, h.store, o);
      const sent = h.rec.sent();
      expect(sent).toContain('a nurse on night shift');
      expect(sent).toContain('typos');
      const recs = r.proposal.items.map((i) => (i.data as { record: { tags: string[]; metadata: { generator: { persona?: string; style?: string; version: number } } } }).record);
      expect(recs[0]!.tags).toEqual(expect.arrayContaining(['persona:a-nurse-on-night-shift', 'style:terse']));
      expect(recs[1]!.metadata.generator).toMatchObject({ persona: 'a student', style: 'typos', version: 2 });
    } finally {
      h.cleanup();
    }
  });

  it('too many or too long voices are refused before anything is sent', async () => {
    const { h, deps } = setup([{ match: 'slots', response: samples(['q?']) }]);
    try {
      await expect(generateTestset(deps, h.store, { paths: ['docs'], count: 1, personas: Array.from({ length: 9 }, (_, i) => `p${i}`) })).rejects.toThrow(/At most 8/);
      expect(h.rec.requests).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });
});

describe('dedupe: embedding', () => {
  const base = 'When does the clinic open on weekdays in the morning';
  it('unticks a question that means the same as one of an earlier batch, and the estimate counts the embeddings', async () => {
    const batch = (qs: string[]) => samples(qs);
    const { h, deps, host } = setup([
      { match: 'REFERENCE SUPPORT', response: VERDICT },
      // 9 questions = two batches of the task: the second batch's last question repeats the first batch's first by meaning
      { match: 'slots', responses: [batch(Array.from({ length: 8 }, (_, i) => (i === 0 ? base : `Question number ${i} about booster vaccines ${'x'.repeat(i)}`))), batch([`${base} hours today`])] },
    ]);
    try {
      const o = { paths: ['docs'], count: 9, types: ['single-hop' as const], name: 'dedupe', seed: 'a', dedupe: 'embedding' as const, embedder: 'mock-ai' };
      const e = await estimateGeneration(h.store, host, o);
      expect(e.total.embedCalls).toBe(9);
      expect(e.metrics.map((m) => m.id)).toContain('dedupe-embedding');
      const r = await generateTestset(deps, h.store, o);
      const last = r.proposal.items[8]!;
      const badge = last.verification.filter((b) => b.verifier === 'testset-duplicate');
      expect(badge.some((b) => b.status === 'fail' && /means the same/.test(b.label))).toBe(true);
      expect(last.selected).toBe(false);
      expect(r.proposal.items[0]!.selected).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it('an unknown mode is refused', async () => {
    const { h, deps } = setup([]);
    try {
      await expect(generateTestset(deps, h.store, { paths: ['docs'], count: 1, dedupe: 'telepathy' as never })).rejects.toThrow(/Unknown dedupe mode/);
    } finally {
      h.cleanup();
    }
  });
});
