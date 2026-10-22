/**
 * AI-4 / AI-10 for agents and scripts: MCP `spec_gaps`, `spec_tests_generate`, `tidy_import` (they propose; apply with
 * ai_apply_proposal) and CLI `testpion generate gaps|tests` and `testpion tidy --ai` — with the mock provider and the
 * --json envelope. The owner's key is never used: only the mock.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { defaultSettings, MemorySecretStore, WorkspaceStore } from '../../packages/core/src/index.js';
import { aiTools } from '../../packages/core/src/mcp-server/tools/ai-tools.js';
import { withToolContract } from '../../packages/core/src/mcp-server/tool-contract.js';
import { TOOL_DOCS } from '../../packages/core/src/mcp-server/tool-docs.js';
import { cliData, runCliSync, tempDir } from '../helpers.js';
import { mockProvider } from '../ai/harness.js';
import { addShopSpec } from '../ai/spec-fixtures.js';
import { IMPORTED, TIDY_PLAN, TOKEN } from '../ai/tidy-fixtures.js';

const SPEC_PLAN = JSON.stringify({
  summary: 'Quantity limits.',
  assumptions: ['qty 0 is refused'],
  cases: [
    { operation: 'POST /orders', category: 'negative', name: 'Quantity zero is refused', expectStatus: 422, bodyPatch: [{ field: 'qty', value: 0 }] },
    { operation: 'POST /invoices', category: 'negative', name: 'Invented', expectStatus: 400 },
  ],
});

const t = tempDir('tp-ai-spec-surfaces-');
afterAll(() => t.cleanup());

function workspace(name: string) {
  const store = WorkspaceStore.create(join(t.dir, name), name);
  store.saveProviders([mockProvider([{ match: '"operations"', response: SPEC_PLAN }, { match: '"requests"', response: TIDY_PLAN }, { match: '.', response: '{}' }])]);
  addShopSpec(store);
  store.saveCollection(JSON.parse(JSON.stringify(IMPORTED)));
  return store;
}

const tools = (store: WorkspaceStore, settings = { ...defaultSettings(), assistantProvider: 'mock-ai', assistantModel: 'mock-model' }) => {
  const raw = aiTools({ store, secrets: new MemorySecretStore(), settings });
  // descriptions as the MCP server lists them (with the contract), results as the tools return them
  const list = withToolContract(raw, { docs: TOOL_DOCS });
  return { list, call: async (name: string, args: Record<string, unknown>) => (await raw.find((x) => x.name === name)!.run(args)) as Record<string, any> };
};

describe('MCP: spec_gaps, spec_tests_generate, tidy_import', () => {
  it('the tools say when to use them, and spec_gaps needs no model', async () => {
    const store = workspace('mcp-gaps');
    try {
      const { list, call } = tools(store, { ...defaultSettings(), assistantProvider: undefined });
      for (const n of ['spec_gaps', 'spec_tests_generate', 'tidy_import']) expect(list.find((x) => x.name === n)!.description).toMatch(/Use it when/);
      const r = await call('spec_gaps', { spec: 'specs/shop.yaml' });
      expect(r.report.summary).toMatchObject({ operations: 5, covered: 4 });
      expect(r.draft.tests).toBeGreaterThan(5);
      expect((await call('spec_gaps', { spec: 'specs/shop.yaml', format: 'markdown' })).markdown).toContain('# Test gaps: Shop API');
      await expect(call('spec_gaps', {})).rejects.toThrow(/spec is required/);
    } finally {
      store.close();
    }
  });

  it('spec_tests_generate proposes validated tests; apply is a separate call; no model falls back to the deterministic cases', async () => {
    const store = workspace('mcp-spec');
    try {
      const { call } = tools(store);
      const dry = JSON.stringify(await call('spec_tests_generate', { spec: 'specs/shop.yaml', dryRun: true, operations: ['POST /orders'] }));
      expect(dry).toContain('"dryRun":true');
      const ran = await call('spec_tests_generate', { spec: 'specs/shop.yaml', categories: ['negative', 'boundary'] });
      const p = ran.proposal;
      expect(p.task).toBe('tests-from-spec');
      expect(p.items[0].verification.map((b: { verifier: string }) => b.verifier)).toEqual(['test-file', 'spec-tests']);
      expect(p.notes.join('\n')).toContain('POST /invoices is not an operation');
      expect(p.summary).toContain('Coverage of the document');
      expect(ran.next).toContain('ai_apply_proposal');
      expect(() => store.readTestFile(p.items[0].path)).toThrow();
      await call('ai_apply_proposal', { id: p.id });
      expect(store.readTestFile(p.items[0].path)).toContain('Quantity zero is refused');
      // an unknown category / spec is said, not guessed
      await expect(call('spec_tests_generate', { spec: 'specs/none.yaml' })).rejects.toThrow(/Cannot read/);
      const off = tools(store, { ...defaultSettings(), assistantProvider: undefined });
      const draft = await off.call('spec_tests_generate', { spec: 'specs/shop.yaml', gapsOnly: false, path: 'api/all.yaml' });
      expect(draft.fallback).toBeTruthy();
      expect(draft.proposal.model).toContain('no AI');
      expect(draft.proposal.items[0].path).toBe('api/all.yaml');
      expect((await off.call('spec_tests_generate', { spec: 'specs/shop.yaml', noAi: true, operations: 'GET /health' }).catch((e: Error) => e.message))).toMatch(/already cover|Nothing to generate/);
    } finally {
      store.close();
    }
  });

  it('tidy_import proposes verified changes; applied by ai_apply_proposal, undone by ai_undo_proposal', async () => {
    const store = workspace('mcp-tidy');
    try {
      const { call } = tools(store);
      const dry = JSON.stringify(await call('tidy_import', { collection: 'HAR import 2026-10-19', dryRun: true, privacy: 'metadata' }));
      expect(dry).toContain('"dryRun":true');
      expect(dry).not.toContain(TOKEN);
      const ran = await call('tidy_import', { collection: 'imp', source: 'har' });
      const p = ran.proposal;
      expect(p.items.every((i: { kind: string }) => i.kind === 'collection')).toBe(true);
      expect(p.items.some((i: { verification: Array<{ status: string }> }) => i.verification.some((b) => b.status === 'fail'))).toBe(false);
      expect(ran.next).toContain('ai_undo_proposal');
      await call('ai_apply_proposal', { id: p.id });
      expect(store.getCollection('imp').variables.map((v) => v.key).sort()).toEqual(['apiUrl', 'orderId', 'token']);
      await call('ai_undo_proposal', { id: p.id });
      expect(store.getCollection('imp').variables).toEqual([]);
      const off = tools(store, { ...defaultSettings(), assistantProvider: undefined });
      const draft = await off.call('tidy_import', { collection: 'imp' });
      expect(draft.fallback).toBeTruthy();
      expect(draft.proposal.items.length).toBe(6);
      await expect(call('tidy_import', { collection: 'nope' })).rejects.toThrow(/No collection "nope"/);
    } finally {
      store.close();
    }
  });
});

describe('CLI: testpion generate gaps|tests and tidy --ai', () => {
  const env = { TESTPION_AI_PROVIDER: 'mock-ai', TESTPION_AI_MODEL: 'mock-model', CI: '' };

  it('generate gaps (no model), generate tests --dry-run, a proposal, --apply, --no-ai, errors', () => {
    const store = workspace('cli-spec');
    const ws = store.root;
    store.close();
    const gaps = cliData(runCliSync(['generate', 'gaps', '--spec', 'specs/shop.yaml', '--json', '-w', ws], { env: { ...env, TESTPION_AI_PROVIDER: '' } }).out);
    expect(gaps.report.operations.map((o: { operation: string }) => o.operation)).toContain('POST /orders');
    expect(gaps.draft.tests).toBeGreaterThan(5);
    const text = runCliSync(['generate', 'gaps', '--spec', 'specs/shop.yaml', '-w', ws], { env });
    expect(text.out).toContain('Test gaps: Shop API');

    const dry = cliData(runCliSync(['generate', 'tests', '--spec', 'specs/shop.yaml', '--dry-run', '--json', '-w', ws], { env }).out);
    expect(dry.dryRun).toBe(true);
    expect(dry.preview.context.sections.map((s: { name: string }) => s.name)).toContain('operations');

    const r = cliData(runCliSync(['generate', 'tests', '--spec', 'specs/shop.yaml', '--category', 'negative,boundary', '--json', '-w', ws], { env }).out);
    expect(r.proposal.items[0]).toMatchObject({ kind: 'file', path: 'shop/orders-gaps.yaml', selected: true });
    expect(r.proposal.notes.join('\n')).toMatch(/POST \/invoices is not an operation/);

    const applied = cliData(runCliSync(['generate', 'tests', '--spec', 'specs/shop.yaml', '--path', 'api/gaps.yaml', '--apply', '--json', '-w', ws], { env }).out);
    expect(applied.applied.applied[0].path).toBe('api/gaps.yaml');

    const draft = cliData(runCliSync(['generate', 'tests', '--spec', 'specs/shop.yaml', '--no-ai', '--no-gaps-only', '--operation', 'POST /orders', '--json', '-w', ws], { env }).out);
    expect(draft.model).toMatch(/deterministic/);
    expect(draft.proposal.items[0].after).toMatch(/without AI/);

    const bad = runCliSync(['generate', 'tests', '--spec', 'specs/shop.yaml', '--category', 'chaos', '--json', '-w', ws], { env });
    expect(bad.status).not.toBe(0);
    expect(JSON.parse(bad.out).errors[0].message).toMatch(/Unknown category chaos/);
  }, 180_000);

  it('tidy --ai: dry run, a proposal, --apply, --no-model; the plain tidy keeps working with --dry-run', () => {
    const store = workspace('cli-tidy');
    const ws = store.root;
    store.close();
    const dry = cliData(runCliSync(['tidy', 'imp', '--ai', '--dry-run', '--json', '-w', ws], { env }).out);
    expect(dry.dryRun).toBe(true);
    expect(JSON.stringify(dry.preview.messages)).not.toContain(TOKEN);

    const r = cliData(runCliSync(['tidy', 'imp', '--ai', '--source', 'har', '--json', '-w', ws], { env }).out);
    expect(r.proposal.items.length).toBeGreaterThan(5);
    expect(r.proposal.items.every((i: { kind: string }) => i.kind === 'collection')).toBe(true);

    const applied = cliData(runCliSync(['tidy', 'imp', '--ai', '--apply', '--json', '-w', ws], { env }).out);
    expect(applied.applied.applied.length).toBeGreaterThan(5);
    const undone = cliData(runCliSync(['ai', 'undo', applied.proposal.id, '--yes', '--json', '-w', ws], { env }).out);
    expect(undone.restored).toBeGreaterThan(0);

    const none = cliData(runCliSync(['tidy', 'imp', '--ai', '--no-model', '--json', '-w', ws], { env }).out);
    expect(none.model).toMatch(/deterministic/);
    expect(none.proposal.items.length).toBe(6);

    // the plain tidy: --dry-run reports what would go and changes nothing
    const plain = cliData(runCliSync(['tidy', 'imp', '--remove-duplicates', '--dry-run', '--json', '-w', ws], { env }).out);
    expect(plain.removed).toBeGreaterThan(0);
    expect(cliData(runCliSync(['tidy', 'imp', '--json', '-w', ws], { env }).out).findings.some((f: { kind: string }) => f.kind === 'duplicate')).toBe(true);
  }, 240_000);
});
