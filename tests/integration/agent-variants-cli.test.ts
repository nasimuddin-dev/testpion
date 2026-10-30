import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { WorkspaceStore, EVALUATIONS_LIBRARY, type SavedEvaluation } from '../../packages/core/src/index.js';
import { cliData, runCli, tempDir } from '../helpers.js';

/** A-9: compare mode for agents: the variants' tool calls per case, and whether they used the first variant's tools. */
const tmp = tempDir('tp-agent-variants-');
let ws: string;
let env: NodeJS.ProcessEnv;
const NAME = 'Task agent';

const rules = (first: string, extra: unknown[] = []) => JSON.stringify([{ match: 'remind me', toolCall: { name: first, arguments: {} } }, { match: 'what tasks', toolCall: { name: 'list_tasks', arguments: {} } }, ...extra]);

beforeAll(() => {
  ws = join(tmp.dir, 'ws');
  WorkspaceStore.create(ws, 'Var').close();
  env = { ...process.env, TESTPION_HOME: join(tmp.dir, 'home') };
  const store = WorkspaceStore.open(ws);
  try {
    const mock = (id: string, first: string) => ({ id, name: id, kind: 'mock' as const, baseUrl: 'mock://', defaultModel: 'demo', headers: [{ key: 'x-mock-rules', value: rules(first) }] });
    store.saveProviders([...store.getProviders(), mock('agent-a', 'add_task'), mock('agent-b', 'delete_task')]);
    const tool = (name: string) => ({ name, description: name, inputSchema: { type: 'object', properties: {} }, result: { ok: true } });
    const data: SavedEvaluation = {
      name: NAME,
      type: 'agent',
      provider: 'agent-a',
      model: 'demo',
      prompt: '{{input}}',
      format: 'text',
      datasetFormat: 'jsonl',
      dataset: ['{"id":"remind","input":"Please remind me to buy milk"}', '{"id":"list","input":"What tasks do I have?"}'].join('\n'),
      expectedField: 'expected',
      evaluators: [],
      concurrency: 1,
      retries: 0,
      tools: [tool('add_task'), tool('list_tasks'), tool('delete_task')],
      maxSteps: 3,
      variants: [{ label: 'Deleter', provider: 'agent-b', model: 'demo' }],
    };
    store.saveLibrary(EVALUATIONS_LIBRARY, { folders: [], items: [{ id: 'ev-agent', name: NAME, data }] });
  } finally {
    store.close();
  }
}, 60_000);
afterAll(() => tmp.cleanup());

describe('compare mode for an agent evaluation', () => {
  it('runs both variants and says how many tool calls each made and whether they used the first one\'s tools', async () => {
    const run = await runCli(['eval', 'run', NAME, '--variants', '-w', ws, '-q', '--yes'], { env });
    expect(run.status).toBeLessThanOrEqual(1);
    const s = cliData((await runCli(['eval', 'variants', NAME, '-w', ws, '--json'], { env })).out);
    expect(s.ready).toBe(true);
    expect(s.columns.map((c: { label: string }) => c.label)).toEqual(['Current', 'Deleter']);
    expect(s.columns[0].agent).toEqual({ avgToolCalls: 1, avgModelCalls: 2, cases: 2 });
    expect(s.columns[1].agent).toMatchObject({ avgToolCalls: 1, cases: 2, sameToolsAsFirst: 1 });
    const rows = Object.fromEntries(s.rows.map((r: { metric: string }) => [r.metric, r]));
    expect(rows.tools.values).toEqual(['1', '1']);
    expect(rows['same-tools'].values).toEqual(['–', '1 of 2']);
    expect(s.conclusion).toContain('B used other tools in 1 of 2 cases.');
  }, 180_000);
});
