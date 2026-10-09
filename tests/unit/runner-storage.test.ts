import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runTests,
  readResultsFile,
  writeReports,
  createBaseline,
  compareToBaseline,
  streamTests,
  loadSuite,
  readDataset,
  normalizeTest,
  WorkspaceManager,
  WorkspaceStore,
  migrateWorkspace,
  EncryptedFileSecretStore,
  EnvSecretStore,
  MemorySecretStore,
  envNameForSecret,
  createEngineContext,
  importAny,
  WorkspaceSearch,
  readJson,
  ProviderRegistry,
  VariableScope,
  McpManager,
  Redactor,
  type ExecServices,
  type TestCase,
  type TestResult,
} from '../../packages/core/src/index.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aps-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function services(): ExecServices {
  const vars = new VariableScope();
  const redactor = new Redactor();
  return {
    vars,
    providers: new ProviderRegistry([], vars, redactor),
    mcp: new McpManager(() => undefined),
    mcpServers: [],
    redactor,
    pricing: [],
    defaultTimeoutMs: 5000,
  };
}

/** LLM tests against the offline mock provider — no network needed. */
function llmTest(i: number, extra: Partial<TestCase> = {}): TestCase {
  return { id: `t${i}`, name: `test ${i}`, type: 'llm', model: { provider: 'mock', name: 'mock' }, prompt: `hello ${i}`, assertions: [{ type: 'contains', expected: `hello ${i}` }], ...extra } as TestCase;
}

describe('runner', () => {
  it('runs tests in parallel with bounded concurrency and streams results', async () => {
    const events: string[] = [];
    const file = join(dir, 'results.jsonl');
    const summary = await runTests({
      name: 'parallel',
      tests: Array.from({ length: 25 }, (_, i) => llmTest(i)),
      concurrency: 5,
      services: services(),
      resultsFile: file,
      onEvent: (e) => events.push(e.type),
    });
    expect(summary).toMatchObject({ total: 25, passed: 25, failed: 0 });
    expect(events[0]).toBe('run-start');
    expect(events.at(-1)).toBe('run-end');
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(25);
    expect(summary.tokens.totalTokens).toBeGreaterThan(0);
  });

  it('handles dependencies, skip, retries and setup/teardown', async () => {
    const order: string[] = [];
    const summary = await runTests({
      name: 'deps',
      setup: [llmTest(100, { name: 'setup' })],
      teardown: [llmTest(101, { name: 'teardown' })],
      tests: [
        llmTest(2, { dependsOn: ['t1'] }),
        llmTest(1),
        llmTest(3, { dependsOn: ['t4'], assertions: [{ type: 'contains', expected: 'x' }] }),
        llmTest(4, { assertions: [{ type: 'contains', expected: 'never' }], retries: 2 }),
        llmTest(5, { skip: true }),
        llmTest(6, { dependsOn: ['does-not-exist'] }),
      ],
      concurrency: 2,
      retryDelayMs: 1,
      services: services(),
      onEvent: (e) => e.type === 'test-end' && order.push(`${e.result.id}:${e.result.status}:${e.result.attempts}`),
    });
    expect(order).toContain('t1:passed:1');
    expect(order.indexOf('t1:passed:1')).toBeLessThan(order.indexOf('t2:passed:1'));
    expect(order).toContain('t4:failed:3');
    expect(order).toContain('t3:skipped:0');
    expect(order).toContain('t5:skipped:0');
    expect(order).toContain('t6:skipped:0');
    expect(order[0]).toBe('t100:passed:1');
    expect(order.at(-1)).toBe('t101:passed:1');
    expect(summary).toMatchObject({ passed: 4, failed: 1, skipped: 3 });
  });

  it('cancels and resumes from the results checkpoint', async () => {
    const file = join(dir, 'r.jsonl');
    const ctrl = new AbortController();
    let n = 0;
    const tests = () => Array.from({ length: 40 }, (_, i) => llmTest(i));
    const first = await runTests({
      name: 'resumable',
      tests: tests(),
      concurrency: 1,
      services: services(),
      resultsFile: file,
      signal: ctrl.signal,
      onEvent: (e) => {
        if (e.type === 'test-end' && ++n === 10) ctrl.abort();
      },
    });
    expect(first.cancelled).toBe(true);
    expect(first.total).toBeLessThan(40);
    const second = await runTests({ name: 'resumable', tests: tests(), concurrency: 4, services: services(), resultsFile: file, resume: true });
    expect(second.total).toBe(40);
    const ids = new Set<string>();
    for await (const r of await readResultsFile(file)) ids.add(r.id);
    expect(ids.size).toBe(40);
  });

  it('streams very large suites without holding results in memory', async () => {
    let produced = 0;
    async function* many() {
      for (let i = 0; i < 3000; i++) {
        produced++;
        yield llmTest(i, { assertions: [] });
      }
    }
    const s = await runTests({ name: 'big', tests: many(), concurrency: 50, services: services(), traceMode: 'none' });
    expect(produced).toBe(3000);
    expect(s.total).toBe(3000);
    expect(s.latency.count).toBe(3000);
  });

  it('writes JUnit, JSON, HTML and Markdown reports and detects regressions', async () => {
    const file = join(dir, 'res.jsonl');
    const summary = await runTests({ name: 'report', tests: [llmTest(1), llmTest(2, { assertions: [{ type: 'contains', expected: 'zzz' }] })], services: services(), resultsFile: file });
    const paths = await writeReports(join(dir, 'reports'), summary, () => readResults(file));
    const junit = readFileSync(paths.junit, 'utf8');
    expect(junit).toContain('<testsuites');
    expect(junit).toContain('failures="1"');
    expect(JSON.parse(readFileSync(paths.json, 'utf8')).results).toHaveLength(2);
    expect(readFileSync(paths.html, 'utf8')).toContain('FAILED');
    expect(readFileSync(paths.markdown, 'utf8')).toContain('❌');

    const baseline = await createBaseline('base', { ...summary, failed: 0, passed: 2 }, readResults(file));
    baseline.tests.t2!.status = 'passed';
    const cmp = await compareToBaseline(baseline, summary, readResults(file));
    expect(cmp.regressions.some((r) => r.id === 't2' && r.kind === 'new-failure')).toBe(true);
    expect(cmp.passed).toBe(false);
  });
});

