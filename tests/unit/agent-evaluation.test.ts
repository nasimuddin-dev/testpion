import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentCaseChecks, parseToolList } from '@testpion/shared';
import { WorkspaceStore, MemorySecretStore, createEngineContext, ensureDemoModel, evaluationTests, runTests, tryEvalCheck, type SavedEvaluation, type RunEvent } from '../../packages/core/src/index.js';

describe('the tools a case lists (AU-19)', () => {
  it('reads names, arguments, lists and objects', () => {
    expect(parseToolList('')).toEqual([]);
    expect(parseToolList('search_docs')).toEqual([{ tool: 'search_docs' }]);
    expect(parseToolList('search_docs(q=hours, limit=3), open_page; close')).toEqual([{ tool: 'search_docs', arguments: { q: 'hours', limit: 3 } }, { tool: 'open_page' }, { tool: 'close' }]);
    expect(parseToolList('a(x="1,2", y=[1,2])')).toEqual([{ tool: 'a', arguments: { x: '1,2', y: [1, 2] } }]);
    expect(parseToolList(['a', { tool: 'b', arguments: { k: 1 } }])).toEqual([{ tool: 'a' }, { tool: 'b', arguments: { k: 1 } }]);
  });

  it('makes one check per tool to call and one for all tools never to call', () => {
    expect(agentCaseChecks({ input: 'x' })).toEqual([]);
    expect(agentCaseChecks({ should_call: 'a(q=1), b', should_not_call: 'del, drop' })).toEqual([
      { type: 'tool-called', tool: 'a', arguments: { q: 1 } },
      { type: 'tool-called', tool: 'b' },
      { type: 'tool-not-called', tool: ['del', 'drop'] },
    ]);
  });
});

const dir = mkdtempSync(join(tmpdir(), 'tp-agent-eval-'));
const store = WorkspaceStore.create(join(dir, 'ws'), 'Agent');
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const draft = (): SavedEvaluation => ({
  name: 'Agent checks',
  type: 'agent',
  provider: ensureDemoModel(store).provider.id,
  model: 'demo',
  system: '',
  prompt: '{{input}}',
  format: 'text',
  datasetFormat: 'jsonl',
  dataset: [
    { input: 'Please use search_docs for the opening hours', should_call: 'search_docs', should_not_call: 'delete_record' },
    { input: 'Please use delete_record now', should_call: 'search_docs', should_not_call: 'delete_record' },
    { input: 'Just answer', should_call: '', should_not_call: '' },
  ]
    .map((r) => JSON.stringify(r))
    .join('\n'),
  expectedField: 'expected',
  evaluators: [{ type: 'max-tool-calls', max: 3 }],
  concurrency: 1,
  retries: 0,
  tools: [
    { name: 'search_docs', description: 'Search the help pages', result: { hits: 2 } },
    { name: 'delete_record', description: 'Delete a record', result: { deleted: true } },
  ],
});

describe('an agent evaluation (AU-19)', () => {
  it('runs each case as an agent test with the mock tools and checks the tools of that case', async () => {
    const d = draft();
    const c = createEngineContext({ store, secrets: new MemorySecretStore(), settings: { pricing: [] } as never });
    try {
      const status: string[] = [];
      await runTests({ name: 'Agent checks', tests: evaluationTests(d, { store }), services: c.services, concurrency: 1, onEvent: (e: RunEvent) => void (e.type === 'test-end' && status.push(e.result.status + (e.result.error ? ' ' + e.result.error.message : ''))) });
      // case 1 calls search_docs and never delete_record; case 2 calls delete_record (the mock calls the tool the task names), so both its checks fail
      expect(status).toEqual(['passed', 'failed', 'passed']);
    } finally {
      await c.dispose();
    }
  });

  it('tries a check on a case and also reports the case\'s own tool checks', async () => {
    const c = createEngineContext({ store, secrets: new MemorySecretStore(), settings: { pricing: [] } as never });
    try {
      const r = await tryEvalCheck({ draft: draft(), check: { type: 'no-error' }, caseNumber: 2 }, { services: c.services, store });
      expect(r.passed).toBe(true);
      expect(r.caseChecks?.map((k) => [k.type, k.passed])).toEqual([
        ['tool-called', false],
        ['tool-not-called', false],
      ]);
    } finally {
      await c.dispose();
    }
  });
});
