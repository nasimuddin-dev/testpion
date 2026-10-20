import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { GUARDED_METHODS, guardProduction } from '../../apps/desktop/backend/production-guard.js';
import {
  allowProductionFor,
  createEngineContext,
  createTestPionMcpServer,
  isDataChangingMethod,
  isGraphQLMutation,
  isGrpcReadMethod,
  listMonitors,
  MemorySecretStore,
  productionAllowed,
  productionAskOf,
  productionRefusal,
  getProposal,
  runTests,
  saveProposal,
  saveMonitor,
  setProductionAllowedByDefault,
  WorkspaceManager,
  WorkspaceStore,
  type TestCase,
  type TestResult,
} from '../../packages/core/src/index.js';
import { withProductionConsent, type Tool } from '../../packages/core/src/mcp-server/tool.js';
import { productionAskText } from '../../packages/shared/src/index.js';
import { runCli, tempDir } from '../helpers.js';
import { addRun, httpResult } from '../ai/run-fixtures.js';

// WF-06: one production guard for every send and run path: the backend boundary (every RPC method that sends or runs),
// the engine (every data-changing step of a context made for production), the MCP server and the CLI.
const tmp = tempDir('tp-prodguard-');
const JOBS = 'name: Jobs\ntests:\n  - id: job-done\n    name: Job is done\n    url: "{{base}}/job"\n    assertions:\n      - { type: status, expected: 200 }\n';
const FLAKY_PROPOSAL = 'ai-flakyprod01';
let server: Server;
let base = '';
const hits: string[] = [];
const backends: Backend[] = [];
let root = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  root = join(tmp.dir, 'ws');
  const s = WorkspaceStore.create(root, 'Guard');
  s.saveEnvironment({ id: 'prod', name: 'Production', isProduction: true, variables: [{ key: 'base', value: base }] } as never);
  s.saveEnvironment({ id: 'dev', name: 'Dev', variables: [{ key: 'base', value: base }] } as never);
  s.saveCollection({
    schemaVersion: '1.0',
    id: 'shop',
    name: 'Shop',
    version: 0,
    updatedAt: '',
    variables: [],
    items: [
      { kind: 'http', id: 'list', name: 'List', request: { method: 'GET', url: '{{base}}/list', headers: [] } },
      { kind: 'http', id: 'create', name: 'Create', request: { method: 'POST', url: '{{base}}/create', headers: [] } },
      { kind: 'graphql', id: 'mut', name: 'Mutate', request: { endpoint: '{{base}}/graphql', query: 'mutation { add }' } },
    ],
  } as never);
  // AI-5: a flaky test whose runs were in Production, and its analysis: Attempt to fix applies the fix and runs it there
  s.writeTestFile('flaky/jobs.yaml', JOBS);
  const file = join(s.path('tests'), 'flaky', 'jobs.yaml');
  await addRun(s, {
    id: 'run-flaky',
    startedAt: '2026-10-10T10:00:00.000Z',
    environment: 'Production',
    origin: { kind: 'tests', paths: ['flaky/jobs.yaml'] },
    results: [httpResult({ id: 'job-done', name: 'Job is done', url: `${base}/job`, status: 200, file, checks: [{ name: 'status', passed: true }] })],
  });
  const now = new Date();
  saveProposal(s, {
    schemaVersion: 1,
    id: FLAKY_PROPOSAL,
    task: 'analyze-flaky',
    taskVersion: 1,
    title: 'Why "Job is done" is flaky',
    assumptions: [],
    items: [{ id: 'i1', kind: 'file', title: 'Rename the step', path: 'flaky/jobs.yaml', before: JOBS, after: JOBS.replace('Job is done', 'Job is done (fixed)'), verification: [], selected: true }],
    provider: 'mock',
    model: 'mock',
    surface: 'app',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
    status: 'open',
    usage: { inputTokens: 0, outputTokens: 0 },
    request: { item: { kind: 'test-case', testId: 'job-done' } },
  } as never);
  s.close();
});
afterAll(async () => {
  for (const be of backends) await be.dispose();
  server.close();
  setProductionAllowedByDefault(false);
  tmp.cleanup();
});

