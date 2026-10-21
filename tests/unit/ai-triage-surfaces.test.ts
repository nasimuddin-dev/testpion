/**
 * AI-2 / AI-5 for agents and CI: MCP `ai_triage_run`, `ai_analyze_flaky`, `ai_attempt_fix` (confirmed) and the CLI
 * `testpion ai triage` (--json, --no-ai, --apply), `testpion ai run analyze-flaky --item test:…` and
 * `testpion test … --triage` (a section after a failed run, triage.md, a "Triage (AI)" JUnit section, the exit code
 * unchanged) — with the mock provider and the --json envelope.
 */
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultSettings, MemorySecretStore, WorkspaceStore, type Collection } from '../../packages/core/src/index.js';
import { aiTools } from '../../packages/core/src/mcp-server/tools/ai-tools.js';
import { withToolContract } from '../../packages/core/src/mcp-server/tool-contract.js';
import { TOOL_DOCS } from '../../packages/core/src/mcp-server/tool-docs.js';
import { cliData, runCli, runCliSync, tempDir } from '../helpers.js';
import { mockProvider } from '../ai/harness.js';
import { addRun, httpResult } from '../ai/run-fixtures.js';

// the workspaces are reached through a link, as every temp folder is on macOS (/var → /private/var)
const t = tempDir('tp-ai-triage-surfaces-', { alias: true });
let server: Server;
let api = '';
beforeAll(async () => {
  server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  api = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  t.cleanup();
});

const STALE = JSON.stringify({
  summary: 'Health answers "ok" now.',
  causes: [
    {
      groups: ['g1'],
      kind: 'stale-test',
      title: 'Health answers "ok" now',
      explanation: 'It said "up" before.',
      confidence: 0.8,
      fix: { type: 'check', check: { type: 'equals', path: '$.status', expected: 'up' }, newCheck: { type: 'equals', path: '$.status', expected: 'ok' } },
    },
  ],
});
const FLAKY = JSON.stringify({ pattern: 'timing', title: 'Reads too early', explanation: 'x', confidence: 0.6, fix: { type: 'none', note: 'Wait for the job.' } });

const SVC = (url: string): Collection =>
  ({
    schemaVersion: '1.0',
    id: 'svc',
    name: 'Service',
    version: 1,
    variables: [],
    updatedAt: '2026-10-16T00:00:00Z',
    items: [{ kind: 'http', id: 'health', name: 'Health', request: { method: 'GET', url: `${url}/health` }, assertions: [{ type: 'equals', path: '$.status', expected: 'up' }] }],
  }) as unknown as Collection;

async function workspace(name: string) {
  const store = WorkspaceStore.create(join(t.dir, name), name);
  store.saveProviders([
    mockProvider([
      { match: 'pattern', response: FLAKY },
      { match: '"groups"', response: STALE },
    ]),
  ]);
  store.saveCollection(SVC('http://127.0.0.1:4010'));
  const ok = httpResult({
    id: 'health@1',
    name: 'Health',
    url: 'http://127.0.0.1:4010/health',
    status: 200,
    body: { status: 'up' },
    checks: [{ type: 'equals', name: 'equals $.status', passed: true }],
  });
  const bad = httpResult({
    id: 'health@1',
    name: 'Health',
    url: 'http://127.0.0.1:4010/health',
    status: 200,
    body: { status: 'ok' },
    checks: [{ type: 'equals', name: 'equals $.status', passed: false, message: 'expected "up", got "ok"' }],
  });
  const origin = { kind: 'collection' as const, collectionId: 'svc' };
  for (const [i, r] of [ok, bad, ok, bad].entries()) await addRun(store, { id: `run-${i}`, startedAt: `2026-10-1${i}T10:00:00.000Z`, origin, results: [r] });
  return store;
}

