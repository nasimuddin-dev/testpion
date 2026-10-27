import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceSearch, WorkspaceStore } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';

// Quick Open and the search cover every kind of item a person names: Monitors, Environments, Datasets and Evaluations included,
// each found by its name and opened by a reference the window can follow.
const t = tempDir('tp-search-scope-');
afterAll(() => t.cleanup());

describe('the workspace search finds each named kind of item', () => {
  it('a monitor, an environment (and its variables), a dataset, an evaluation, a load test and a prompt', () => {
    const store = WorkspaceStore.create(join(t.dir, 'ws'), 'Scope');
    store.saveEnvironment({ id: 'staging-env', name: 'Zebra staging', variables: [{ key: 'zebraToken', value: 'x', enabled: true }] } as never);
    mkdirSync(store.path('datasets'), { recursive: true });
    writeFileSync(store.path('datasets', 'zebra-users.csv'), 'id,name\n1,a\n');
    const lib = (kind: string, name: string, data: Record<string, unknown>) => store.saveLibrary(kind, { folders: [], items: [{ id: `${kind}-1`, name, data }] as never });
    lib('monitors', 'Zebra health monitor', { everyMinutes: 5 });
    lib('evaluations', 'Zebra answer quality', { prompt: 'x' });
    lib('load-tests', 'Zebra load test', { url: 'http://x' });
    lib('ai-prompts', 'Zebra prompt', { prompt: 'hello' });
    const hits = new WorkspaceSearch(store).search('zebra', 50);
    const by = (kind: string) => hits.filter((h) => h.kind === kind);
    expect(by('environment').map((h) => h.title)).toEqual(['Zebra staging']);
    expect(by('environment-variable').map((h) => h.title)).toEqual(['zebraToken']);
    expect(by('dataset').map((h) => h.title)).toEqual(['zebra-users.csv']);
    const saved = by('saved').map((h) => `${(h.ref as { library?: string }).library}: ${h.title}`);
    expect(saved).toEqual(expect.arrayContaining(['monitors: Zebra health monitor', 'evaluations: Zebra answer quality', 'load-tests: Zebra load test', 'ai-prompts: Zebra prompt']));
    expect(hits.every((h) => !!h.ref)).toBe(true);
    store.close();
  });
});
