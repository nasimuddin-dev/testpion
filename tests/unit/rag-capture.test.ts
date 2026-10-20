import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Redactor, WorkspaceStore, buildRecords, captureDataset, callsOfHar, matchesTarget, questionLocator, readQuestion, saveRagTarget, type CapturedCall } from '../../packages/core/src/index.js';
import type { RagTarget } from '@testpion/shared';

const target: RagTarget = {
  protocol: 'http',
  step: { type: 'http', method: 'POST', url: '{{ragUrl}}/query', headers: { 'Content-Type': 'application/json' }, json: { input: { q: 'Answer briefly: {{question}}' }, k: 3 } },
  mapping: { answer: '$.answer', contexts: '$.sources[*]', context: { text: '$.text', id: '$.id', score: '$.score' } },
};

const call = (id: string, q: string, answer: string, o: Partial<CapturedCall> = {}): CapturedCall => ({
  source: 'history',
  id,
  at: `2026-10-01T10:00:0${id.length > 1 ? 9 : id}.000Z`,
  method: 'POST',
  url: 'https://rag.example.com/query',
  requestBody: JSON.stringify({ input: { q: `Answer briefly: ${q}` }, k: 3 }),
  status: 200,
  responseText: JSON.stringify({ answer, sources: [{ id: 'd1', text: `About ${q}`, score: 0.9 }] }),
  responseHeaders: [['content-type', 'application/json']],
  ...o,
});

describe('where the question is', () => {
  it('is found from the placeholder of the target’s request, in a nested body, with the text around it', () => {
    const loc = questionLocator(target)!;
    expect(loc).toMatchObject({ where: 'body-json', path: ['input', 'q'], template: 'Answer briefly: {{question}}' });
    expect(readQuestion(loc, call('1', 'When is the clinic open?', 'x'))).toBe('When is the clinic open?');
  });
  it('is found in a query parameter, a text body and with the JSON-escaped form', () => {
    const q = questionLocator({ protocol: 'http', step: { type: 'http', url: '{{u}}/ask', params: { q: '{{question}}' } } })!;
    expect(readQuestion(q, { source: 'har', id: 'a', url: 'https://x.test/ask?q=hello%20there&z=1' })).toBe('hello there');
    const t = questionLocator({ protocol: 'http', step: { type: 'http', url: '{{u}}', body: '{"text": "{{questionEscaped}}"}' } })!;
    expect(t.where).toBe('body-json');
    expect(readQuestion(t, { source: 'har', id: 'b', requestBody: '{"text":"say \\"hi\\""}' })).toBe('say "hi"');
  });
  it('a path the person gives wins', () => {
    const loc = questionLocator(target, '$.input.q')!;
    expect(readQuestion(loc, call('1', 'raw', 'x'))).toBe('Answer briefly: raw');
    expect(questionLocator({ protocol: 'http', step: { type: 'http', url: 'x' } })).toBeUndefined();
  });
  it('matches the target’s URL and method, variables standing for anything', () => {
    expect(matchesTarget(target, call('1', 'q', 'a'))).toBe(true);
    expect(matchesTarget(target, call('1', 'q', 'a', { url: 'https://rag.example.com/other' }))).toBe(false);
    expect(matchesTarget(target, call('1', 'q', 'a', { method: 'GET' }))).toBe(false);
  });
});