describe('MCP: ai_triage_run, ai_analyze_flaky, ai_attempt_fix', () => {
  it('proposes verified fixes (applied with ai_apply_proposal), the grouping without a model, and asks before attempting a fix', async () => {
    const store = await workspace('mcp');
    try {
      const settings = { ...defaultSettings(), assistantProvider: 'mock-ai', assistantModel: 'mock-model' };
      const tools = withToolContract(aiTools({ store, secrets: new MemorySecretStore(), settings }), { docs: TOOL_DOCS });
      // the contract wraps a result: its value is what the agent reads
      const call = async (name: string, args: Record<string, unknown>) => ((await tools.find((x) => x.name === name)!.run(args)) as { value: Record<string, any> }).value;
      for (const n of ['ai_triage_run', 'ai_analyze_flaky', 'ai_attempt_fix']) expect(tools.find((x) => x.name === n)!.description).toMatch(/Use it /);

      const r = await call('ai_triage_run', { run: 'last' });
      expect(r.ai).toBe(true);
      expect(r.findings[0]).toMatchObject({ kind: 'stale-test', count: 1 });
      expect(r.proposal.items[0]).toMatchObject({ kind: 'assertion', title: 'Health: equals $.status = "up" → equals $.status = "ok"' });
      expect(r.next).toMatch(/ai_apply_proposal/);
      await call('ai_apply_proposal', { id: r.proposal.id, confirm: true });
      expect((store.getCollection('svc').items[0] as { assertions: unknown[] }).assertions).toEqual([{ type: 'equals', path: '$.status', expected: 'ok' }]);

      const plain = await call('ai_triage_run', { run: 'run-1', noAi: true });
      expect(plain).toMatchObject({ ai: false, runId: 'run-1', failures: 1 });
      expect(plain.proposal).toBeUndefined();

      const flaky = await call('ai_analyze_flaky', { item: 'test-case:health' });
      expect(flaky.finding).toMatchObject({ kind: 'timing' });
      expect(flaky.signals).toMatchObject({ runs: 4, passed: 2, failed: 2 });
      const asked = JSON.stringify(await call('ai_attempt_fix', { id: flaky.proposal.id }));
      expect(asked).toMatch(/run the test 5 times/);
    } finally {
      store.close();
    }
  });
});

