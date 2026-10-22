/**
 * AI-1 / AI-3 for agents and scripts: MCP `flow_generate` (proposes; apply with ai_apply_proposal), CLI
 * `testpion flow generate` (--dry-run, the proposal, --apply, the draft without a model) and
 * `testpion ai run suggest-assertions --item request:…` — all with the mock provider and the --json envelope.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { defaultSettings, MemorySecretStore, WorkspaceStore } from '../../packages/core/src/index.js';
import { aiTools } from '../../packages/core/src/mcp-server/tools/ai-tools.js';
import { withToolContract } from '../../packages/core/src/mcp-server/tool-contract.js';
import { TOOL_DOCS } from '../../packages/core/src/mcp-server/tool-docs.js';
import { cliData, runCliSync, tempDir } from '../helpers.js';
import { mockProvider } from '../ai/harness.js';
import { SHOP } from '../ai/fixtures.js';

const PLAN = JSON.stringify({
  name: 'Order lifecycle',
  summary: 'Create, read and delete an order.',
  assumptions: ['POST /orders answers with the id in $.id'],
  steps: [
    { id: 'create-order', request: 'req-create', extract: { orderId: '$.id' }, assertions: [{ type: 'status', expected: 201 }] },
    { id: 'read-order', request: 'req-get', dependsOn: ['create-order'], url: '{{baseUrl}}/orders/{{orderId}}', assertions: [{ type: 'status', expected: 200 }] },
    { id: 'ghost', request: 'req-invented' },
  ],
});

const t = tempDir('tp-ai-flow-surfaces-');
afterAll(() => t.cleanup());

function workspace(name: string) {
  const store = WorkspaceStore.create(join(t.dir, name), name);
  store.saveProviders([
    mockProvider([
      { match: '"source"', response: PLAN },
      { match: '.', response: '{"checks":[{"type":"status","expected":201},{"type":"equals","path":"$.id","expected":42}]}' },
    ]),
  ]);
  store.saveCollection(structuredClone(SHOP));
  return store;
}

describe('MCP: flow_generate', () => {
  it('proposes a verified flow from a folder (by name), applied only by ai_apply_proposal with confirm; falls back to the draft without a model', async () => {
    const store = workspace('mcp');
    try {
      const settings = { ...defaultSettings(), assistantProvider: 'mock-ai', assistantModel: 'mock-model' };
      const tools = withToolContract(aiTools({ store, secrets: new MemorySecretStore(), settings }), { docs: TOOL_DOCS });
      const call = (name: string, args: Record<string, unknown>) => tools.find((x) => x.name === name)!.run(args);
      expect(tools.find((x) => x.name === 'flow_generate')!.description).toMatch(/Use it when/);

      const dry = JSON.stringify(await call('flow_generate', { collection: 'Shop', folder: 'Orders', dryRun: true, privacy: 'metadata' }));
      expect(dry).toContain('"dryRun":true');
      expect(dry).not.toContain('bookshelf');

      expect(JSON.stringify(await call('flow_generate', { collection: 'Shop', folder: 'Orders' }))).toContain('confirmationRequired');
      const ran = JSON.stringify(await call('flow_generate', { collection: 'Shop', folder: 'Orders', confirm: true }));
      const id = /"id":"(ai-[^"]+)"/.exec(ran)![1]!;
      expect(ran).toContain('ai_apply_proposal');
      expect(ran).toContain('Dropped step');
      expect(() => store.readTestFile('flows/shop-orders.yaml')).toThrow();
      await call('ai_apply_proposal', { id, confirm: true });
      expect(store.readTestFile('flows/shop-orders.yaml')).toContain('read-order');

      // no model set up: the deterministic draft, with a note
      const off = aiTools({ store, secrets: new MemorySecretStore(), settings: { ...defaultSettings(), assistantProvider: undefined } });
      const draft = JSON.stringify(await off.find((x) => x.name === 'flow_generate')!.run({ collection: 'shop', folder: 'fld-orders' }));
      expect(draft).toContain('"fallback"');
      expect(draft).toContain('no AI (deterministic draft)');
    } finally {
      store.close();
    }
  });
});

describe('CLI: testpion flow generate and ai run suggest-assertions', () => {
  it('--dry-run, a proposal, --apply, --no-ai, all with the --json envelope', () => {
    const store = workspace('cli');
    const ws = store.root;
    store.close();
    const env = { TESTPION_AI_PROVIDER: 'mock-ai', TESTPION_AI_MODEL: 'mock-model', CI: '' };

    const dry = cliData(runCliSync(['flow', 'generate', '--collection', 'Shop', '--folder', 'Orders', '--dry-run', '--json', '-w', ws], { env }).out);
    expect(dry.dryRun).toBe(true);
    expect(dry.preview.context.sections.map((s: { name: string }) => s.name)).toContain('requests');

    const r = cliData(runCliSync(['flow', 'generate', '--collection', 'Shop', '--folder', 'Orders', '--json', '-w', ws], { env }).out);
    expect(r.proposal.items[0]).toMatchObject({ kind: 'flow', path: 'flows/shop-orders.yaml', selected: true });
    expect(r.proposal.assumptions).toEqual(['POST /orders answers with the id in $.id']);
    expect(r.proposal.notes[0]).toMatch(/Dropped step "ghost"/);

    const applied = cliData(runCliSync(['flow', 'generate', '--collection', 'Shop', '--folder', 'Orders', '--path', 'flows/orders-ai.yaml', '--apply', '--json', '-w', ws], { env }).out);
    expect(applied.applied.applied[0].path).toBe('flows/orders-ai.yaml');

    const draft = cliData(runCliSync(['flow', 'generate', '--collection', 'Shop', '--folder', 'Orders', '--no-ai', '--json', '-w', ws], { env }).out);
    expect(draft.model).toMatch(/deterministic/);
    expect(draft.proposal.items[0].after).toMatch(/without AI/);

    const missing = runCliSync(['flow', 'generate', '--collection', 'Shop', '--folder', 'Refunds', '--json', '-w', ws], { env });
    expect(missing.status).not.toBe(0);
    expect(JSON.parse(missing.out).errors[0].message).toMatch(/No folder "Refunds"/);

    // AI-3 parity: the alias, an item, verified checks (no stored response: not checked, never applied blindly)
    const checks = cliData(
      runCliSync(['ai', 'run', 'suggest-assertions', '--item', 'request:shop:req-create', '--context', JSON.stringify({ status: 201, body: '{"id":42}' }), '--json', '-w', ws], { env }).out,
    );
    expect(checks.task).toBe('generate-assertions');
    expect(checks.proposal.items.length).toBe(2);
  }, 180_000);
});
