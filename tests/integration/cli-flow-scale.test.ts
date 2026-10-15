import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { WorkspaceStore, listScaleRuns } from '../../packages/core/src/index.js';
import { createRestServer } from '../../examples/servers/demo-servers.mjs';
import { cliData } from '../helpers.js';

// The Scale stage from the command line, against the demo REST API: testpion test --data (a run per CSV row, JSON
// streamed), --env-matrix / -e repeated, testpion load --test-file and testpion flow report (text, --json, --html).
const run = promisify(execFile);
const dir = mkdtempSync(join(tmpdir(), 'tp-cli-scale-'));
const ws = join(dir, 'ws');
let server: Server;
let base = '';

beforeAll(async () => {
  server = createRestServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const store = WorkspaceStore.create(ws, 'scale');
  store.saveEnvironment({
    id: 'dev',
    name: 'dev',
    variables: [
      { key: 'baseUrl', value: base, enabled: true },
      { key: 'code', value: '200', enabled: true },
    ],
  } as never);
  store.saveEnvironment({
    id: 'staging',
    name: 'staging',
    variables: [
      { key: 'baseUrl', value: base, enabled: true },
      { key: 'code', value: '503', enabled: true },
    ],
  } as never);
  store.writeTestFile(
    'scale/health.yaml',
    [
      'name: Health per row',
      'tests:',
      '  - { id: health, name: Health, url: "{{baseUrl}}/health", extract: { state: "$.status" }, assertions: [{ type: status, expected: 200 }] }',
      '  - { id: status, name: Status, url: "{{baseUrl}}/status?code={{code}}&who={{name}}", dependsOn: [health], assertions: [{ type: status, expected: 200 }] }',
      '',
    ].join('\n'),
  );
  writeFileSync(join(ws, 'datasets', 'people.csv'), 'name,code\nann,200\nbob,404\ncy,200\n');
  store.close();
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const cli = async (...args: string[]) => {
  try {
    const r = await run(process.execPath, [join(process.cwd(), 'packages/cli/bin/testpion.js'), ...args], {
      encoding: 'utf8',
      cwd: ws,
      env: { ...process.env, NO_COLOR: '1', TESTPION_HOME: join(dir, 'home') },
      maxBuffer: 64 * 1024 * 1024,
    });
    return { status: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    return { status: x.code ?? -1, out: x.stdout ?? '', err: x.stderr ?? '' };
  }
};

describe('CLI: a flow at scale', () => {
  it('test --data runs the flow once per row; --json streams the rows and a summary', async () => {
    const r = await cli('test', 'scale/health.yaml', '-e', 'dev', '--data', 'datasets/people.csv', '--json');
    expect(r.status).toBe(1);
    const doc = cliData(r.out) as { rows: Array<{ index: number; status: string; failedStep?: string }>; summary: { id: string; total: number; passed: number; failed: number } };
    expect(doc.summary).toMatchObject({ total: 3, passed: 2, failed: 1 });
    expect(doc.rows.sort((a, b) => a.index - b.index).map((x) => `${x.index}=${x.status}`)).toEqual(['0=passed', '1=failed', '2=passed']);
    expect(doc.rows.find((x) => x.index === 1)?.failedStep).toBe('status');
    const store = WorkspaceStore.open(ws);
    try {
      expect(listScaleRuns(store, { file: 'scale/health.yaml', kind: 'data' })[0]).toMatchObject({ id: doc.summary.id, total: 3, failed: 1 });
    } finally {
      store.close();
    }
    const text = await cli('test', 'scale/health.yaml', '-e', 'dev', '--data', 'datasets/people.csv', '--data-concurrency', '2', '--bail');
    expect(text.out).toMatch(/failed at Status/);
    expect(text.out).toMatch(/FAILED/);
  });

  it('a missing data file or environment is a configuration error with a clear message', async () => {
    const r = await cli('test', 'scale/health.yaml', '--data', 'nope.csv');
    expect(r.status).toBe(2);
    expect(r.err).toMatch(/No such data file: nope\.csv/);
    const m = await cli('test', 'scale/health.yaml', '--env-matrix', 'dev,qa');
    expect(m.status).toBe(2);
    expect(m.err).toMatch(/qa/);
    const h = await cli('test', 'scale/health.yaml', '--data');
    expect(h.status).toBe(2);
    expect(h.err).toMatch(/has no data/);
  });

  it('--env-matrix (or -e repeated) compares the environments step by step', async () => {
    const r = await cli('test', 'scale/health.yaml', '--env-matrix', 'dev,staging', '--var', 'name=x', '--json');
    expect(r.status).toBe(1);
    const m = cliData(r.out) as { environments: string[]; columns: Array<{ environment: string; status: string; cells: Record<string, { status: string }> }>; differingSteps: string[] };
    expect(m.environments).toEqual(['dev', 'staging']);
    expect(m.columns.map((c) => `${c.environment}=${c.status}`)).toEqual(['dev=passed', 'staging=failed']);
    expect(m.differingSteps).toEqual(['status']);
    const t = await cli('test', 'scale/health.yaml', '-e', 'dev', '-e', 'staging', '--var', 'name=x');
    expect(t.out).toMatch(/Health\s+passed.*passed/);
    expect(t.out).toMatch(/1 of 2 environments passed/);
  });

  it('a data run or matrix where nothing ran (every step skipped) says SKIPPED and exits 1, 0 with --allow-skipped', async () => {
    writeFileSync(join(ws, 'tests', 'scale', 'orphan.yaml'), 'tests:\n  - { id: a, name: A, url: "{{baseUrl}}/health", dependsOn: [elsewhere] }\n  - { id: b, name: B, url: "{{baseUrl}}/health", dependsOn: [a] }\n');
    const data = await cli('test', 'scale/orphan.yaml', '-e', 'dev', '--data', 'datasets/people.csv', '--json');
    expect(data.status).toBe(1);
    expect((cliData(data.out) as { summary: { status: string; skipped: number; passed: number } }).summary).toMatchObject({ status: 'skipped', skipped: 3, passed: 0 });
    const text = await cli('test', 'scale/orphan.yaml', '-e', 'dev', '--data', 'datasets/people.csv');
    expect(text.out).toMatch(/SKIPPED\s+0 of 3 rows passed, 3 skipped/);
    expect(text.err).toMatch(/Nothing ran/);
    expect((await cli('test', 'scale/orphan.yaml', '-e', 'dev', '--data', 'datasets/people.csv', '--allow-skipped', '-q')).status).toBe(0);
    const m = await cli('test', 'scale/orphan.yaml', '--env-matrix', 'dev', 'staging', '--json');
    expect(m.status).toBe(1);
    expect(cliData(m.out)).toMatchObject({ status: 'skipped', passed: 0, failed: 0, skipped: 2 });
    // the kept run says skipped too (the app's list and the MCP tools read it)
    const store = WorkspaceStore.open(ws);
    try {
      expect(listScaleRuns(store, { file: 'scale/orphan.yaml' }).map((r) => r.status)).toEqual(['skipped', 'skipped', 'skipped', 'skipped']);
    } finally {
      store.close();
    }
  }, 60_000);

  it('load --test-file: every virtual user runs the whole flow', async () => {
    const r = await cli('load', '--test-file', 'scale/health.yaml', '-e', 'dev', '--vus', '2', '--duration', '1', '--json', join(dir, 'load.json'));
    expect(r.out).toMatch(/Per step \(\d+ runs of the flow\)/);
    const snap = JSON.parse(readFileSync(join(dir, 'load.json'), 'utf8')) as { iteration: { count: number; failed: number }; perRequest: Array<{ name: string }> };
    expect(snap.iteration.count).toBeGreaterThan(0);
    expect(snap.iteration.failed).toBe(0);
    expect(snap.perRequest.map((p) => p.name)).toEqual(['Health', 'Status']);
  });

  it('flow report: the timeline with its critical path, as text, JSON and HTML', async () => {
    expect((await cli('test', 'tests/scale/health.yaml', '-e', 'dev', '--var', 'name=x')).status).toBe(0);
    const t = await cli('flow', 'report', 'scale/health.yaml');
    expect(t.status, t.err + t.out).toBe(0);
    expect(t.out).toMatch(/Critical path.*health → status/);
    const j = await cli('flow', 'report', 'scale/health.yaml', '--json');
    const tl = cliData(j.out) as { runId: string; timeline: { criticalPath: string[]; bars: unknown[] } };
    expect(tl.timeline.criticalPath).toEqual(['health', 'status']);
    const out = join(dir, 'timeline.html');
    const h = await cli('flow', 'report', 'scale/health.yaml', '--run', tl.runId, '--html', out);
    expect(h.status).toBe(0);
    expect(existsSync(out)).toBe(true);
    const html = readFileSync(out, 'utf8');
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).not.toMatch(/<script|<link/);
    expect(html).toContain('data-step-id="status"');
  });
});