describe('CLI: testpion ai triage, ai run analyze-flaky, test --triage', () => {
  const env = { TESTPION_AI_PROVIDER: 'mock-ai', TESTPION_AI_MODEL: 'mock-model', CI: '' };

  it('--json, --no-ai, --apply, and the flaky analysis through the generic runner', async () => {
    const store = await workspace('cli');
    const ws = store.root;
    store.close();
    const plain = cliData(runCliSync(['ai', 'triage', '--run', 'last', '--no-ai', '--json', '-w', ws], { env }).out);
    expect(plain).toMatchObject({ ai: false, runId: 'run-3' });
    expect(plain.findings[0].kind).toBe('flaky');

    const r = cliData(runCliSync(['ai', 'triage', '--json', '-w', ws], { env }).out);
    expect(r.proposal.items[0].verification[0]).toMatchObject({ verifier: 'fix', status: 'warn' });

    const applied = cliData(runCliSync(['ai', 'triage', '--apply', '--json', '-w', ws], { env }).out);
    expect(applied.applied.applied).toHaveLength(1);
    expect(applied.rerun).toBe('testpion run-collection svc --rerun-failed run-3');

    const flaky = cliData(runCliSync(['ai', 'run', 'analyze-flaky', '--item', 'test-case:health', '--json', '-w', ws], { env }).out);
    expect(flaky.task).toBe('analyze-flaky');
    expect(flaky.proposal.findings[0].kind).toBe('timing');

    // no model set up, or --no-ai: TestPion's own finding (as the app and MCP give it), exit 0
    const noModel = { ...env, TESTPION_AI_PROVIDER: '', TESTPION_AI_MODEL: '' };
    const plainFlaky = runCliSync(['ai', 'run', 'analyze-flaky', '--item', 'test-case:health', '-w', ws], { env: noModel });
    expect(plainFlaky.status).toBe(0);
    expect(plainFlaky.out).toMatch(/Why is this flaky\? .* made without AI/);
    expect(plainFlaky.out).toMatch(/note: no model configured/);
    const asked = runCliSync(['ai', 'run', 'analyze-flaky', '--item', 'test-case:health', '--no-ai', '--json', '-w', ws], { env });
    expect(asked.status).toBe(0);
    expect(cliData(asked.out)).toMatchObject({ task: 'analyze-flaky', ai: false, testId: 'health', finding: { kind: expect.any(String) } });
  }, 180_000);

  it('test --triage: a failed run gets the section, triage.md and a JUnit "Triage" section; the exit code is the run\'s', async () => {
    const store = WorkspaceStore.create(join(t.dir, 'ci'), 'ci');
    store.saveProviders([mockProvider([{ match: '"groups"', response: STALE }])]);
    store.writeTestFile(
      'smoke/health.yaml',
      `name: Smoke\ntests:\n  - id: health\n    name: Health\n    url: ${api}/health\n    assertions:\n      - { type: equals, path: $.status, expected: up }\n`,
    );
    const ws = store.root;
    store.close();
    // -w names the workspace through the link; the current folder is its real path (what process.cwd() says on macOS),
    // so the run records the test file by its real path: triage still finds the file and proposes the edit
    const real = join(t.real, 'ci');
    const r = await runCli(['test', 'tests/smoke/health.yaml', '--triage', '-w', ws], { env, cwd: real });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/## Triage \(AI\)/);
    expect(r.out).toMatch(/Health answers "ok" now/);
    const s = WorkspaceStore.open(ws);
    const run = s.meta.listRuns({ limit: 1 }).items[0]!;
    const dir = s.runDir(run.id);
    s.close();
    expect(existsSync(join(dir, 'triage.md'))).toBe(true);
    expect(readFileSync(join(dir, 'junit.xml'), 'utf8')).toMatch(/<system-out><!\[CDATA\[## Triage \(AI\)/);
    expect(JSON.parse(readFileSync(join(dir, 'triage.json'), 'utf8')).proposal.items[0].kind).toBe('file');

    // no model: the grouping, never a failure of the command itself
    const off = await runCli(['test', 'tests/smoke/health.yaml', '--triage', '-w', ws], { env: { ...env, TESTPION_AI_PROVIDER: '', TESTPION_AI_MODEL: '' }, cwd: real });
    expect(off.status).toBe(1);
    expect(off.out).toMatch(/## Triage\n/);
    expect(off.out).toMatch(/grouped by TestPion \(no model\)/);
  }, 180_000);

  it('--triage outside a workspace says it records nothing (stderr and the envelope) and exits as the run did', async () => {
    const dir = join(t.dir, 'no-ws');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'health.postman.json');
    writeFileSync(
      file,
      JSON.stringify({
        info: { name: 'Health', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
        item: [{ name: 'Health', request: { method: 'GET', url: `${api}/health` }, event: [{ listen: 'test', script: { exec: ["pm.test('up', () => pm.expect(pm.response.json().status).to.equal('up'));"] } }] }],
      }),
    );
    const text = await runCli(['run-collection', file, '--triage', '-q'], { env, cwd: dir });
    expect(text.status).toBe(1);
    expect(text.err).toMatch(/warning: triage needs a workspace \(-w\); nothing recorded/);
    expect(text.out).not.toMatch(/## Triage/);
    // --jsonl: a line per result, then the envelope
    const json = await runCli(['run-collection', file, '--triage', '--jsonl'], { env, cwd: dir });
    expect(json.status).toBe(1);
    expect(JSON.parse(json.out.trim().split('\n').at(-1)!).warnings).toContain('triage needs a workspace (-w); nothing recorded');
  }, 120_000);
});
