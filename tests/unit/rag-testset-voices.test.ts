/**
 * Test-set generation: personas and styles (who asks, how they word it) and the comparison of questions by meaning. The
 * embedding model is the offline mock provider's (a hashed bag of words); no real model is called.
 */
import { describe, expect, it } from 'vitest';
import {
  ApsError,
  chunkCorpus,
  closestQuestion,
  corpusToken,
  embedderFor,
  estimateTestset,
  meaningBadge,
  parseTestsetVoices,
  planBatch,
  rememberCorpus,
  verifyDuplicate,
  type AiRunDeps,
  type ProposalItem,
  type TestsetRecord,
} from '../../packages/core/src/index.js';
import { harness } from '../ai/harness.js';

const corpus = chunkCorpus([
  { name: 'a.md', kind: 'file', format: 'markdown', text: '# A\n\nThe clinic opens at 8am on weekdays.\n\n## Fees\n\nA checkup costs 40 euros.\n\n## Vaccines\n\nPuppies are vaccinated at 8 weeks.' },
  { name: 'b.md', kind: 'file', format: 'markdown', text: '# B\n\nParking is free for patients.\n\n## Pets\n\nWe treat dogs and cats.' },
]);

describe('personas and styles', () => {
  const o = { seed: 's', batch: 0, count: 8, types: ['single-hop' as const] };
  it('go round in turn over the slots and are the same for the same inputs', () => {
    const plan = planBatch(corpus.chunks, { ...o, personas: ['a nurse', 'a student', 'a vet'], styles: ['terse', 'typos'] });
    expect(plan.slots.map((s) => s.persona)).toEqual(['a nurse', 'a student', 'a vet', 'a nurse', 'a student', 'a vet', 'a nurse', 'a student']);
    expect(plan.slots.map((s) => s.style)).toEqual(['terse', 'typos', 'terse', 'typos', 'terse', 'typos', 'terse', 'typos']);
    expect(planBatch(corpus.chunks, { ...o, personas: ['a nurse', 'a student', 'a vet'], styles: ['terse', 'typos'] })).toEqual(plan);
    // without them the slots are what they were
    expect(planBatch(corpus.chunks, o).slots.every((s) => s.persona === undefined && s.style === undefined)).toBe(true);
  });

  it('the list is read from a text or an array, trimmed, unique, short and at most eight', () => {
    expect(parseTestsetVoices('a nurse,  a student\na nurse', 'personas')).toEqual(['a nurse', 'a student']);
    expect(parseTestsetVoices(['terse', ' typos '], 'styles')).toEqual(['terse', 'typos']);
    expect(parseTestsetVoices(undefined, 'styles')).toEqual([]);
    expect(() => parseTestsetVoices(Array.from({ length: 9 }, (_, i) => `p${i}`), 'personas')).toThrow(ApsError);
    expect(() => parseTestsetVoices('x'.repeat(121), 'styles')).toThrow(/short description/);
  });

  it('the estimate counts what the voices add to the prompt', () => {
    const h = harness({ rules: [] });
    try {
      const host = { deps: { providers: h.deps.providers, settings: h.deps.settings } } as never;
      const plain = estimateTestset(host, undefined, corpus, { count: 8, types: ['single-hop'], seed: 's' });
      const voiced = estimateTestset(host, undefined, corpus, { count: 8, types: ['single-hop'], seed: 's', personas: ['a night-shift nurse who is in a hurry'], styles: ['terse'] });
      expect(voiced.total.inputTokens).toBeGreaterThan(plain.total.inputTokens);
    } finally {
      h.cleanup();
    }
  });
});