async function* readResults(file: string): AsyncGenerator<TestResult> {
  for await (const r of await readResultsFile(file)) yield r;
}

describe('loader & datasets', () => {
  it('normalises the SRS appendix formats', () => {
    const llm = normalizeTest({
      name: 'Customer Intent Classification',
      type: 'llm',
      model: { provider: 'openai-compatible', name: 'model-name', temperature: 0 },
      input: { message: 'I need to cancel my appointment' },
      prompt: 'Classify.\n{{message}}',
      expected: { intent: 'cancellation' },
      evaluators: [{ type: 'json-schema' }, { type: 'exact-match', path: '$.intent', expected: 'cancellation' }],
      limits: { latency_ms: 3000 },
    });
    expect(llm).toMatchObject({ type: 'llm', model: { provider: 'openai-compatible', name: 'model-name', temperature: 0 }, input: { message: 'I need to cancel my appointment' } });
    const mcp = normalizeTest({ name: 'x', type: 'mcp', server: { name: 'customer-mcp' }, tool: { name: 'search_customer' }, arguments: { customer_id: '123' } });
    expect(mcp).toMatchObject({ server: 'customer-mcp', tool: 'search_customer' });
    const gql = normalizeTest({ name: 'g', type: 'graphql', endpoint: '{{graphqlEndpoint}}', query: '{ a }', variables: { id: '123' } });
    expect(gql).toMatchObject({ graphqlVariables: { id: '123' } });
    const httpT = normalizeTest({ name: 'h', type: 'http', method: 'post', url: '/x', headers: { a: 'b' }, body: { k: 1 } });
    expect(httpT).toMatchObject({ request: { method: 'POST', headers: [{ key: 'a', value: 'b' }], body: { type: 'json' } } });
    expect(normalizeTest({ name: 's', type: 'llm', model: 'openai/gpt', prompt: 'p' })).toMatchObject({ model: { provider: 'openai', name: 'gpt' } });
  });

  it('streams JSONL, CSV and Markdown datasets', async () => {
    writeFileSync(join(dir, 'd.jsonl'), '{"input":"Cancel my appointment","expected":"cancellation"}\n{"input":"I need a refill","expected":"refill"}\n');
    writeFileSync(join(dir, 'd.csv'), 'input,expected\n"Cancel, please",cancellation\nrefill me,refill\n');
    writeFileSync(join(dir, 'd.md'), '| input | expected |\n|---|---|\n| hi | greeting |\n');
    const read = async (p: string, o = {}) => {
      const out = [];
      for await (const r of readDataset({ path: join(dir, p), ...o })) out.push(r);
      return out;
    };
    expect(await read('d.jsonl')).toHaveLength(2);
    expect((await read('d.csv'))[0]).toEqual({ input: 'Cancel, please', expected: 'cancellation' });
    expect(await read('d.md')).toEqual([{ input: 'hi', expected: 'greeting' }]);
    expect(await read('d.jsonl', { offset: 1, limit: 1 })).toEqual([{ input: 'I need a refill', expected: 'refill' }]);
  });

  it('discovers test files, expands datasets and loads suites', async () => {
    mkdirSync(join(dir, 'tests', 'ai'), { recursive: true });
    writeFileSync(join(dir, 'tests', 'a.yaml'), 'name: A\ntype: llm\nmodel: mock\nprompt: hi\ntags: [smoke]\n');
    writeFileSync(join(dir, 'tests', 'ai', 'cases.jsonl'), '{"id":"c1","message":"cancel it","expected":"cancellation"}\n{"id":"c2","message":"refill","expected":"refill"}\n');
    writeFileSync(join(dir, 'tests', 'ai', 'dataset.yaml'), 'name: Intent\ntype: llm\nmodel: mock\nprompt: "Classify {{message}}"\ndataset:\n  path: cases.jsonl\n');
    writeFileSync(join(dir, 'tests', 'multi.yaml'), 'defaults:\n  type: llm\n  model: mock\ntests:\n  - name: M1\n    prompt: a\n  - name: M2\n    prompt: b\n');
    writeFileSync(join(dir, 'smoke.suite.yaml'), 'name: Smoke\ntests: [tests]\nconcurrency: 3\n');
    const all: TestCase[] = [];
    for await (const t of streamTests(['tests'], dir)) all.push(t);
    expect(all.map((t) => t.name).sort()).toEqual(['A', 'Intent [c1]', 'Intent [c2]', 'M1', 'M2']);
    const intent = all.find((t) => t.name === 'Intent [c1]')!;
    expect(intent).toMatchObject({ input: { message: 'cancel it' }, expected: 'cancellation' });
    const smoke: TestCase[] = [];
    for await (const t of streamTests(['tests/**/*.yaml'], dir, { tags: ['smoke'] })) smoke.push(t);
    expect(smoke.map((t) => t.name)).toEqual(['A']);
    expect((await loadSuite(join(dir, 'smoke.suite.yaml'))).concurrency).toBe(3);
  });
});