function backend(): Backend {
  const be = new Backend({ appDir: join(tmp.dir, `app-${backends.length}`), emit: () => undefined, noMonitors: true });
  backends.push(be);
  be.openStore(root);
  return be;
}

describe('the rule', () => {
  it('knows which requests change data', () => {
    for (const m of ['GET', 'head', 'OPTIONS', 'TRACE']) expect(isDataChangingMethod(m)).toBe(false);
    for (const m of ['POST', 'put', 'PATCH', 'DELETE', '{{method}}']) expect(isDataChangingMethod(m)).toBe(true);
    expect(isGraphQLMutation('mutation', 'mutation { a }')).toBe(true);
    expect(isGraphQLMutation('query', '{ a }')).toBe(false);
    expect(isGraphQLMutation(undefined, 'mutation {')).toBe(true); // unparseable but says so
    expect(isGrpcReadMethod('vet.v1.Pets/GetPet')).toBe(true);
    expect(isGrpcReadMethod('grpc.health.v1.Health/Check')).toBe(true);
    expect(isGrpcReadMethod('vet.v1.Pets/CreatePet')).toBe(false);
    expect(isGrpcReadMethod('vet.v1.Pets/DeletePet')).toBe(false);
  });

  it('a refusal carries its ask across the RPC (thrown or normalised)', () => {
    const e = productionRefusal({ environment: 'Production', action: 'Run Shop', changesData: true, run: true, requests: 3, changing: 2 });
    const ask = productionAskOf(e);
    expect(ask).toMatchObject({ environment: 'Production', action: 'Run Shop', requests: 3, changing: 2 });
    expect(productionAskOf(JSON.parse(JSON.stringify(e.toJSON())))).toEqual(ask);
    expect(productionAskText(ask!)).toBe('Run Shop (3 requests, 2 change data)');
    expect(productionAskOf(new Error('x'))).toBeUndefined();
  });

  it('consent travels with the async call, and only with it', async () => {
    expect(productionAllowed()).toBe(false);
    await allowProductionFor(true, async () => {
      await new Promise((r) => setTimeout(r, 5));
      expect(productionAllowed()).toBe(true);
      await allowProductionFor(false, async () => expect(productionAllowed()).toBe(false));
    });
    expect(productionAllowed()).toBe(false);
  });
});

describe('the engine refuses data-changing steps in a production context without consent', () => {
  const run = async (allowProduction: boolean | undefined, environment = 'Production') => {
    const store = WorkspaceStore.open(root);
    const ctx = createEngineContext({ store, secrets: new MemorySecretStore(), environment, allowProduction });
    const results: TestResult[] = [];
    const tests: TestCase[] = [
      { id: 'g', name: 'read', type: 'http', request: { method: 'GET', url: '{{base}}/engine-get' } } as TestCase,
      { id: 'p', name: 'write', type: 'http', request: { method: 'POST', url: '{{base}}/engine-post' } } as TestCase,
      { id: 'm', name: 'mutate', type: 'graphql', endpoint: '{{base}}/engine-gql', query: 'mutation { a }' } as TestCase,
    ];
    try {
      await runTests({ name: 'guard', tests, services: ctx.services, concurrency: 1, onEvent: (e) => e.type === 'test-end' && results.push(e.result) });
    } finally {
      await ctx.dispose();
      store.close();
    }
    return Object.fromEntries(results.map((r) => [r.name, r]));
  };

  it('reads run, writes fail with the refusal, and nothing is sent for them', async () => {
    hits.length = 0;
    const r = await run(undefined);
    expect(r.read!.status).toBe('passed');
    for (const name of ['write', 'mutate']) {
      expect(r[name]!.status).toBe('error');
      expect(r[name]!.error?.message).toMatch(/production environment.*needs confirmation/);
    }
    expect(hits).toEqual(['GET /engine-get']);
  });

  it('with consent (given to the context, or by the call it is created in) everything is sent', async () => {
    hits.length = 0;
    expect(Object.values(await run(true)).map((x) => x.error?.message)).toEqual([undefined, undefined, undefined]);
    expect(await allowProductionFor(true, () => run(undefined)).then((x) => x.write!.error)).toBeUndefined();
    expect(hits.filter((h) => h.startsWith('POST /engine-post'))).toHaveLength(2);
  });

  it('a non-production environment is never asked about', async () => {
    expect((await run(undefined, 'Dev')).write!.status).toBe('passed');
  });
});

