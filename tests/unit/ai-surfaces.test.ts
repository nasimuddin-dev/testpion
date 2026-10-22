import { describe, it, expect, afterAll } from 'vitest';
import { join } from 'node:path';
import { defaultSettings, MemorySecretStore, WorkspaceStore } from '../../packages/core/src/index.js';
import { aiTools } from '../../packages/core/src/mcp-server/tools/ai-tools.js';
import { withToolContract, isContractResult } from '../../packages/core/src/mcp-server/tool-contract.js';
import { TOOL_DOCS } from '../../packages/core/src/mcp-server/tool-docs.js';
import { cliData, runCliSync, tempDir } from '../helpers.js';
import { mockProvider } from '../ai/harness.js';

const FLOW = 'name: Smoke\ntests:\n  - id: ping\n    name: Ping\n    type: http\n    method: GET\n    url: "{{baseUrl}}/ping"\n    assertions:\n      - { type: status, expected: 200 }\n';

const t = tempDir('tp-ai-surfaces-');
afterAll(() => t.cleanup());

function workspace(name: string) {
  const store = WorkspaceStore.create(join(t.dir, name), name);
  store.saveProviders([mockProvider([{ match: '.', response: `\`\`\`yaml\n${FLOW}\`\`\`` }])]);
  return store;
}

const unwrap = (v: unknown) =>
  (isContractResult(v) ? ((v as unknown as { structured?: unknown; value?: unknown }).value ?? (v as unknown as { structured?: unknown }).structured) : v) as Record<string, unknown>;

describe('MCP: ai_* tools (propose, then a confirmed apply)', () => {
  it('runs a task to a proposal, applies it only with confirm, and records the call as mcp', async () => {
    const store = workspace('mcp');
    try {
      const settings = { ...defaultSettings(), assistantProvider: 'mock-ai', assistantModel: 'mock-model' };
      const tools = withToolContract(aiTools({ store, secrets: new MemorySecretStore(), settings }), { docs: TOOL_DOCS });
      const call = (name: string, args: Record<string, unknown>) => tools.find((x) => x.name === name)!.run(args);
      expect(tools.find((x) => x.name === 'ai_run_task')!.description).toMatch(/When to use|Use it when/);
      const listed = JSON.stringify(await call('ai_list_tasks', {}));
      expect(listed).toContain('design-flow');

      const dry = JSON.stringify(await call('ai_run_task', { task: 'design-flow', question: 'smoke test', dryRun: true }));
      expect(dry).toContain('"dryRun":true');
      expect(dry).toContain('"messages"');

      const askedFirst = JSON.stringify(await call('ai_run_task', { task: 'design-flow', question: 'smoke test', path: 'ai/smoke.yaml' }));
      expect(askedFirst).toContain('confirmationRequired');
      const ran = JSON.stringify(await call('ai_run_task', { task: 'design-flow', question: 'smoke test', path: 'ai/smoke.yaml', confirm: true }));
      const id = /"id":"(ai-[^"]+)"/.exec(ran)![1]!;
      expect(ran).toContain('ai_apply_proposal');

      // without confirm: nothing changes, the answer asks for it
      const asked = JSON.stringify(await call('ai_apply_proposal', { id }));
      expect(asked).toMatch(/confirm/);
      expect(() => store.readTestFile('ai/smoke.yaml')).toThrow();

      const applied = JSON.stringify(await call('ai_apply_proposal', { id, confirm: true }));
      expect(applied).toContain('ai/smoke.yaml');
      expect(store.readTestFile('ai/smoke.yaml')).toContain('id: ping');

      const usage = JSON.stringify(await call('ai_usage', {}));
      expect(usage).toContain('"surface":"mcp"');
      expect(usage).toContain('"outcome":"accepted"');
      void unwrap;
    } finally {
      store.close();
    }
  });
});

