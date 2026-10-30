import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  MemorySecretStore,
  WorkspaceManager,
  WorkspaceStore,
  createEngineContext,
  listMonitors,
  loadSuite,
  loadTestsFromFile,
  parseYaml,
  runTests,
  streamTests,
  validateCustomMetric,
  validateMonitor,
  type TestCase,
} from '../../packages/core/src/index.js';
import { Backend } from '../../apps/desktop/backend/backend.js';

// The examples workspace ships with the app and opens on first launch (examples/public-workspace).
// Its public-API tests need the internet, so CI checks that every file loads and runs the Offline suite
// (offline demo model + mock MCP server) end to end.
const template = resolve('examples/public-workspace');
const dir = mkdtempSync(join(tmpdir(), 'tp-examples-'));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));

describe('examples workspace (public APIs)', () => {
  const root = join(dir, 'ws');
  cpSync(template, root, { recursive: true });
  const store = WorkspaceStore.open(root);
  afterAll(() => store.close());

  it('has valid collections, environment, providers, MCP servers, saved items and monitors', () => {
    const cols = store.listCollections();
    expect(cols.filter((c) => c.problem)).toEqual([]);
    expect(cols.map((c) => c.id).sort()).toEqual(['graphql-public', 'grpc', 'httpbin', 'jsonplaceholder', 'live-streams', 'petstore', 'public-rest', 'realtime', 'soap']);
    expect(store.getEnvironment('Public APIs')?.variables.some((v) => v.key === 'petstoreMcp')).toBe(true);
    expect(store.getProviders().map((p) => p.id)).toContain('demo');
    expect(store.getMcpServers().map((s) => s.name)).toEqual(['Petstore MCP', 'DeepWiki', 'Weather (offline mock)', 'Microsoft Learn docs', 'Context7 (library docs)', 'Cloudflare docs', 'Astro docs', 'MCP spec repo (GitMCP)', 'Hugging Face Hub', 'Everything (reference server, needs Node.js)', 'Tasks (offline mock)', 'Payments (offline mock)', 'Handbook bot (offline mock)']);
    expect(store.libraryKinds().sort()).toEqual(['ai-prompts', 'evaluations', 'grpc', 'monitors', 'rag-targets', 'websocket']);
    // gRPC calls and connections are shown in their collections
    const colIds = new Set(cols.map((c) => c.id));
    for (const kind of ['grpc', 'websocket']) for (const i of store.getLibrary(kind).items) expect(colIds.has(i.collectionId ?? ''), `${kind}: ${i.name}`).toBe(true);
    for (const m of listMonitors(store)) {
      expect(m.enabled).toBe(false); // never hit public APIs on a schedule unless the user turns it on
      validateMonitor(store, m);
    }
  });

  it('every test file and suite loads', async () => {
    const files: string[] = [];
    const walk = (d: string) => readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(join(d, e.name)) : files.push(join(d, e.name))));
    walk(store.path('tests'));
    let tests = 0;
    for (const f of files) {
      if (f.endsWith('.suite.yaml')) {
        const suite = await loadSuite(f);
        for (const p of suite.tests as string[]) expect(existsSync(join(store.path('tests'), p))).toBe(true);
      } else for await (const _ of loadTestsFromFile(f)) tests++;
    }
    expect(tests).toBeGreaterThan(10);
  });

  it('the Learn by example suite passes without network, and the handbook bot fails on its two seeded defects only', async () => {
    const ctx = createEngineContext({ store, secrets: new MemorySecretStore(), environment: 'Public APIs' });
    try {
      const suite = await loadSuite(store.path('tests', 'learn.suite.yaml'));
      const all: TestCase[] = [];
      for await (const t of streamTests(suite.tests as string[], store.path('tests'))) all.push(t);
      const learn = await runTests({ name: 'learn', runId: 'run-learn', tests: all, services: ctx.services, concurrency: 4, resultsFile: join(dir, 'results-learn.jsonl') });
      expect(learn).toMatchObject({ failed: 0, errors: 0 });
      expect(learn.total).toBeGreaterThanOrEqual(30);
      // the bot with sources: eight questions through the mock bot, judged by the offline demo model (examples)
      const bot: TestCase[] = [];
      for await (const t of streamTests(['ai/handbook-bot.yaml'], store.path('tests'))) bot.push(t);
      const results: Array<{ name: string; status: string }> = [];
      const summary = await runTests({ name: 'handbook', runId: 'run-handbook', tests: bot, services: ctx.services, concurrency: 2, resultsFile: join(dir, 'results-handbook.jsonl'), onEvent: (e) => void (e.type === 'test-end' && results.push({ name: e.result.name, status: e.result.status })) });
      expect(summary).toMatchObject({ total: 8, failed: 2, errors: 0 });
      expect(results.filter((r) => r.status === 'failed').map((r) => r.name).sort()).toEqual(['Handbook bot [laptop]', 'Handbook bot [parental]']);
    } finally {
      await ctx.dispose();
    }
  });

  it('the custom metrics of the examples are valid', () => {
    for (const f of readdirSync(store.path('metrics'))) {
      const id = f.replace(/\.yaml$/, '');
      const problems = validateCustomMetric(parseYaml(readFileSync(store.path('metrics', f), 'utf8')), { fileId: id });
      expect(problems.filter((p) => p.level === 'error'), f).toEqual([]);
    }
  });

  it('the Offline suite passes without network', async () => {
    const suite = await loadSuite(store.path('tests', 'offline.suite.yaml'));
    const ctx = createEngineContext({ store, secrets: new MemorySecretStore(), environment: 'Public APIs' });
    try {
      const all: TestCase[] = [];
      for await (const t of streamTests(suite.tests as string[], store.path('tests'))) all.push(t);
      const summary = await runTests({ name: 'offline', runId: 'run-offline', tests: all, services: ctx.services, concurrency: 4, resultsFile: join(dir, 'results.jsonl') });
      expect(summary).toMatchObject({ failed: 0, errors: 0 });
      expect(summary.total).toBeGreaterThanOrEqual(11);
    } finally {
      await ctx.dispose();
    }
  });
});

describe('first launch', () => {
  it('installs the examples workspace, opens it, and never overwrites it later', async () => {
    const home = join(dir, 'home');
    const be = new Backend({ appDir: home, emit: () => undefined, examplesDir: template, noMonitors: true });
    try {
      const cur = (await be.handlers['ws.current']!({})) as { id: string; name: string };
      expect(cur).toMatchObject({ id: 'ws-testpion-examples', name: 'TestPion Examples' });
      expect(new WorkspaceManager(home).list().map((w) => w.name)).toEqual(['My Workspace', 'TestPion Examples']);
      // the copy is the user's: run artefacts from the repo are not copied, and a second install keeps it
      const path = new WorkspaceManager(home).resolve('TestPion Examples')!;
      expect(existsSync(join(path, 'runs', 'monitors'))).toBe(false);
      await be.handlers['ws.openExamples']!({});
      expect(new WorkspaceManager(home).list()).toHaveLength(2);
    } finally {
      await be.dispose();
    }
  });
});
