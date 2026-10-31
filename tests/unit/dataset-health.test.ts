import { describe, expect, it } from 'vitest';
import { datasetHealth } from '../../packages/shared/src/dataset-health.js';

const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n');
const base = { datasetFormat: 'jsonl' as const, expectedField: 'expected', prompt: 'Classify: {{input}}', evaluators: [{ type: 'contains', expected: '{{expected}}' }] };

describe('datasetHealth', () => {
  it('says there are no cases for an empty dataset', () => {
    expect(datasetHealth({ ...base, dataset: '' })).toMatchObject({ cases: 0, notes: [{ kind: 'empty' }] });
  });

  it('calls a varied, complete dataset healthy', () => {
    const rows = ['cancel', 'refill', 'booking', 'other', 'cancel', 'refill'].map((e, i) => ({ input: `message ${i}`, expected: e }));
    expect(datasetHealth({ ...base, dataset: jsonl(rows) })).toMatchObject({ cases: 6, notes: [], text: '6 cases look healthy.' });
  });

  it('finds a repeated input (ignoring case and spaces), missing expected answers, and a prompt variable some case lacks', () => {
    const h = datasetHealth({
      ...base,
      prompt: 'Reply to {{input}} in {{tone}}',
      dataset: jsonl([
        { input: 'Cancel my visit', expected: 'cancel', tone: 'kind' },
        { input: ' cancel my visit ', expected: 'cancel', tone: 'kind' },
        { input: 'Refill', expected: '', tone: 'kind' },
        { input: 'Book', expected: 'booking' },
      ]),
    });
    expect(h.notes.map((n) => [n.kind, n.cases])).toEqual([
      ['duplicates', [2]],
      ['no-expected', [3]],
      ['missing-column', [4]],
    ]);
    expect(h.notes[1]!.text).toBe('1 case has no "expected", which a check compares the answer with.');
    expect(h.notes[2]!.text).toBe('The prompt uses {{tone}}, and 1 case has no "tone".');
    expect(h.text).toMatch(/^3 things to look at in 4 cases: /);
  });

  it('does not ask for expected answers when no check compares with one', () => {
    const h = datasetHealth({ ...base, evaluators: [{ type: 'json-valid' }], dataset: jsonl([{ input: 'a' }, { input: 'b' }]) });
    expect(h.notes).toEqual([]);
  });

  it('notices when most cases expect the same answer, only with enough cases and more than one answer', () => {
    const skewed = jsonl([...Array.from({ length: 8 }, (_, i) => ({ input: `m${i}`, expected: 'other' })), { input: 'x', expected: 'refill' }, { input: 'y', expected: 'booking' }]);
    expect(datasetHealth({ ...base, dataset: skewed }).notes).toEqual([{ kind: 'skewed', text: '8 of 10 cases expect "other": a model that always says that already passes 80%. Add cases for the other answers.' }]);
    expect(datasetHealth({ ...base, dataset: jsonl([{ input: 'a', expected: 'x' }, { input: 'b', expected: 'x' }]) }).notes).toEqual([]);
    expect(datasetHealth({ ...base, dataset: jsonl(Array.from({ length: 9 }, (_, i) => ({ input: `m${i}`, expected: 'same' }))) }).notes).toEqual([]);
  });

  it('reads the question of a bot with sources as its input, not the id', () => {
    const h = datasetHealth({ dataset: jsonl([{ id: 'a', question: 'What time do you open?' }, { id: 'b', question: 'what time do you open?' }]), datasetFormat: 'jsonl' });
    expect(h.notes).toMatchObject([{ kind: 'duplicates', cases: [2] }]);
  });

  it('notices very long inputs and reads CSV too', () => {
    const long = datasetHealth({ ...base, evaluators: [], dataset: jsonl([{ input: 'x'.repeat(9000) }, { input: 'short' }]) });
    expect(long.notes).toMatchObject([{ kind: 'long', cases: [1] }]);
    const csv = datasetHealth({ ...base, datasetFormat: 'csv', dataset: 'input,expected\nhello,greeting\nhello,greeting\n' });
    expect(csv.notes[0]).toMatchObject({ kind: 'duplicates', cases: [2] });
  });
});