function row(q: string, id: string): ProposalItem {
  const token = corpusToken(corpus, 'v');
  rememberCorpus(token, corpus);
  const record: TestsetRecord = {
    id: `ts-${id}`,
    question: q,
    reference: 'x',
    reference_ids: [corpus.chunks[0]!.id],
    reference_contexts: [corpus.chunks[0]!.text],
    answerable: true,
    tags: ['generated'],
    metadata: { generator: { task: 'rag-generate-testset', version: 2, seed: 's', batch: 7, type: 'single-hop' } },
  };
  return { id, kind: 'dataset-row', title: q, after: `${JSON.stringify(record)}\n`, language: 'json', data: { dataset: 'datasets/t.jsonl', record, corpus: token, dedupe: 'embedding', embedder: 'mock-ai' }, verification: [], selected: true };
}

describe('comparing questions by meaning', () => {
  const base = 'When does the clinic open on weekdays in the morning';
  const near = `${base} hours today`;

  it('a paraphrase that shares few content words passes the words check and fails by meaning', async () => {
    const h = harness({ rules: [] });
    try {
      const deps = { providers: h.deps.providers, settings: h.deps.settings, redactor: h.redactor } as unknown as AiRunDeps;
      const a = row(base, 'i1');
      const b = row(near, 'i2');
      expect((await verifyDuplicate(a, { runDeps: deps }))!.status).toBe('pass');
      const second = await verifyDuplicate(b, { runDeps: deps });
      expect(second).toMatchObject({ verifier: 'testset-duplicate', status: 'fail' });
      expect(second!.label).toMatch(/means the same as an earlier question \(similarity 0\.9\d+\)/);
      // a different question is not a duplicate by words or meaning
      const c = await verifyDuplicate(row('What does the booster cost for puppies', 'i3'), { runDeps: deps });
      expect(c).toMatchObject({ status: 'pass', label: expect.stringMatching(/words and meaning/) });
    } finally {
      h.cleanup();
    }
  });

  it('without a model that embeds the words are compared and the badge says so', async () => {
    const h = harness({ rules: [] });
    try {
      const noProviders = { providers: undefined, settings: h.deps.settings, redactor: h.redactor } as unknown as AiRunDeps;
      const a = row(base, 'i1');
      await verifyDuplicate(a, { runDeps: noProviders });
      const b = await verifyDuplicate(row(near, 'i2'), { runDeps: noProviders });
      expect(b).toMatchObject({ status: 'pass' });
      expect(b!.detail).toMatch(/words only/);
    } finally {
      h.cleanup();
    }
  });

  it('closestQuestion works with any embedder: the nearest earlier question and its similarity', async () => {
    const e = { name: 'fake', embed: async (texts: string[]) => texts.map((t) => (t.includes('cheap') ? [1, 0] : t.includes('inexpensive') ? [0.99, 0.14] : [0, 1])) };
    const r = await closestQuestion(e, 'an inexpensive checkup?', ['where is parking?', 'a cheap checkup?']);
    expect(r.closest).toEqual({ question: 'a cheap checkup?', similarity: 0.99 });
    expect(meaningBadge(r)).toMatchObject({ status: 'fail' });
    expect(meaningBadge({ closest: { question: 'q', similarity: 0.87 }, embedder: 'fake' })).toMatchObject({ status: 'warn' });
    expect(meaningBadge({ closest: { question: 'q', similarity: 0.3 }, embedder: 'fake' })).toMatchObject({ status: 'pass' });
    // an embedder that fails: the words stand, nothing is invented
    const broken = await closestQuestion({ name: 'x', embed: async () => Promise.reject(new Error('boom')) }, 'q', ['p']);
    expect(broken.problem).toMatch(/boom/);
    expect(meaningBadge(broken)).toMatchObject({ status: 'pass', detail: expect.stringMatching(/words only/) });
  });

  it('Local only refuses a cloud embedding model before anything is sent', () => {
    const h = harness({ rules: [] });
    try {
      const settings = { ...(h.deps.settings as object), ai: { localOnly: true } } as never;
      // the mock provider stays on this computer: allowed
      expect(embedderFor({ providers: h.deps.providers, settings }, 'mock-ai')).toHaveProperty('name');
      expect(embedderFor({ providers: undefined }, 'mock-ai')).toHaveProperty('problem');
    } finally {
      h.cleanup();
    }
  });
});