describe('the backend boundary: every send and run method', () => {
  // each method, with parameters against the production environment, and what it would do
  const PROD: Record<string, Record<string, unknown>> = {
    'http.send': { request: { method: 'POST', url: `{{base}}/x` }, environment: 'Production' },
    'http.compareEnvironments': { request: { method: 'DELETE', url: `{{base}}/x` }, left: 'Dev', right: 'Production' },
    'gql.send': { request: { endpoint: '{{base}}/g', query: 'mutation Add { add }' }, environment: 'Production' },
    'grpc.send': { target: 'localhost:1', method: 'vet.v1.Pets/CreatePet', environment: 'Production' },
    'wsock.send': { id: 'nope', data: 'hi', environment: 'Production' },
    'sio.emit': { id: 'nope', event: 'e', environment: 'Production' },
    'mqtt.publish': { id: 'nope', topic: 't', environment: 'Production' },
    'kafka.produce': { id: 'nope', topic: 't', environment: 'Production' },
    'mcp.call': { serverId: 'srv', tool: 'delete_all', args: {} },
    'col.run': { collectionId: 'shop', environment: 'Production' },
    'col.rerunFailed': { runId: 'run-x', collectionId: 'shop', environment: 'Production' },
    'tests.run': { paths: [], environment: 'Production' },
    'tests.rerunFailed': { runId: 'run-x', environment: 'Production' },
    'runs.runAgain': { runId: 'run-x', environment: 'Production' },
    'tests.flowRun': { file: 'a.yaml', environment: 'Production' },
    'tests.dataRun': { file: 'a.yaml', environment: 'Production' },
    'tests.matrixRun': { file: 'a.yaml', environments: ['Dev', 'Production'] },
    'eval.run': { template: {}, environment: 'Production' },
    'eval.runDraft': { draft: { name: 'E' }, environment: 'Production' },
    'rag.probe': { target: { protocol: 'http', step: {}, mapping: { answer: '$.a' } }, question: 'q', environment: 'Production' },
    'load.start': { config: { target: { kind: 'http', request: { method: 'GET', url: '{{base}}' } } }, environment: 'Production' },
    'flows.webhooks.start': { environment: 'Production' },
    'monitor.save': { monitor: { name: 'Prod check', collectionId: 'shop', environment: 'Production', everyMinutes: 60, enabled: false } },
    'ai.attemptFix': { id: FLAKY_PROPOSAL },
  };

  it('every method that sends or runs is guarded (a new one must be added to the guard, or listed here as not sending)', () => {
    const be = backend();
    const NOT_SENDING = new Set([
      'http.cancel',
      'grpc.cancel',
      'runs.cancel',
      'ai.cancel',
      'load.stop',
      'debug.start',
      'mock.start',
      'gql.mock.start',
      'record.start',
      'tests.scaleRun',
      'tests.scaleCancel',
      'tests.scaleRuns',
      'tests.scaleRows',
      'tests.scaleRow',
      'tests.flowRuns',
      'tests.flowRunResults',
      'monitor.testWebhook',
      'mcp.mock.call',
      'tests.deployStatus',
      'runs.resume',
      // reads two finished runs' results
      'eval.compare',
      // the same for two RAG runs, metric by metric
      'rag.compare',
    ]);
    const sending = Object.keys(be.handlers).filter(
      (m) => /(\.send|\.run|Run$|\.publish|\.emit|\.produce|\.call|\.start|rerun|compare)/i.test(m) && !/^(runs|baselines|debug|git|ai|history)\./.test(m),
    );
    expect(sending.filter((m) => !GUARDED_METHODS.includes(m) && !NOT_SENDING.has(m))).toEqual([]);
    expect(Object.keys(PROD).sort()).toEqual([...GUARDED_METHODS].filter((m) => m !== 'monitor.run').sort());
  });

  it('each one is refused without allowProduction, before its handler runs, and named in the ask', async () => {
    const be = backend();
    // an MCP server connected with the production environment (its read-only tools remembered)
    await guardProduction(be, 'mcp.connect', { serverId: 'srv', environment: 'Production' }, async () => ({ tools: [{ name: 'list', annotations: { readOnlyHint: true } }, { name: 'delete_all' }] }));
    for (const [method, params] of Object.entries(PROD)) {
      let ran = false;
      const e = await guardProduction(be, method, params, async () => (ran = true)).then(
        () => undefined,
        (x) => x,
      );
      expect(productionAskOf(e), method).toMatchObject({ environment: 'Production' });
      expect(ran, method).toBe(false);
      // with consent it runs, and the contexts it creates may change production
      const inside = await guardProduction(be, method, { ...params, allowProduction: true }, async () => be.context({ environment: 'Production' }).services.production?.allowed);
      expect(inside, method).toBe(true);
    }
    // a read-only MCP tool and a GET are not asked about, and their contexts may not change production
    expect(await guardProduction(be, 'mcp.call', { serverId: 'srv', tool: 'list' }, async () => be.context({ environment: 'Production' }).services.production?.allowed)).toBe(false);
    expect(await guardProduction(be, 'http.send', { request: { method: 'GET', url: 'x' }, environment: 'Production' }, async () => 'sent')).toBe('sent');
    expect(await guardProduction(be, 'gql.send', { request: { endpoint: 'x', query: '{ a }' }, environment: 'Production' }, async () => 'sent')).toBe('sent');
    expect(await guardProduction(be, 'grpc.send', { method: 'vet.v1.Pets/ListPets', environment: 'Production' }, async () => 'sent')).toBe('sent');
    // the same methods against a non-production environment are not asked about
    expect(await guardProduction(be, 'col.run', { collectionId: 'shop', environment: 'Dev' }, async () => 'ran')).toBe('ran');
  });

  it('a connection keeps the environment it was opened with, and forgets it when closed', async () => {
    const be = backend();
    await guardProduction(be, 'wsock.connect', { url: 'ws://x', environment: 'Production' }, async () => ({ id: 'ws1' }));
    // the active environment is Dev by now: the message still goes to the production server
    await expect(guardProduction(be, 'wsock.send', { id: 'ws1', data: 'x', environment: 'Dev' }, async () => 'sent')).rejects.toMatchObject({ details: { environment: 'Production' } });
    await guardProduction(be, 'wsock.close', { id: 'ws1' }, async () => undefined);
    expect(await guardProduction(be, 'wsock.send', { id: 'ws1', data: 'x', environment: 'Dev' }, async () => 'sent')).toBe('sent');
  });

  it('a collection run says how many requests change data', async () => {
    const be = backend();
    const e = await be.invoke('col.run', { collectionId: 'shop', environment: 'Production' }).catch((x) => x);
    expect(productionAskOf(e)).toMatchObject({ run: true, requests: 3, changing: 2, action: 'Run Shop' });
  });

  it('through invoke: a POST is refused and never sent; with allowProduction it is', async () => {
    const be = backend();
    hits.length = 0;
    await expect(be.invoke('http.send', { request: { method: 'POST', url: '{{base}}/invoke' }, environment: 'Production' })).rejects.toMatchObject({ details: { code: 'PRODUCTION_CONFIRMATION' } });
    expect(hits).toEqual([]);
    const r = (await be.invoke('http.send', { request: { method: 'POST', url: '{{base}}/invoke' }, environment: 'Production', allowProduction: true })) as { response?: { status: number } };
    expect(r.response?.status).toBe(200);
    expect(hits).toEqual(['POST /invoke']);
    // a GET needs no consent
    const g = (await be.invoke('http.send', { request: { method: 'GET', url: '{{base}}/read' }, environment: 'Production' })) as { response?: { status: number } };
    expect(g.response?.status).toBe(200);
  });

  it('a pre-request script that turns a GET into a POST is stopped by the engine check', async () => {
    const be = backend();
    hits.length = 0;
    const r = (await be.invoke('http.send', { request: { method: 'GET', url: '{{base}}/sneaky' }, environment: 'Production', preRequestScript: 'tp.request.method = "POST"' })) as {
      error?: { message: string };
    };
    expect(r.error?.message).toMatch(/needs confirmation/);
    expect(hits).toEqual([]);
  });

  it('tp.sendRequest is a send: a GET whose scripts send asks first, and without consent the script request is not sent', async () => {
    const be = backend();
    hits.length = 0;
    const script = 'tp.sendRequest({ url: tp.environment.get("base") + "/script-post", method: "POST" }, (err) => tp.environment.set("scriptErr", String(err && err.message)))';
    // the backend asks: the scripts may change data whatever the request's method
    const e = await be.invoke('http.send', { request: { method: 'GET', url: '{{base}}/with-script' }, environment: 'Production', preRequestScript: script }).catch((x) => x);
    expect(productionAskOf(e)).toMatchObject({ changesData: true, action: expect.stringMatching(/its scripts send requests too/) });
    // the engine refuses it in a context without consent (a run's step, the CLI) …
    const store = WorkspaceStore.open(root);
    const ctx = createEngineContext({ store, secrets: new MemorySecretStore(), environment: 'Production' });
    const results: TestResult[] = [];
    try {
      await runTests({ name: 's', tests: [{ id: 's', name: 'scripted', type: 'http', request: { method: 'GET', url: '{{base}}/step-get' }, preRequestScript: script } as TestCase], services: ctx.services, concurrency: 1, onEvent: (x) => x.type === 'test-end' && results.push(x.result) });
    } finally {
      await ctx.dispose();
      store.close();
    }
    expect(hits).toEqual(['GET /step-get']);
    expect(JSON.stringify(results[0]!.metadata?.sentRequests ?? [])).toMatch(/needs confirmation/);
    // … and sends it with consent
    hits.length = 0;
    await be.invoke('http.send', { request: { method: 'GET', url: '{{base}}/with-script' }, environment: 'Production', preRequestScript: script, allowProduction: true });
    expect(hits.sort()).toEqual(['GET /with-script', 'POST /script-post']);
  });

  it('every tp.sendRequest sender is given its context’s production gate', () => {
    const roots = [join(__dirname, '../../packages/core/src'), join(__dirname, '../../packages/cli/src'), join(__dirname, '../../apps/desktop/backend')];
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : /\.ts$/.test(f) ? [join(d, f)] : []));
    const calls = roots.flatMap(walk).flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/scriptRequestSender\(\{([^}]*)\}\)/g)].map((m) => ({ f, args: m[1]! })));
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.filter((c) => !/\bproduction:/.test(c.args)).map((c) => c.f)).toEqual([]);
  });

  it('a monitor on production is saved with consent only when it was given, and keeps it while its environment does', async () => {
    const be = backend();
    const m = { name: 'Prod check', collectionId: 'shop', environment: 'Production', everyMinutes: 60, enabled: false, allowProduction: true };
    // the consent sent inside the monitor does not count
    await expect(be.invoke('monitor.save', { monitor: m })).rejects.toMatchObject({ details: { code: 'PRODUCTION_CONFIRMATION' } });
    const saved = (await be.invoke('monitor.save', { monitor: m, allowProduction: true })) as { id: string; allowProduction?: boolean };
    expect(saved.allowProduction).toBe(true);
    // saved again (another name): not asked, consent kept
    const again = (await be.invoke('monitor.save', { monitor: { ...m, id: saved.id, name: 'Renamed', allowProduction: undefined } })) as { allowProduction?: boolean };
    expect(again.allowProduction).toBe(true);
    // Run now of a monitor with consent asks nothing more
    await expect(guardProduction(be, 'monitor.run', { id: saved.id }, async () => 'ran')).resolves.toBe('ran');
    // moved to Dev: no consent kept; back to Production: asked again
    expect(((await be.invoke('monitor.save', { monitor: { ...m, id: saved.id, environment: 'Dev' } })) as { allowProduction?: boolean }).allowProduction).toBeUndefined();
    await expect(be.invoke('monitor.save', { monitor: { ...m, id: saved.id } })).rejects.toMatchObject({ details: { code: 'PRODUCTION_CONFIRMATION' } });
    await be.invoke('monitor.delete', { id: saved.id });
  });

  it('Attempt to fix (AI-5) asks before running a flaky test in production; refused, nothing is applied or sent', async () => {
    const be = backend();
    hits.length = 0;
    const e = await be.invoke('ai.attemptFix', { id: FLAKY_PROPOSAL, times: 3 }).catch((x) => x);
    expect(productionAskOf(e)).toMatchObject({ environment: 'Production', run: true, action: 'Attempt to fix Job is done: run it 3 times' });
    expect(hits).toEqual([]);
    expect(be.ws.readTestFile('flaky/jobs.yaml')).toBe(JOBS);
    expect(getProposal(be.ws, FLAKY_PROPOSAL).status).toBe('open');
    // the MCP server started without --allow-production refuses it the same way as run_tests, before applying
    const srv = createTestPionMcpServer({ store: be.ws, secrets: new MemorySecretStore(), settings: new WorkspaceManager(join(tmp.dir, 'mcp-home')).loadSettings() });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await srv.connect(a);
    await client.connect(b);
    try {
      const r = (await client.callTool({ name: 'ai_attempt_fix', arguments: { id: FLAKY_PROPOSAL, times: 2, confirm: true } })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/"Production" is a production environment.*--allow-production/);
    } finally {
      await client.close();
    }
    expect(hits).toEqual([]);
    expect(be.ws.readTestFile('flaky/jobs.yaml')).toBe(JOBS);
    // with the window's consent: applied, then run there
    const ok = (await be.invoke('ai.attemptFix', { id: FLAKY_PROPOSAL, times: 3, allowProduction: true })) as { attempt: { verdict: string; runs: number } };
    expect(ok.attempt).toMatchObject({ verdict: 'stable', runs: 3 });
    expect(hits).toEqual(['GET /job', 'GET /job', 'GET /job']);
    expect(be.ws.readTestFile('flaky/jobs.yaml')).toMatch(/Job is done \(fixed\)/);
  });

  it('a monitor without consent runs its reads on its schedule but not its writes', async () => {
    const be = backend();
    const store = be.ws;
    const { saveMonitor, executeMonitor } = await import('../../packages/core/src/index.js');
    const mon = saveMonitor(store, { id: 'mon-p', name: 'Sched', collectionId: 'shop', environment: 'Production', everyMinutes: 60, enabled: false });
    hits.length = 0;
    const r = await executeMonitor({ store, monitor: mon, trigger: 'schedule', context: (o) => be.context(o) });
    expect(r.errors).toBe(2);
    expect(hits).toEqual(['GET /list']);
    hits.length = 0;
    const ok = await executeMonitor({ store, monitor: { ...mon, allowProduction: true }, trigger: 'schedule', context: (o) => be.context(o) });
    expect(ok.errors).toBe(0);
    expect(hits).toHaveLength(3);
  });
});