describe('CLI: testpion ai', () => {
  it('tasks, run --dry-run, run (a proposal), apply, undo and usage, all with the --json envelope', () => {
    const store = workspace('cli');
    const ws = store.root;
    store.close();
    const env = { TESTPION_AI_PROVIDER: 'mock-ai', TESTPION_AI_MODEL: 'mock-model', CI: '' };
    const tasks = cliData(runCliSync(['ai', 'tasks', '--json'], { env }).out);
    expect(tasks.tasks.some((x: { id: string }) => x.id === 'generate-assertions')).toBe(true);

    const dry = cliData(runCliSync(['ai', 'run', 'design-flow', '-q', 'smoke', '--dry-run', '--json', '-w', ws], { env }).out);
    expect(dry.dryRun).toBe(true);
    expect(dry.preview.messages.length).toBeGreaterThan(1);

    const run = runCliSync(['ai', 'run', 'design-flow', '-q', 'smoke', '--path', 'ai/smoke.yaml', '--json', '-w', ws], { env });
    const r = cliData(run.out);
    expect(r.proposal.items[0].verification[0]).toMatchObject({ verifier: 'test-file', status: 'pass' });

    const applied = cliData(runCliSync(['ai', 'apply', r.proposal.id, '--json', '-w', ws], { env }).out);
    expect(applied.applied[0].path).toBe('ai/smoke.yaml');
    const undone = cliData(runCliSync(['ai', 'undo', r.proposal.id, '--json', '-w', ws], { env }).out);
    expect(undone.restored).toBe(1);

    const usage = cliData(runCliSync(['ai', 'usage', '--json', '-w', ws], { env }).out);
    expect(usage.today.calls).toBe(1);
    expect(usage.byTask[0].task).toBe('design-flow');

    // no model at all: the envelope says how to set one up
    const off = runCliSync(['ai', 'run', 'explain-error', '-q', 'x', '--json', '-w', ws], { env: { TESTPION_AI_PROVIDER: '', CI: '' } });
    expect(off.status).toBe(2);
    expect(JSON.parse(off.out).errors[0]).toMatchObject({ code: 'ConfigurationError' });
  }, 120_000);

  it('for people: a dry-run apply says what it would do (no ✓, no undo), usage counts "1 call", the flow path is printed once', () => {
    const store = workspace('cli-text');
    const ws = store.root;
    store.close();
    const env = { TESTPION_AI_PROVIDER: 'mock-ai', TESTPION_AI_MODEL: 'mock-model', CI: '' };
    const id = cliData(runCliSync(['ai', 'run', 'design-flow', '-q', 'smoke', '--path', 'ai/smoke.yaml', '--json', '-w', ws], { env }).out).proposal.id;
    const shown = runCliSync(['ai', 'proposals', '--id', id, '-w', ws], { env }).out;
    expect(shown.match(/ai\/smoke\.yaml/g)).toHaveLength(1);
    const dry = runCliSync(['ai', 'apply', id, '--dry-run', '-w', ws], { env });
    expect(dry.status, dry.err).toBe(0);
    expect(dry.out).toMatch(/would apply i1/);
    expect(dry.out).not.toMatch(/✓|undo/);
    expect(dry.out).toMatch(/Dry run: nothing was changed/);
    const usage = runCliSync(['ai', 'usage', '-w', ws], { env }).out;
    expect(usage).toMatch(/\b1 call\b/);
    expect(usage).not.toMatch(/\b1 calls\b/);
  }, 120_000);

  it('an answer still invalid after the repairs is said so, with exit code 1 (the envelope: failed)', () => {
    const store = WorkspaceStore.create(join(t.dir, 'invalid'), 'invalid');
    store.saveProviders([mockProvider([{ match: '.', response: '```yaml\ntests: [unclosed\n```' }])]);
    const ws = store.root;
    store.close();
    const env = { TESTPION_AI_PROVIDER: 'mock-ai', TESTPION_AI_MODEL: 'mock-model', CI: '' };
    const human = runCliSync(['ai', 'run', 'design-flow', '-q', 'smoke', '-w', ws], { env });
    expect(human.status).toBe(1);
    expect(human.out).toMatch(/Still (invalid|wrong) after/);
    const json = runCliSync(['ai', 'run', 'design-flow', '-q', 'smoke', '--json', '-w', ws], { env });
    expect(json.status).toBe(1);
    const env2 = JSON.parse(json.out);
    expect(env2.status).toBe('failed');
    expect(env2.data.problems.length).toBeGreaterThan(0);
  }, 120_000);

  it('Local only refuses a keyless cloud provider for leaving the computer, before the missing key is mentioned', () => {
    const store = WorkspaceStore.create(join(t.dir, 'local-only'), 'local-only');
    // a cloud provider whose key reference has no value here (never a real key)
    store.saveProviders([{ id: 'cloud', name: 'Cloud', kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1', apiKey: '{{$env.TP_TEST_NO_SUCH_KEY}}', defaultModel: 'm' }]);
    const ws = store.root;
    store.close();
    const env = { TESTPION_AI_PROVIDER: 'cloud', TESTPION_AI_MODEL: 'm', TP_TEST_NO_SUCH_KEY: '', CI: '' };
    const local = runCliSync(['ai', 'run', 'explain-error', '-q', 'x', '--json', '-w', ws], { env: { ...env, TESTPION_AI_LOCAL_ONLY: '1' } });
    expect(local.status).toBe(2);
    expect(JSON.parse(local.out).errors[0].message).toMatch(/Local only is on/);
    const keyless = runCliSync(['ai', 'run', 'explain-error', '-q', 'x', '--json', '-w', ws], { env: { ...env, TESTPION_AI_LOCAL_ONLY: '0' } });
    expect(keyless.status).toBe(2);
    expect(JSON.parse(keyless.out).errors[0].message).toMatch(/No API key for Cloud/);
  }, 120_000);
});
