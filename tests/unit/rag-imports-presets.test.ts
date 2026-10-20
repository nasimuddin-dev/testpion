/**
 * Datasets from BEIR, NVIDIA and promptfoo (data only), and the one-click target presets: every preset's mapping reads
 * the sample response of its framework's documented shape.
 */
import { describe, expect, it } from 'vitest';
import { RAG_TARGET_PRESETS, findRagTargetPreset } from '@testpion/shared';
import { applyMapping, detectRagFormat, importBeir, importNvidia, importPromptfoo, importRagRecords, mappingProblems, parsePromptfooTests, parseRagImportText, responseOf, targetProblems } from '../../packages/core/src/index.js';

describe('target presets', () => {
  it('every preset is a valid target whose mapping reads its documented sample response', () => {
    expect(RAG_TARGET_PRESETS.map((p) => p.id)).toEqual(['generic-json', 'openai-compatible', 'openai-compatible-stream', 'langserve', 'llamaindex', 'haystack', 'dify', 'flowise']);
    for (const p of RAG_TARGET_PRESETS) {
      expect(mappingProblems(p.mapping), p.id).toEqual([]);
      expect(targetProblems({ protocol: p.protocol, step: p.step, mapping: p.mapping }), p.id).toEqual([]);
      const sample = applyMapping(responseOf({ body: p.sample, text: JSON.stringify(p.sample) }), p.mapping);
      expect(sample.answer, p.id).toBe('The clinic opens at 8am.');
      expect(sample.warnings.filter((w) => !/contexts/.test(w)), p.id).toEqual([]);
      if (p.mapping.contexts) {
        expect(sample.contexts[0]!.text, p.id).toContain('opens at 8am');
        expect(sample.contexts[0]!.id, p.id).toBeTruthy();
      }
    }
  });

  it('the question reaches the request, and a preset that cannot map contexts says so', () => {
    for (const p of RAG_TARGET_PRESETS) expect(JSON.stringify(p.step), p.id).toMatch(/\{\{question\}\}/);
    expect(findRagTargetPreset('OpenAI-compatible')?.id).toBe('openai-compatible');
    expect(findRagTargetPreset('openai-compatible')!.note).toMatch(/No retrieved contexts/);
    expect(findRagTargetPreset('nope')).toBeUndefined();
  });

  it('the streamed preset joins the pieces of the answer', () => {
    const p = findRagTargetPreset('openai-compatible-stream')!;
    expect(applyMapping(responseOf({ body: p.sample, text: '' }), p.mapping).answer).toBe('The clinic opens at 8am.');
  });
});

describe('BEIR', () => {
  const queries = '{"_id":"q1","text":"What time does the clinic open?"}\n{"_id":"q2","text":"Is there parking?"}\n{"_id":"q3","text":"No gold"}';
  const qrels = 'query-id\tcorpus-id\tscore\nq1\td1\t1\nq1\td2\t0\nq2\td3\t2\nq2\td4\t1\n';
  const corpus = '{"_id":"d1","title":"Hours","text":"Opens at 8am."}\n{"_id":"d3","title":"Parking","text":"Behind the building."}\n{"_id":"d4","text":"Free for two hours."}';

  it('a query is a record whose gold ids are the documents with a positive score, best grade first', () => {
    const r = importBeir({ queries, qrels, corpus });
    expect(r.records).toEqual([
      { id: 'q1', question: 'What time does the clinic open?', reference_ids: ['d1'], reference_contexts: ['Hours\nOpens at 8am.'], tags: ['beir'] },
      { id: 'q2', question: 'Is there parking?', reference_ids: ['d3', 'd4'], reference_contexts: ['Parking\nBehind the building.', 'Free for two hours.'], tags: ['beir'] },
    ]);
    expect(r.notes.join('\n')).toMatch(/1 queries have no relevant document/);
    expect(r.notes.join('\n')).toMatch(/Graded relevance/);
  });

  it('without a corpus only the ids are there, and it says so; TREC-style qrels (4 columns) work', () => {
    const r = importBeir({ queries, qrels: 'q1 0 d1 1\nq2 0 d3 1' });
    expect(r.records[0]).not.toHaveProperty('reference_contexts');
    expect(r.notes.join('\n')).toMatch(/No corpus file/);
    expect(r.records.map((x) => x.reference_ids)).toEqual([['d1'], ['d3']]);
  });

  it('--limit', () => {
    expect(importBeir({ queries, qrels, corpus }, { limit: 1 }).records).toHaveLength(1);
  });

  it('the generic importer says BEIR is three files', () => {
    expect(() => importRagRecords([], 'beir')).toThrow(/three files/);
  });
});

