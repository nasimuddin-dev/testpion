/**
 * The follow-ups of judge calibration over a real run of the local demo RAG system scored by a mock judge: the report as a
 * file (Markdown and JSON, by `rag calibrate --out`, by `testpion output rag.calibration` and by the MCP tool), and "Make an
 * example of this" (`rag metric example`, MCP `rag_make_metric_example`). No key, no network beyond 127.0.0.1.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpSession, WorkspaceStore, mcpResultBody, parseCustomMetric, type MockRule, type SavedEvaluation } from '../../packages/core/src/index.js';
// @ts-expect-error - plain JS example module
import { startRagServer } from '../../examples/servers/rag-server.mjs';
import { cliData, cliPath, runCli, tempDir } from '../helpers.js';

const t = tempDir('tp-rag-calibrate-example-');
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
  ws = WorkspaceStore.create(join(t.dir, 'ws'), 'RAG calibrate example');
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
  await cli(['rag', 'label', runId, '-w', ws.root, '--result', 'hours', '--metric', 'faithfulness', '--pass']);
  await cli(['rag', 'label', runId, '-w', ws.root, '--result', 'parking', '--metric', 'faithfulness', '--pass', '--note', 'parking is mentioned elsewhere']);
  session = new McpSession({ id: 'cal2', name: 'testpion', transport: 'stdio', command: process.execPath, args: [cliPath, 'mcp-server', '-w', ws.root], env: { ...process.env, TESTPION_HOME: home() } as Record<string, string> });
  await session.connect(30_000);
}, 120_000);
afterAll(async () => {
  await session?.close();
  await server.close();
  ws.close();
  t.cleanup();
});

describe('the calibration report as a file', () => {
  it('`rag calibrate --out` writes Markdown (or JSON) with the numbers, the confusion table and the disagreement', async () => {
    const md = join(t.dir, 'report.md');
    const r = await cli(['rag', 'calibrate', '--run', runId, '-w', ws.root, '--tune', '--out', md]);
    expect(r.status, r.err).toBe(0);
    const text = readFileSync(md, 'utf8');
    expect(text).toMatch(/^# Judge calibration · /);
    expect(text).toContain('## faithfulness');
    expect(text).toMatch(/Cohen’s kappa/);
    expect(text).toMatch(/Where the judge and the person disagree \(1\)/);
    expect(text).toContain('parking');
    const js = join(t.dir, 'report.json');
    await cli(['rag', 'calibrate', '--run', runId, '-w', ws.root, '--format', 'json', '--out', js]);
    expect(JSON.parse(readFileSync(js, 'utf8')).metrics[0].metric).toBe('faithfulness');
  });

  it('`testpion output rag.calibration` is the same file through the shared output command', async () => {
    const out = join(t.dir, 'out.md');
    const r = await cli(['output', 'rag.calibration', '--run', runId, '--format', 'md', '--out', out, '-w', ws.root]);
    expect(r.status, r.err).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, 'utf8')).toContain('## faithfulness');
    const missing = await cli(['output', 'rag.calibration', '-w', ws.root, '--format', 'md']);
    expect(missing.status).not.toBe(0);
  });
});

describe('make an example of this', () => {
  const metricPath = () => join(ws.root, 'metrics', 'polite.yaml');

  it('a labelled sample becomes an example of the custom metric file, once, with the person’s verdict', async () => {
    const made = await cli(['rag', 'metric', 'new', 'polite', '--kind', 'rule', '-w', ws.root]);
    expect(made.status, made.err).toBe(0);
    const before = parseCustomMetric(readFileSync(metricPath(), 'utf8'), { fileId: 'polite' }).metric!;
    const n = before.examples?.length ?? 0;
    const r = await cli(['rag', 'metric', 'example', 'custom/polite', '--run', runId, '--result', 'parking', '--expect', 'fail', '-w', ws.root, '--json']);
    expect(r.status, r.err).toBe(0);
    expect(cliData<{ index: number; expect: string; examples: number }>(r.out)).toMatchObject({ index: n, expect: 'fail', examples: n + 1 });
    const after = parseCustomMetric(readFileSync(metricPath(), 'utf8'), { fileId: 'polite' });
    expect(after.problems.filter((p) => p.level === 'error')).toEqual([]);
    const ex = after.metric!.examples!.at(-1)!;
    expect(ex.expect).toBe('fail');
    expect(ex.sample.question).toBe('Is there parking at the clinic?');
    expect(ex.sample.answer).toBeTruthy();
    expect(ex.sample.contexts?.length).toBeGreaterThan(0);
    // the same sample is not added twice
    const again = await cli(['rag', 'metric', 'example', 'custom/polite', '--run', runId, '--result', 'parking', '--expect', 'fail', '-w', ws.root]);
    expect(again.status).toBe(2);
    expect(again.err).toMatch(/already example/);
  });

  it('without --expect the person’s label is the verdict; with neither it says what to do; a built-in metric has no file', async () => {
    const none = await cli(['rag', 'metric', 'example', 'custom/polite', '--run', runId, '--result', 'hours', '-w', ws.root]);
    expect(none.status).toBe(2);
    expect(none.err).toMatch(/or label it first/);
    await cli(['rag', 'label', runId, '-w', ws.root, '--result', 'hours', '--metric', 'custom/polite', '--pass']);
    // (the run has no custom/polite column, so the label is refused; the verdict is then given explicitly)
    const builtin = await cli(['rag', 'metric', 'example', 'faithfulness', '--run', runId, '--result', 'hours', '--expect', 'pass', '-w', ws.root]);
    expect(builtin.status).toBe(2);
    expect(builtin.err).toMatch(/built-in/);
  });

  it('the MCP tool does the same and refuses a bad verdict', async () => {
    const call = async (args: Record<string, unknown>) => {
      const r = await session.callTool('rag_make_metric_example', args);
      const text = mcpResultBody(r).text;
      return { isError: r.isError, text, data: (() => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return undefined; } })() };
    };
    const ok = await call({ metric: 'custom/polite', run_id: runId, result: 'hours', expect: 'pass', name: 'opening hours are fine' });
    expect(ok.isError, ok.text).toBeFalsy();
    expect(ok.data).toMatchObject({ saved: true, file: 'metrics/polite.yaml', expect: 'pass' });
    expect(readFileSync(metricPath(), 'utf8')).toContain('opening hours are fine');
    expect((await call({ metric: 'custom/polite', run_id: runId, result: 'hours', expect: 'maybe' })).isError).toBe(true);
  });
});
