/**
 * `testpion rag label|calibrate` and the MCP tools rag_label / rag_calibrate, over a real run of the local demo RAG system
 * scored by a mock judge (no key, no network beyond 127.0.0.1). Labels are a workspace file; the report is statistics only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpSession, WorkspaceStore, mcpResultBody, type CalibrationReport, type MockRule, type SavedEvaluation } from '../../packages/core/src/index.js';
// @ts-expect-error - plain JS example module
import { startRagServer } from '../../examples/servers/rag-server.mjs';
import { cliData, cliPath, runCli, tempDir } from '../helpers.js';

const t = tempDir('tp-rag-calibrate-');
let server: { httpUrl: string; close(): Promise<void> };
let ws: WorkspaceStore;
let runId = '';
let session: McpSession;
const home = () => join(t.dir, 'home');
const cli = (args: string[]) => runCli(args, { home: home() });

const RULES: MockRule[] = [
  { match: 'faithfulness-v1[\\s\\S]*Parking is free', response: JSON.stringify({ reasoning: 'no parking document', items: [{ text: 'The clinic opens at 8am.', verdict: true, reason: '[doc-1]' }, { text: 'Parking is free.', verdict: false, reason: 'none' }] }) },
  { match: 'faithfulness-v1', response: JSON.stringify({ reasoning: 'ok', items: [{ text: 'The clinic opens at 8am.', verdict: true, reason: '[doc-1]' }] }) },
];

beforeAll(async () => {
  mkdirSync(home(), { recursive: true });
  server = await startRagServer({ port: 0, grpcPort: 0 });
  ws = WorkspaceStore.create(join(t.dir, 'ws'), 'RAG calibrate');
  ws.saveProviders([{ id: 'judge', name: 'Mock judge', kind: 'mock', baseUrl: 'mock://local', defaultModel: 'mock-model', headers: [{ key: 'x-mock-rules', value: JSON.stringify(RULES) }] }]);
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
  const r = await cli(['rag', 'run', 'Clinic RAG', '-w', ws.root, '--metrics', 'faithfulness', '--judge', 'judge/mock-model', '--json']);
  runId = cliData<{ runId: string }>(r.out).runId;
  session = new McpSession({ id: 'cal', name: 'testpion', transport: 'stdio', command: process.execPath, args: [cliPath, 'mcp-server', '-w', ws.root], env: { ...process.env, TESTPION_HOME: home() } as Record<string, string> });
  await session.connect(30_000);
}, 120_000);
afterAll(async () => {
  await session?.close();
  await server.close();
  ws.close();
  t.cleanup();
});

describe('rag label and rag calibrate (CLI)', () => {
  it('labels attach to the record and keep what the person saw; list shows them', async () => {
    const a = cliData<{ labels: string; label: { record: string; judge: { score: number; model: string } } }>((await cli(['rag', 'label', runId, '-w', ws.root, '--result', 'hours', '--metric', 'faithfulness', '--pass', '--json'])).out);
    expect(a.labels).toBe('Clinic-RAG');
    expect(a.label).toMatchObject({ record: 'hours', judge: { score: 1, model: 'mock-model' } });
    const b = await cli(['rag', 'label', runId, '-w', ws.root, '--result', 'parking', '--metric', 'faithfulness', '--pass', '--note', 'parking is mentioned elsewhere']);
    expect(b.status, b.err).toBe(0);
    expect(existsSync(join(ws.root, 'labels', 'Clinic-RAG.json'))).toBe(true);
    const list = cliData<{ labels: Array<{ record: string; label: string; note?: string }> }>((await cli(['rag', 'label', 'list', 'Clinic-RAG', '-w', ws.root, '--json'])).out);
    expect(list.labels.map((l) => [l.record, l.label])).toEqual([['hours', 'pass'], ['parking', 'pass']]);
    expect((await cli(['rag', 'label', runId, '-w', ws.root, '--result', 'nope', '--pass'])).status).toBe(2);
    expect((await cli(['rag', 'label', runId, '-w', ws.root, '--result', 'hours'])).err).toMatch(/--pass or --fail/);
  });

  it('calibrate reports kappa, the confusion matrix and the disagreement; --min-kappa fails the exit code', async () => {
    const r = cliData<CalibrationReport>((await cli(['rag', 'calibrate', '--run', runId, '-w', ws.root, '--tune', '--json'])).out);
    expect(r.labelled).toBe(2);
    const m = r.metrics.find((x) => x.metric === 'faithfulness')!;
    // the judge passed "hours" and failed "parking" (0.5); the person passed both
    expect(m.agreement.confusion).toEqual({ tp: 1, fp: 0, fn: 1, tn: 0 });
    expect(m.disagreements.map((d) => [d.record, d.judge, d.human])).toEqual([['parking', 'fail', 'pass']]);
    expect(m.tuning!.threshold).toBeLessThanOrEqual(0.5);
    expect(m.advice).toMatch(/Only 2 labelled/);
    const gate = await cli(['rag', 'calibrate', '--run', runId, '-w', ws.root, '--min-kappa', '0.5']);
    expect(gate.status).toBe(1);
    expect(gate.out).toMatch(/faithfulness/);
  });

  it('--tune --apply never fails on a metric the evaluation does not score: nothing is applied and the exit is 0', async () => {
    const r = await cli(['rag', 'calibrate', '--run', runId, '-w', ws.root, '--tune', '--apply', '--evaluation', 'Clinic RAG', '--json']);
    expect(r.status, r.err).toBe(0);
    const out = cliData<{ applied?: Array<{ metric: string }> }>(r.out);
    // faithfulness is judged in this run but the saved evaluation scores token-f1 only; here the tuned mark gains nothing either (one class of labels)
    expect(out.applied ?? []).toEqual([]);
  });
});

describe('rag_label and rag_calibrate (MCP)', () => {
  const call = async <T>(tool: string, args: Record<string, unknown>) => {
    const r = await session.callTool(tool, args);
    const text = mcpResultBody(r).text;
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
    return { isError: r.isError, data: data as T, text };
  };
  it('rag_label records a verdict, rag_calibrate compares the judge with the labels', async () => {
    const l = await call<{ saved: boolean; path: string }>('rag_label', { run_id: runId, result: 'parking', metric: 'faithfulness', label: 'fail', labels: 'mcp-set' });
    expect(l.text).toContain('saved');
    expect(l.data).toMatchObject({ saved: true, path: 'labels/mcp-set.json' });
    await call('rag_label', { run_id: runId, result: 'hours', metric: 'faithfulness', label: 'pass', labels: 'mcp-set' });
    const c = await call<CalibrationReport>('rag_calibrate', { run_id: runId, labels: 'mcp-set', tune: true });
    const m = c.data.metrics.find((x) => x.metric === 'faithfulness')!;
    expect(m.agreement).toMatchObject({ n: 2, accuracy: 1, confusion: { tp: 1, fp: 0, fn: 0, tn: 1 } });
    expect(m.tuning).toBeDefined();
    expect(JSON.parse(readFileSync(join(ws.root, 'labels', 'mcp-set.json'), 'utf8')).labels).toHaveLength(2);
    const bad = await call('rag_label', { run_id: runId, result: 'hours', label: 'maybe' });
    expect(bad.isError).toBe(true);
  });
});

