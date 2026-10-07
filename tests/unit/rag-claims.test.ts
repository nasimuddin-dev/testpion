import { describe, expect, it } from 'vitest';
import { runChecks, type CheckContext } from '../../packages/core/src/index.js';

// The RAG checks claim by claim (the way Ragas measures them): with a judge, each claim, document or statement gets a
// verdict and its evidence, the score is computed from the verdicts, and the items stay in the result.

/** A judge that answers the prompts it is given from a list, and remembers them. */
function fakeJudge(...answers: unknown[]) {
  const prompts: string[] = [];
  const provider = {
    config: { name: 'Fake judge' },
    chat: async (req: { messages: Array<{ content: string }> }) => {
      prompts.push(req.messages[0]!.content);
      return { text: JSON.stringify(answers.shift()) };
    },
  };
  const providers = { resolveModel: () => ({ provider, model: 'judge-1' }) } as unknown as NonNullable<CheckContext['services']>['providers'];
  return { prompts, services: { providers } };
}

const rag = (services?: CheckContext['services']): CheckContext => ({
  testType: 'rag',
  body: '',
  question: 'When is the clinic open?',
  text: 'The clinic is open 8am to 6pm on weekdays. It offers free lunch.',
  expected: 'Paws Clinic is open 8am to 6pm, Monday to Friday.',
  contexts: [
    { id: 'hours', text: 'Paws Clinic opening hours: 8am to 6pm, Monday to Friday.' },
    { id: 'parking', text: 'Parking is behind the building.' },
  ],
  services,
});

const judge = { provider: 'fake', name: 'judge-1' };

describe('groundedness (faithfulness) with a judge', () => {
  it('is the share of supported claims, and lists what is still to verify', async () => {
    const j = fakeJudge({
      items: [
        { text: 'The clinic is open 8am to 6pm on weekdays.', ok: true, evidence: '[hours]' },
        { text: 'It offers free lunch.', ok: false, evidence: 'no document mentions lunch' },
      ],
    });
    const [r] = await runChecks([{ type: 'faithfulness', judge, threshold: 0.9 }], rag(j.services));
    expect(r!.score).toBe(0.5);
    expect(r!.passed).toBe(false);
    expect(r!.source).toBe('ai-judge');
    expect(r!.message).toMatch(/1 of 2 claims supported by the context; still to verify: "It offers free lunch\."/);
    expect((r!.metadata!.items as unknown[]).length).toBe(2);
    expect(j.prompts[0]).toMatch(/RETRIEVED CONTEXT:\n\[hours\] Paws Clinic/);
  });

  it('an answer with no claims makes nothing up', async () => {
    const [r] = await runChecks([{ type: 'groundedness', judge }], rag(fakeJudge({ items: [] }).services));
    expect(r!.score).toBe(1);
  });

  it('a judge that does not answer with items fails the check, saying so', async () => {
    const [r] = await runChecks([{ type: 'groundedness', judge }], rag(fakeJudge({ score: 1 }).services));
    expect(r!.passed).toBe(false);
    expect(r!.message).toMatch(/judge failed: judge returned no items/);
  });
});

describe('context precision with a judge', () => {
  it('is rank-aware: the useful document first scores higher than last', async () => {
    const first = await runChecks(
      [{ type: 'context-precision', judge }],
      rag(
        fakeJudge({
          items: [
            { text: 'hours', ok: true },
            { text: 'parking', ok: false },
          ],
        }).services,
      ),
    );
    const ctx = rag(
      fakeJudge({
        items: [
          { text: 'parking', ok: false },
          { text: 'hours', ok: true },
        ],
      }).services,
    );
    ctx.contexts = [...ctx.contexts!].reverse();
    const last = await runChecks([{ type: 'context-precision', judge }], ctx);
    expect(first[0]!.score).toBe(1);
    expect(last[0]!.score).toBe(0.5);
  });
});

describe('context recall with a judge', () => {
  it("is the share of the reference's statements found in the context", async () => {
    const j = fakeJudge({
      items: [
        { text: 'open 8am to 6pm', ok: true },
        { text: 'Monday to Friday', ok: true },
        { text: 'closed on holidays', ok: false },
      ],
    });
    const [r] = await runChecks([{ type: 'context-recall', judge }], rag(j.services));
    expect(r!.score).toBe(0.667);
    expect(r!.passed).toBe(true);
  });
});

describe('context entity recall', () => {
  it("finds the reference's names and numbers in the context, with no model", async () => {
    const [r] = await runChecks([{ type: 'context-entity-recall' }], rag());
    expect(r!.passed).toBe(true);
    const items = r!.metadata!.items as Array<{ text: string; ok: boolean }>;
    expect(items.map((i) => i.text)).toEqual(expect.arrayContaining(['Paws Clinic', 'Monday', 'Friday', '8am', '6pm']));
    // a context without the clinic's name loses it
    const [lost] = await runChecks([{ type: 'context-entity-recall', threshold: 1 }], { ...rag(), contexts: [{ id: 'x', text: 'Open 8am to 6pm, Monday to Friday.' }] });
    expect(lost!.passed).toBe(false);
    expect(lost!.message).toMatch(/still to verify: "Paws Clinic"/);
  });

  it('takes the entities to look for', async () => {
    const [r] = await runChecks([{ type: 'context-entity-recall', entities: ['Paws Clinic', 'Sunday'], threshold: 1 }], rag());
    expect(r!.score).toBe(0.5);
  });
});

describe('answer correctness', () => {
  it("with a judge: F1 of the answer's claims and the reference's", async () => {
    const j = fakeJudge(
      {
        items: [
          { text: 'open 8am to 6pm on weekdays', ok: true },
          { text: 'free lunch', ok: false },
        ],
      },
      {
        items: [
          { text: 'Paws Clinic is open 8am to 6pm', ok: true },
          { text: 'Monday to Friday', ok: true },
        ],
      },
    );
    const [r] = await runChecks([{ type: 'answer-correctness', judge }], rag(j.services));
    expect(r!.metadata).toMatchObject({ precision: 0.5, recall: 1 });
    expect(r!.score).toBe(0.667);
    expect(r!.message).toMatch(/1 claim\(s\) not in the reference/);
    expect(j.prompts).toHaveLength(2);
  });

  it('precision alone asks the judge once', async () => {
    const j = fakeJudge({ items: [{ text: 'a', ok: true }] });
    const [r] = await runChecks([{ type: 'answer-correctness', judge, mode: 'precision' }], rag(j.services));
    expect(r!.score).toBe(1);
    expect(j.prompts).toHaveLength(1);
  });

  it('without a judge, compares sentences; without a reference it says what is missing', async () => {
    const [r] = await runChecks([{ type: 'answer-correctness', expected: 'The clinic is open 8am to 6pm on weekdays.', threshold: 0.5 }], rag());
    expect(r!.source).toBe('heuristic');
    expect(r!.passed).toBe(true);
    const [none] = await runChecks([{ type: 'answer-correctness' }], { ...rag(), expected: undefined });
    expect(none!.message).toMatch(/needs a reference answer/);
  });
});