describe('building records', () => {
  const opts = { maskPii: true };
  it('reads question, answer and contexts with the target’s mapping, and says what it skipped', () => {
    const calls = [call('1', 'What are the hours?', 'Eight to six.'), call('2', 'x', 'a', { url: 'https://rag.example.com/health' }), call('3', 'y', 'a', { status: 500 }), call('4', 'z', 'a', { responseText: '{"nothing":1}' })];
    const { records, report } = buildRecords({ calls, target, options: opts });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ question: 'What are the hours?', answer: 'Eight to six.', contexts: [{ id: 'd1', text: 'About What are the hours?', score: 0.9 }], tags: ['captured', 'history'] });
    expect(report).toMatchObject({ read: 4, matched: 1, records: 1 });
    expect(report.skipped.map((s) => s.reason)).toEqual(expect.arrayContaining([expect.stringContaining('not a call to the target'), expect.stringContaining('500'), expect.stringContaining('finds no answer')]));
  });
  it('masks secrets always and personal data by default, before anything is kept; the count is reported', () => {
    const redactor = new Redactor();
    redactor.addSecret('hunter2-secret');
    const calls = [call('1', 'My email is jane.doe@example.com, my key hunter2-secret', 'Call 415-555-0134 or write to jane.doe@example.com. Bearer abcdefghijklmnopqrstuvwxyz0123456789')];
    const { records, report } = buildRecords({ calls, target, options: opts, redactor });
    const text = JSON.stringify(records);
    expect(text).not.toContain('jane.doe@example.com');
    expect(text).not.toContain('hunter2-secret');
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(report.masked.strings).toBeGreaterThan(0);
    const keep = buildRecords({ calls, target, options: { maskPii: false }, redactor }).records;
    expect(JSON.stringify(keep)).toContain('jane.doe@example.com');
    expect(JSON.stringify(keep)).not.toContain('hunter2-secret');
  });
  it('keeps the newest of repeated questions (or the first), and counts them', () => {
    const calls = [call('1', 'Same question?', 'old'), call('2', 'same  question', 'new'), call('3', 'Other', 'o')];
    expect(buildRecords({ calls, target, options: { dedupe: true } }).records.map((r) => r.answer)).toEqual(['new', 'o']);
    const first = buildRecords({ calls, target, options: { dedupe: 'first' } });
    expect(first.records.map((r) => r.answer)).toEqual(['old', 'o']);
    expect(first.report.deduped).toBe(1);
  });
  it('a seeded sample is the same every time and a limit keeps the newest', () => {
    const calls = Array.from({ length: 30 }, (_, i) => call(String(i), `question ${i}`, 'a', { at: `2026-10-01T10:00:${String(i).padStart(2, '0')}.000Z` }));
    const a = buildRecords({ calls, target, options: { sample: 5, seed: 'x' } }).records.map((r) => r.question);
    const b = buildRecords({ calls, target, options: { sample: 5, seed: 'x' } }).records.map((r) => r.question);
    const c = buildRecords({ calls, target, options: { sample: 5, seed: 'y' } }).records.map((r) => r.question);
    expect(a).toEqual(b);
    expect(a).toHaveLength(5);
    expect(a).not.toEqual(c);
    expect(buildRecords({ calls, target, options: { limit: 3 } }).records.map((r) => r.question)).toEqual(['question 27', 'question 28', 'question 29']);
  });
  it('--as-questions writes questions only, so the target is called anew', () => {
    const { records } = buildRecords({ calls: [call('1', 'Hours?', 'secret answer')], target, options: { asQuestions: true } });
    expect(records[0]).not.toHaveProperty('answer');
    expect(records[0]).not.toHaveProperty('contexts');
  });
  it('reads a streamed (server-sent events) answer with the same mapping', () => {
    const sse: RagTarget = { ...target, protocol: 'sse', mapping: { answer: '$.events[*].data.delta', contexts: '$.events[0].data.sources[*]', context: { text: '$.text' } } };
    const text = 'data: {"sources":[{"text":"doc"}],"delta":"Hel"}\n\ndata: {"delta":"lo"}\n\n';
    const { records } = buildRecords({ calls: [call('1', 'Hi', '', { responseText: text, responseHeaders: [['Content-Type', 'text/event-stream']] })], target: sse, options: {} });
    expect(records[0]!.answer).toBe('Hello');
    expect(records[0]!.contexts![0]!.text).toBe('doc');
  });
});

