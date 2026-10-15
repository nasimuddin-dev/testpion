import { afterAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceStore, workspaceAttention, type RunSummary } from '../../packages/core/src/index.js';
import { runCli, tempDir, cliData } from '../helpers.js';

// WF-03 Problems: one list (the app's panel, Home, what_needs_attention, testpion problems), grouped, with failures and
// errors told apart, and the workspace files that can't be read first.
const tmp = tempDir('tp-problems-');
afterAll(() => tmp.cleanup());

describe('problems', () => {
  it('files that cannot be read come first; a run says its failures and errors apart', async () => {
    const root = join(tmp.dir, 'ws');
    const store = WorkspaceStore.create(root, 'P');
    writeFileSync(store.path('environments', 'broken.json'), '{ not json');
    store.meta.addRun(
      { runId: 'run-1', name: 'Smoke', startedAt: new Date().toISOString(), durationMs: 1, total: 4, passed: 1, failed: 2, skipped: 0, errors: 1 } as RunSummary,
      store.runDir('run-1'),
    );
    const items = await workspaceAttention(store);
    expect(items[0]).toMatchObject({ kind: 'file', severity: 'high', group: 'Workspace files', type: 'error', ref: { kind: 'environment' } });
    const run = items.find((i) => i.kind === 'run')!;
    expect(run).toMatchObject({ group: 'Runs', type: 'failure', ref: { kind: 'run', runId: 'run-1' } });
    expect(run.message).toBe('The latest run "Smoke": 2 failed, 1 error (network, TLS, timeout or script)');
    expect(run.at).toBeTruthy();
    store.close();
    // the terminal: testpion problems (= attention) --json, exit 1 on a high one
    const r = await runCli(['problems', '-w', root, '--json'], { home: join(tmp.dir, 'home') });
    expect(r.status).toBe(1);
    expect(cliData(r.out).map((i: { group: string }) => i.group)).toEqual(['Workspace files', 'Runs']);
  }, 60_000);

  it('a run with only errors is an error', async () => {
    const store = WorkspaceStore.create(join(tmp.dir, 'ws2'), 'P2');
    store.meta.addRun({ runId: 'run-2', name: 'Down', startedAt: new Date().toISOString(), durationMs: 1, total: 1, passed: 0, failed: 0, skipped: 0, errors: 1 } as RunSummary, store.runDir('run-2'));
    expect((await workspaceAttention(store)).find((i) => i.kind === 'run')).toMatchObject({ type: 'error', message: 'The latest run "Down": 1 error (network, TLS, timeout or script)' });
    store.close();
  });
});
