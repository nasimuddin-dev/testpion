import { describe, expect, it } from 'vitest';
import { caseColumns, casesToJsonl, cellText, cellValue, datasetRecords, guessCaseColumns, mapCaseColumns, parsePastedCases } from '../../packages/shared/src/index.js';

describe('test cases as a table (AU-10)', () => {
  it('reads every format and writes JSONL back without losing a case', () => {
    const jsonl = '{"input":"a","expected":"x"}\n{"input":"b","expected":"y","tags":["t"]}';
    const rows = datasetRecords(jsonl, 'jsonl');
    expect(rows).toHaveLength(2);
    expect(caseColumns(rows)).toEqual(['input', 'expected', 'tags']);
    expect(datasetRecords(casesToJsonl(rows), 'jsonl')).toEqual(rows);
    expect(datasetRecords('input,expected\n"hi, there",x\nb,y', 'csv')).toEqual([
      { input: 'hi, there', expected: 'x' },
      { input: 'b', expected: 'y' },
    ]);
    expect(datasetRecords('[{"input":"a"},{"input":"b"}]', 'json')).toHaveLength(2);
    expect(datasetRecords('| input | expected |\n|---|---|\n| a | x |', 'md')).toEqual([{ input: 'a', expected: 'x' }]);
    expect(datasetRecords('not json', 'jsonl')).toEqual([]);
  });

  it('round trips a text edit: a cell keeps its kind, an empty cell leaves the key out', () => {
    expect(cellText({ a: 1 })).toBe('{"a":1}');
    expect(cellText(undefined)).toBe('');
    expect(cellValue('42', 7)).toBe(42);
    expect(cellValue('oops', 7)).toBe('oops');
    expect(cellValue('["a"]', ['x'])).toEqual(['a']);
    expect(cellValue('hello', undefined)).toBe('hello');
    expect(casesToJsonl([{ input: 'a', expected: '' }, { input: '', expected: '' }, { input: 'b', expected: 'y' }])).toBe('{"input":"a"}\n{"input":"b","expected":"y"}');
  });

  it('reads spreadsheet cells (tab separated), CSV with a header, JSONL and JSON lists pasted anywhere', () => {
    const sheet = parsePastedCases('message\tanswer\nCancel it\tcancellation\nI need a refill\trefill')!;
    expect(sheet.format).toBe('csv');
    expect(sheet.columns).toEqual(['message', 'answer']);
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.headerless).toBe(false);
    const bare = parsePastedCases('Cancel it\tcancellation\nI need a refill\trefill')!;
    expect(bare.headerless).toBe(true);
    expect(bare.columns).toEqual(['input', 'expected']);
    expect(bare.rows[1]).toEqual({ input: 'I need a refill', expected: 'refill' });
    expect(parsePastedCases('one question\nanother question')!.columns).toEqual(['input']);
    expect(parsePastedCases('{"input":"a"}\n{"input":"b"}')!.format).toBe('jsonl');
    expect(parsePastedCases('[{"input":"a"}]')!.format).toBe('json');
    expect(parsePastedCases('   ')).toBeUndefined();
  });

  it('maps columns to the names the evaluation reads and guesses them', () => {
    const rows = [{ prompt: 'a', label: 'x', note: 'n' }];
    expect(mapCaseColumns(rows, { prompt: 'input', label: 'expected' })).toEqual([{ input: 'a', expected: 'x', note: 'n' }]);
    expect(guessCaseColumns(['Question', 'Answer'])).toEqual({ input: 'Question', expected: 'Answer' });
    expect(guessCaseColumns(['prompt', 'label'])).toEqual({ input: 'prompt', expected: 'label' });
    expect(guessCaseColumns(['foo'], 'foo')).toEqual({ input: undefined, expected: 'foo' });
  });

  it('holds thousands of rows quickly', () => {
    const text = Array.from({ length: 5000 }, (_, i) => JSON.stringify({ input: `case ${i}`, expected: String(i) })).join('\n');
    const t = performance.now();
    const rows = datasetRecords(text, 'jsonl');
    const back = casesToJsonl(rows);
    expect(rows).toHaveLength(5000);
    expect(back).toBe(text);
    expect(performance.now() - t).toBeLessThan(500);
  });
});
