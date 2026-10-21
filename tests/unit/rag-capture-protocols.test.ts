/**
 * Capture of a RAG dataset from gRPC, MCP and WebSocket calls: History keeps the request of a gRPC or an MCP call (its
 * message, its arguments) but no response, so those datasets hold the questions; a WebSocket call is read from a saved message
 * log (a sent message and the replies after it) with the target's mapping. No network, no model.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceStore, buildRecords, callOfHistory, callsOfMessages, captureDataset, listCaptureSources, matchesTarget, questionLocator, readQuestion, type CapturedCall, type HistoryEntry } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';

const grpcTarget = { protocol: 'grpc' as const, step: { type: 'grpc', target: '{{ragHost}}:50051', method: 'rag.Rag/Ask', message: { question: '{{question}}', topK: 3 } }, mapping: { answer: '$.answer' } };
const mcpTarget = { protocol: 'mcp' as const, step: { type: 'mcp', server: 'rag', tool: 'search', arguments: { query: 'Answer briefly: {{question}}', limit: 5 } }, mapping: { answer: '$.answer' } };
const wsTarget = { protocol: 'websocket' as const, step: { type: 'websocket', url: 'wss://rag.example.com/ws', waitMs: 3000, send: [{ type: 'hello' }, { question: '{{question}}' }] }, mapping: { answer: '$.received[0].answer', context: { text: '$.text', id: '$.id' }, contexts: '$.received[0].sources[*]' } };

const history = (over: Partial<HistoryEntry>): HistoryEntry => ({ id: 'h1', timestamp: '2026-10-20T10:00:00.000Z', kind: 'grpc', name: 'rag.Rag/Ask', status: 'OK', ...over }) as HistoryEntry;

describe('gRPC and MCP calls in History', () => {
  const g = callOfHistory({ path: (...p: string[]) => p.join('/') }, history({ request: { target: 'localhost:50051', method: 'rag.Rag/Ask', message: JSON.stringify({ question: 'When does the clinic open?', topK: 3 }), metadata: [] } }));
  const m = callOfHistory({ path: (...p: string[]) => p.join('/') }, history({ id: 'h2', kind: 'mcp', name: 'rag · search', status: 'ok', request: { serverId: 's1', tool: 'search', args: { query: 'Answer briefly: Is parking free?', limit: 5 } } }));

  it('become calls with the request body, the operation and whether they succeeded', () => {
    expect(g).toMatchObject({ protocol: 'grpc', operation: 'rag.Rag/Ask', url: 'localhost:50051', ok: true });
    expect(JSON.parse(g.requestBody!)).toMatchObject({ question: 'When does the clinic open?' });
    expect(g.responseText).toBeUndefined();
    expect(m).toMatchObject({ protocol: 'mcp', operation: 'search', ok: true });
    expect(callOfHistory({ path: () => '' }, history({ status: 'UNAVAILABLE', request: { target: 'x', method: 'm', message: '{}' } })).ok).toBe(false);
  });

  it('are matched to the target by method (gRPC) or tool (MCP) and the question is read where the target writes it', () => {
    expect(matchesTarget(grpcTarget, g)).toBe(true);
    expect(matchesTarget({ ...grpcTarget, step: { ...grpcTarget.step, method: 'rag.Rag/Other' } }, g)).toBe(false);
    expect(matchesTarget(mcpTarget, m)).toBe(true);
    expect(matchesTarget({ ...mcpTarget, step: { ...mcpTarget.step, tool: 'other' } }, m)).toBe(false);
    expect(readQuestion(questionLocator(grpcTarget)!, g)).toBe('When does the clinic open?');
    // the target writes the question inside a longer text: only the question comes back
    expect(readQuestion(questionLocator(mcpTarget)!, m)).toBe('Is parking free?');
  });

  it('make a dataset of questions, with a note that the answers are not in History; --as-questions is not needed', () => {
    const { records, report } = buildRecords({ calls: [g], target: grpcTarget, options: {} });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ question: 'When does the clinic open?', tags: ['captured', 'history'] });
    expect(records[0]).not.toHaveProperty('answer');
    expect(report.warnings.join(' ')).toMatch(/keeps the request of a gRPC call but not its response/);
    const mcp = buildRecords({ calls: [m], target: mcpTarget, options: {} });
    expect(mcp.records.map((r) => r.question)).toEqual(['Is parking free?']);
  });

  it('a call to another protocol, or one that failed, is left out with the reason', () => {
    const failed = { ...g, id: 'bad', ok: false };
    const { records, report } = buildRecords({ calls: [g, m, failed], target: grpcTarget, options: {} });
    expect(records).toHaveLength(1);
    expect(report.skipped.map((s) => s.reason)).toEqual(expect.arrayContaining(['a mcp call, and the target is grpc', 'the call did not succeed']));
    // a HAR call is HTTP: a gRPC target says so instead of reading it
    const http: CapturedCall = { source: 'har', id: 'x', method: 'POST', url: 'https://x/y', status: 200, requestBody: '{"question":"q"}' };
    expect(buildRecords({ calls: [http], target: grpcTarget, options: {} }).report.skipped[0]!.reason).toBe('a http call, and the target is grpc');
  });
});

describe('a WebSocket message log', () => {
  const log = [
    { time: 1_760_000_000_000, direction: 'system', data: 'connected' },
    { time: 1_760_000_000_100, direction: 'sent', data: '{"type":"hello"}' },
    { time: 1_760_000_000_200, direction: 'sent', data: '{"question":"When does the clinic open?"}' },
    { time: 1_760_000_000_900, direction: 'received', data: '{"answer":"At 8am.","sources":[{"id":"doc-1","text":"The clinic opens at 8am."}]}' },
    { time: 1_760_000_001_000, direction: 'sent', data: '{"question":"Is parking free?"}' },
    { time: 1_760_000_001_500, direction: 'received', data: '{"answer":"Yes.","sources":[]}' },
    { time: 1_760_000_002_000, direction: 'sent', data: '{"question":"No reply to this"}' },
  ]
    .map((m) => JSON.stringify(m))
    .join('\n');

  it('is read as one call per sent message, with the replies that followed it', () => {
    const calls = callsOfMessages(log, 'messages/clinic.jsonl', 'wss://rag.example.com/ws');
    expect(calls).toHaveLength(4);
    expect(calls[1]).toMatchObject({ protocol: 'websocket', ok: true, latencyMs: 700, url: 'wss://rag.example.com/ws' });
    expect(JSON.parse(calls[1]!.responseText!).received[0].answer).toBe('At 8am.');
    expect(calls[3]!.ok).toBe(false);
    expect(() => callsOfMessages('not json', 'x')).toThrow(/not a message log/);
  });

  it('becomes a dataset with the answers and contexts the target’s mapping reads; the hello message and the unanswered one are left out', () => {
    const calls = callsOfMessages(log, 'messages/clinic.jsonl', 'wss://rag.example.com/ws');
    const { records, report } = buildRecords({ calls, target: wsTarget, options: {} });
    expect(records.map((r) => [r.question, r.answer])).toEqual([
      ['When does the clinic open?', 'At 8am.'],
      ['Is parking free?', 'Yes.'],
    ]);
    expect(records[0]!.contexts).toEqual([{ id: 'doc-1', text: 'The clinic opens at 8am.' }]);
    // the hello and the last message got no reply: two calls that did not succeed
    expect(report.skipped).toMatchObject([{ reason: 'the call did not succeed', count: 2 }]);
    expect(report.questionAt).toBe('request body $.question');
  });

  it('a log of another socket is not read for this target', () => {
    const calls = callsOfMessages(log, 'x', 'wss://other.example.com/ws');
    expect(buildRecords({ calls, target: wsTarget, options: {} }).records).toHaveLength(0);
  });
});

describe('through the workspace', () => {
  it('captureDataset reads a saved message log and History entries of gRPC calls; the log is listed as a source', async () => {
    const t = tempDir('tp-capture-proto-');
    const ws = WorkspaceStore.create(join(t.dir, 'ws'), 'capture protocols');
    try {
      ws.saveLibrary('rag-targets', {
        folders: [],
        items: [
          { id: 'ws-rag', name: 'WS RAG', data: wsTarget },
          { id: 'grpc-rag', name: 'gRPC RAG', data: grpcTarget },
        ],
      });
      mkdirSync(join(ws.root, 'messages'), { recursive: true });
      writeFileSync(
        join(ws.root, 'messages', 'chat.jsonl'),
        [
          { time: 1_760_000_000_000, direction: 'sent', data: '{"question":"What time does the clinic open?"}' },
          { time: 1_760_000_000_300, direction: 'received', data: '{"answer":"8am.","sources":[{"id":"d1","text":"Opens at 8am"}]}' },
        ]
          .map((m) => JSON.stringify(m))
          .join('\n'),
      );
      expect(listCaptureSources(ws).messages).toEqual(['messages/chat.jsonl']);
      const r = await captureDataset(ws, { target: 'WS RAG', source: { kind: 'messages', file: 'messages/chat.jsonl', url: 'wss://rag.example.com/ws' }, name: 'ws-made' });
      expect(r.written).toMatchObject({ path: 'datasets/ws-made.jsonl', rows: 1 });
      expect(JSON.parse(readFileSync(join(ws.root, 'datasets', 'ws-made.jsonl'), 'utf8').trim())).toMatchObject({ question: 'What time does the clinic open?', answer: '8am.' });

      ws.meta.addHistory(history({ id: 'hg1', request: { target: 'localhost:50051', method: 'rag.Rag/Ask', message: JSON.stringify({ question: 'Where is the clinic?', topK: 3 }), metadata: [] } }));
      ws.meta.addHistory(history({ id: 'hg2', timestamp: '2026-10-20T10:05:00.000Z', request: { target: 'localhost:50051', method: 'rag.Rag/Ask', message: JSON.stringify({ question: 'Who is the vet?', topK: 3 }), metadata: [] } }));
      const g = await captureDataset(ws, { target: 'gRPC RAG', source: { kind: 'history' }, name: 'grpc-made', dedupe: 'newest' });
      expect(g.written?.rows).toBe(2);
      const rows = readFileSync(join(ws.root, 'datasets', 'grpc-made.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(rows.map((x) => x.question)).toEqual(['Where is the clinic?', 'Who is the vet?']);
      expect(rows[0]).not.toHaveProperty('answer');
    } finally {
      ws.close();
      t.cleanup();
    }
  });
});
