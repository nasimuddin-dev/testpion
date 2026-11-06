import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CurrentValues,
  McpManager,
  MemorySecretStore,
  MonitorScheduler,
  ProviderRegistry,
  Redactor,
  VariableScope,
  WorkspaceStore,
  createEngineContext,
  duplicateEnvironmentGroup,
  findMonitor,
  listMonitorDefinitions,
  listMonitors,
  monitorConsent,
  monitorConsentPending,
  monitorTenants,
  pauseMonitor,
  resumeMonitor,
  runTests,
  saveMonitor,
  setEnvironmentVariables,
  type ExecServices,
  type Monitor,
  type MonitorResult,
  type TestCase,
} from '../../packages/core/src/index.js';
import { dynamicValue } from '../../packages/core/src/vars/dynamic.js';
import { productionStep } from '../../packages/core/src/runner/execute.js';

// The fixes of the whole-code review of 2026-11-05: each test is the scenario the review described.

const dir = mkdtempSync(join(tmpdir(), 'tp-review-'));
const stores: WorkspaceStore[] = [];
afterAll(() => {
  for (const s of stores) s.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function workspace(name: string): WorkspaceStore {
  const store = WorkspaceStore.create(join(dir, name), name);
  stores.push(store);
  store.saveCollection({ schemaVersion: '1.0', id: 'api', name: 'API', version: 0, variables: [], updatedAt: '', items: [{ kind: 'request', id: 'r', name: 'Health', request: { method: 'GET', url: 'http://127.0.0.1:9/health', headers: [], params: [] } }] } as never);
  return store;
}

const result = (monitorId: string, runId: string, status: MonitorResult['status']): MonitorResult => ({ monitorId, runId, startedAt: new Date().toISOString(), durationMs: 1, status, total: 1, passed: status === 'passed' ? 1 : 0, failed: status === 'passed' ? 0 : 1, errors: 0, trigger: 'schedule' });

describe('the scheduler alerts at the failure that makes the streak', () => {
  // the hosts read `recent` from the results file, where the run has already recorded its own result
  const scheduler = (m: Monitor, statuses: MonitorResult['status'][]) => {
    const recorded: MonitorResult[] = [];
    const alerts: string[] = [];
    let n = 0;
    const s = new MonitorScheduler({
      list: () => [m],
      last: () => recorded[0],
      recent: (_id, limit) => recorded.slice(0, limit),
      run: async () => {
        const r = result(m.id, `run-${n}`, statuses[n++]!);
        recorded.unshift(r);
        return r;
      },
      // never reached: the webhook is refused before any request (the scheme), which is all this test needs to see
      onWebhook: (_m, sent) => alerts.push(sent.ok ? 'sent' : 'tried'),
    });
    return { s, alerts, recorded };
  };

  it('with the default (the first failure) it alerts once, and tells the recovery', async () => {
    const m: Monitor = { id: 'm', name: 'M', collectionId: 'api', everyMinutes: 1, enabled: true, webhook: 'http://127.0.0.1:9/hook' };
    const { s, alerts } = scheduler(m, ['failed', 'failed', 'passed', 'passed']);
    let now = Date.now();
    const counts: number[] = [];
    for (let i = 0; i < 4; i++) {
      await s.tick((now += 10 * 60_000));
      counts.push(alerts.length);
    }
    // failing (alert), still failing (quiet), recovered (alert), passing (quiet)
    expect(counts).toEqual([1, 1, 2, 2]);
  });

  it('with alertAfter 2 a blip is quiet and the second failure in a row alerts', async () => {
    const m: Monitor = { id: 'm2', name: 'M2', collectionId: 'api', everyMinutes: 1, enabled: true, alertAfter: 2, webhook: 'http://127.0.0.1:9/hook' };
    const { s, alerts } = scheduler(m, ['failed', 'passed', 'failed', 'failed', 'passed']);
    let now = Date.now();
    const counts: number[] = [];
    for (let i = 0; i < 5; i++) {
      await s.tick((now += 10 * 60_000));
      counts.push(alerts.length);
    }
    expect(counts).toEqual([0, 0, 0, 1, 2]);
  });
});

describe('two tenants with an environment of the same name', () => {
  const store = workspace('tenants');
  store.saveEnvironment({ id: 'acme-staging', name: 'Staging', group: 'Acme', variables: [{ key: 'baseUrl', value: 'https://acme.example', enabled: true }, { key: 'customer', value: 'acme-customer-0001', enabled: true }] });
  store.saveEnvironment({ id: 'globex-staging', name: 'Staging', group: 'Globex', variables: [{ key: 'baseUrl', value: 'https://globex.example', enabled: true }, { key: 'customer', value: 'globex-customer-0002', enabled: true }] });
  store.saveEnvironment({ id: 'acme-prod', name: 'Production', group: 'Acme', isProduction: true, variables: [] } as never);
  store.saveEnvironment({ id: 'globex-prod', name: 'Live', group: 'Globex', isProduction: true, variables: [] } as never);
  const secrets = new MemorySecretStore();

  it('a tenant monitor names its own environment, and a run resolves that one', async () => {
    saveMonitor(store, { id: 'checkout', name: 'Checkout', collectionId: 'api', environmentGroup: 'Acme', everyMinutes: 5, enabled: true });
    const staging = listMonitors(store).find((m) => m.id === 'checkout@acme-staging')!;
    expect(staging.environment).toBe('Acme ▸ Staging');
    expect(staging.tenant).toMatchObject({ of: 'checkout', environmentId: 'acme-staging' });
    const ctx = createEngineContext({ store, secrets, environment: staging.environment });
    try {
      expect(ctx.environment?.id).toBe('acme-staging');
      expect(ctx.vars.resolve('{{baseUrl}}')).toBe('https://acme.example');
    } finally {
      await ctx.dispose();
    }
  });

  it('a name several tenants share, or one that is gone, is an error and never a run without an environment', () => {
    expect(() => createEngineContext({ store, secrets, environment: 'Staging' })).toThrow(/No environment "Staging"/);
    expect(() => createEngineContext({ store, secrets, environment: 'Deleted' })).toThrow(/No environment "Deleted"/);
  });

  it("the other tenant's environment of the same name is another environment for the leak check", async () => {
    const ctx = createEngineContext({ store, secrets, environment: 'acme-staging' });
    try {
      const others = ctx.services.otherEnvironmentValues!();
      expect(others).toContainEqual({ environment: 'Globex ▸ Staging', key: 'customer', value: 'globex-customer-0002' });
      expect(others.some((o) => o.value === 'acme-customer-0001')).toBe(false);
    } finally {
      await ctx.dispose();
    }
  });

  it('one tenant pauses and resumes on its own', () => {
    const paused = pauseMonitor(store, 'checkout@acme-staging', { minutes: 60, reason: 'deploy' });
    expect(paused.pauseReason).toBe('deploy');
    expect(paused.pausedUntil).toBeTruthy();
    const other = findMonitor(store, 'checkout@acme-prod');
    expect(other.pausedUntil).toBeUndefined();
    expect(listMonitorDefinitions(store).find((m) => m.id === 'checkout')!.pausedUntil).toBeUndefined();
    // until resumed: only that tenant is off
    expect(pauseMonitor(store, 'checkout@acme-staging').enabled).toBe(false);
    expect(findMonitor(store, 'checkout@acme-prod').enabled).toBe(true);
    expect(resumeMonitor(store, 'checkout@acme-staging').enabled).toBe(true);
    expect(listMonitorDefinitions(store).find((m) => m.id === 'checkout')!.pausedTenants).toBeUndefined();
    // the whole definition paused: resuming a tenant that has no pause of its own resumes the definition
    pauseMonitor(store, 'checkout');
    expect(findMonitor(store, 'checkout@acme-prod').enabled).toBe(false);
    expect(resumeMonitor(store, 'checkout@acme-prod').enabled).toBe(true);
  });

  it('a tenant row saved keeps what the person typed in the name, and its own pause is not written to the definition', () => {
    pauseMonitor(store, 'checkout@acme-staging');
    const row = findMonitor(store, 'checkout@acme-staging');
    saveMonitor(store, { ...row, name: 'Checkout · EU · Acme ▸ Staging' });
    const def = listMonitorDefinitions(store).find((m) => m.id === 'checkout')!;
    expect(def.name).toBe('Checkout · EU');
    expect(def.enabled).toBe(true);
    expect(def.environment).toBeUndefined();
    saveMonitor(store, { ...def, name: 'Checkout' });
    resumeMonitor(store, 'checkout@acme-staging');
  });

  it('production consent is per environment: one environment, or each production environment of a group', () => {
    const def = listMonitorDefinitions(store).find((m) => m.id === 'checkout')!;
    expect(monitorConsentPending(store, def, def)).toEqual(['Production']);
    expect(monitorConsent(store, def, def, false)).toEqual({ allowProduction: undefined, allowProductionFor: undefined });
    const given = monitorConsent(store, def, def, true);
    expect(given).toEqual({ allowProduction: undefined, allowProductionFor: ['acme-prod'] });
    const saved = saveMonitor(store, { ...def, ...given });
    expect(monitorTenants(store, saved).map((t) => [t.id, t.allowProduction])).toEqual([
      ['checkout@acme-prod', true],
      ['checkout@acme-staging', false],
    ]);
    // kept while the group is; another group's production was never agreed to
    expect(monitorConsent(store, saved, saved, false).allowProductionFor).toEqual(['acme-prod']);
    expect(monitorConsent(store, { environmentGroup: 'Globex' }, saved, false).allowProductionFor).toBeUndefined();
    expect(monitorConsentPending(store, saved, saved)).toEqual([]);
    // one environment: kept for the same environment only
    const single: Monitor = { id: 's', name: 'S', collectionId: 'api', environment: 'Live', everyMinutes: 5, enabled: true, allowProduction: true };
    expect(monitorConsent(store, { environment: 'globex-prod' }, single, false).allowProduction).toBe(true);
    expect(monitorConsent(store, { environment: 'Production' }, single, false).allowProduction).toBeUndefined();
    expect(monitorConsent(store, { environment: 'Acme ▸ Staging' }, undefined, true).allowProduction).toBeUndefined();
  });
});

describe('a new environment never takes the file of another', () => {
  it('--create with names that give the same file name makes two files; an ambiguous name is refused', () => {
    const store = workspace('env-create');
    const before = readdirSync(store.path('environments')).length;
    const a = setEnvironmentVariables(store, '生产', { A: '1' }, { create: true });
    const b = setEnvironmentVariables(store, '测试', { B: '2' }, { create: true });
    expect(a.id).not.toBe(b.id);
    expect(readdirSync(store.path('environments')).length).toBe(before + 2);
    expect(store.getEnvironment(a.id)!.variables.map((v) => v.key)).toEqual(['A']);
    store.saveEnvironment({ id: 'x-staging', name: 'Staging', group: 'X', variables: [] });
    store.saveEnvironment({ id: 'y-staging', name: 'Staging', group: 'Y', variables: [] });
    expect(() => setEnvironmentVariables(store, 'Staging', { A: '1' }, { create: true })).toThrow(/Several environments are named/);
    // a copy of a group next to an environment that already has the id the copy would get
    store.saveEnvironment({ id: 'z-staging', name: 'Other', variables: [] });
    const copies = duplicateEnvironmentGroup(store, 'X', 'Z');
    expect(copies.map((e) => e.id)).toEqual(['z-staging-2']);
    expect(store.getEnvironment('z-staging')!.name).toBe('Other');
  });
});

describe('current values', () => {
  it('reset of one environment leaves the one whose name starts the same; values move to a new owner with their secrets', async () => {
    const secrets = new MemorySecretStore();
    const cv = new CurrentValues(join(dir, 'cv.json'), secrets, 'ws');
    await cv.set('environment', 'Staging', 'token', 'tok-A', true);
    await cv.set('environment', 'Staging EU', 'token', 'tok-EU', true);
    await cv.set('environment', 'Staging EU', 'page', 2, false);
    await cv.reset('environment', 'Staging');
    expect(cv.get('environment', 'Staging')).toEqual({});
    expect(cv.get('environment', 'Staging EU')).toEqual({ token: 'tok-EU', page: 2 });
    expect([...cv.secretKeysOf('environment', 'Staging EU')]).toEqual(['token']);
    // kept by name in an older version, by id now
    expect(cv.moveOwner('environment', 'Staging EU', 'env-eu')).toBe(true);
    expect(cv.get('environment', 'env-eu')).toEqual({ token: 'tok-EU', page: 2 });
    expect(cv.get('environment', 'Staging EU')).toEqual({});
    await new Promise((r) => setTimeout(r, 20));
    expect(new CurrentValues(join(dir, 'cv.json'), secrets, 'ws').get('environment', 'env-eu')).toEqual({ token: 'tok-EU', page: 2 });
    expect(cv.moveOwner('environment', 'nobody', 'env-eu')).toBe(false);
  });
});

describe('the engine', () => {
  const services = (): ExecServices => {
    const vars = new VariableScope();
    const redactor = new Redactor();
    return { vars, providers: new ProviderRegistry([], vars, redactor), mcp: new McpManager(() => undefined), mcpServers: [], redactor, pricing: [], defaultTimeoutMs: 5000 };
  };
  const llm = (id: string, extra: Partial<TestCase> = {}): TestCase => ({ id, name: id, type: 'llm', model: { provider: 'mock', name: 'mock' }, prompt: `hello ${id}`, assertions: [{ type: 'contains', expected: `hello ${id}` }], ...extra }) as TestCase;

  it('teardown runs after a bail', async () => {
    const ran: string[] = [];
    await runTests({
      name: 'bail',
      bail: true,
      tests: [llm('fails', { assertions: [{ type: 'contains', expected: 'never' }] }), llm('after')],
      teardown: [llm('clean-up')],
      services: services(),
      onEvent: (e) => void (e.type === 'test-end' && ran.push(`${e.result.name}: ${e.result.status}`)),
    });
    expect(ran).toContain('[teardown] clean-up: passed');
  });

  it('{{$randomInt(10,1)}} is a number from 1 to 10, and a span too wide is not a variable', () => {
    for (let i = 0; i < 50; i++) {
      const v = dynamicValue('$randomInt(10,1)') as number;
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(10);
    }
    expect(dynamicValue('$randomInt(0,999999999999999999999)')).toBeUndefined();
  });

  it('the production guard reads a GraphQL query as it is sent: a mutation that comes from a variable changes data', () => {
    const scope = new VariableScope();
    scope.set('doc', 'mutation { deleteOrder(id: 1) { id } }', 'runtime');
    scope.set('read', '{ orders { id } }', 'runtime');
    expect(productionStep({ type: 'graphql', name: 'g', query: '{{doc}}' } as TestCase, scope).changesData).toBe(true);
    expect(productionStep({ type: 'graphql', name: 'g', query: '{{read}}' } as TestCase, scope).changesData).toBe(false);
  });
});
