/**
 * The AI task `rag-draft-references` with the offline mock provider: reference answers for the records of a captured dataset
 * that have none, written from the passages each record retrieved (never from the system's own answer), checked against
 * them, reviewed as a proposal and written into the dataset in place of the record of the same id. No real model.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyProposal, createRagJudgeHost, getProposal, listAiTasks, runAiTask, undoProposal, type AiRunDeps, type AppSettings, type ExecServices, type MockRule } from '../../packages/core/src/index.js';
import { harness } from './harness.js';

const REC = (id: string, question: string, answer: string, passages: Array<[string, string]>, extra: Record<string, unknown> = {}) => ({
  id,
  question,
  answer,
  contexts: passages.map(([pid, text]) => ({ id: pid, text })),
  tags: ['captured', 'har'],
  metadata: { capturedFrom: { kind: 'har', id } },
  ...extra,
});
const ROWS = [
  REC('cap-1', 'When does the clinic open on weekdays?', 'ZZZ-WRONG-ANSWER it opens at noon', [['doc-1', 'The clinic opens at 8am on weekdays and closes at 6pm.'], ['doc-2', 'Parking is free for patients.']]),
  REC('cap-2', 'Who is the owner of the clinic?', 'Dr. Smith.', [['doc-3', 'We treat dogs and cats and offer vaccines for puppies.']]),
  REC('cap-3', 'Is parking free?', 'Yes.', [['doc-2', 'Parking is free for patients.']], { reference: 'Yes, for patients.' }),
  { id: 'cap-4', question: 'A question with no retrieved passages', tags: ['captured'] },
];
const VERDICT = JSON.stringify({ reasoning: 'checked', items: [{ text: 'claim', verdict: true, reason: '[doc-1] "opens at 8am"' }] });
const drafts = (d: Array<Record<string, unknown>>) => JSON.stringify({ drafts: d });

function setup(rules: MockRule[]) {
  const h = harness({ rules });
  mkdirSync(join(h.store.root, 'datasets'), { recursive: true });
  const file = join(h.store.root, 'datasets', 'captured.jsonl');
  writeFileSync(file, `${ROWS.map((r) => JSON.stringify(r)).join('\n')}\n`);
  const host = createRagJudgeHost({ store: h.store, providers: h.deps.providers, redactor: h.redactor, settings: h.deps.settings as AppSettings, surface: 'cli' });
  const deps: AiRunDeps = { ...h.deps, services: { providers: h.deps.providers, ragJudge: host } as ExecServices };
  return { h, deps, file };
}

const GOOD = drafts([
  { id: 'cap-1', reference: 'The clinic opens at 8am on weekdays.', chunks: ['doc-1'], answerable: true },
  { id: 'cap-2', reference: '', chunks: [], answerable: false },
]);

describe('rag-draft-references', () => {
  it('is registered as a large task with the support verifier', () => {
    expect(listAiTasks().find((t) => t.id === 'rag-draft-references')).toMatchObject({ tier: 'large', proposes: true, verifiers: ['testset-support'] });
  });

  it('drafts from the passages only (the system’s answer is not sent), checks each draft, and accepting replaces the record in place; undo restores the file', async () => {
    const { h, deps, file } = setup([
      { match: 'REFERENCE SUPPORT', response: VERDICT },
      { match: 'without', response: GOOD },
    ]);
    try {
      const before = readFileSync(file, 'utf8');
      const r = await runAiTask(deps, { task: 'rag-draft-references', context: { dataset: 'captured.jsonl' } });
      const sent = h.rec.sent();
      expect(sent).toContain('The clinic opens at 8am');
      expect(sent).not.toContain('ZZZ-WRONG-ANSWER');
      // only the two records without a reference and with passages are asked about
      expect(sent).not.toContain('Is parking free');
      expect(sent).not.toContain('no retrieved passages');
      const p = getProposal(h.store, r.proposal!.id);
      expect(p.items).toHaveLength(2);
      const [a, b] = p.items;
      expect(a!.verification.map((x) => [x.verifier, x.status])).toEqual([['testset-support', 'pass']]);
      expect(a!.verification[0]!.label).toMatch(/judge finds all 1 claims/);
      expect(b!.verification[0]).toMatchObject({ verifier: 'testset-support', status: 'pass', label: expect.stringMatching(/unanswerable/) });
      expect(p.notes?.join(' ')).toMatch(/cap-4: no retrieved passages/);
      expect(p.summary).toMatch(/2 drafted reference answers/);

      applyProposal(h.store, r.proposal!.id);
      const rows = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(rows).toHaveLength(4);
      // the record keeps its answer, contexts and tags; it gains the reference, its sources and where it came from
      expect(rows[0]).toMatchObject({ id: 'cap-1', answer: expect.stringContaining('ZZZ-WRONG-ANSWER'), reference: 'The clinic opens at 8am on weekdays.', reference_ids: ['doc-1'], answerable: true });
      expect(rows[0].reference_contexts).toEqual(['The clinic opens at 8am on weekdays and closes at 6pm.']);
      expect(rows[0].tags).toEqual(expect.arrayContaining(['captured', 'har', 'ai-reference']));
      expect(rows[0].metadata).toMatchObject({ capturedFrom: { kind: 'har' }, reference: { source: 'ai-draft', task: 'rag-draft-references' } });
      expect(rows[1]).toMatchObject({ id: 'cap-2', answerable: false, reference_ids: [] });
      expect(rows[2].reference).toBe('Yes, for patients.');
      undoProposal(h.store, r.proposal!.id);
      expect(readFileSync(file, 'utf8')).toBe(before);
    } finally {
      h.cleanup();
    }
  });

  it('a draft whose words are not in its passages is unticked with the reason, and applying writes nothing for it', async () => {
    const bad = drafts([{ id: 'cap-1', reference: 'The clinic offers free grooming every Tuesday afternoon for senior animals.', chunks: ['doc-1'], answerable: true }]);
    const { h, deps } = setup([{ match: 'without', response: bad }]);
    try {
      const r = await runAiTask(deps, { task: 'rag-draft-references', context: { dataset: 'captured.jsonl', ids: ['cap-1'] } });
      const item = r.proposal!.items[0]!;
      expect(item.verification[0]).toMatchObject({ verifier: 'testset-support', status: 'fail' });
      expect(item.selected).toBe(false);
      applyProposal(h.store, r.proposal!.id);
      const rows = readFileSync(join(h.store.root, 'datasets', 'captured.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(rows[0].reference).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  it('a dataset where every record has a reference, or none can be drafted, says so before anything is sent', async () => {
    const { h, deps, file } = setup([{ match: 'without', response: GOOD }]);
    try {
      writeFileSync(file, `${JSON.stringify(ROWS[2])}\n`);
      await expect(runAiTask(deps, { task: 'rag-draft-references', context: { dataset: 'captured.jsonl' } })).rejects.toThrow(/has a reference answer already/);
      writeFileSync(file, `${JSON.stringify(ROWS[3])}\n`);
      await expect(runAiTask(deps, { task: 'rag-draft-references', context: { dataset: 'captured.jsonl' } })).rejects.toThrow(/no retrieved passages/);
      await expect(runAiTask(deps, { task: 'rag-draft-references', context: { dataset: '../escape.jsonl' } })).rejects.toThrow(/not a dataset/);
      await expect(runAiTask(deps, { task: 'rag-draft-references', context: { dataset: 'missing.jsonl' } })).rejects.toThrow(/not in the workspace/);
      expect(h.rec.requests).toHaveLength(0);
      expect(existsSync(file)).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it('the privacy level must be Full: the questions and passages are the context', async () => {
    const { h, deps } = setup([{ match: 'without', response: GOOD }]);
    try {
      await expect(runAiTask(deps, { task: 'rag-draft-references', context: { dataset: 'captured.jsonl' }, privacy: 'names' })).rejects.toThrow(/privacy level/);
      expect(h.rec.requests).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });
});
