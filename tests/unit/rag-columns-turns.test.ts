import { describe, expect, it } from 'vitest';
import { RAG_FIELDS, mapColumns, missingDatasetInputs, pickRecord, suggestColumnMapping, turnsOf } from '../../packages/core/src/index.js';

// `turns` is a field of the column mapper: a column holding a conversation is read as the turns of the record.
describe('the conversation column of the mapper', () => {
  it('is a field of the mapper, guessed from the names tools use', () => {
    expect(RAG_FIELDS.find((f) => f.field === 'turns')).toMatchObject({ label: expect.stringMatching(/Conversation/) });
    expect(suggestColumnMapping(['id', 'dialogue', 'gold_answer'])).toMatchObject({ turns: 'dialogue', id: 'id', reference: 'gold_answer' });
    expect(suggestColumnMapping(['conversation'])).toEqual({ turns: 'conversation' });
  });

  it('keeps a list of messages or a transcript as it is, and the question of the record is the last user message', () => {
    const list = [
      { role: 'user', content: 'Hi, I am Ann.' },
      { role: 'assistant', content: 'Hello Ann.' },
      { role: 'user', content: 'What was my name?' },
    ];
    const { records, notes } = mapColumns(
      [
        { chat: list, gold: 'Ann' },
        { chat: 'User: When do you open?\nAssistant: At 8am.\nUser: And on Saturdays?', gold: '9am' },
        { chat: JSON.stringify(['First question', 'Second question']), gold: 'x' },
        { chat: '', gold: 'no conversation' },
      ],
      { turns: 'chat', reference: 'gold' },
    );
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({ question: 'What was my name?', reference: 'Ann' });
    expect(Array.isArray(records[0]!.turns)).toBe(true);
    expect(records[1]).toMatchObject({ question: 'And on Saturdays?', turns: expect.stringContaining('User: When do you open?') });
    expect(records[2]!.question).toBe('Second question');
    expect(notes.join(' ')).toMatch(/1 record\(s\) have no question/);
    // the record reader reads the same turns the mapper kept
    expect(turnsOf(records[0]!.turns)!.map((t) => t.role)).toEqual(['user', 'assistant', 'user']);
    expect(pickRecord(records[1]!)!.turns!.map((t) => t.content)).toEqual(['When do you open?', 'At 8am.', 'And on Saturdays?']);
  });

  it('an explicit question column wins over the one taken from the turns', () => {
    const { records } = mapColumns([{ q: 'Summarise the call', chat: ['Hello', 'Bye'] }], { question: 'q', turns: 'chat' });
    expect(records[0]!.question).toBe('Summarise the call');
  });

  it('the conversation metrics count a mapped column as the dataset’s turns', () => {
    expect(missingDatasetInputs(['turns'], ['id', 'dialogue'], true)).toEqual([]);
    expect(missingDatasetInputs(['turns'], ['id', 'question'], true)).toEqual(['turns']);
  });
});
