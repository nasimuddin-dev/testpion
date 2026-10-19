/**
 * AI-12 for the terminal and agents: `testpion search --ask` / `--query-json` (--json envelope, --in, --no-ai, --dry-run,
 * exit codes) and the MCP tool `search_ask` — with the mock model, over a fixture workspace. The plain
 * `testpion search <words>` is unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultSettings, MemorySecretStore, WorkspaceStore } from '../../packages/core/src/index.js';
import { withToolContract } from '../../packages/core/src/mcp-server/tool-contract.js';
import { TOOL_DOCS } from '../../packages/core/src/mcp-server/tool-docs.js';
import { searchAskTools } from '../../packages/core/src/mcp-server/tools/search-ask-tools.js';
import { mockProvider } from '../ai/harness.js';
import { seedSearchData } from '../ai/search-fixtures.js';
import { cliData, runCli, runCliSync, tempDir } from '../helpers.js';

// reached through a link, as every temp folder is on macOS
const t = tempDir('tp-search-ask-', { alias: true });
let ws = '';
let store: WorkspaceStore;

const SPEC = JSON.stringify({ query: { sources: ['history'], where: [{ field: 'status', op: 'gte', value: 500 }] }, assumptions: ['server errors = 5xx'] });
const env = { TESTPION_AI_PROVIDER: 'mock-ai', TESTPION_AI_MODEL: 'mock-model', CI: '' };

beforeAll(async () => {
  store = WorkspaceStore.create(`${t.dir}/ws`, 'search');
  store.saveProviders([mockProvider([{ match: 'server errors', response: SPEC }])]);
  await seedSearchData(store);
  ws = store.root;
  store.close();
});
afterAll(() => t.cleanup());

describe('CLI: testpion search --ask / --query-json', () => {
  it('--ask --json: the question translated, how it was understood, the hits with refs', async () => {
    const r = await runCli(['search', '--ask', 'server errors', '--json', '-w', ws], { env });
    expect(r.status).toBe(0);
    const a = cliData(r.out);
    expect(a).toMatchObject({ question: 'server errors', mode: 'ai', model: 'Mock AI/mock-model', assumptions: ['server errors = 5xx'] });
    expect(a.explain).toBe('Looking in History where status at least 500; newest first, at most 25.');
    expect(a.chips).toEqual([expect.objectContaining({ field: 'status', op: 'gte', value: 500, text: 'status at least 500' })]);
    expect(a.outcome.rows.map((x: { id: string }) => x.id)).toEqual(['h1']);
    expect(a.outcome.rows[0].ref).toMatchObject({ kind: 'history' });
    expect(a.usage.totalTokens).toBeGreaterThan(0);
  }, 120_000);

  it('human output says how it was understood, then the hits', async () => {
    const r = await runCli(['search', '--ask', 'server errors', '-w', ws], { env });
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/Understood as: Looking in History where status at least 500/);
    expect(r.out).toMatch(/assumed: server errors = 5xx/);
    expect(r.out).toMatch(/Charge card/);
    expect(r.out).toMatch(/1 of 1 match/);
  }, 120_000);

  it('--no-ai and no model: the words as typed, with the reason; exit 0', async () => {
    const off = cliData((await runCli(['search', '--ask', 'payments charge', '--no-ai', '--json', '-w', ws], { env })).out);
    expect(off).toMatchObject({ mode: 'text', fallback: expect.stringMatching(/no AI, as asked/) });
    expect(off.outcome.rows.map((x: { id: string }) => x.id)).toEqual(['h1', 'h2']);
    const none = await runCli(['search', '--ask', 'payments charge', '--json', '-w', ws], { env: { ...env, TESTPION_AI_PROVIDER: '', TESTPION_AI_MODEL: '' } });
    expect(none.status).toBe(0);
    expect(cliData(none.out)).toMatchObject({ mode: 'text', fallback: expect.stringMatching(/Searched for the words as typed instead/) });
  }, 120_000);

  it('--dry-run sends nothing and prints what would be sent', async () => {
    const r = await runCli(['search', '--ask', 'server errors', '--dry-run', '-w', ws], { env });
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/What will be sent/);
    expect(r.out).toMatch(/Question: server errors/);
    expect(r.out).not.toMatch(/Charge card/);
  }, 120_000);

  it('--query-json: a query run with no model; --in limits the sources', async () => {
    const spec = JSON.stringify({ where: [{ field: 'failed', op: 'eq', value: true }], limit: 10 });
    const r = cliData((await runCli(['search', '--query-json', spec, '--in', 'runs', '--json', '-w', ws], { env: { ...env, TESTPION_AI_PROVIDER: '' } })).out);
    expect(r).toMatchObject({ mode: 'query' });
    expect(r.query.sources).toEqual(['runs']);
    expect(r.outcome.rows.map((x: { id: string }) => x.id)).toEqual(['run-b', 'run-a']);
    expect(r.usage).toBeUndefined();
  }, 120_000);

  it('--query-json: an invalid query exits 2 and says what is allowed; a bad --in too', () => {
    const bad = runCliSync(['search', '--query-json', '{"where":[{"field":"password","op":"eq","value":"x"}]}', '-w', ws], { env });
    expect(bad.status).toBe(2);
    expect(bad.err + bad.out).toMatch(/unknown field "password" \(allowed: text, time/);
    const badIn = runCliSync(['search', '--ask', 'x', '--in', 'users', '-w', ws], { env });
    expect(badIn.status).toBe(2);
    expect(badIn.err + badIn.out).toMatch(/Unknown source "users"/);
    const both = runCliSync(['search', '--ask', 'x', '--query-json', '{}', '-w', ws], { env });
    expect(both.status).toBe(2);
    const enveloped = JSON.parse(runCliSync(['search', '--query-json', '{"limit":9999}', '--json', '-w', ws], { env }).out);
    expect(enveloped.status).not.toBe('ok');
  }, 120_000);

  it('the plain `testpion search <words>` is the workspace search as before', () => {
    const r = runCliSync(['search', 'charge', '--json', '-w', ws], { env });
    expect(r.status).toBe(0);
    expect(cliData(r.out).some((h: { kind: string }) => h.kind === 'history')).toBe(true);
    expect(runCliSync(['search', '-w', ws], { env }).status).toBe(2);
  }, 120_000);
});

describe('MCP: search_ask', () => {
  const tools = () => {
    store = WorkspaceStore.open(ws);
    const settings = { ...defaultSettings(), assistantProvider: 'mock-ai', assistantModel: 'mock-model' };
    return withToolContract(searchAskTools({ store, secrets: new MemorySecretStore(), settings }), { docs: TOOL_DOCS });
  };
  const call = async (args: Record<string, unknown>) =>
    (
      (await tools()
        .find((x) => x.name === 'search_ask')!
        .run(args)) as { value: Record<string, any> }
    ).value;

  it('is read-only, documented, and answers a question and a direct query', async () => {
    const tool = tools().find((x) => x.name === 'search_ask')!;
    expect(tool.write).toBeFalsy();
    expect(tool.description).toMatch(/Use it /);
    const a = await call({ question: 'server errors' });
    expect(a).toMatchObject({ mode: 'ai', explain: expect.stringContaining('status at least 500') });
    expect(a.outcome.rows[0]).toMatchObject({ id: 'h1', ref: { kind: 'history', historyId: 'h1' } });
    const q = await call({ query: { where: [{ field: 'flaky', op: 'eq', value: true }] } });
    expect(q.outcome.rows.map((x: { id: string }) => x.id)).toEqual(['run-b:checkout', 'run-a:checkout']);
    expect((await call({ question: 'payments', noAi: true })).mode).toBe('text');
    expect((await call({ question: 'server errors', dryRun: true })).dryRun).toBe(true);
    store.close();
  }, 60_000);

  it('refuses an invalid query with the problems, an unknown source, and a call with neither question nor query', async () => {
    await expect(call({ query: { where: [{ field: 'nope', op: 'eq', value: 1 }] } })).rejects.toThrow(/unknown field "nope"/);
    await expect(call({ question: 'x', sources: ['users'] })).rejects.toThrow(/Unknown source "users"/);
    await expect(call({})).rejects.toThrow(/Pass `question`/);
    await expect(call({ question: 'x', query: {} })).rejects.toThrow(/not both/);
    store.close();
  }, 60_000);
});
