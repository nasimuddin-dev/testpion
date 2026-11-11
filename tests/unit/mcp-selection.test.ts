/**
 * Tool selection across models (N-2): each model is offered the tool list and asked every case; only its choice is read.
 * The offline mock plays two models: one that chooses right, one that confuses two tools.
 */
import { describe, expect, it } from 'vitest';
import { ProviderRegistry, Redactor, VariableScope, parseSelectionCases, runToolSelection, selectionCasesText, vetSelectionCases, type MockRule, type ProviderConfig, type SelectionCase, type ToolDefinition } from '../../packages/core/src/index.js';

const TOOLS: ToolDefinition[] = [
  { name: 'search_orders', description: 'Find orders by customer or status.', inputSchema: { type: 'object', properties: { customer: { type: 'string' } } } },
  { name: 'get_order', description: 'One order by its id, with its lines.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'refund_order', description: 'Pay an order back.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
];
const CASES: SelectionCase[] = [
  { ask: 'What did Ann buy last month?', tool: 'search_orders' },
  { ask: 'Show me what is in number 7731', tool: 'get_order' },
  { ask: 'Give the money back for 7731', tool: 'refund_order' },
  { ask: 'Send the money back for 8802 please', tool: 'refund_order' },
  { ask: 'What is the weather in Paris?', tool: 'none' },
];
const mock = (id: string, rules: MockRule[]): ProviderConfig => ({ id, name: id, kind: 'mock', baseUrl: 'mock://local', defaultModel: 'mock-model', headers: [{ key: 'x-mock-rules', value: JSON.stringify(rules) }] });
const call = (match: string, name: string): MockRule => ({ match, toolCall: { name } });
const GOOD: MockRule[] = [call('Ann buy', 'search_orders'), call('number 7731', 'get_order'), call('money back', 'refund_order'), { match: 'weather', response: 'I cannot look up the weather.' }];
// this one takes a refund for a lookup, twice, and calls a tool for the weather
const CONFUSED: MockRule[] = [call('Ann buy', 'search_orders'), call('number 7731', 'get_order'), call('money back', 'get_order'), call('weather', 'search_orders')];
const registry = () => new ProviderRegistry([mock('good', GOOD), mock('confused', CONFUSED)], new VariableScope(), new Redactor());

describe('which tool does each model choose', () => {
  it('reports the share each model chose right, its misses, the pairs it confuses and what every model missed', async () => {
    const r = await runToolSelection(registry(), { tools: TOOLS, cases: CASES, models: ['good/mock-model', 'confused'], cost: () => 0.01 });
    expect(r.models.map((m) => [m.model, m.correct, m.accuracy, m.errors])).toEqual([
      ['good/mock-model', 5, 1, 0],
      ['confused', 2, 0.4, 0],
    ]);
    expect(r.models[1]!.misses).toEqual([
      { ask: 'Give the money back for 7731', expected: 'refund_order', picked: 'get_order' },
      { ask: 'Send the money back for 8802 please', expected: 'refund_order', picked: 'get_order' },
      { ask: 'What is the weather in Paris?', expected: 'none', picked: 'search_orders' },
    ]);
    expect(r.models[1]!.confusions).toEqual([{ expected: 'refund_order', picked: 'get_order', count: 2 }]);
    expect(r.models[0]!.costUsd).toBe(0.01);
    expect(r.missedByAll).toEqual([]);
    expect(r.text).toBe('5 requests over 3 tools: good/mock-model chose right 100%, confused chose right 40%.');
    const both = await runToolSelection(registry(), { tools: TOOLS, cases: CASES, models: ['confused', 'confused/mock-model'] });
    expect(both.missedByAll.map((m) => m.expected)).toEqual(['refund_order', 'refund_order', 'none']);
    expect(both.text).toContain('3 requests were missed by every model');
  });

  it('a model that cannot be asked is not counted as wrong; cases for a tool the server does not have are refused', async () => {
    const reg = registry();
    const get = reg.get.bind(reg);
    reg.get = (ref: string) => (ref === 'good' ? { config: get(ref).config, chat: async () => Promise.reject(new Error('401 no key')) } : get(ref));
    const r = await runToolSelection(reg, { tools: TOOLS, cases: CASES, models: ['good'] });
    expect(r.models[0]).toMatchObject({ errors: 5, correct: 0, accuracy: 0, firstError: '401 no key', misses: [] });
    await expect(runToolSelection(registry(), { tools: TOOLS, cases: [{ ask: 'x', tool: 'drop_table' }], models: ['good'] })).rejects.toThrow(/does not list: drop_table/);
    await expect(runToolSelection(registry(), { tools: TOOLS, cases: CASES, models: [] })).rejects.toThrow(/at least one model/);
    await expect(runToolSelection(registry(), { tools: [], cases: CASES, models: ['good'] })).rejects.toThrow(/no tools/);
  });

  it('reads cases as JSON lines or an array, and drops written cases that test nothing', () => {
    expect(parseSelectionCases('{"ask": "a", "tool": "t"}\n\n{"question": "b", "expected_tool": "none"}\n{"ask": ""}')).toEqual([
      { ask: 'a', tool: 't' },
      { ask: 'b', tool: 'none' },
    ]);
    expect(parseSelectionCases('[{"input": "c", "expected": "t"}]')).toEqual([{ ask: 'c', tool: 't' }]);
    expect(() => parseSelectionCases('not json')).toThrow(/JSON lines/);
    expect(parseSelectionCases(selectionCasesText(CASES))).toEqual(CASES);
    const v = vetSelectionCases(
      [
        { ask: 'What did Ann buy?', tool: 'search_orders' },
        { ask: 'what did ann buy', tool: 'search_orders' },
        { ask: 'Please call get_order for 7', tool: 'get_order' },
        { ask: 'I want to refund order 7', tool: 'refund_order' },
        { ask: 'Delete everything', tool: 'drop_table' },
        { ask: 'Tell me a joke', tool: 'none' },
      ],
      TOOLS,
    );
    expect(v.cases).toEqual([
      { ask: 'What did Ann buy?', tool: 'search_orders' },
      { ask: 'Tell me a joke', tool: 'none' },
    ]);
    expect(v.dropped.map((d) => d.why)).toEqual(['the same request twice', 'the request names the tool, so it tests nothing', 'the request names the tool, so it tests nothing', 'the server has no such tool']);
    expect(v.uncovered).toEqual(['get_order', 'refund_order']);
  });
});

// the same run for a server saved in a workspace (the app, the CLI and the MCP tool share it)
describe('tool selection for a server of a workspace', () => {
  it('reads the cases of datasets/mcp-selection-<server>.jsonl and says so when there are none', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { selectionCasesFile, selectionCasesInfo, selectServerTools } = await import('@testpion/core');
    const root = mkdtempSync(join(tmpdir(), 'tp-sel-'));
    try {
      const server = { id: 'srv-1', name: 'Orders API' };
      const file = selectionCasesFile(server);
      expect(file).toMatch(/^datasets\/mcp-selection-[a-z0-9-]+\.jsonl$/);
      expect(selectionCasesInfo(root, server)).toEqual({ file, exists: false, cases: 0 });
      const ctx = { services: { providers: registry(), pricing: [] } } as never;
      await expect(selectServerTools({ root, server, offered: { tools: TOOLS }, ctx, models: ['good'] })).rejects.toThrow(/No cases at datasets\/mcp-selection-/);
      mkdirSync(join(root, 'datasets'), { recursive: true });
      writeFileSync(join(root, file), selectionCasesText(CASES));
      expect(selectionCasesInfo(root, server)).toEqual({ file, exists: true, cases: 5 });
      const calls: Array<Record<string, unknown>> = [];
      const store = { meta: { addAiCall: (c: Record<string, unknown>) => calls.push(c) } } as never;
      const r = await selectServerTools({ root, server, offered: { tools: TOOLS }, ctx, models: ['good', 'confused/mock-model'], store, surface: 'app' });
      expect(r).toMatchObject({ server: 'Orders API', casesFile: file, cases: 5, tools: 3 });
      expect(r.models.map((m) => m.accuracy)).toEqual([1, 0.4]);
      // one line a model in the usage ledger
      expect(calls.map((c) => [c.task, c.surface, c.provider, c.model, c.calls, c.outcome])).toEqual([
        ['mcp-selection', 'app', 'good', '', 5, 'ok'],
        ['mcp-selection', 'app', 'confused', 'mock-model', 5, 'ok'],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