describe('the MCP server', () => {
  it('every sending tool with an environment takes allowProduction, which counts only when the server allows production', async () => {
    const seen: boolean[] = [];
    const tool: Tool = {
      name: 'send_x',
      write: true,
      description: '',
      inputSchema: { type: 'object', properties: { environment: { type: 'string' } } },
      run: () => void seen.push(productionAllowed()),
    };
    const read: Tool = { name: 'list_x', description: '', inputSchema: { type: 'object', properties: { environment: { type: 'string' } } }, run: () => void seen.push(productionAllowed()) };
    const [allowing] = withProductionConsent([tool], true);
    const [refusing] = withProductionConsent([tool], false);
    const [reading] = withProductionConsent([read], true);
    expect(allowing!.inputSchema.properties.allowProduction).toMatchObject({ type: 'boolean' });
    expect(reading!.inputSchema.properties.allowProduction).toBeUndefined();
    await allowing!.run({ allowProduction: true });
    await allowing!.run({});
    await refusing!.run({ allowProduction: true });
    await reading!.run({ allowProduction: true });
    expect(seen).toEqual([true, false, false, false]);
  });

  it('send_request: a POST to production is refused without allowProduction, sent with it', async () => {
    const store = WorkspaceStore.open(root);
    const srv = createTestPionMcpServer({ store, secrets: new MemorySecretStore(), settings: new WorkspaceManager(join(tmp.dir, 'mcp-home')).loadSettings(), allowProduction: true });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await srv.connect(a);
    await client.connect(b);
    try {
      const tools = await client.listTools();
      for (const name of ['send_request', 'run_collection', 'run_tests', 'grpc_call']) expect(tools.tools.find((t) => t.name === name)?.inputSchema.properties, name).toHaveProperty('allowProduction');
      hits.length = 0;
      const refused = (await client.callTool({ name: 'send_request', arguments: { method: 'POST', url: '{{base}}/mcp', environment: 'Production' } })) as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      expect(refused.isError).toBe(true);
      expect(refused.content[0]!.text).toMatch(/needs confirmation/);
      expect(hits).toEqual([]);
      const sent = (await client.callTool({ name: 'send_request', arguments: { method: 'POST', url: '{{base}}/mcp', environment: 'Production', allowProduction: true } })) as { isError?: boolean };
      expect(sent.isError).toBeFalsy();
      expect(hits).toEqual(['POST /mcp']);
      // a saved request run by name goes through the engine check the same way
      const saved = (await client.callTool({ name: 'send_request', arguments: { collection: 'Shop', request: 'Create', environment: 'Production' } })) as { content: Array<{ text: string }> };
      expect(saved.content[0]!.text).toMatch(/needs confirmation/);
    } finally {
      await client.close();
      store.close();
    }
  });

  it('save_monitor replacing a monitor keeps its production consent (same environment); a call never grants it', async () => {
    const store = WorkspaceStore.open(root);
    const srv = createTestPionMcpServer({ store, secrets: new MemorySecretStore(), settings: new WorkspaceManager(join(tmp.dir, 'mcp-home')).loadSettings(), allowProduction: true });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await srv.connect(a);
    await client.connect(b);
    const consent = (name: string) => listMonitors(store).find((m) => m.name === name)?.allowProduction;
    const save = (args: Record<string, unknown>) => client.callTool({ name: 'save_monitor', arguments: { collection: 'Shop', every: '1h', enabled: false, ...args } }) as Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
    try {
      // consent given in the app (or with --allow-production)
      saveMonitor(store, { id: 'mon-consent', name: 'Prod watch', collectionId: 'shop', environment: 'Production', everyMinutes: 60, enabled: false, allowProduction: true });
      const r = await save({ name: 'Prod watch', environment: 'Production', every: '30m' });
      expect(r.isError, r.content[0]?.text).toBeFalsy();
      expect(consent('Prod watch')).toBe(true);
      expect(listMonitors(store).find((m) => m.name === 'Prod watch')?.everyMinutes).toBe(30);
      // another environment: the consent was for production, it goes
      await save({ name: 'Prod watch', environment: 'Dev' });
      expect(consent('Prod watch')).toBeUndefined();
      // back on production: not given again by the call
      await save({ name: 'Prod watch', environment: 'Production' });
      expect(consent('Prod watch')).toBeUndefined();
      // a new monitor never gets it from what the caller sends
      await save({ name: 'New prod watch', environment: 'Production', allowProduction: true });
      expect(consent('New prod watch')).toBeUndefined();
    } finally {
      await client.close();
      store.close();
    }
  });
});

