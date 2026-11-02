import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  MemorySecretStore,
  MonitorScheduler,
  WorkspaceStore,
  alertAfterOf,
  monitorAlert,
  createEngineContext,
  deleteMonitor,
  executeMonitor,
  findMonitor,
  flowDeployStatus,
  formatEvery,
  isDue,
  listMonitors,
  listMonitorDefinitions,
  monitorTenants,
  monitorsStatus,
  monitorsStatusByOwner,
  monitorsStatusHtml,
  monitorsStatusMarkdown,
  monitorDaily,
  monitorResults,
  nextRunAt,
  parseEvery,
  parsePauseFor,
  pauseMonitor,
  pausedFor,
  pausedText,
  monitorStatus,
  resumeMonitor,
  saveMonitor,
  type Monitor,
  type MonitorResult,
} from '../../packages/core/src/index.js';

let dir: string;
let server: Server;
let base: string;
let store: WorkspaceStore;
let healthy = true;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tp-monitors-'));
  server = createServer((req, res) => {
    res.writeHead(req.url === '/health' && healthy ? 200 : 503, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  store = WorkspaceStore.create(join(dir, 'ws'), 'Monitors');
  store.saveEnvironment({ id: 'local', name: 'Local', variables: [{ key: 'baseUrl', value: base, enabled: true }] });
  store.saveCollection({
    schemaVersion: '1.0',
    id: 'api',
    name: 'API',
    version: 0,
    variables: [],
    updatedAt: '',
    items: [
      {
        kind: 'folder',
        id: 'f-health',
        name: 'Health',
        items: [{ kind: 'request', id: 'r-health', name: 'Health', request: { method: 'GET', url: '{{baseUrl}}/health', headers: [], params: [] }, assertions: [{ type: 'status', expected: 200 }] }],
      },
    ],
  } as never);
});

afterAll(async () => {
  store.close();
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

const context = (o: { environment?: string; collectionId: string }) => createEngineContext({ store, secrets: new MemorySecretStore(), environment: o.environment, collectionId: o.collectionId });
const monitor: Monitor = { id: 'mon-health', name: 'Health check', collectionId: 'api', selection: ['f-health'], environment: 'Local', everyMinutes: 5, enabled: true };

describe('monitor schedule rules', () => {
  it('parses and formats intervals', () => {
    expect(parseEvery('15')).toBe(15);
    expect(parseEvery('15m')).toBe(15);
    expect(parseEvery('2h')).toBe(120);
    expect(parseEvery('1d')).toBe(1440);
    expect(() => parseEvery('0')).toThrow(/1 minute to 7 days/);
    expect(() => parseEvery('8d')).toThrow(/1 minute to 7 days/);
    expect(() => parseEvery('soon')).toThrow(/not an interval/);
    expect(formatEvery(1)).toBe('every minute');
    expect(formatEvery(15)).toBe('every 15 minutes');
    expect(formatEvery(60)).toBe('hourly');
    expect(formatEvery(180)).toBe('every 3 hours');
    expect(formatEvery(1440)).toBe('daily');
  });

  it('a pause for a while: not due until the time, then due by itself; the status says until when and why', () => {
    const now = Date.parse('2026-09-29T12:00:00Z');
    const paused = { ...monitor, pausedUntil: '2026-09-29T14:30:00Z', pauseReason: 'deploy' };
    expect(pausedFor(paused, now)).toBe(true);
    expect(isDue(paused, undefined, now)).toBe(false);
    expect(isDue(paused, undefined, Date.parse('2026-09-29T14:30:00Z'))).toBe(true);
    expect(pausedFor(paused, Date.parse('2026-09-29T14:30:00Z'))).toBe(false);
    expect(pausedText(paused, now)).toMatch(/^paused until \d{1,2}:\d{2}( [AP]M)? \(deploy\)$/);
    expect(parsePauseFor('2h')).toBe(120);
    expect(parsePauseFor('30m')).toBe(30);
    expect(parsePauseFor('1d')).toBe(1440);
    expect(parsePauseFor(45)).toBe(45);
    expect(() => parsePauseFor('soon')).toThrow(/not a duration/);
    expect(() => parsePauseFor('31d')).toThrow(/1 minute to 30 days/);
  });

  it('pauseMonitor keeps the schedule on with a time, or switches it off without one; resumeMonitor ends either', () => {
    const saved = saveMonitor(store, { ...monitor, id: 'mon-pause', name: 'Pausable' });
    const now = Date.parse('2026-09-29T12:00:00Z');
    const timed = pauseMonitor(store, saved.id, { minutes: 90, reason: 'deploy' }, now);
    expect(timed).toMatchObject({ enabled: true, pausedUntil: '2026-09-29T13:30:00.000Z', pauseReason: 'deploy' });
    expect(monitorStatus(store, timed, now)).toMatchObject({ paused: true, schedule: expect.stringMatching(/^paused until .*\(deploy\)$/) });
    expect(Date.parse(monitorStatus(store, timed, now).nextRunAt!)).toBe(Date.parse('2026-09-29T13:30:00.000Z'));
    expect(monitorStatus(store, timed, Date.parse('2026-09-29T13:31:00Z')).paused).toBe(false);
    const off = pauseMonitor(store, saved.id, {}, now);
    expect(off).toMatchObject({ enabled: false });
    expect(off.pausedUntil).toBeUndefined();
    expect(monitorStatus(store, off, now).schedule).toBe('paused');
    expect(() => pauseMonitor(store, saved.id, { until: '2026-09-29T11:00:00Z' }, now)).toThrow(/in the past/);
    const back = resumeMonitor(store, saved.id);
    expect(back).toMatchObject({ enabled: true });
    expect(back.pausedUntil).toBeUndefined();
    expect(monitorStatus(store, back, now).paused).toBe(false);
    deleteMonitor(store, saved.id);
  });

  it('is due when it never ran or its interval passed, and never when paused', () => {
    const now = Date.parse('2026-09-29T12:00:00Z');
    const last = { startedAt: '2026-09-29T11:56:00Z' } as MonitorResult;
    expect(isDue(monitor, undefined, now)).toBe(true);
    expect(isDue(monitor, last, now)).toBe(false);
    expect(nextRunAt(monitor, last, now)).toBe(Date.parse('2026-09-29T12:01:00Z'));
    expect(isDue(monitor, last, Date.parse('2026-09-29T12:01:00Z'))).toBe(true);
    expect(isDue({ ...monitor, enabled: false }, undefined, now)).toBe(false);
  });
});

describe('monitors in a workspace', () => {
  it('saves, validates, finds and deletes definitions (library/monitors.json)', () => {
    saveMonitor(store, monitor);
    expect(listMonitors(store)).toEqual([expect.objectContaining({ id: 'mon-health', name: 'Health check', everyMinutes: 5 })]);
    expect(findMonitor(store, 'health check').id).toBe('mon-health');
    expect(() => findMonitor(store, 'nope')).toThrow(/Health check/);
    expect(() => saveMonitor(store, { ...monitor, id: 'x', collectionId: 'missing' })).toThrow();
    expect(() => saveMonitor(store, { ...monitor, id: 'x', environment: 'Nope' })).toThrow(/No environment/);
    expect(() => saveMonitor(store, { ...monitor, id: 'x', selection: ['no-such-folder'] })).toThrow(/Nothing to run/);
    expect(JSON.parse(readFileSync(store.path('library', 'monitors.json'), 'utf8')).items).toHaveLength(1);
    // exported with the workspace
    expect(store.exportBundle().library?.monitors?.items).toHaveLength(1);
  });

  it('runs a monitor, records passed and failed results and a normal run', async () => {
    healthy = true;
    const ok = await executeMonitor({ store, monitor, context });
    expect(ok).toMatchObject({ monitorId: 'mon-health', status: 'passed', total: 1, passed: 1, trigger: 'manual' });
    healthy = false;
    const bad = await executeMonitor({ store, monitor, context, trigger: 'schedule' });
    expect(bad).toMatchObject({ status: 'failed', failed: 1, trigger: 'schedule' });
    expect(monitorResults(store, 'mon-health').map((r) => r.status)).toEqual(['failed', 'passed']);
    expect(store.meta.listRuns().items.map((r) => r.name)).toContain('Monitor · Health check');
    expect(readFileSync(join(store.runDir(ok.runId), 'report.html'), 'utf8')).toContain('Monitor · Health check');
  });

  it('fails a run that is slower than its p95 limit, with the reason, even when every check passed', async () => {
    healthy = true;
    const slow = await executeMonitor({ store, monitor: { ...monitor, id: 'mon-slow', maxP95Ms: 0.001 }, context });
    expect(slow).toMatchObject({ status: 'failed', passed: 1, failed: 0 });
    expect(slow.p95Ms).toBeGreaterThan(0);
    expect(slow.reason).toMatch(/^p95 \d+ ms is over the 0.001 ms limit$/);
    const fine = await executeMonitor({ store, monitor: { ...monitor, id: 'mon-fast', maxP95Ms: 60_000 }, context });
    expect(fine.status).toBe('passed');
    expect(fine.reason).toBeUndefined();
    expect(() => saveMonitor(store, { ...monitor, id: 'mon-bad-limit', maxP95Ms: -1 })).toThrow(/positive number/);
  });

  it('records a run that cannot start as an error instead of throwing', async () => {
    const r = await executeMonitor({ store, monitor: { ...monitor, id: 'mon-broken', collectionId: 'gone' }, context });
    expect(r.status).toBe('error');
    expect(r.error).toBeTruthy();
  });

  it('alert after n failures in a row: quiet until the streak, recovery told only after an alert', () => {
    const r = (status: 'passed' | 'failed') => ({ status }) as MonitorResult;
    const m = { alertAfter: 3 };
    expect(alertAfterOf({})).toBe(1);
    expect(alertAfterOf({ alertAfter: 0 })).toBe(1);
    expect(alertAfterOf({ alertAfter: 99 })).toBe(10);
    expect(monitorAlert(m, r('failed'), [])).toBeUndefined();
    expect(monitorAlert(m, r('failed'), [r('failed')])).toBeUndefined();
    expect(monitorAlert(m, r('failed'), [r('failed'), r('failed')])).toBe('failing');
    expect(monitorAlert(m, r('failed'), [r('failed'), r('failed'), r('failed')])).toBeUndefined();
    expect(monitorAlert(m, r('passed'), [r('failed'), r('failed')])).toBeUndefined();
    expect(monitorAlert(m, r('passed'), [r('failed'), r('failed'), r('failed'), r('passed')])).toBe('recovered');
    // the default (1) is the old rule: the first failure and the first pass after it
    expect(monitorAlert({}, r('failed'), [])).toBe('failing');
    expect(monitorAlert({}, r('failed'), [r('failed')])).toBeUndefined();
    expect(monitorAlert({}, r('passed'), [r('failed')])).toBe('recovered');
    expect(monitorAlert({}, r('passed'), [r('passed')])).toBeUndefined();
  });

  it('alerts the webhook when a monitor starts failing and when it recovers, not on every run', async () => {
    const posts: Array<{ text: string; status: string }> = [];
    const hook = createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => (posts.push(JSON.parse(b)), res.writeHead(200).end('ok')));
    });
    await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`;
    const results: MonitorResult[] = [];
    let next: MonitorResult['status'] = 'failed';
    const m = { id: 'mon-alert', name: 'Checkout', collectionId: 'c', everyMinutes: 1, enabled: true, webhook: '{{alertUrl}}' } as Monitor;
    const s = new MonitorScheduler({
      list: () => [m],
      last: () => results[results.length - 1],
      run: async () => {
        const r = { monitorId: m.id, runId: `r${results.length}`, startedAt: new Date().toISOString(), durationMs: 5, status: next, total: 4, passed: next === 'passed' ? 4 : 1, failed: next === 'passed' ? 0 : 3, errors: 0, trigger: 'schedule' } as MonitorResult;
        results.push(r);
        return r;
      },
      resolve: (_m, text) => text.replace('{{alertUrl}}', url),
    });
    try {
      let t = Date.now();
      await s.tick((t += 120_000)); // passed → failed (first run fails): alert
      await s.tick((t += 120_000)); // still failing: no alert
      next = 'passed';
      await s.tick((t += 120_000)); // recovers: alert
      await s.tick((t += 120_000)); // still fine: no alert
      expect(posts.map((p) => [p.status, p.text])).toEqual([
        ['failed', '🔴 Monitor "Checkout" failed: 3 of 4 requests'],
        ['passed', '🟢 Monitor "Checkout" passes again (4 of 4 requests)'],
      ]);
    } finally {
      await new Promise<void>((r) => hook.close(() => r()));
    }
  });

  it('the scheduler runs due monitors once and reports status changes', async () => {
    healthy = true;
    const changes: string[] = [];
    const s = new MonitorScheduler({
      list: () => listMonitors(store),
      last: (id) => monitorResults(store, id, 1)[0],
      run: (m) => executeMonitor({ store, monitor: m, context, trigger: 'schedule' }),
      onResult: (m, r, prev) => changes.push(`${m.name}: ${prev?.status} -> ${r.status}`),
    });
    const later = Date.now() + 10 * 60_000;
    expect(await s.tick(later)).toBe(1);
    expect(changes).toEqual(['Health check: failed -> passed']);
    // it just ran: not due again until its interval passes
    expect(await s.tick(Date.now())).toBe(0);
    deleteMonitor(store, 'mon-health');
    expect(listMonitors(store)).toEqual([]);
    expect(await s.tick(later + 60 * 60_000)).toBe(0);
  });
});

describe('a monitor for every tenant (an environment group) from one definition', () => {
  it('lists one monitor per environment of the group with its own id, name, environment and results; saving or deleting a tenant changes the definition', async () => {
    store.saveEnvironment({ id: 'acme-staging', name: 'Staging', group: 'Acme', variables: [{ key: 'baseUrl', value: base, enabled: true }] });
    store.saveEnvironment({ id: 'acme-prod', name: 'Production', group: 'Acme', variables: [{ key: 'baseUrl', value: base, enabled: true }] });
    const grouped: Monitor = { id: 'mon-tenants', name: 'Checkout', collectionId: 'api', environment: 'Local', environmentGroup: 'Acme', everyMinutes: 5, enabled: true };
    expect(() => saveMonitor(store, { ...grouped, id: 'x', environmentGroup: 'Nobody' })).toThrow(/No environment is in the group/);
    const saved = saveMonitor(store, grouped);
    expect(saved.environment).toBeUndefined();
    expect(listMonitorDefinitions(store).filter((m) => m.id === 'mon-tenants')).toHaveLength(1);
    const tenants = listMonitors(store).filter((m) => m.tenant?.of === 'mon-tenants');
    expect(tenants.map((m) => [m.id, m.name, m.environment])).toEqual([
      // environments list by file name: Production first
      ['mon-tenants@acme-prod', 'Checkout · Acme ▸ Production', 'Production'],
      ['mon-tenants@acme-staging', 'Checkout · Acme ▸ Staging', 'Staging'],
    ]);
    expect(findMonitor(store, 'mon-tenants@acme-prod').environment).toBe('Production');
    expect(findMonitor(store, 'checkout · acme ▸ staging').id).toBe('mon-tenants@acme-staging');
    expect(monitorTenants(store, findMonitor(store, 'Checkout'))).toHaveLength(2);
    healthy = true;
    for (const t of tenants) await executeMonitor({ store, monitor: t, context });
    expect(monitorResults(store, 'mon-tenants@acme-staging')).toHaveLength(1);
    expect(monitorResults(store, 'mon-tenants@acme-prod')).toHaveLength(1);
    expect(monitorResults(store, 'mon-tenants')).toHaveLength(0);
    // a tenant's own status page: only the monitors that run in its environments, titled with the group
    const page = monitorsStatus(store, { group: 'acme' });
    expect(page.group).toBe('acme');
    expect(page.monitors.map((m) => m.name).sort()).toEqual(['Checkout · Acme ▸ Production', 'Checkout · Acme ▸ Staging']);
    expect(monitorsStatus(store).monitors.length).toBeGreaterThanOrEqual(page.monitors.length);
    expect(monitorsStatusHtml(page)).toContain('<h1>Monitors · acme</h1>');
    // every tenant on one page: a heading per group; one tenant's page: none
    expect(monitorsStatusHtml(monitorsStatus(store))).toMatch(/<h2 class="tenant">(No tenant|Acme)<\/h2>/);
    expect(monitorsStatusHtml(page)).not.toContain('class="tenant"');
    expect(monitorsStatusMarkdown(page)).toMatch(/^# Monitors · acme — status/);
    expect(monitorsStatus(store, { group: 'Nobody' }).monitors).toEqual([]);
    expect(monitorsStatusHtml(monitorsStatus(store, { group: 'Nobody' }))).toContain('No monitor runs in an environment of Nobody.');
    // a team's own page: by the CODEOWNERS owner of the monitor's collection (none here: no CODEOWNERS)
    const team = await monitorsStatusByOwner(store, '@org/payments');
    expect(team.owner).toBe('@org/payments');
    expect(team.monitors).toEqual([]);
    expect(monitorsStatusHtml(team)).toContain('No monitor runs what @org/payments owns.');
    expect(monitorsStatusMarkdown(team)).toMatch(/^# Monitors · @org\/payments — status/);
    // edited as the app sends it back (a tenant row): the definition changes, no second monitor appears
    saveMonitor(store, { ...tenants[0]!, everyMinutes: 10 });
    expect(listMonitorDefinitions(store).filter((m) => m.name === 'Checkout').map((m) => m.everyMinutes)).toEqual([10]);
    deleteMonitor(store, 'mon-tenants@acme-prod');
    expect(listMonitorDefinitions(store).some((m) => m.id === 'mon-tenants')).toBe(false);
    store.deleteEnvironment('acme-staging');
    store.deleteEnvironment('acme-prod');
  });
});

describe('monitor uptime by day', () => {
  it('counts runs per calendar day in the given zone, with empty days', () => {
    const now = Date.parse('2026-10-01T10:00:00Z');
    const row = (startedAt: string, status: MonitorResult['status'], p95Ms?: number) => JSON.stringify({ monitorId: 'mon-daily', runId: startedAt, startedAt, durationMs: 5, status, total: 1, passed: status === 'passed' ? 1 : 0, failed: status === 'passed' ? 0 : 1, errors: 0, trigger: 'schedule', p95Ms });
    mkdirSync(store.path('runs', 'monitors'), { recursive: true });
    writeFileSync(
      store.path('runs', 'monitors', 'mon-daily.jsonl'),
      [
        row('2026-09-20T12:00:00Z', 'passed'), // older than the period
        row('2026-09-29T09:00:00Z', 'passed', 40),
        row('2026-09-29T10:00:00Z', 'failed', 900),
        row('2026-09-30T23:30:00Z', 'passed', 20), // Oct 1 at UTC+2
        row('2026-10-01T08:00:00Z', 'passed', 30),
      ].join('\n') + '\n',
    );
    const utc = monitorDaily(store, 'mon-daily', 3, 0, now);
    expect(utc.map((d) => [d.date, d.runs, d.passed, d.uptime, d.maxP95Ms])).toEqual([
      ['2026-09-29', 2, 1, 50, 900],
      ['2026-09-30', 1, 1, 100, 20],
      ['2026-10-01', 1, 1, 100, 30],
    ]);
    const east = monitorDaily(store, 'mon-daily', 3, -120, now); // UTC+2
    expect(east.map((d) => [d.date, d.runs])).toEqual([
      ['2026-09-29', 2],
      ['2026-09-30', 0],
      ['2026-10-01', 2],
    ]);
    expect(east[1]!.uptime).toBeUndefined();
  });
});

describe('a monitor that runs a test file (a flow on a schedule)', () => {
  const flow = 'name: Health flow\ntests:\n  - id: health\n    name: Health\n    method: GET\n    url: "{{baseUrl}}/health"\n    assertions: [{ type: status, expected: 200 }]\n';
  const fileMonitor: Monitor = { id: 'mon-flow', name: 'Health flow', testFile: 'flows/health.yaml', environment: 'Local', everyMinutes: 5, enabled: true };

  it('validates exactly one target: a collection or an existing test file under tests/', () => {
    mkdirSync(store.path('tests', 'flows'), { recursive: true });
    writeFileSync(store.path('tests', 'flows', 'health.yaml'), flow);
    expect(() => saveMonitor(store, { ...fileMonitor, collectionId: 'api' })).toThrow(/not both/);
    expect(() => saveMonitor(store, { ...fileMonitor, testFile: undefined })).toThrow(/needs what to run/);
    expect(() => saveMonitor(store, { ...fileMonitor, testFile: 'flows/missing.yaml' })).toThrow(/No test file tests\/flows\/missing\.yaml/);
    expect(() => saveMonitor(store, { ...fileMonitor, testFile: '../workspace.json' })).toThrow(/outside tests|not a test file|No test file/);
    expect(() => saveMonitor(store, { ...fileMonitor, testFile: 'flows/notes.md' })).toThrow(/not a test file/);
    expect(() => saveMonitor(store, { ...fileMonitor, selection: ['x'] })).toThrow(/runs as a whole/);
    // tests/ prefix and backslashes are taken; an empty collection is no target
    const saved = saveMonitor(store, { ...fileMonitor, collectionId: '', testFile: 'tests\\flows\\health.yaml' });
    expect(saved.testFile).toBe('flows/health.yaml');
    expect(findMonitor(store, 'Health flow')).toMatchObject({ testFile: 'flows/health.yaml' });
    expect(findMonitor(store, 'Health flow').collectionId).toBeUndefined();
  });

  it('runs it with the test runner: the same result shape, recorded with its history', async () => {
    healthy = true;
    const ok = await executeMonitor({ store, monitor: findMonitor(store, 'mon-flow'), context, trigger: 'schedule' });
    expect(ok).toMatchObject({ monitorId: 'mon-flow', status: 'passed', total: 1, passed: 1, failed: 0, trigger: 'schedule' });
    expect(ok.p50Ms).toBeGreaterThanOrEqual(0);
    healthy = false;
    const bad = await executeMonitor({ store, monitor: findMonitor(store, 'mon-flow'), context });
    expect(bad).toMatchObject({ status: 'failed', failed: 1 });
    healthy = true;
    expect(monitorResults(store, 'mon-flow').map((r) => r.status)).toEqual(['failed', 'passed']);
    // the run is a run like any other (Runs list, reports)
    expect(readFileSync(join(store.runDir(ok.runId), 'results.jsonl'), 'utf8')).toContain('Health');
    // a file removed since: an error result, not a throw
    const gone = await executeMonitor({ store, monitor: { ...fileMonitor, id: 'mon-gone', testFile: 'flows/gone.yaml' }, context });
    expect(gone).toMatchObject({ status: 'error', error: expect.stringMatching(/No test file/) });
  });

  it('is the schedule of the flow in its deploy status', () => {
    expect(flowDeployStatus(store, 'flows/health.yaml').schedule).toMatchObject({ monitorId: 'mon-flow', name: 'Health flow', every: 'every 5 minutes', enabled: true, lastStatus: 'failed' });
    deleteMonitor(store, 'mon-flow');
    expect(flowDeployStatus(store, 'flows/health.yaml').schedule).toBeUndefined();
  });
});
