/**
 * `testpion rag trend` and the MCP tool rag_trend over real runs of the local demo RAG system scored by a mock judge (no key, no
 * network beyond 127.0.0.1): the second run is judged by a different model, so the trend marks it instead of calling it a drop.
 * Also `rag run --rotate --baseline-results`: the pull-request comment gets the regression table.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpSession, WorkspaceStore, mcpResultBody, type MockRule, type RagTrend, type SavedEvaluation } from '../../packages/core/src/index.js';
// @ts-expect-error - plain JS example module
import { startRagServer } from '../../examples/servers/rag-server.mjs';
import { cliData, cliPath, runCli, tempDir } from '../helpers.js';

const t = tempDir('tp-rag-trend-');
let server: { httpUrl: string; close(): Promise<void> };
let ws: WorkspaceStore;
let session: McpSession;
const runs: string[] = [];
const home = () => join(t.dir, 'home');
const cli = (args: string[], env: NodeJS.ProcessEnv = {}) => runCli(args, { home: home(), env });
/** The day the rotating sample is drawn for: fixed, so the test does not depend on today's date. */
const DAY = { TESTPION_NOW: '2026-10-22T12:00:00Z' };

const RULES: MockRule[] = [
  { match: 'faithfulness-v1[\\s\\S]*Parking is free', response: JSON.stringify({ reasoning: 'no parking document', items: [{ text: 'The clinic opens at 8am.', verdict: true, reason: '[doc-1]' }, { text: 'Parking is free.', verdict: false, reason: 'none' }] }) },
  { match: 'faithfulness-v1', response: JSON.stringify({ reasoning: 'ok', items: [{ text: 'The clinic opens at 8am.', verdict: true, reason: '[doc-1]' }] }) },
];

beforeAll(async () => {
  mkdirSync(home(), { recursive: true });
  server = await startRagServer({ port: 0, grpcPort: 0 });
  ws = WorkspaceStore.create(join(t.dir, 'ws'), 'RAG trend');
  // two judges with the same rules: the model name is what differs between the runs
  ws.saveProviders([
    { id: 'judge', name: 'Mock judge', kind: 'mock', baseUrl: 'mock://local', defaultModel: 'mock-a', headers: [{ key: 'x-mock-rules', value: JSON.stringify(RULES) }] },
    { id: 'judge2', name: 'Other judge', kind: 'mock', baseUrl: 'mock://local', defaultModel: 'mock-b', headers: [{ key: 'x-mock-rules', value: JSON.stringify(RULES) }] },
  ]);
  ws.saveLibrary('rag-targets', {
    folders: [],
    items: [{ id: 'rag-http', name: 'Clinic HTTP', data: { protocol: 'http', step: { type: 'http', method: 'POST', url: `${server.httpUrl}/query`, json: { question: '{{question}}' } }, mapping: { answer: '$.answer', contexts: '$.sources[*]', context: { text: '$.text', id: '$.id', score: '$.score' } } } }],
  });
  const dataset = [
    { id: 'hours', question: 'What time does the clinic open?', reference: 'The clinic opens at 8am on weekdays.', reference_ids: ['doc-1'] },
    { id: 'parking', question: 'Is there parking at the clinic?', reference: 'The clinic opens at 8am on weekdays.', reference_ids: ['doc-1'] },
  ]
    .map((r) => JSON.stringify(r))
    .join('\n');
  const evaluation: SavedEvaluation = { name: 'Clinic RAG', type: 'rag', provider: '', model: '', prompt: '', format: 'text', datasetFormat: 'jsonl', dataset, expectedField: 'expected', evaluators: [{ type: 'token-f1', threshold: 0.3 }], concurrency: 2, retries: 0, target: 'rag-http' };
  ws.saveLibrary('evaluations', { folders: [], items: [{ id: 'ev-rag', name: 'Clinic RAG', data: evaluation }] });
  for (const judge of ['judge/mock-a', 'judge/mock-a', 'judge2/mock-b']) {
    const r = await cli(['rag', 'run', 'Clinic RAG', '-w', ws.root, '--metrics', 'faithfulness', '--judge', judge, '--json']);
    runs.push(cliData<{ runId: string }>(r.out).runId);
    // the run list is ordered by start time: runs a few ms apart would tie
    await new Promise((ok) => setTimeout(ok, 15));
  }
  session = new McpSession({ id: 'trend', name: 'testpion', transport: 'stdio', command: process.execPath, args: [cliPath, 'mcp-server', '-w', ws.root], env: { ...process.env, TESTPION_HOME: home() } as Record<string, string> });
  await session.connect(30_000);
}, 180_000);
afterAll(async () => {
  await session?.close();
  await server.close();
  ws.close();
  t.cleanup();
});