describe('a workspace', () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-capture-'));
    const store = WorkspaceStore.create(join(dir, 'ws'), 'W');
    saveRagTarget(store, { name: 'clinic', target });
    return { dir, store };
  };
  it('writes a dataset from History entries, never over a file, with no headers or cookies in it', async () => {
    const { dir, store } = setup();
    try {
      mkdirSync(store.path('payloads'), { recursive: true });
      for (const [i, q] of ['Hours?', 'Phone number?'].entries()) {
        const p = store.path('payloads', `p${i}.bin`);
        writeFileSync(p, JSON.stringify({ answer: `A${i}`, sources: [{ id: 'd', text: 'doc' }] }));
        store.meta.addHistory({
          id: `h${i}`,
          timestamp: `2026-10-01T10:00:0${i}.000Z`,
          kind: 'http',
          name: 'ask',
          method: 'POST',
          url: 'https://rag.example.com/query',
          status: 200,
          durationMs: 10 + i,
          request: { method: 'POST', url: '{{ragUrl}}/query', headers: [{ key: 'Authorization', value: 'Bearer top-secret-token-1234', enabled: true }, { key: 'Cookie', value: 'sid=zzz', enabled: true }], body: { type: 'json', content: JSON.stringify({ input: { q: `Answer briefly: ${q}` } }) } },
          responseMeta: { headers: [['content-type', 'application/json'], ['set-cookie', 'sid=zzz']] },
          payloadPath: p,
        });
      }
      const dry = await captureDataset(store, { target: 'clinic', source: { kind: 'history' }, dryRun: true });
      expect(dry.written).toBeUndefined();
      expect(dry.preview).toHaveLength(2);
      expect(existsSync(store.path('datasets', 'captured.jsonl'))).toBe(false);
      const r = await captureDataset(store, { target: 'clinic', source: { kind: 'history', ids: ['h0', 'h1'] }, name: 'captured' });
      expect(r.written).toEqual({ path: 'datasets/captured.jsonl', rows: 2 });
      const text = readFileSync(store.path('datasets', 'captured.jsonl'), 'utf8');
      expect(text.trim().split('\n')).toHaveLength(2);
      expect(text).not.toMatch(/top-secret|sid=|Authorization|set-cookie/i);
      await expect(captureDataset(store, { target: 'clinic', source: { kind: 'history' }, name: 'captured' })).rejects.toThrow(/exists already/);
      await expect(captureDataset(store, { target: 'clinic', source: { kind: 'history' }, name: 'captured', overwrite: true })).resolves.toBeTruthy();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('reads a saved Debugger session (by name and by its History entry), a HAR file and an evaluation run', async () => {
    const { dir, store } = setup();
    try {
      const har = JSON.stringify({ log: { entries: [{ startedDateTime: '2026-10-01T10:00:00Z', time: 12, request: { method: 'POST', url: 'https://rag.example.com/query', postData: { mimeType: 'application/json', text: JSON.stringify({ input: { q: 'Answer briefly: From the proxy' } }) }, headers: [{ name: 'Authorization', value: 'Bearer abc' }] }, response: { status: 200, headers: [], content: { text: JSON.stringify({ answer: 'ok', sources: [] }) } } }] } });
      mkdirSync(store.path('debugger'), { recursive: true });
      writeFileSync(store.path('debugger', 'monday.har'), har);
      store.meta.addHistory({ id: 'cap-1', timestamp: '2026-10-01T11:00:00.000Z', kind: 'capture', name: 'Session saved', status: 'saved', capture: { result: 'session', ref: { kind: 'capture', name: 'monday.har' }, exchanges: 1, sources: ['proxy'], hosts: [] } });
      const a = await captureDataset(store, { target: 'clinic', source: { kind: 'debugger', session: 'monday' }, dryRun: true });
      const b = await captureDataset(store, { target: 'clinic', source: { kind: 'debugger', session: 'cap-1' }, dryRun: true });
      expect(a.preview[0]).toMatchObject({ question: 'From the proxy', answer: 'ok', metadata: { latencyMs: 12 } });
      expect(b.preview).toHaveLength(1);
      mkdirSync(store.path('imports'), { recursive: true });
      writeFileSync(store.path('imports', 'x.har'), har);
      expect((await captureDataset(store, { target: 'clinic', source: { kind: 'har', file: 'imports/x.har' }, dryRun: true })).report.matched).toBe(1);
      expect(callsOfHar(har, 'har', 'x')[0]!.requestBody).toContain('From the proxy');
      // an evaluation run: its results already are samples, no target needed
      const runDir = store.runDir('run-1');
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'results.jsonl'), JSON.stringify({ id: 'run-1:1', metadata: { rag: { query: 'Q from a run', sample: { answer: 'A', contexts: [{ id: 'c', text: 'T' }] } } } }) + '\n');
      const run = await captureDataset(store, { source: { kind: 'run', run: 'run-1' }, dryRun: true });
      expect(run.preview[0]).toMatchObject({ question: 'Q from a run', answer: 'A', tags: ['captured', 'run'] });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
