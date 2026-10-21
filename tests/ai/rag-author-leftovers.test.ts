/**
 * Evaluation authoring follow-ups with the offline mock model: the gates are a field of the saved evaluation the proposal
 * saves, and the slice of the dataset the evaluation runs can also be written as a dataset file (a second item, undone with
 * the proposal). No real model, no key.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyProposal, runAiTask, saveRagTarget, undoProposal, type MockRule, type SavedEvaluation, type WorkspaceStore } from '../../packages/core/src/index.js';
import { harness } from './harness.js';

const TARGET = {
  protocol: 'http' as const,
  step: { type: 'http', method: 'POST', url: 'https://rag.example.test/query', json: { question: '{{question}}' } },
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
    dataset: { slice: { limit: 2 } },
    metrics: [{ id: 'recall@k', threshold: 0.8, options: { k: 3 } }, { id: 'token-f1', threshold: 0.6 }],
    gates: { 'recall@k': 0.7, 'token-f1': 0.5 },
    ...over,
  });

function setup() {
  const h = harness({ rules: [{ match: '.', response: plan() } as MockRule] });
  saveRagTarget(h.store, { name: 'Clinic RAG', target: TARGET });
  mkdirSync(join(h.store.root, 'datasets'), { recursive: true });
  writeFileSync(join(h.store.root, 'datasets', 'clinic.jsonl'), `${ROWS.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return h;
}
const savedEvaluations = (s: WorkspaceStore) => s.getLibrary<SavedEvaluation>('evaluations').items;
const ask = (h: ReturnType<typeof setup>, extra: Record<string, unknown> = {}) => runAiTask(h.deps, { task: 'rag-author-evaluation', context: { target: 'Clinic RAG', dataset: 'clinic.jsonl', ...extra } });

describe('gates in the saved evaluation', () => {
  it('the proposal saves them as the evaluation’s own gates field (and shows them), not as flags to remember', async () => {
    const h = setup();
    try {
      const r = await ask(h);
      const item = r.proposal!.items[0]!;
      expect(item.after).toContain('gates:\n  recall@k: 0.7\n  token-f1: 0.5');
      expect(item.after).toContain('Gates are saved in the evaluation');
      expect(r.proposal!.summary).toMatch(/saved in the evaluation/);
      applyProposal(h.store, r.proposal!.id);
      expect(savedEvaluations(h.store)[0]!.data.gates).toEqual({ 'recall@k': 0.7, 'token-f1': 0.5 });
      undoProposal(h.store, r.proposal!.id);
      expect(savedEvaluations(h.store)).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  it('a plan without gates saves none', async () => {
    const h = harness({ rules: [{ match: '.', response: plan({ gates: {} }) } as MockRule] });
    try {
      saveRagTarget(h.store, { name: 'Clinic RAG', target: TARGET });
      mkdirSync(join(h.store.root, 'datasets'), { recursive: true });
      writeFileSync(join(h.store.root, 'datasets', 'clinic.jsonl'), `${ROWS.map((r) => JSON.stringify(r)).join('\n')}\n`);
      const r = await ask(h);
      applyProposal(h.store, r.proposal!.id);
      expect(savedEvaluations(h.store)[0]!.data).not.toHaveProperty('gates');
    } finally {
      h.cleanup();
    }
  });
});

describe('the slice file', () => {
  it('is a second item with the same records the evaluation runs; applying writes datasets/<name>.jsonl, undo removes it', async () => {
    const h = setup();
    try {
      const r = await ask(h, { sliceFile: 'clinic-first-two' });
      expect(r.proposal!.items.map((i) => i.kind)).toEqual(['evaluation', 'dataset-row']);
      const slice = r.proposal!.items[1]!;
      expect(slice.title).toBe('Dataset slice: 2 records to datasets/clinic-first-two.jsonl');
      expect(r.proposal!.summary).toMatch(/also written to datasets\/clinic-first-two\.jsonl/);
      applyProposal(h.store, r.proposal!.id);
      const file = join(h.store.root, 'datasets', 'clinic-first-two.jsonl');
      const rows = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(rows.map((x) => x.id)).toEqual(['q1', 'q2']);
      // the evaluation holds the same two records
      expect(savedEvaluations(h.store)[0]!.data.dataset.trim().split('\n')).toHaveLength(2);
      undoProposal(h.store, r.proposal!.id);
      expect(existsSync(file)).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it('applying twice adds nothing twice, and an existing file keeps its other records', async () => {
    const h = setup();
    try {
      const file = join(h.store.root, 'datasets', 'slice.jsonl');
      writeFileSync(file, `${JSON.stringify({ id: 'old', question: 'An old question' })}\n${JSON.stringify(ROWS[0])}\n`);
      const r = await ask(h, { sliceFile: 'slice' });
      applyProposal(h.store, r.proposal!.id);
      const ids = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l).id);
      expect(ids).toEqual(['old', 'q1', 'q2']);
      undoProposal(h.store, r.proposal!.id);
      expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2);
    } finally {
      h.cleanup();
    }
  });

  it('refuses a slice file that would replace the dataset it is cut from, before anything is sent', async () => {
    const h = setup();
    try {
      await expect(ask(h, { sliceFile: 'clinic' })).rejects.toThrow(/would replace the dataset it is cut from/);
      expect(h.rec.requests).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  it('no slice file is offered without a slice file name', async () => {
    const h = setup();
    try {
      expect((await ask(h)).proposal!.items).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });
});
