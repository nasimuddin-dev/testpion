import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { WorkspaceStore, EVALUATIONS_LIBRARY, type SavedEvaluation } from '../../packages/core/src/index.js';
import { cliData, runCli, tempDir } from '../helpers.js';

/**
 * A-2: the golden trajectory. An agent evaluation is run, a run is marked as its baseline, the agent then uses other tools, and the
 * report card, `eval trajectory` and `eval baseline` say how the tools differ.
 */
const tmp = tempDir('tp-agent-base-');
let ws: string;
let env: NodeJS.ProcessEnv;
const NAME = 'Task agent';

const rules = (first: string) => JSON.stringify([{ match: 'remind me', toolCall: { name: first, arguments: first === 'add_task' ? { title: 'Buy milk' } : {} } }, { match: 'what tasks', toolCall: { name: 'list_tasks', arguments: {} } }]);

const setRules = (first: string) => {
  const store = WorkspaceStore.open(ws);
  try {
    store.saveProviders(store.getProviders().map((p) => (p.id === 'agent-demo' ? { ...p, headers: [{ key: 'x-mock-rules', value: rules(first) }] } : p)));
  } finally {
    store.close();
  }
};

beforeAll(() => {
  ws = join(tmp.dir, 'ws');
  WorkspaceStore.create(ws, 'Base').close();
  env = { ...process.env, TESTPION_HOME: join(tmp.dir, 'home') };
  const store = WorkspaceStore.open(ws);
  try {
    store.saveProviders([...store.getProviders(), { id: 'agent-demo', name: 'Agent demo', kind: 'mock', baseUrl: 'mock://', defaultModel: 'demo', headers: [{ key: 'x-mock-rules', value: rules('add_task') }] }]);
    const data: SavedEvaluation = {
      name: NAME,
      type: 'agent',
      provider: 'agent-demo',
      model: 'demo',
      prompt: '{{input}}',
      format: 'text',
      datasetFormat: 'jsonl',
      dataset: ['{"id":"remind","input":"Please remind me to buy milk"}', '{"id":"list","input":"What tasks do I have?"}'].join('\n'),
      expectedField: 'expected',
      evaluators: [],
      concurrency: 1,
      retries: 0,
      tools: [
        { name: 'add_task', description: 'Add a task', inputSchema: { type: 'object', properties: { title: { type: 'string' } } }, result: { id: 'task-1' } },
        { name: 'list_tasks', description: 'List tasks', inputSchema: { type: 'object', properties: {} }, result: { tasks: [] } },
        { name: 'delete_task', description: 'Delete a task', inputSchema: { type: 'object', properties: {} }, result: { ok: true } },
      ],
      maxSteps: 3,
    };
    store.saveLibrary(EVALUATIONS_LIBRARY, { folders: [], items: [{ id: 'ev-agent', name: NAME, data }] });
  } finally {
    store.close();
  }
}, 60_000);
afterAll(() => tmp.cleanup());

const cli = (args: string[]) => runCli(args, { env });

describe('the golden trajectory of an agent evaluation', () => {
  it('has no baseline at first; marking the run sets it, and the report says the run is the baseline', async () => {
    expect((await cli(['eval', 'run', NAME, '-w', ws, '-q', '-r', 'console'])).status).toBe(0);
    const before = cliData((await cli(['eval', 'summary', 'last', '-w', ws, '--json'])).out);
    expect(before.agentCases).toBe(2);
    expect(before.agentBaseline).toBeUndefined();
    // the tools the cases called, and the offered ones no case called
    expect(before.toolUse.used).toEqual([{ name: 'add_task', calls: 1, cases: 1 }, { name: 'list_tasks', calls: 1, cases: 1 }]);
    expect(before.toolUse.neverCalled).toEqual(['delete_task']);
    expect(before.toolUse.text).toBe('Tools called: add_task in 1 case, list_tasks in 1 case. Never called: delete_task.');
    expect(before.text).toContain('Never called: delete_task.');
    const set = cliData((await cli(['eval', 'baseline', 'last', '-w', ws, '--json'])).out);
    expect(set).toMatchObject({ evaluation: NAME });
    expect(set.baselineRun).toMatch(/^run-/);
    const after = cliData((await cli(['eval', 'summary', 'last', '-w', ws, '--json'])).out);
    expect(after.baselineRun).toBe(set.baselineRun);
    // the baseline run against itself says nothing
    expect(after.agentBaseline).toBeUndefined();
  }, 120_000);

  it('a run whose agent uses the same tools is the same as the baseline', async () => {
    expect((await cli(['eval', 'run', NAME, '-w', ws, '-q', '-r', 'console'])).status).toBe(0);
    const d = cliData((await cli(['eval', 'summary', 'last', '-w', ws, '--json'])).out);
    expect(d.agentBaseline).toMatchObject({ same: 2, changed: 0, cases: [], text: 'Tools against the baseline: all 2 cases the same.' });
    expect(d.text).toContain('Tools against the baseline: all 2 cases the same.');
    const t = cliData((await cli(['eval', 'trajectory', 'last', 'remind', '-w', ws, '--json'])).out);
    expect(t.vsBaseline).toMatchObject({ kind: 'same', baseline: ['add_task'], now: ['add_task'] });
  }, 120_000);

  it('a run whose agent calls another tool says which case changed and how', async () => {
    setRules('delete_task');
    expect((await cli(['eval', 'run', NAME, '-w', ws, '-q', '-r', 'console'])).status).toBe(0);
    const d = cliData((await cli(['eval', 'summary', 'last', '-w', ws, '--json'])).out);
    expect(d.agentBaseline).toMatchObject({ same: 1, changed: 1 });
    expect(d.agentBaseline.cases).toHaveLength(1);
    expect(d.agentBaseline.cases[0]).toMatchObject({ key: 'remind', kind: 'tools-changed' });
    expect(d.agentBaseline.cases[0].text).toBe('Dropped add_task; added delete_task. Baseline: add_task. Now: delete_task.');
    const words = (await cli(['eval', 'trajectory', 'last', 'remind', '-w', ws])).out;
    expect(words).toContain('Against the baseline');
    expect(words).toContain('Dropped add_task; added delete_task');
    // another run to compare with, by choice
    const list = cliData((await cli(['eval', 'trajectory', 'last', 'list', '-w', ws, '--json'])).out);
    expect(list.vsBaseline.kind).toBe('same');
  }, 120_000);

  it('only an agent evaluation has a baseline, and it can be cleared', async () => {
    const clear = cliData((await cli(['eval', 'baseline', '--clear', '--evaluation', NAME, '-w', ws, '--json'])).out);
    expect(clear).toEqual({ evaluation: NAME });
    const d = cliData((await cli(['eval', 'summary', 'last', '-w', ws, '--json'])).out);
    expect(d.agentBaseline).toBeUndefined();
    expect(d.baselineRun).toBeUndefined();
    const bad = await cli(['eval', 'baseline', '--clear', '--evaluation', 'Nope', '-w', ws]);
    expect(bad.status).not.toBe(0);
  }, 120_000);
});
