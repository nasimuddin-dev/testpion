/**
 * `testpion rag generate-dataset` and the MCP tool rag_generate_testset with the offline mock model: documents (workspace
 * and outside it, for the CLI) become verified rows in a proposal, --apply writes the ticked ones to datasets/, a refused URL
 * and a bad path are said, and the estimate sends nothing. No key, no network.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpSession, WorkspaceStore, mcpResultBody, type MockRule } from '../../packages/core/src/index.js';
import { mockProvider } from '../ai/harness.js';
import { cliData, cliPath, runCli, tempDir } from '../helpers.js';

const t = tempDir('tp-rag-testset-', { alias: true });
let ws = '';
let session: McpSession;
const home = () => join(t.dir, 'home');
const env = { TESTPION_AI_PROVIDER: 'mock-ai', TESTPION_AI_MODEL: 'mock-model', CI: '' };
const cli = (args: string[]) => runCli(args, { home: home(), env });

const DOC = 'Happy Paws opens at 8am on weekdays and closes at 6pm. On Saturdays it opens at 9am and closes at noon.\n\nThe puppy booster follows at 12 weeks and costs 45 dollars.';
const samples = JSON.stringify({
  samples: [
    { slot: 1, type: 'single-hop', question: 'When does Happy Paws open on weekdays?', reference: 'It opens at 8am on weekdays and closes at 6pm.', chunks: [], answerable: true },
    { slot: 2, type: 'unanswerable', question: 'Which surgeon performs hip replacements for horses?', reference: '', chunks: [], answerable: false },
  ],
});
const verdict = JSON.stringify({ reasoning: 'ok', items: [{ text: 'It opens at 8am.', verdict: true, reason: '[doc]' }] });
const RULES: MockRule[] = [
  { match: 'REFERENCE SUPPORT', response: verdict },
  { match: 'slots', response: samples },
];

beforeAll(async () => {
  mkdirSync(home(), { recursive: true });
  // the MCP server reads the app's settings: the mock model answers large tasks
  writeFileSync(join(home(), 'settings.json'), JSON.stringify({ assistantProvider: 'mock-ai', assistantModel: 'mock-model' }));
  const store = WorkspaceStore.create(join(t.dir, 'ws'), 'RAG testset');
  store.saveProviders([mockProvider(RULES)]);
  mkdirSync(join(store.root, 'docs'), { recursive: true });
  writeFileSync(join(store.root, 'docs', 'handbook.md'), DOC);
  mkdirSync(join(t.dir, 'outside'), { recursive: true });
  writeFileSync(join(t.dir, 'outside', 'notes.txt'), DOC);
  ws = store.root;
  store.close();
  session = new McpSession({ id: 'ts', name: 'testpion', transport: 'stdio', command: process.execPath, args: [cliPath, 'mcp-server', '-w', ws], env: { ...process.env, TESTPION_HOME: home() } as Record<string, string> });
  await session.connect(30_000);
}, 120_000);
afterAll(async () => {
  await session?.close();
  t.cleanup();
});

describe('testpion rag generate-dataset', () => {
  it('--estimate reads the documents, prints the plan and sends nothing', async () => {
    const r = await cli(['rag', 'generate-dataset', 'docs', '--count', '2', '--types', 'single-hop,unanswerable', '--estimate', '--json', '-w', ws]);
    expect(r.status, r.err).toBe(0);
    const e = cliData<{ total: { llmCalls: number }; corpus: { documents: number; passages: number }; metrics: Array<{ id: string }> }>(r.out);
    expect(e.corpus).toMatchObject({ documents: 1, passages: 1 });
    expect(e.metrics.map((m) => m.id)).toEqual(['write-questions', 'reference-support']);
    expect(e.total.llmCalls).toBe(2);
    expect(readdirSync(join(ws, 'datasets'))).toEqual([]);
  });

  it('writes a proposal with verified rows; --apply adds the ticked rows to datasets/<name>.jsonl; undo removes them', async () => {
    const r = await cli(['rag', 'generate-dataset', 'docs', '--count', '2', '--types', 'single-hop,unanswerable', '--name', 'clinic', '--apply', '--json', '-w', ws]);
    expect(r.status, r.err).toBe(0);
    const out = cliData<{ proposal: { id: string; items: Array<{ kind: string; selected: boolean; verification: Array<{ verifier: string; status: string }> }> }; tally: { verified: number }; applied: { applied: unknown[] } }>(r.out);
    expect(out.proposal.items).toHaveLength(2);
    expect(out.proposal.items.every((i) => i.kind === 'dataset-row' && i.verification.map((b) => b.verifier).join() === 'testset-support,testset-answerable,testset-duplicate')).toBe(true);
    expect(out.tally.verified).toBe(2);
    expect(out.applied.applied).toHaveLength(2);
    const rows = readFileSync(join(ws, 'datasets', 'clinic.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.map((x) => x.answerable)).toEqual([true, false]);
    expect(rows[0]).toMatchObject({ reference_ids: ['docs-handbook#1'] });
    // running it again adds nothing twice (the same questions are duplicates of what the file holds)
    const again = cliData<{ proposal: { items: Array<{ selected: boolean }> } }>((await cli(['rag', 'generate-dataset', 'docs', '--count', '2', '--types', 'single-hop,unanswerable', '--name', 'clinic', '--json', '-w', ws])).out);
    expect(again.proposal.items.every((i) => !i.selected)).toBe(true);
    const undo = await cli(['ai', 'undo', out.proposal.id, '-w', ws, '--yes']);
    expect(undo.status, undo.err).toBe(0);
    expect(existsSync(join(ws, 'datasets', 'clinic.jsonl'))).toBe(false);
  });

  it('the CLI may name documents outside the workspace; a bad URL and a missing path are said (exit 2)', async () => {
    const abs = await cli(['rag', 'generate-dataset', join(t.dir, 'outside', 'notes.txt'), '--count', '2', '--types', 'single-hop,unanswerable', '--json', '-w', ws]);
    expect(abs.status, abs.err).toBe(0);
    const bad = await cli(['rag', 'generate-dataset', '--url', 'http://example.com/a', '--count', '2', '-w', ws]);
    expect(bad.status).toBe(2);
    expect(bad.err).toMatch(/No document could be read|only https/);
    const missing = await cli(['rag', 'generate-dataset', 'docs/none.md', '--count', '2', '-w', ws]);
    expect(missing.status).toBe(2);
    const priv = await cli(['rag', 'generate-dataset', '--url', 'https://169.254.169.254/latest', '--count', '2', '-w', ws]);
    expect(priv.status).toBe(2);
    const types = await cli(['rag', 'generate-dataset', 'docs', '--types', 'bogus', '-w', ws]);
    expect(types.status).toBe(2);
    expect(types.err).toMatch(/Unknown question type bogus/);
  });
});

describe('rag_generate_testset (MCP)', () => {
  const call = async <T>(args: Record<string, unknown>) => {
    const r = await session.callTool('rag_generate_testset', args);
    const text = mcpResultBody(r).text;
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
    return { isError: r.isError, data: data as T, text };
  };

  it('dry_run returns the estimate; a run returns one proposal whose rows carry their badges; paths outside the workspace are refused', async () => {
    const d = await call<{ dryRun: boolean; estimate: { total: { llmCalls: number } } }>({ paths: ['docs'], count: 2, types: ['single-hop', 'unanswerable'], dry_run: true });
    expect(d.data).toMatchObject({ dryRun: true, estimate: { total: { llmCalls: 2 } } });
    const r = await call<{ proposal: { id: string; items: Array<{ type: string; question: string; reference_ids: string[]; verification: Array<{ status: string }> }> }; next: string }>({ paths: ['docs'], count: 2, types: ['single-hop', 'unanswerable'], name: 'mcp-set', confirm: true });
    expect(r.isError).toBeFalsy();
    expect(r.data.proposal.items.map((i) => i.type)).toEqual(['single-hop', 'unanswerable']);
    expect(r.data.proposal.items[0]).toMatchObject({ reference_ids: ['docs-handbook#1'] });
    expect(r.data.proposal.items.every((i) => i.verification.every((b) => b.status === 'pass'))).toBe(true);
    expect(r.data.next).toContain('ai_apply_proposal');
    // it only proposes: the dataset file is not there until the person agrees
    expect(existsSync(join(ws, 'datasets', 'mcp-set.jsonl'))).toBe(false);
    const outside = await call({ paths: [join(t.dir, 'outside', 'notes.txt')], count: 2, confirm: true });
    expect(outside.isError).toBe(true);
    expect(outside.text).toMatch(/outside the workspace/);
  });
});