describe('workspace storage', () => {
  it('creates, opens, migrates and detects corruption', () => {
    const mgr = new WorkspaceManager(join(dir, 'app'));
    const ws = mgr.create('Veterinary API');
    expect(mgr.list().map((w) => w.name)).toEqual(['Veterinary API']);
    expect(ws.listEnvironments()[0]!.name).toBe('Development');
    ws.saveCollection({ schemaVersion: '1.0', id: 'c1', name: 'C1', version: 0, variables: [], items: [], updatedAt: '' });
    expect(ws.getCollection('c1').version).toBe(1);
    ws.close();

    // corrupted collection is reported, preserved and does not break listing
    writeFileSync(join(ws.root, 'collections', 'broken.json'), '{ not json');
    const reopened = mgr.open('veterinary api');
    const cols = reopened.listCollections();
    expect(cols.find((c) => c.id === 'broken')?.problem).toMatch(/Corrupted/);
    expect(readdirSync(join(ws.root, 'collections')).some((f) => f.startsWith('broken.json.corrupt-'))).toBe(true);
    reopened.close();

    const dup = mgr.duplicate('Veterinary API', 'Copy');
    expect(existsSync(join(dup.path, 'collections', 'c1.json'))).toBe(true);
    mgr.delete('Copy');
    expect(mgr.list()).toHaveLength(1);
  });

  it('runs migrations and refuses newer formats', () => {
    const { ws, applied } = migrateWorkspace({ schemaVersion: '0.9', variables: { baseUrl: 'x' } });
    expect(applied).toEqual(['0.9 → 1.0']);
    expect(ws.variables).toEqual([{ key: 'baseUrl', value: 'x', enabled: true }]);
    expect(() => migrateWorkspace({ schemaVersion: '9.0' })).toThrow(/newer/);

    const root = join(dir, 'legacy');
    mkdirSync(root);
    writeFileSync(join(root, 'workspace.json'), JSON.stringify({ schemaVersion: '0.9', id: 'ws-old', name: 'Old', variables: { a: 1 }, createdAt: '', updatedAt: '' }));
    const store = WorkspaceStore.open(root);
    expect(store.migrationsApplied).toEqual(['0.9 → 1.0']);
    expect(readJson<{ schemaVersion: string }>(join(root, 'workspace.json')).schemaVersion).toBe('1.0');
    expect(existsSync(join(root, 'workspace.json.bak-0.9'))).toBe(true);
    store.close();
  });

  it('workspace manager: details, rename, and delete (managed folders removed, opened folders kept)', () => {
    const mgr = new WorkspaceManager(join(dir, 'app'));
    const a = mgr.create('Alpha');
    a.saveEnvironment({ id: 'dev', name: 'Dev', variables: [] });
    const envCount = a.listEnvironments().length;
    const aRoot = a.root;
    a.close();
    const extRoot = join(dir, 'external-ws');
    mgr.create('Beta', extRoot).close();
    mgr.saveSettings({ ...mgr.loadSettings(), lastWorkspace: aRoot });

    expect(mgr.details('alpha')).toMatchObject({ name: 'Alpha', managed: true, environments: envCount, collections: 0 });
    expect(mgr.details(extRoot)).toMatchObject({ name: 'Beta', managed: false });
    expect(mgr.rename('Alpha', '  Alpha 2 ').name).toBe('Alpha 2');
    expect(mgr.list().map((w) => w.name)).toEqual(['Alpha 2', 'Beta']);
    expect(() => mgr.rename('nope', 'x')).toThrow(/not found/);

    expect(mgr.delete('Alpha 2')).toEqual({ deletedFiles: true });
    expect(existsSync(aRoot)).toBe(false);
    expect(mgr.loadSettings().lastWorkspace).toBeUndefined();
    expect(mgr.delete('Beta')).toEqual({ deletedFiles: false });
    expect(existsSync(join(extRoot, 'workspace.json'))).toBe(true);
    expect(mgr.list()).toEqual([]);
    expect(() => mgr.delete('Beta')).toThrow(/not found/);
  });

  it('keeps a user-chosen environment order', () => {
    const ws = new WorkspaceManager(join(dir, 'app')).create('Order');
    for (const [id, name] of [['development', 'Development'], ['production', 'Production'], ['staging', 'Staging'], ['uat', 'User Acceptance']])
      ws.saveEnvironment({ id: id!, name: name!, variables: [] });
    const names = () => ws.listEnvironments().map((e) => e.name);
    expect(names()).toEqual(['Development', 'Production', 'Staging', 'User Acceptance']);
    ws.reorderEnvironments(['development', 'uat', 'staging']);
    expect(names()).toEqual(['Development', 'User Acceptance', 'Staging', 'Production']);
    // saving from a stale copy (old order) does not move it; new environments go last
    ws.saveEnvironment({ id: 'uat', name: 'UAT', variables: [], order: 3 });
    ws.saveEnvironment({ id: 'alpha', name: 'Alpha', variables: [] });
    expect(names()).toEqual(['Development', 'UAT', 'Staging', 'Production', 'Alpha']);
    ws.close();
  });

  it('never persists secrets in plain text', async () => {
    const mgr = new WorkspaceManager(join(dir, 'app'));
    const ws = mgr.create('Secrets');
    const cipher = { isAvailable: () => true, encrypt: (s: string) => Buffer.from(s).reverse(), decrypt: (b: Buffer) => Buffer.from(b).reverse().toString(), backend: 'test' };
    const secrets = new EncryptedFileSecretStore(join(dir, 'app', 'secrets.json'), cipher);
    await secrets.set('env.development.accessToken', 'tok-SECRET-123');
    ws.saveEnvironment({ id: 'development', name: 'Development', variables: [{ key: 'accessToken', value: 'tok-SECRET-123', secret: true }] });
    const onDisk = readFileSync(join(ws.root, 'environments', 'development.json'), 'utf8') + readFileSync(join(dir, 'app', 'secrets.json'), 'utf8');
    expect(onDisk).not.toContain('tok-SECRET-123');
    const ctx = createEngineContext({ store: ws, secrets, environment: 'Development' });
    expect(ctx.vars.resolve('{{accessToken}}')).toBe('tok-SECRET-123');
    expect(ctx.redactor.redactString('Bearer tok-SECRET-123')).toBe('Bearer [REDACTED]');
    expect(() => ws.saveProviders([{ id: 'p', name: 'P', kind: 'openai-compatible', baseUrl: 'x', apiKey: 'sk-literal' }])).toThrow(/literal API key/);
    const unavailable = new EncryptedFileSecretStore(join(dir, 'x.json'), { ...cipher, isAvailable: () => false });
    await expect(unavailable.set('a', 'b')).rejects.toThrow(/plain text/);
    ws.close();
  });

  it('reads CI secrets from TESTPION_SECRET_* env vars', () => {
    expect(envNameForSecret('provider.openai.apiKey')).toBe('TESTPION_SECRET_PROVIDER_OPENAI_APIKEY');
    const s = new EnvSecretStore({ TESTPION_SECRET_PROVIDER_OPENAI_APIKEY: 'k' });
    expect(s.get('provider.openai.apiKey')).toBe('k');
    expect(new MemorySecretStore().writable).toBe(true);
  });

  it('records history/traces in the metadata store and searches the workspace', () => {
    const mgr = new WorkspaceManager(join(dir, 'app'));
    const ws = mgr.create('Search');
    ws.saveCollection({
      schemaVersion: '1.0',
      id: 'pets',
      name: 'Pets API',
      version: 0,
      variables: [],
      items: [{ kind: 'folder', id: 'f', name: 'Patients', items: [{ kind: 'http', id: 'r1', name: 'Get Patient', request: { method: 'GET', url: '{{baseUrl}}/patients/1' } }] }],
      updatedAt: '',
    });
    ws.writeTestFile('smoke/health.yaml', 'name: Health check\ntype: http\nurl: http://x/health\n');
    ws.meta.addHistory({ id: 'h1', timestamp: new Date().toISOString(), kind: 'http', name: 'GET /health', method: 'GET', url: 'http://x/health', status: 200, durationMs: 5 });
    expect(ws.meta.listHistory({ query: 'health' }).total).toBe(1);
    const hits = new WorkspaceSearch(ws).search('patient');
    expect(hits[0]).toMatchObject({ kind: 'request', title: 'Get Patient' });
    expect(new WorkspaceSearch(ws).search('health').some((h) => h.kind === 'test')).toBe(true);
    expect(() => ws.writeTestFile('../escape.yaml', 'x')).toThrow(/escapes/);
    ws.close();
  });
});