describe('NVIDIA retriever data', () => {
  it('positives are the gold chunks (ids when they have them), negatives are kept apart', () => {
    const r = importNvidia([
      { question_id: 'n1', query: 'What time?', pos_doc: [{ id: 'p1', text: 'Opens at 8am.' }], neg_doc: ['Parking is behind.'] },
      { query: 'Cancel?', positive_passages: [{ pid: 'p9', text: 'Up to 24 hours.' }, { pid: 'p10', text: 'Free.' }], answers: ['Yes, 24 hours before.'] },
      { query: 'no positives' },
    ]);
    expect(r.records).toHaveLength(2);
    expect(r.records[0]).toMatchObject({ id: 'n1', question: 'What time?', reference_ids: ['p1'], reference_contexts: ['Opens at 8am.'], negative_contexts: ['Parking is behind.'] });
    expect(r.records[1]).toMatchObject({ reference: 'Yes, 24 hours before.', reference_ids: ['p9', 'p10'] });
    expect(r.notes.join('\n')).toMatch(/Record 3 has no positive document/);
  });

  it('a positive without an id gives gold texts only, with a note; the format is found by its columns', () => {
    const recs = [{ query: 'q', pos_doc: 'plain text' }];
    expect(detectRagFormat(recs)).toBe('nvidia');
    const r = importRagRecords(recs);
    expect(r.from).toBe('nvidia');
    expect(r.records[0]).toMatchObject({ reference_contexts: ['plain text'] });
    expect(r.records[0]).not.toHaveProperty('reference_ids');
    expect(r.notes.join('\n')).toMatch(/gold texts only/);
  });
});

describe('promptfoo', () => {
  const yaml = `
description: clinic
tests:
  - vars:
      query: When does the clinic open?
      context: The clinic opens at 8am.
    assert:
      - type: context-recall
        value: Opens at 8am on weekdays.
      - type: javascript
        value: output.length > 5
    metadata: { category: hours }
  - vars: { question: "Parking?" }
    assert:
      - type: contains
        value: behind
  - vars: { other: 1 }
`;
  it('the question variable, the expected value of a reference assertion and the context variable', () => {
    const r = importPromptfoo(parsePromptfooTests(yaml));
    expect(r.records).toEqual([
      { id: 'promptfoo-1', question: 'When does the clinic open?', reference: 'Opens at 8am on weekdays.', reference_contexts: ['The clinic opens at 8am.'], tags: ['hours'] },
      { id: 'promptfoo-2', question: 'Parking?', reference: 'behind' },
    ]);
    expect(r.notes.join('\n')).toMatch(/Test 3 has no question variable/);
    expect(r.notes.join('\n')).toMatch(/assertions are not imported \(javascript\)/);
  });

  it('a list of tests works, JSON too, and a file without tests says what it needs', () => {
    expect(parsePromptfooTests('[{"vars":{"query":"q"}}]')).toHaveLength(1);
    expect(() => parsePromptfooTests('description: x')).toThrow(/`tests:` list/);
    expect(detectRagFormat(parsePromptfooTests(yaml))).toBe('promptfoo');
  });
});

describe('parseRagImportText', () => {
  it('reads YAML (promptfoo), CSV, TSV, JSON in a wrapper and JSON Lines by the file name', () => {
    expect(parseRagImportText('tests:\n  - vars: {query: q}', 'promptfooconfig.yaml')).toHaveLength(1);
    expect(parseRagImportText('question,reference\nq1,r1\nq2,r2', 'd.csv')).toEqual([{ question: 'q1', reference: 'r1' }, { question: 'q2', reference: 'r2' }]);
    expect(parseRagImportText('query\tpos_doc\nq\tp', 'd.tsv')).toEqual([{ query: 'q', pos_doc: 'p' }]);
    expect(parseRagImportText('{"goldens":[{"input":"q"}]}', 'd.json')).toEqual([{ input: 'q' }]);
    expect(parseRagImportText('{"question":"a"}\n{"question":"b"}', 'd.jsonl')).toHaveLength(2);
  });
});