describe('the CLI', () => {
  // (the CLI runs in its own process: async, so this process's test server can answer it)
  it('send and run-collection refuse data changes on production without --allow-production', async () => {
    const home = join(tmp.dir, 'cli-home');
    hits.length = 0;
    const refused = await runCli(['send', `${base}/cli`, '-X', 'POST', '-w', root, '-e', 'Production'], { home });
    expect(refused.status).not.toBe(0);
    expect(refused.err + refused.out).toMatch(/needs confirmation/);
    // the message says what to add (a CI pipeline that writes to production fails with it)
    expect(refused.err + refused.out).toMatch(/--allow-production/);
    expect(hits).toEqual([]);
    const sent = await runCli(['send', `${base}/cli`, '-X', 'POST', '-w', root, '-e', 'Production', '--allow-production'], { home });
    expect(sent.status).toBe(0);
    expect(hits).toEqual(['POST /cli']);
    hits.length = 0;
    const run = await runCli(['run-collection', 'Shop', '-w', root, '-e', 'Production', '-r', 'json', '-o', join(tmp.dir, 'cli-out')], { home });
    expect(run.status).not.toBe(0);
    expect(run.out + run.err).toMatch(/--allow-production/);
    expect(hits).toEqual(['GET /list']);
    const runAllowed = await runCli(['run-collection', 'Shop', '-w', root, '-e', 'Production', '-r', 'json', '-o', join(tmp.dir, 'cli-out2'), '--allow-production'], { home });
    expect(runAllowed.out + runAllowed.err).not.toMatch(/needs confirmation/);
  }, 120_000);
});
