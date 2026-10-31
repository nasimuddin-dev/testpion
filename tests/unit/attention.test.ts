import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore, recordCertificate, saveMonitor, workspaceAttention, type RunSummary } from '../../packages/core/src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'tp-attention-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('what needs attention', () => {
  it('lists a failing monitor, an expiring certificate, a failed latest run and a failing request, most severe first', async () => {
    const store = WorkspaceStore.create(join(dir, 'ws'), 'Attention');
    store.saveCollection({
      schemaVersion: '1.0',
      id: 'api',
      name: 'API',
      version: 0,
      variables: [],
      updatedAt: '',
      items: [{ kind: 'http', id: 'r1', name: 'Login', request: { method: 'POST', url: 'https://api.example.com/login', headers: [], params: [] } }],
    } as never);
    saveMonitor(store, { id: 'm1', name: 'Health', collectionId: 'api', everyMinutes: 5, enabled: true });
    mkdirSync(store.path('runs', 'monitors'), { recursive: true });
    writeFileSync(
      store.path('runs', 'monitors', 'm1.jsonl'),
      JSON.stringify({ monitorId: 'm1', runId: 'run-m', startedAt: new Date().toISOString(), durationMs: 1, status: 'failed', total: 1, passed: 0, failed: 1, errors: 0, trigger: 'schedule' }) + '\n',
    );
    recordCertificate(store, 'https://api.example.com/', { subject: 'api.example.com', validTo: new Date(Date.now() + 3 * 864e5 + 3600e3).toISOString() });
    store.meta.addRun(
      { runId: 'run-1', name: 'Smoke', startedAt: new Date().toISOString(), durationMs: 1, total: 2, passed: 1, failed: 1, skipped: 0, errors: 0 } as RunSummary,
      store.runDir('run-1'),
    );
    store.meta.addHistory({ id: 'h1', timestamp: new Date().toISOString(), kind: 'http', name: 'Login', status: 500, collectionId: 'api', requestId: 'r1' });
    const items = await workspaceAttention(store);
    expect(items.map((i) => [i.kind, i.severity])).toEqual([
      ['monitor', 'high'],
      ['certificate', 'high'],
      ['run', 'medium'],
      ['request', 'low'],
    ]);
    expect(items[0]!.message).toBe('Monitor "Health" is failing: 1 of 1 requests failed');
    expect(items[1]!.message).toBe('The certificate of api.example.com expires in 3 days');
    expect(items[3]!.message).toBe('API › Login: the latest response was 500');
    store.close();
  });

  it('is empty when all is well', async () => {
    const store = WorkspaceStore.create(join(dir, 'ok'), 'Fine');
    expect(await workspaceAttention(store)).toEqual([]);
    store.close();
  });
});

describe('an evaluation that passes less than it did', () => {
  it('is listed when its latest run passed clearly fewer cases than the run before, and not for a small change or a bot with sources', async () => {
    const store = WorkspaceStore.create(join(dir, 'evals'), 'Evals');
    const evaluation = (id: string, name: string, type?: string) => ({ id, name, data: { type, provider: 'mock', model: 'm', prompt: 'x', dataset: '{}', datasetFormat: 'jsonl', evaluators: [] }, createdAt: '', updatedAt: '' });
    store.saveLibrary('evaluations', { folders: [], items: [evaluation('e1', 'Support intents'), evaluation('e2', 'Steady one'), evaluation('e3', 'A bot', 'rag')] as never });
    const run = (id: string, name: string, passed: number, total: number, minutes: number) =>
      store.meta.addRun({ runId: id, name, startedAt: new Date(Date.now() - minutes * 60_000).toISOString(), durationMs: 1, total, passed, failed: total - passed, skipped: 0, errors: 0 } as RunSummary, store.runDir(id));
    run('a1', 'Support intents', 9, 10, 20);
    run('a2', 'Support intents', 5, 10, 5);
    run('b1', 'Steady one', 18, 20, 20);
    run('b2', 'Steady one', 17, 20, 5);
    run('c1', 'A bot', 9, 10, 20);
    run('c2', 'A bot', 2, 10, 5);
    const items = (await workspaceAttention(store)).filter((i) => /^Evaluation /.test(i.message));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'run', severity: 'high', group: 'Runs', type: 'warning', ref: { kind: 'run', runId: 'a2' } });
    expect(items[0]!.message).toBe('Evaluation "Support intents" passed 5 of 10, down from 9 of 10 the run before');
    store.close();
  });
});