describe('rag trend (CLI)', () => {
  it('json: a point per run, oldest first, with the judge; the run by another judge is marked, not a drop', async () => {
    const t1 = cliData<RagTrend>((await cli(['rag', 'trend', 'Clinic RAG', '-w', ws.root, '--json'])).out);
    expect(t1.points.map((p) => p.runId)).toEqual(runs);
    expect(t1.points[0]!.metrics.faithfulness).toMatchObject({ mean: 0.75, n: 2 });
    expect(t1.points.map((p) => p.judge)).toEqual(['Mock judge/mock-a', 'Mock judge/mock-a', 'Other judge/mock-b']);
    expect(t1.points.map((p) => !!p.judgeChanged)).toEqual([false, false, true]);
    expect(t1.findings).toEqual([]);
    expect(existsSync(join(ws.runDir(runs[0]!), 'rag-means.json'))).toBe(true);
  });
  it('table and csv; --metric limits; a wrong name is a configuration error', async () => {
    const table = (await cli(['rag', 'trend', 'Clinic RAG', '-w', ws.root])).out;
    expect(table).toContain('faithfulness');
    expect(table).toContain('judge or a metric version changed');
    const csv = (await cli(['rag', 'trend', 'Clinic RAG', '-w', ws.root, '--format', 'csv', '--metric', 'faithfulness'])).out;
    expect(csv.split('\n')[0]).toBe('run,at,samples,judge,judge_changed,faithfulness,faithfulness_low,faithfulness_high');
    expect(csv.trim().split('\n')).toHaveLength(4);
    const bad = await cli(['rag', 'trend', 'No such evaluation', '-w', ws.root]);
    expect(bad.status).toBe(2);
  });
});

describe('rag_trend (MCP)', () => {
  it('returns the same points', async () => {
    const r = JSON.parse(mcpResultBody(await session.callTool('rag_trend', { evaluation: 'Clinic RAG', runs: 2 })).text) as RagTrend;
    expect(r.points.map((p) => p.runId)).toEqual(runs.slice(1));
  });
});

describe('rag run with a rotating sample and a baseline file', () => {
  it('scores --limit records, and the markdown comment gets the regression table; a missing baseline file is no error', async () => {
    const md = join(t.dir, 'comment.md');
    const first = await cli(['rag', 'run', 'Clinic RAG', '-w', ws.root, '--metrics', 'faithfulness', '--judge', 'judge/mock-a', '--limit', '1', '--rotate', '--baseline-results', join(t.dir, 'nothing', 'results.jsonl'), '--markdown', md, '--json'], DAY);
    // which record is scored depends on the UTC day (--rotate), fixed here: it may pass (0) or fail its check (1), never a configuration or run error
    expect([0, 1]).toContain(first.status);
    const r1 = cliData<{ runId: string; summary: { total: number } }>(first.out);
    expect(r1.summary.total).toBe(1);
    const second = await cli(['rag', 'run', 'Clinic RAG', '-w', ws.root, '--metrics', 'faithfulness', '--judge', 'judge/mock-a', '--baseline', runs[0]!, '--markdown', md, '--json']);
    expect(second.status).toBe(0);
    expect(readFileSync(md, 'utf8')).toContain(`### Against ${runs[0]}`);
    const noLimit = await cli(['rag', 'run', 'Clinic RAG', '-w', ws.root, '--rotate'], DAY);
    expect(noLimit.status).toBe(2);
  });
});
