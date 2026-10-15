import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { WorkspaceStore } from '../../packages/core/src/index.js';
import { tempDir, waitFor } from '../helpers.js';

// The Scale stage's RPC in the app: a data run in the background (progress batched, never one event per row; rows
// paged; a row's steps), cancel, an environment matrix (a missing environment refused up front), the timeline of a run
// and its HTML export.
const tmp = tempDir('tp-scale-rpc-');
let server: Server;
let base = '';
let requests = 0;
const events: Array<{ channel: string; payload: unknown }> = [];
let be: Backend;
const saved = join(tmp.dir, 'saved-timeline.html');

beforeAll(async () => {
  server = createServer(async (req, res) => {
    requests++;
    const url = new URL(req.url ?? '/', 'http://x');
    const ms = Number(url.searchParams.get('ms')) || 0;
    if (ms) await new Promise((r) => setTimeout(r, ms));
    res.writeHead(Number(url.searchParams.get('code')) || 200, { 'content-type': 'application/json' });
    res.end('{"id":"u1"}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const root = join(tmp.dir, 'ws');
  const s = WorkspaceStore.create(root, 'Scale');
  s.saveEnvironment({ id: 'dev', name: 'dev', variables: [{ key: 'baseUrl', value: base, enabled: true }] } as never);
  s.saveEnvironment({
    id: 'stage',
    name: 'stage',
    variables: [
      { key: 'baseUrl', value: base, enabled: true },
      { key: 'code', value: '500', enabled: true },
    ],
  } as never);
  s.writeTestFile(
    'flow.yaml',
    `tests:\n  - { id: one, name: One, url: "{{baseUrl}}/a?code={{code}}&ms={{ms}}", extract: { id: "$.id" }, assertions: [{ type: status, expected: 200 }] }\n  - { id: two, name: Two, url: "{{baseUrl}}/b/{{id}}", dependsOn: [one] }\n`,
  );
  const rows = ['code,ms', ...Array.from({ length: 500 }, (_, i) => `${i % 100 === 3 ? 500 : 200},0`)];
  writeFileSync(join(root, 'datasets', 'rows.csv'), rows.join('\n'));
  writeFileSync(join(root, 'datasets', 'slow.csv'), ['code,ms', ...Array.from({ length: 50 }, () => '200,100')].join('\n'));
  s.close();
  be = new Backend({ appDir: join(tmp.dir, 'app'), emit: (channel, payload) => void events.push({ channel, payload }), noMonitors: true, saveDialog: async () => saved });
  be.openStore(root);
});
afterAll(async () => {
  await be.dispose();
  await new Promise<void>((r) => server.close(() => r()));
  tmp.cleanup();
});

const finished = (id: string) => events.find((e) => e.channel === 'scale.finished' && (e.payload as { id: string }).id === id)?.payload as { status: string; error?: { message: string } } | undefined;

describe('tests.dataRun', () => {
  it('runs in the background: batched progress, rows paged, a row’s steps', async () => {
    const { id } = (await be.invoke('tests.dataRun', { file: 'flow.yaml', data: 'datasets/rows.csv', environment: 'dev', concurrency: 8 })) as { id: string };
    await waitFor(() => !!finished(id), 30_000, 'the data run');
    expect(finished(id)!.status).toBe('failed');
    const progress = events.filter((e) => e.channel === 'scale.progress').length;
    // batched: far fewer events than rows
    expect(progress).toBeLessThan(100);
    const page = (await be.invoke('tests.scaleRows', { id, offset: 0, limit: 200, status: 'failed' })) as {
      matched: number;
      counts: Record<string, number>;
      rows: Array<{ index: number; failedStep: string }>;
    };
    expect(page.counts).toEqual({ passed: 495, failed: 5, cancelled: 0, skipped: 0 });
    expect(page.rows.map((r) => r.index)).toEqual([3, 103, 203, 303, 403]);
    const steps = (await be.invoke('tests.scaleRow', { id, index: 103 })) as Array<{ id: string; status: string }>;
    expect(steps.map((s) => `${s.id}=${s.status}`)).toEqual(['one=failed', 'two=skipped']);
    expect(await be.invoke('tests.scaleRow', { id, index: 499 })).toBeNull();
    const list = (await be.invoke('tests.scaleRuns', { file: 'flow.yaml' })) as Array<{ id: string; total: number }>;
    expect(list[0]).toMatchObject({ id, total: 500 });
  });

  it('cancel stops it: nothing more is sent after the run says it finished', async () => {
    const { id } = (await be.invoke('tests.dataRun', { file: 'flow.yaml', data: 'datasets/slow.csv', environment: 'dev', concurrency: 2 })) as { id: string };
    await new Promise((r) => setTimeout(r, 250));
    expect(await be.invoke('tests.scaleCancel', { id })).toEqual({ id, running: true });
    await waitFor(() => !!finished(id), 10_000, 'the cancelled run');
    expect(finished(id)!.status).toBe('cancelled');
    const after = requests;
    await new Promise((r) => setTimeout(r, 300));
    expect(requests).toBe(after);
    const run = (await be.invoke('tests.scaleRun', { id })) as { total: number; stopped: boolean };
    expect(run.stopped).toBe(true);
    expect(run.total).toBeLessThan(50);
  });

  it('bad input gives a clear error, before anything runs', async () => {
    await expect(be.invoke('tests.dataRun', { file: 'flow.yaml', data: 'datasets/none.csv' })).rejects.toThrow(/No such data file/);
    await expect(be.invoke('tests.dataRun', { file: 'flow.yaml' })).rejects.toThrow(/has no data/);
    await expect(be.invoke('tests.dataRun', { file: 'nope.yaml', data: 'datasets/rows.csv' })).rejects.toThrow(/No such test file/);
    await expect(be.invoke('tests.matrixRun', { file: 'flow.yaml', environments: ['dev', 'qa'] })).rejects.toThrow(/qa/);
  });
});

describe('tests.matrixRun', () => {
  it('compares the environments', async () => {
    const { id } = (await be.invoke('tests.matrixRun', { file: 'flow.yaml', environments: ['dev', 'stage'] })) as { id: string };
    await waitFor(() => !!finished(id), 20_000, 'the matrix');
    const m = (await be.invoke('tests.scaleRun', { id })) as { columns: Array<{ environment: string; status: string; results: unknown[] }>; differingSteps: string[] };
    expect(m.columns.map((c) => `${c.environment}=${c.status}`)).toEqual(['dev=passed', 'stage=failed']);
    expect(m.differingSteps).toEqual(['one', 'two']);
    expect(m.columns[0]!.results).toHaveLength(2);
  });
});

describe('tests.flowTimeline', () => {
  it('a run as a timeline, saved as a self-contained HTML file', async () => {
    const { runId } = (await be.invoke('tests.run', { paths: ['flow.yaml'], environment: 'dev' })) as { runId: string };
    await waitFor(() => events.some((e) => e.channel === 'run.finished' && (e.payload as { runId: string }).runId === runId), 20_000, 'the run');
    const t = (await be.invoke('tests.flowTimeline', { runId })) as { file: string; timeline: { criticalPath: string[]; bars: unknown[] } };
    expect(t.file).toBe('flow.yaml');
    expect(t.timeline.criticalPath).toEqual(['one', 'two']);
    const byFile = (await be.invoke('tests.flowTimeline', { file: 'flow.yaml' })) as { runId: string };
    expect(byFile.runId).toBe(runId);
    expect(await be.invoke('tests.flowTimelineHtml', { runId })).toEqual({ path: saved });
    expect(existsSync(saved)).toBe(true);
    expect(readFileSync(saved, 'utf8')).toMatch(/^<!doctype html>[\s\S]*Critical path/);
  });
});
