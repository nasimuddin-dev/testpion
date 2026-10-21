/**
 * Evaluation authoring (AI-11): the task `rag-author-evaluation` with the offline mock model. The plan the model answers
 * with becomes a saved evaluation that TestPion builds itself (what cannot run is dropped with a note), it is dry-run on a
 * few samples by the verifier `rag-eval-dry-run` without sending anything to a judge, and applying it saves it, undo takes it
 * away. The target's credentials and the dataset's secrets never reach the model.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyProposal, listAiTasks, runAiTask, saveRagTarget, undoProposal, type MockRule, type SavedEvaluation } from '../../packages/core/src/index.js';
import { harness } from './harness.js';

const TARGET = {
  protocol: 'http' as const,
  step: { type: 'http', method: 'POST', url: 'https://rag.example.test/query', headers: { Authorization: 'Bearer sk-secret-author-token-1234567890' }, json: { question: '{{question}}' } },
  mapping: { answer: '$.answer', contexts: '$.sources', context: { text: '$.text', id: '$.id' } },
};

const ROWS = [
  { id: 'q1', question: 'When does the clinic open?', reference: 'The clinic opens at 8am.', reference_ids: ['hours-1'], answer: 'It opens at 8am.', contexts: [{ id: 'hours-1', text: 'The clinic opens at 8am on weekdays.' }], tags: ['hours'] },
  { id: 'q2', question: 'Where is it?', reference: 'On Main Street.', reference_ids: ['loc-1'], answer: 'On Main Street.', contexts: [{ id: 'loc-1', text: 'We are at 5 Main Street.' }], tags: ['place'] },
  { id: 'q3', question: 'Do you treat birds?', reference: 'Yes, small birds.', reference_ids: ['birds-1'], answer: 'No idea.', contexts: [{ id: 'x', text: 'Unrelated text.' }] },
];

const plan = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: 'Clinic RAG check',
    summary: 'Retrieval by gold ids, the answer against the reference, and groundedness.',
    assumptions: ['The handbook is the only source'],
    dataset: { slice: { limit: 2, reason: 'a quick first look' } },
    metrics: [
      { id: 'recall@k', threshold: 0.8, options: { k: 3 }, why: 'did the gold chunk come back' },
      { id: 'token-f1', threshold: 0.6, why: 'the answer matches the reference' },
      { id: 'faithfulness', threshold: 0.8, why: 'no invented claims' },
    ],
    judge: { shortCircuit: true, maxCostUsd: 0.5, why: 'cap the spend' },
    gates: { 'recall@k': 0.7, faithfulness: 0.75 },
    baseline: 'previous',
    risks: ['only 3 questions'],
    ...over,
  });

function setup(rules: MockRule[], dataset = true) {
  const h = harness({ rules });
  saveRagTarget(h.store, { name: 'Clinic RAG', target: TARGET });
  if (dataset) {
    mkdirSync(join(h.store.root, 'datasets'), { recursive: true });
    writeFileSync(join(h.store.root, 'datasets', 'clinic.jsonl'), `${ROWS.map((r) => JSON.stringify(r)).join('\n')}\n`);
  }
  return h;
}

const ask = (h: ReturnType<typeof setup>, context: Record<string, unknown> = { target: 'Clinic RAG', dataset: 'clinic.jsonl', goal: 'answers come from the handbook' }) => runAiTask(h.deps, { task: 'rag-author-evaluation', question: 'answers come from the handbook', context });

describe('the task', () => {
  it('is registered: a large task whose verifier is the dry run', () => {
    expect(listAiTasks().find((t) => t.id === 'rag-author-evaluation')).toMatchObject({ tier: 'large', proposes: true, verifiers: ['rag-eval-dry-run'] });
  });
});

describe('the proposal', () => {
  it('builds the evaluation from the plan: gold-id retrieval, reference match and groundedness, the slice, the judge options and the gates', async () => {
    const h = setup([{ match: '.', response: plan() }]);
    try {
      const r = await ask(h);
      expect(r.problems).toEqual([]);
      const item = r.proposal!.items[0]!;
      expect(item).toMatchObject({ kind: 'evaluation', title: 'Evaluation: Clinic RAG check', language: 'yaml' });
      const ev = (item.data as { evaluation: SavedEvaluation; gates: Record<string, number>; gateFlags: string[]; records: { used: number; total: number } }).evaluation;
      expect(ev).toMatchObject({ type: 'rag', target: 'Clinic RAG', maxJudgeCostUsd: 0.5, judge: { shortCircuit: true } });
      expect(ev.evaluators.map((e) => e.type)).toEqual(['recall@k', 'token-f1', 'faithfulness']);
      expect(ev.evaluators[0]).toMatchObject({ k: 3, threshold: 0.8 });
      // the slice: two of the three records, stored inside the evaluation
      expect(ev.dataset.trim().split('\n')).toHaveLength(2);
      const data = item.data as { gates: Record<string, number>; gateFlags: string[]; records: { used: number; total: number } };
      expect(data.gates).toEqual({ 'recall@k': 0.7, faithfulness: 0.75 });
      expect(data.records).toEqual({ used: 2, total: 3 });
      expect(r.proposal!.summary).toMatch(/--min recall@k=0.7 --min faithfulness=0.75/);
      expect(r.proposal!.assumptions).toContain('Cannot tell: only 3 questions');
      // the review text names the dataset, it does not repeat it
      expect(item.after).toContain('<2 records of clinic.jsonl');
    } finally {
      h.cleanup();
    }
  });

  it('the dry run: free metrics are computed on real samples, the judged one is counted and nothing is sent to a judge', async () => {
    const h = setup([{ match: '.', response: plan() }]);
    try {
      const r = await ask(h);
      const badge = r.proposal!.items[0]!.verification.find((b) => b.verifier === 'rag-eval-dry-run')!;
      expect(badge.status).not.toBe('fail');
      expect(badge.label).toMatch(/^3 of 3 metrics can run on 5? ?\d? ?sample/);
      expect(badge.detail).toMatch(/free metric/);
      expect(badge.detail).toMatch(/judged metric would make \d+ model calls/);
      // one request in all: the draft itself. The judged part was never asked.
      expect(h.rec.requests).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it('what the model is sent: the target by what it reads and the columns, never the request or its credentials', async () => {
    const h = setup([{ match: '.', response: plan() }]);
    try {
      await ask(h);
      const sent = h.rec.sent();
      expect(sent).not.toContain('sk-secret-author-token');
      expect(sent).not.toContain('rag.example.test');
      expect(sent).not.toContain('Authorization');
      expect(sent).toContain('"contexts": true');
      expect(sent).toContain('When does the clinic open?');
      expect(sent).toContain('recall@k');
    } finally {
      h.cleanup();
    }
  });

  it('drops what cannot run, fixes what is out of range, and says so (never silently)', async () => {
    const h = setup(
      [
        {
          match: '.',
          response: plan({
            metrics: [
              { id: 'recall@k', threshold: 1.7, options: { k: 3, bogus: 1 } },
              { id: 'not-a-metric', threshold: 0.5 },
              { id: 'tool-call-accuracy' },
              { id: 'token-f1' },
              { id: 'token-f1' },
            ],
            gates: { 'recall@k': 0.7, ghost: 0.5, 'token-f1': 4 },
          }),
        },
      ],
      true,
    );
    try {
      const r = await ask(h);
      const item = r.proposal!.items[0]!;
      const data = item.data as { evaluation: SavedEvaluation; gates: Record<string, number>; notes: string[] };
      expect(data.evaluation.evaluators.map((e) => e.type)).toEqual(['recall@k', 'token-f1']);
      expect(data.evaluation.evaluators[0]!.threshold).not.toBe(1.7);
      expect(data.gates).toEqual({ 'recall@k': 0.7 });
      const notes = data.notes.join('\n');
      expect(notes).toMatch(/not-a-metric.*not a metric of the catalogue/);
      expect(notes).toMatch(/tool-call-accuracy/);
      expect(notes).toMatch(/pass mark of 1.7 is outside 0 to 1/);
      expect(notes).toMatch(/bogus/);
      expect(notes).toMatch(/second token-f1/);
      expect(notes).toMatch(/gate on "ghost"/);
      expect(r.proposal!.notes!.join('\n')).toMatch(/not-a-metric/);
    } finally {
      h.cleanup();
    }
  });

  it('without a dataset a reference metric cannot be offered; the evaluation says it needs a dataset', async () => {
    const h = setup([{ match: '.', response: plan({ metrics: [{ id: 'token-f1' }, { id: 'faithfulness' }], gates: {} }) }], false);
    try {
      const r = await ask(h, { target: 'Clinic RAG', goal: 'x' });
      const item = r.proposal!.items[0]!;
      const ev = (item.data as { evaluation: SavedEvaluation }).evaluation;
      // the target supplies the answer and the contexts; nothing supplies a reference
      expect(ev.evaluators.map((e) => e.type)).toEqual(['faithfulness']);
      expect((item.data as { notes: string[] }).notes.join('\n')).toMatch(/Dropped token-f1.*reference/);
      expect(item.verification.find((b) => b.verifier === 'rag-eval-dry-run')!.status).toBe('warn');
    } finally {
      h.cleanup();
    }
  });

  it('no usable metric is a failing badge: the item is not ticked', async () => {
    const h = setup([{ match: '.', response: plan({ metrics: [{ id: 'nope' }], gates: {} }) }]);
    try {
      const r = await runAiTask(h.deps, { task: 'rag-author-evaluation', context: { target: 'Clinic RAG', dataset: 'clinic.jsonl' }, maxRepairs: 0 } as never);
      const item = r.proposal!.items[0]!;
      expect(item.selected).toBe(false);
      expect(item.verification.find((b) => b.verifier === 'rag-eval-dry-run')).toMatchObject({ status: 'fail', label: 'no metric to run' });
    } finally {
      h.cleanup();
    }
  });

  it('a target that does not exist is refused before anything is sent', async () => {
    const h = setup([{ match: '.', response: plan() }]);
    try {
      await expect(ask(h, { target: 'Nope' })).rejects.toThrow(/No RAG target "Nope"/);
      expect(h.rec.requests).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  it('--judge and --name win over the plan; a taken name gets (2)', async () => {
    const h = setup([{ match: '.', response: plan() }]);
    try {
      h.store.saveLibrary('evaluations', { folders: [], items: [{ id: 'e1', name: 'Mine', data: {} }] });
      const r = await ask(h, { target: 'Clinic RAG', dataset: 'clinic.jsonl', judge: 'mock-ai/mock-model', name: 'Mine' });
      const ev = (r.proposal!.items[0]!.data as { evaluation: SavedEvaluation }).evaluation;
      expect(ev.name).toBe('Mine (2)');
      expect(ev.judge).toMatchObject({ provider: 'mock-ai', model: 'mock-model' });
    } finally {
      h.cleanup();
    }
  });
});

describe('apply and undo', () => {
  it('Accept saves a saved evaluation (with its dataset); undo takes it away and leaves the others', async () => {
    const h = setup([{ match: '.', response: plan() }]);
    try {
      h.store.saveLibrary('evaluations', { folders: [], items: [{ id: 'keep', name: 'Keep me', data: { name: 'Keep me' } }] });
      const r = await ask(h);
      const applied = applyProposal(h.store, r.proposal!.id);
      expect(applied.applied[0]).toMatchObject({ kind: 'evaluation' });
      const items = h.store.getLibrary<SavedEvaluation>('evaluations').items;
      expect(items.map((i) => i.name)).toEqual(['Keep me', 'Clinic RAG check']);
      expect(items[1]!.data).toMatchObject({ type: 'rag', target: 'Clinic RAG' });
      expect(items[1]!.data.dataset.trim().split('\n')).toHaveLength(2);
      expect(undoProposal(h.store, r.proposal!.id).restored).toBe(1);
      expect(h.store.getLibrary('evaluations').items.map((i) => i.name)).toEqual(['Keep me']);
    } finally {
      h.cleanup();
    }
  });

  it('applying twice never overwrites: the second one is named (2)', async () => {
    const h = setup([{ match: '.', response: plan() }]);
    try {
      const a = await ask(h);
      applyProposal(h.store, a.proposal!.id);
      const b = await ask(h);
      applyProposal(h.store, b.proposal!.id);
      expect(h.store.getLibrary('evaluations').items.map((i) => i.name)).toEqual(['Clinic RAG check', 'Clinic RAG check (2)']);
    } finally {
      h.cleanup();
    }
  });
});