describe('importers', () => {
  it('imports OpenAPI 3 with tags, params, bodies and auth', () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'Vet API' },
      servers: [{ url: 'https://api.vet.test/v1' }],
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } }, schemas: { Patient: { type: 'object', properties: { name: { type: 'string', example: 'Rex' }, age: { type: 'integer' } } } } },
      security: [{ bearer: [] }],
      paths: {
        '/patients/{id}': { get: { tags: ['Patients'], summary: 'Get patient', parameters: [{ name: 'id', in: 'path' }, { name: 'expand', in: 'query' }], responses: { 200: {} } } },
        '/patients': { post: { tags: ['Patients'], summary: 'Create patient', requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Patient' } } } }, responses: { 201: {} } } },
      },
    };
    const { format, collection } = importAny(JSON.stringify(spec));
    expect(format).toBe('openapi');
    expect(collection!.variables[0]).toMatchObject({ key: 'baseUrl', value: 'https://api.vet.test/v1' });
    const folder = collection!.items[0] as { name: string; items: Array<{ request: { url: string; body?: { content: string }; auth?: unknown }; assertions?: unknown[] }> };
    expect(folder.name).toBe('Patients');
    expect(folder.items[0]!.request.url).toBe('{{baseUrl}}/patients/{{id}}');
    expect(folder.items[0]!.request.auth).toEqual({ type: 'bearer', token: '{{accessToken}}' });
    expect(JSON.parse(folder.items[1]!.request.body!.content)).toEqual({ name: 'Rex', age: 0 });
    expect(folder.items[1]!.assertions).toEqual([{ type: 'status', expected: 201 }]);
  });

  it('imports Postman collections and HAR', () => {
    const pm = {
      info: { name: 'PM', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [{ name: 'Login', request: { method: 'POST', url: { raw: 'https://x.test/login?a=1', query: [{ key: 'a', value: '1' }] }, body: { mode: 'raw', raw: '{"u":1}', options: { raw: { language: 'json' } } } }, event: [{ listen: 'test', script: { exec: ['pm.test("ok", () => {})'] } }] }],
    };
    const r = importAny(JSON.stringify(pm));
    expect(r.format).toBe('postman');
    const req = r.collection!.items[0] as { request: { url: string; params: unknown[]; body: { type: string } }; testScript: string };
    expect(req.request.url).toBe('https://x.test/login');
    expect(req.request.params).toEqual([{ key: 'a', value: '1', enabled: true }]);
    expect(req.request.body.type).toBe('json');
    // pm.* scripts come over as tp.* by default
    expect(req.testScript).toContain('tp.test');
    expect(r.scripts).toMatchObject({ converted: 1, unchanged: [] });
    const har = { log: { entries: [{ request: { method: 'GET', url: 'https://x.test/a?b=2', headers: [{ name: 'Accept', value: '*/*' }] }, response: { status: 200 } }] } };
    expect(importAny(JSON.stringify(har)).collection!.items).toHaveLength(1);
  });
});

describe('settings recovery', () => {
  it('resets to defaults (and keeps a backup) when settings.json is corrupted', () => {
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'settings.json'), '{ "lastWorkspace": "D:\Dev" '); // invalid JSON
    const mgr = new WorkspaceManager(home);
    const s = mgr.loadSettings();
    expect(s.theme).toBe('system');
    expect(mgr.settingsProblem).toMatch(/Corrupted/);
    expect(readdirSync(home).some((f) => f.startsWith('settings.json.corrupt-'))).toBe(true);
  });
});
