/**
 * `testpion rag author` (a real CLI process) and the MCP tool rag_author_evaluation (in process, with the tool contract):
 * a mock model drafts the plan, TestPion builds and dry-runs the evaluation, `--apply` saves it. No key, no network.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultSettings, MemorySecretStore, WorkspaceStore, type MockRule, type SavedEvaluation } from '../../packages/core/src/index.js';
import { ragAuthorTools } from '../../packages/core/src/mcp-server/rag-author-tools.js';
import { withToolContract } from '../../packages/core/src/mcp-server/tool-contract.js';
import { TOOL_DOCS } from '../../packages/core/src/mcp-server/tool-docs.js';
import { cliData, runCli, tempDir } from '../helpers.js';

const t = tempDir('tp-rag-author-');
let ws: WorkspaceStore;
const home = () => join(t.dir, 'home');
const cli = (args: string[]) => runCli(args, { home: home() });

const PLAN = JSON.stringify({
  name: 'Clinic check',
  summary: 'Retrieval and answer quality.',
  metrics: [
    { id: 'recall@k', threshold: 0.8, options: { k: 3 }, why: 'gold chunk back' },
    { id: 'token-f1', threshold: 0.5, why: 'matches the reference' },
  ],
  gates: { 'token-f1': 0.5 },
});
const RULES: MockRule[] = [{ match: '.', response: PLAN }];

beforeAll(() => {
  mkdirSync(home(), { recursive: true });
  ws = WorkspaceStore.create(join(t.dir, 'ws'), 'RAG author');
  ws.saveProviders([{ id: 'judge', name: 'Mock judge', kind: 'mock', baseUrl: 'mock://local', defaultModel: 'mock-model', headers: [{ key: 'x-mock-rules', value: JSON.stringify(RULES) }] }]);
  ws.saveLibrary('rag-targets', { folders: [], items: [{ id: 'rag-1', name: 'Clinic HTTP', data: { protocol: 'http', step: { type: 'http', method: 'POST', url: 'https://rag.example.test/q', json: { question: '{{question}}' } }, mapping: { answer: '$.answer', contexts: '$.sources[*]', context: { text: '$.text', id: '$.id' } } } }] });
  mkdirSync(join(ws.root, 'datasets'), { recursive: true });
  writeFileSync(
    join(ws.root, 'datasets', 'clinic.jsonl'),
    [
      { id: 'a', question: 'When does it open?', reference: 'At 8am.', reference_ids: ['d1'], answer: 'At 8am.', contexts: [{ id: 'd1', text: 'Open at 8am.' }] },
      { id: 'b', question: 'Where is it?', reference: 'Main Street.', reference_ids: ['d2'], answer: 'Main Street.', contexts: [{ id: 'd2', text: 'We are on Main Street.' }] },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n'),
  );
});
afterAll(() => {
  ws.close();
  t.cleanup();
});

describe('testpion rag author', () => {
  it('--estimate shows what would be sent to the model and sends nothing', async () => {
    const r = await cli(['rag', 'author', '--target', 'Clinic HTTP', '--dataset', 'clinic.jsonl', '-w', ws.root, '--provider', 'judge', '--model', 'mock-model', '--estimate', '--json']);
    expect(r.status, r.err).toBe(0);
    const out = cliData<{ preview: { messages: Array<{ content: string }> } }>(r.out);
    const sent = out.preview.messages.map((m) => m.content).join('\n');
    expect(sent).toContain('When does it open?');
    expect(sent).not.toContain('rag.example.test');
    expect(ws.getLibrary('evaluations').items).toHaveLength(0);
  });

  it('drafts, verifies and shows the evaluation; nothing is saved without --apply', async () => {
    const r = await cli(['rag', 'author', '--target', 'Clinic HTTP', '--dataset', 'clinic.jsonl', '--goal', 'answers match the handbook', '-w', ws.root, '--provider', 'judge', '--model', 'mock-model', '--json']);
    expect(r.status, r.err).toBe(0);
    const out = cliData<{ proposal: { items: Array<{ kind: string; title: string; selected: boolean; verification: Array<{ verifier: string; status: string }> }> } }>(r.out);
    const item = out.proposal.items[0]!;
    expect(item).toMatchObject({ kind: 'evaluation', title: 'Evaluation: Clinic check', selected: true });
    expect(item.verification.find((b) => b.verifier === 'rag-eval-dry-run')!.status).toBe('pass');
    expect(ws.getLibrary('evaluations').items).toHaveLength(0);
  });

  it('--apply saves it as a saved evaluation that `rag run --estimate` can read', async () => {
    const r = await cli(['rag', 'author', '--target', 'Clinic HTTP', '--dataset', 'clinic.jsonl', '--name', 'Clinic nightly', '-w', ws.root, '--provider', 'judge', '--model', 'mock-model', '--apply', '--json']);
    expect(r.status, r.err).toBe(0);
    const saved = ws.getLibrary<SavedEvaluation>('evaluations').items;
    expect(saved.map((i) => i.name)).toEqual(['Clinic nightly']);
    expect(saved[0]!.data).toMatchObject({ type: 'rag', target: 'rag-1' });
    const est = await cli(['rag', 'run', 'Clinic nightly', '-w', ws.root, '--estimate', '--json']);
    expect(est.status, est.err).toBe(0);
  });

  it('an unknown target is a configuration error (exit 2) before any model is asked', async () => {
    const r = await cli(['rag', 'author', '--target', 'Nope', '-w', ws.root, '--provider', 'judge', '--model', 'mock-model']);
    expect(r.status).toBe(2);
    expect(r.err).toMatch(/No RAG target "Nope"/);
  });
});

describe('MCP rag_author_evaluation', () => {
  const tool = () => {
    const store = WorkspaceStore.open(ws.root);
    const settings = { ...defaultSettings(), assistantProvider: 'judge', assistantModel: 'mock-model' };
    return { store, tool: withToolContract(ragAuthorTools({ store, secrets: new MemorySecretStore(), settings, checkEnvironment: () => undefined }), { docs: TOOL_DOCS }).find((x) => x.name === 'rag_author_evaluation')! };
  };

  it('is documented, proposes (an item with badges and an id) and saves nothing', async () => {
    const { store, tool: t1 } = tool();
    try {
      expect(t1.description).toMatch(/When to use: Setting up the evaluation/);
      const r = (await t1.run({ target: 'Clinic HTTP', dataset: 'clinic.jsonl', goal: 'x' })) as { value: { proposal: { id: string; items: Array<{ kind: string; verification: Array<{ verifier: string }> }> }; next: string } };
      expect(r.value.proposal.items[0]).toMatchObject({ kind: 'evaluation' });
      expect(r.value.proposal.items[0]!.verification.map((b) => b.verifier)).toContain('rag-eval-dry-run');
      expect(r.value.next).toMatch(/ai_apply_proposal/);
      // the CLI test above saved one; this call saved none more
      expect(store.getLibrary('evaluations').items).toHaveLength(1);
    } finally {
      store.close();
    }
  }, 60_000);

  it('dry_run returns what would be sent and calls no model', async () => {
    const { store, tool: t1 } = tool();
    try {
      const r = (await t1.run({ target: 'Clinic HTTP', dry_run: true })) as { value: { dryRun: boolean; preview: { task: string } } };
      expect(r.value).toMatchObject({ dryRun: true, preview: { task: 'rag-author-evaluation' } });
    } finally {
      store.close();
    }
  }, 60_000);
});
