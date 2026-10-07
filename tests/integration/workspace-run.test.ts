import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

/** Async spawn — the demo servers live in this process, so a blocking spawnSync would deadlock. */
function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { env });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
import {
  WorkspaceStore,
  MemorySecretStore,
  createEngineContext,
  runTests,
  streamTests,
  loadSuite,
  McpSession,
  mcpResultBody,
  type RunEvent,
  type TestResult,
} from '../../packages/core/src/index.js';
// @ts-expect-error - plain JS example module
import { startAll } from '../../examples/servers/demo-servers.mjs';

/**
 * End-to-end: run the example workspace's regression suite through the same engine the desktop
 * app and CLI use. The demo servers bind the fixed ports referenced by the example environment.
 */
let servers: { close(): Promise<void> } | undefined;
let dir: string;
let ws: WorkspaceStore;

beforeAll(async () => {
  try {
    servers = await startAll(4010);
  } catch {
    servers = undefined; // ports already in use — assume the demo servers are already running
  }
  dir = mkdtempSync(join(tmpdir(), 'aps-ws-'));
  cpSync(resolve('examples/veterinary-workspace'), join(dir, 'veterinary-workspace'), { recursive: true, filter: (s) => !/runs|traces|database\.sqlite/.test(s) });
  ws = WorkspaceStore.open(join(dir, 'veterinary-workspace'));
  // the copy lives outside the repo, so point the stdio MCP server at the repo's script (and its node_modules)
  ws.saveMcpServers([{ id: 'customer-mcp', name: 'customer-mcp', transport: 'stdio', command: process.execPath, args: [resolve('examples/servers/mcp-server.mjs')] }]);
});

afterAll(async () => {
  ws?.close();
  await servers?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('example workspace (end-to-end)', () => {
  it('runs the Kafka example against the demo broker', async () => {
    const ctx = createEngineContext({ store: ws, secrets: new MemorySecretStore(), environment: 'Development' });
    const results: TestResult[] = [];
    try {
      await runTests({ name: 'kafka', tests: streamTests(['kafka'], ws.path('tests')), concurrency: 1, services: ctx.services, onEvent: (e: RunEvent) => e.type === 'test-end' && results.push(e.result) });
    } finally {
      await ctx.dispose();
    }
    expect(results.map((r) => `${r.name}: ${r.status}${r.status === 'passed' ? '' : ` ${r.error?.message ?? r.checks.filter((c) => !c.passed).map((c) => c.message).join('; ')}`}`)).toEqual([
      "The clinic's events are there, in order: passed",
      'A booked appointment can be read back with its key and headers: passed',
    ]);
  });

  it('passes the full regression suite across REST, GraphQL, MCP, LLM, RAG, agent and safety tests', async () => {
    const suite = await loadSuite(ws.path('tests', 'regression.suite.yaml'));
    const ctx = createEngineContext({ store: ws, secrets: new MemorySecretStore(), environment: suite.environment });
    const results: TestResult[] = [];
    const traces: string[] = [];
    try {
      const summary = await runTests({
        name: suite.name,
        tests: streamTests(suite.tests, ws.path('tests')),
        concurrency: suite.concurrency,
        services: ctx.services,
        resultsFile: join(dir, 'results.jsonl'),
        traceMode: 'all',
        onTrace: (t) => void traces.push(ws.saveTrace(t, 'test')),
        onEvent: (e: RunEvent) => e.type === 'test-end' && results.push(e.result),
      });
      const failures = results.filter((r) => r.status !== 'passed').map((r) => `${r.name}: ${r.error?.message ?? r.checks.filter((c) => !c.passed).map((c) => c.message).join('; ')}`);
      expect(failures).toEqual([]);
      expect(summary.total).toBe(29); // 22 + the 7 steps of the patient lifecycle
      const types = new Set(results.map((r) => r.type));
      expect([...types].sort()).toEqual(['agent', 'graphql', 'http', 'llm', 'mcp', 'rag']);
      // AI-judge / heuristic results are labelled distinctly from deterministic ones
      const rag = results.find((r) => r.type === 'rag')!;
      expect(rag.checks.find((c) => c.type === 'groundedness')!.source).toBe('heuristic');
      expect(rag.metadata?.rag).toMatchObject({ documentIds: ['doc-1', 'doc-2'] });
      // traces were persisted and indexed
      expect(ws.meta.listTraces().total).toBe(29);
      const agent = results.find((r) => r.type === 'agent')!;
      const trace = ws.loadTrace(agent.traceId!)!;
      expect(trace.spans.map((s) => s.kind)).toEqual(expect.arrayContaining(['test', 'llm', 'mcp', 'evaluation']));
      // secrets/tokens obtained at runtime never reach persisted results
      expect(readFileSync(join(dir, 'results.jsonl'), 'utf8')).not.toContain('demo-token-3f9a1c');
    } finally {
      await ctx.dispose();
    }
  });

  it('CLI: `testpion run` exits 0 and writes all report formats', async () => {
    const cli = resolve('packages/cli/bin/testpion.js');
    const out = join(dir, 'cli-out');
    const r = await run([cli, 'run', '-w', ws.root, '--suite', 'smoke', '-o', out, '-q'], { ...process.env, TESTPION_HOME: join(dir, 'home') });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(readFileSync(join(out, 'junit.xml'), 'utf8')).toContain('tests="4"');
    expect(JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')).summary.passed).toBe(4);
    expect(readFileSync(join(out, 'report.md'), 'utf8')).toContain('Smoke');
    expect(readFileSync(join(out, 'report.html'), 'utf8')).toContain('PASSED');
    const bad = await run([cli, 'test', join(dir, 'does-not-exist')], { ...process.env, TESTPION_HOME: join(dir, 'home') });
    expect(bad.status).toBe(2);
  });

  it('CLI: `testpion run-collection` runs workspace collections and Postman files (Newman-style)', async () => {
    const cli = resolve('packages/cli/bin/testpion.js');
    const env = { ...process.env, TESTPION_HOME: join(dir, 'home') };

    // workspace collection, one folder, two iterations: the token script feeds the next requests
    const out = join(dir, 'col-out');
    const r = await run([cli, 'run-collection', 'Veterinary API', '-w', ws.root, '-e', 'Development', '--folder', 'Authentication', 'Patients', '-n', '2', '-o', out, '-q'], env);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'))).toMatchObject({ total: 8, passed: 8 });

    // without the token request the patients endpoints refuse: exit 1, and no crash on exit
    const failing = await run([cli, 'run-collection', 'Veterinary API', '-w', ws.root, '-e', 'Development', '--folder', 'Patients', '-o', join(dir, 'col-fail'), '-q'], env);
    expect(failing.stderr).toBe('');
    expect(failing.status).toBe(1);

    // a Postman collection + environment + CSV data outside any workspace
    writeFileSync(
      join(dir, 'smoke.postman_collection.json'),
      JSON.stringify({
        info: { name: 'Smoke', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
        item: [
          {
            name: 'Health',
            request: { method: 'GET', url: '{{baseUrl}}/health' },
            event: [{ listen: 'test', script: { exec: ["pm.test('ok', () => pm.response.to.have.status(200));", "pm.environment.set('seen', pm.iterationData.get('n'));"] } }],
          },
          {
            name: 'Again',
            request: { method: 'GET', url: '{{baseUrl}}/health?n={{n}}' },
            event: [{ listen: 'test', script: { exec: ["pm.test('carries', () => pm.expect(String(pm.environment.get('seen'))).to.equal(String(pm.iterationData.get('n'))));"] } }],
          },
        ],
      }),
    );
    writeFileSync(join(dir, 'local.postman_environment.json'), JSON.stringify({ name: 'Local', values: [{ key: 'baseUrl', value: 'http://localhost:4010', enabled: true }] }));
    writeFileSync(join(dir, 'rows.csv'), 'n\n1\n2\n3\n');
    const pm = await run([cli, 'run-collection', join(dir, 'smoke.postman_collection.json'), '-e', join(dir, 'local.postman_environment.json'), '-d', join(dir, 'rows.csv'), '-o', join(dir, 'pm-out'), '-r', 'junit', '-q'], env);
    expect(pm.stderr).toBe('');
    expect(pm.status).toBe(0);
    expect(readFileSync(join(dir, 'pm-out', 'junit.xml'), 'utf8')).toContain('tests="6"');

    const missing = await run([cli, 'run-collection', join(dir, 'smoke.postman_collection.json'), '--folder', 'Nope'], env);
    expect(missing.status).toBe(2);
  });

  it('CLI: run-collection takes Newman options (globals, --env-var, exports, --suppress-exit-code, junit export)', async () => {
    const cli = resolve('packages/cli/bin/testpion.js');
    const env = { ...process.env, TESTPION_HOME: join(dir, 'home') };
    writeFileSync(
      join(dir, 'nm.postman_collection.json'),
      JSON.stringify({
        info: { name: 'Newman flags', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
        item: [
          {
            name: 'Health',
            request: { method: 'GET', url: '{{baseUrl}}/health?who={{who}}' },
            event: [
              {
                listen: 'test',
                script: {
                  exec: [
                    "pm.test('global from file', () => pm.expect(pm.globals.get('who')).to.equal('file'));",
                    "pm.test('env var override', () => pm.expect(pm.environment.get('baseUrl')).to.equal('http://localhost:4010'));",
                    "pm.test('global var', () => pm.expect(pm.globals.get('extra')).to.equal('x'));",
                    "pm.environment.set('token', 'from-script');",
                    "pm.globals.set('count', 2);",
                    "pm.test('fails on purpose', () => pm.expect(pm.variables.get('failMe')).to.not.equal('yes'));",
                  ],
                },
              },
            ],
          },
        ],
      }),
    );
    writeFileSync(join(dir, 'g.postman_globals.json'), JSON.stringify({ name: 'Globals', _postman_variable_scope: 'globals', values: [{ key: 'who', value: 'file', enabled: true }] }));
    const args = [cli, 'run-collection', join(dir, 'nm.postman_collection.json'), '-g', join(dir, 'g.postman_globals.json'), '--env-var', 'baseUrl=http://localhost:4010', '--global-var', 'extra=x', '--timeout-request', '5000'];
    const envOut = join(dir, 'nm-env.json');
    const junit = join(dir, 'nm-junit.xml');
    const ok = await run([...args, '--export-environment', envOut, '--export-globals', join(dir, 'nm-globals.json'), '--reporters', 'json', '--reporter-junit-export', junit, '-o', join(dir, 'nm1'), '-q'], env);
    expect(ok.stderr).toBe('');
    expect(ok.status).toBe(0);
    const exported = JSON.parse(readFileSync(envOut, 'utf8'));
    expect(exported._postman_variable_scope).toBe('environment');
    expect(exported.values).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'baseUrl', value: 'http://localhost:4010' }), expect.objectContaining({ key: 'token', value: 'from-script' })]));
    expect(JSON.parse(readFileSync(join(dir, 'nm-globals.json'), 'utf8')).values).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'count', value: '2' })]));
    expect(readFileSync(junit, 'utf8')).toContain('<testcase name="Health"');

    // a failing test exits 1, or 0 with --suppress-exit-code
    const failing = [...args, '--var', 'failMe=yes', '-r', 'json', '-q'];
    expect((await run([...failing, '-o', join(dir, 'nm2')], env)).status).toBe(1);
    expect((await run([...failing, '--suppress-exit-code', '-o', join(dir, 'nm3')], env)).status).toBe(0);
  });

  it('CLI: run-collection keeps cookies across requests and exports / imports the cookie jar', async () => {
    const cli = resolve('packages/cli/bin/testpion.js');
    const env = { ...process.env, TESTPION_HOME: join(dir, 'home') };
    const collection = (items: unknown[]) => JSON.stringify({ info: { name: 'Cookies', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: items });
    const me = {
      name: 'Me',
      request: { method: 'GET', url: 'http://localhost:4010/session/me' },
      event: [{ listen: 'test', script: { exec: ["pm.test('logged in', () => pm.response.to.have.status(200));"] } }],
    };
    writeFileSync(
      join(dir, 'login.postman_collection.json'),
      collection([
        { name: 'Login', request: { method: 'POST', url: 'http://localhost:4010/session/login', header: [{ key: 'Content-Type', value: 'application/json' }], body: { mode: 'raw', raw: '{"username":"vet","password":"paws"}' } } },
        me,
      ]),
    );
    writeFileSync(join(dir, 'me.postman_collection.json'), collection([me]));
    const jar = join(dir, 'jar.json');
    const login = await run([cli, 'run-collection', join(dir, 'login.postman_collection.json'), '--export-cookie-jar', jar, '-o', join(dir, 'ck1'), '-r', 'json', '-q'], env);
    expect(login.stderr).toBe('');
    expect(login.status).toBe(0);
    expect(JSON.parse(readFileSync(jar, 'utf8')).cookies.map((c: { name: string }) => c.name).sort()).toEqual(['clinic', 'vet_session']);

    // a fresh run has no session; with the exported jar it does
    expect((await run([cli, 'run-collection', join(dir, 'me.postman_collection.json'), '-o', join(dir, 'ck2'), '-r', 'json', '-q'], env)).status).toBe(1);
    const reuse = await run([cli, 'run-collection', join(dir, 'me.postman_collection.json'), '--cookie-jar', jar, '-o', join(dir, 'ck3'), '-r', 'json', '-q'], env);
    expect(reuse.stderr).toBe('');
    expect(reuse.status).toBe(0);

    // the example workspace's "Cookie session" folder: login → me (pm.cookies, pm.cookies.jar()) → logout
    const example = await run([cli, 'run-collection', 'Veterinary API', '-w', ws.root, '-e', 'Development', '--folder', 'Cookie session', '-o', join(dir, 'ck4'), '-r', 'json', '-q'], env);
    expect(example.stderr).toBe('');
    expect(example.status).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'ck4', 'summary.json'), 'utf8'))).toMatchObject({ total: 3, passed: 3 });
  });

  it('CLI: `testpion export` / `export-environment` write Postman files that run-collection runs', async () => {
    const cli = resolve('packages/cli/bin/testpion.js');
    const env = { ...process.env, TESTPION_HOME: join(dir, 'home') };
    const col = join(dir, 'vet.postman_collection.json');
    const envFile = join(dir, 'dev.postman_environment.json');
    const a = await run([cli, 'export', 'Veterinary API', '-w', ws.root, '-o', col], env);
    expect(a.status).toBe(0);
    expect(JSON.parse(readFileSync(col, 'utf8')).info.schema).toContain('v2.1.0');
    const b = await run([cli, 'export-environment', 'Development', '-w', ws.root, '-o', envFile], env);
    expect(b.status).toBe(0);
    const r = await run([cli, 'run-collection', col, '-e', envFile, '--folder', 'Authentication', 'Patients', 'Cookie session', '-o', join(dir, 'pm-rt'), '-r', 'json', '-q'], env);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'pm-rt', 'summary.json'), 'utf8'))).toMatchObject({ total: 7, passed: 7 });
  });

  it('CLI: `testpion mcp-server` gives AI agents the workspace as MCP tools', async () => {
    const env = { TESTPION_HOME: join(dir, 'home') } as Record<string, string>;
    const cli = resolve('packages/cli/bin/testpion.js');
    const s = new McpSession({ id: 'pl', name: 'testpion', transport: 'stdio', command: process.execPath, args: [cli, 'mcp-server', '-w', ws.root], env });
    await s.connect(20_000);
    try {
      const names = (await s.listTools()).map((t) => t.name).sort();
      expect(names).toEqual(['api_coverage', 'api_fuzz', 'check_certificate', 'ci_config', 'collection_docs', 'collection_health', 'collection_openapi', 'collection_timing', 'compare_environments', 'compare_request_across_environments', 'compare_responses', 'compare_runs', 'create_collection', 'create_folder', 'debugger_capture', 'debugger_exchange', 'debugger_exchanges', 'debugger_rules', 'debugger_session', 'debugger_stats', 'decode_jwt', 'delete_request', 'environment_matrix', 'export_traces', 'flaky_tests', 'generate_dataset', 'generate_tests', 'get_request', 'git_conflicts', 'git_diff', 'git_log', 'git_propose_commit', 'git_resolve', 'git_status', 'graphql_operation', 'graphql_subscribe', 'grpc_call', 'import_definition', 'lint_tests', 'list_certificates', 'list_collections', 'list_datasets', 'list_environments', 'list_evaluations', 'list_mcp_servers', 'list_monitors', 'list_requests', 'list_tests', 'llm_usage', 'load_history', 'load_test', 'mcp_call_tool', 'mcp_server_tools', 'mcp_tool_usage', 'monitor_requests', 'monitor_results', 'monitor_uptime', 'move_request', 'openapi_diff', 'openapi_lint', 'openapi_outline', 'parse_request_snippet', 'realtime_exchange', 'recent_failures', 'rename_variable', 'reorder_environments', 'request_history', 'response_time_stats', 'run_breakdown', 'run_collection', 'run_evaluation', 'run_monitor', 'run_tests', 'save_request', 'save_test', 'score_trend', 'security_review', 'send_request', 'set_collection_variable', 'set_environment_variable', 'set_request_checks', 'test_history', 'testpion_guide', 'unused_variables', 'update_request', 'variable_flow', 'variable_usages', 'what_needs_attention', 'workspace_activity', 'write_test_file']);
      const text = async (tool: string, args: Record<string, unknown> = {}) => {
        const r = await s.callTool(tool, args);
        return { isError: r.isError, text: mcpResultBody(r).text };
      };
      expect((await text('list_collections')).text).toContain('Veterinary API');
      // test files: list them, run one, then re-run only what failed
      expect((await text('list_tests')).text).toContain('rest/auth.yaml');
      const ran = JSON.parse((await text('run_tests', { paths: ['rest/auth.yaml'] })).text) as { runId: string; total: number };
      expect(ran.total).toBeGreaterThan(0);
      const again = JSON.parse((await text('run_tests', { rerunFailed: ran.runId })).text) as { total: number; message?: string };
      expect(again.total === 0 ? again.message : 'ran').toBeTruthy();
      expect(JSON.parse((await text('run_breakdown', { runId: ran.runId })).text)).toHaveProperty('histogram');
      // a run compared with itself: nothing regressed
      const same = JSON.parse((await text('compare_runs', { before: ran.runId, after: ran.runId })).text) as { passed: boolean; regressions: unknown[] };
      expect(same.passed).toBe(true);
      expect(same.regressions).toEqual([]);
      expect((await text('compare_runs', { before: 'run-nope', after: ran.runId })).isError).toBe(true);
      expect((await text('list_requests', { collection: 'Veterinary API' })).text).toContain('Get patient');
      const envs = await text('list_environments');
      expect(envs.text).toContain('clientSecret');
      expect(envs.text).not.toContain('demo-secret');
      const token = await text('get_request', { collection: 'Veterinary API', request: 'Get access token' });
      expect(token.text).not.toContain('demo-secret');
      // a saved request runs with its scripts; an ad-hoc one resolves {{variables}}
      const saved = JSON.parse((await text('send_request', { collection: 'Veterinary API', request: 'Health', environment: 'Development' })).text);
      expect(saved.status).toBe('passed');
      const adhoc = JSON.parse((await text('send_request', { method: 'GET', url: '{{baseUrl}}/health', environment: 'Development' })).text);
      expect(adhoc.status).toBe(200);
      const run = JSON.parse((await text('run_collection', { collection: 'Veterinary API', folder: 'Authentication', environment: 'Development' })).text);
      expect(run).toMatchObject({ total: 1, passed: 1 });
      // iterations, and data files only from inside the workspace
      expect(JSON.parse((await text('run_collection', { collection: 'Veterinary API', folder: 'Authentication', environment: 'Development', iterations: 2 })).text)).toMatchObject({ total: 2, passed: 2 });
      const outside = await text('run_collection', { collection: 'Veterinary API', folder: 'Authentication', environment: 'Development', data: '../outside.csv' });
      expect(outside.isError).toBe(true);
      expect(outside.text).toMatch(/escapes the workspace/);
      // production environments are refused unless the server allows them
      const prod = await text('send_request', { method: 'GET', url: '{{baseUrl}}/health', environment: 'Production' });
      expect(prod.isError).toBe(true);
      expect(prod.text).toMatch(/production/);
      expect((await text('collection_docs', { collection: 'Veterinary API' })).text).toContain('# Veterinary API');

      // AI agents can turn a copied cURL command into a request and save it without writing secrets
      const snippet = `curl 'https://api.test/v1/pets?limit=5&api_key=k-LEAK-1' -H 'Authorization: Bearer tok-LEAK-2' -H 'accept: application/json' -b 'sid=sess-LEAK-3'`;
      const parsed = JSON.parse((await text('parse_request_snippet', { snippet })).text);
      expect(parsed).toMatchObject({ format: 'curl', request: { method: 'GET', url: 'https://api.test/v1/pets' } });
      expect(JSON.stringify(parsed)).not.toMatch(/LEAK/);
      const saveR = JSON.parse((await text('save_request', { collection: 'Imported', create: true, folder: 'Pets / Search', name: 'Search pets', snippet })).text);
      expect(saveR.saved).toMatchObject({ collection: 'Imported', createdCollection: true, request: 'Search pets', method: 'GET' });
      expect(saveR.placeholders.map((p: { variable: string }) => p.variable).sort()).toEqual(['accessToken', 'apiKey', 'sid']);
      const onDisk = readFileSync(join(ws.root, 'collections', `${saveR.saved.collectionId}.json`), 'utf8');
      expect(onDisk).not.toMatch(/LEAK/);
      expect(onDisk).toContain('{{accessToken}}');
      expect((await text('list_requests', { collection: 'Imported' })).text).toContain('Search pets');
      expect((await text('save_request', { collection: 'Nope', url: 'https://x.test' })).isError).toBe(true);
      // import from text (the url form is covered by the import-url unit test)
      const spec = ['openapi: 3.0.0', 'info: { title: Agent Pets, version: "1" }', 'paths:', '  /pets:', '    get: { responses: { "200": { description: ok } } }', ''].join('\n');
      const imp = JSON.parse((await text('import_definition', { text: spec })).text);
      expect(imp).toMatchObject({ format: 'openapi', collection: { name: 'Agent Pets' } });
      expect((await text('import_definition', {})).isError).toBe(true);
      // compare the imported spec (kept in specs/) with a changed copy given as text
      const diff = JSON.parse((await text('openapi_diff', { old: imp.specPath, new: spec.replace('/pets:', '/animals:') })).text);
      expect(diff.breaking.map((c: { kind: string }) => c.kind)).toEqual(['operation-removed']);
      expect(diff.nonBreaking.map((c: { kind: string }) => c.kind)).toEqual(['operation-added']);
      expect((await text('openapi_diff', { old: '../../outside.json', new: spec })).isError).toBe(true);
      // lint the imported spec (no operationId) and every document in specs/
      const lint = JSON.parse((await text('openapi_lint', { spec: imp.specPath, severity: 'warning' })).text);
      expect(lint.problems.map((p: { rule: string; line: number }) => `${p.rule}@${p.line}`)).toEqual(['operation-id@5']);
      const all = JSON.parse((await text('openapi_lint', {})).text);
      expect(all.documents.map((x: { file: string }) => x.file)).toContain(imp.specPath);
      expect((await text('openapi_lint', { spec: '../../outside.yaml' })).isError).toBe(true);
      const outline = JSON.parse((await text('openapi_outline', { spec: imp.specPath })).text);
      expect(outline.tags[0].operations[0]).toMatchObject({ method: 'GET', path: '/pets' });
      // fuzzing sends real requests: remote hosts are refused for agents
      expect((await text('api_fuzz', { spec: imp.specPath, baseUrl: 'https://api.example.com' })).text).toMatch(/needs explicit opt-in/);
      expect((await text('collection_openapi', { collection: 'Veterinary API' })).text).toMatch(/^openapi: 3\.1\.0/);
      expect(Array.isArray(JSON.parse((await text('security_review', { collection: 'Veterinary API' })).text))).toBe(true);
      // variable usages (read) — the rename itself is covered by the unit test
      const uses = JSON.parse((await text('variable_usages', { name: 'clientSecret' })).text);
      expect(uses.map((u: { where: string }) => u.where)).toContain('Environment Development');
      // load tests from agents: local hosts only, capped
      const load = JSON.parse((await text('load_test', { collection: 'Veterinary API', folder: 'Patients', environment: 'Development', virtualUsers: 2, durationSec: 1, warmUp: false })).text);
      expect(load.requests).toBeGreaterThan(0);
      expect(load.perRequest.map((p: { name: string }) => p.name)).toContain('Patients / List patients');
      expect((await text('load_test', { url: 'https://example.com/', durationSec: 1 })).text).toMatch(/requires explicit opt-in/);
      // environment order
      expect(JSON.parse((await text('reorder_environments', { order: ['Production', 'Development'] })).text).slice(0, 2)).toEqual(['Production', 'Development']);
      expect((await text('reorder_environments', { order: ['Nope'] })).isError).toBe(true);
      // run results include script logs and the pm.visualizer rendering (List patients has one)
      const pats = JSON.parse((await text('run_collection', { collection: 'Veterinary API', folder: 'Patients', environment: 'Development' })).text);
      const list = pats.results.find((r: { name: string }) => r.name.endsWith('List patients'));
      if (!list) throw new Error(JSON.stringify(pats.results.map((r: { name: string }) => r.name)));
      expect(list.visualization.html).toContain('<table>');
      // an agent changes the workspace the way a person does: create, edit (secrets become variables), move, delete
      const made = JSON.parse((await text('create_collection', { name: 'Agent sandbox', variables: { base: 'https://example.test' } })).text) as { id: string };
      expect(made.id).toBeTruthy();
      await text('save_request', { collection: 'Agent sandbox', name: 'Ping', method: 'GET', url: '{{base}}/ping' });
      const upd = JSON.parse((await text('update_request', { collection: 'Agent sandbox', request: 'Ping', url: '{{base}}/pong', headers: { Authorization: 'Bearer abc123', Accept: 'application/json' }, body: '{"a":1}' })).text) as { url: string; headers: number; placeholders: Array<{ variable: string }> };
      expect(upd.url).toBe('{{base}}/pong');
      expect(upd.headers).toBe(2);
      expect(upd.placeholders.map((p) => p.variable)).toContain('authorization');
      expect((await text('get_request', { collection: 'Agent sandbox', request: 'Ping' })).text).not.toContain('abc123');
      await text('create_folder', { collection: 'Agent sandbox', folder: 'Health / Deep' });
      expect(JSON.parse((await text('move_request', { collection: 'Agent sandbox', request: 'Ping', folder: 'Health / Deep' })).text)).toMatchObject({ folder: 'Health / Deep' });
      expect((await text('set_collection_variable', { collection: 'Agent sandbox', name: 'apiKey', value: 'k' })).isError).toBe(true); // a secret: refused
      expect(JSON.parse((await text('set_collection_variable', { collection: 'Agent sandbox', name: 'page', value: 2 })).text).variables).toEqual(['base', 'page']);
      expect(JSON.parse((await text('delete_request', { collection: 'Agent sandbox', request: 'Ping' })).text)).toMatchObject({ deleted: 'Ping', kind: 'http' });
      expect((await text('list_requests', { collection: 'Agent sandbox' })).text).not.toContain('Ping');
      // the workspace's MCP servers: a mock one works from here; a stdio one only after the user allowed it in the app
      mkdirSync(join(ws.root, 'mocks'), { recursive: true });
      writeFileSync(join(ws.root, 'mocks', 'ping.mcp-mock.yaml'), ['name: ping-mock', 'tools:', '  - name: ping', '    description: Answers pong.', '    inputSchema: { type: object, properties: {} }', '    responses:', '      - json: { pong: true }', ''].join('\n'));
      const mcpFile = join(ws.root, 'mcp-servers.json');
      const mcpList = JSON.parse(readFileSync(mcpFile, 'utf8')) as { servers: unknown[] };
      mcpList.servers.push({ id: 'ping-mock', name: 'Ping mock', transport: 'mock', mockFile: 'mocks/ping.mcp-mock.yaml' });
      writeFileSync(mcpFile, JSON.stringify(mcpList, null, 2));
      const servers = JSON.parse((await text('list_mcp_servers')).text) as Array<{ name: string; transport: string; allowed?: boolean }>;
      expect(servers.map((x) => x.transport).sort()).toEqual(['mock', 'stdio']);
      const offered = JSON.parse((await text('mcp_server_tools', { server: 'Ping mock' })).text) as { tools: Array<{ name: string }> };
      expect(offered.tools.map((t) => t.name)).toEqual(['ping']);
      const called = JSON.parse((await text('mcp_call_tool', { server: 'Ping mock', tool: 'ping', arguments: {} })).text) as { isError: boolean; structuredContent?: unknown; content: Array<{ text?: string }> };
      expect(called.isError).toBe(false);
      expect(JSON.stringify(called)).toContain('pong');
      // a stdio server is a program: from here only after the user allowed it in the app
      const stdio = servers.find((x) => x.transport === 'stdio')!;
      expect(stdio.allowed).toBe(false);
      expect((await text('mcp_server_tools', { server: stdio.name })).text).toMatch(/not allowed to run/);
    } finally {
      await s.close();
    }
    // --read-only hides the tools that send requests
    const ro = new McpSession({ id: 'ro', name: 'testpion-ro', transport: 'stdio', command: process.execPath, args: [cli, 'mcp-server', '-w', ws.root, '--read-only'], env });
    await ro.connect(20_000);
    try {
      expect((await ro.listTools()).map((t) => t.name)).not.toContain('send_request');
      expect((await ro.listTools()).map((t) => t.name)).not.toContain('import_definition');
      expect((await ro.listTools()).map((t) => t.name)).not.toContain('load_test');
      expect((await ro.listTools()).map((t) => t.name)).not.toContain('rename_variable');
      expect((await ro.listTools()).map((t) => t.name)).not.toContain('git_propose_commit');
      expect((await ro.listTools()).map((t) => t.name)).toContain('git_status');
    } finally {
      await ro.close();
    }
  });

  it('CLI: `testpion send` sends a saved request (scripts, checks) or a URL', async () => {
    const cli = resolve('packages/cli/bin/testpion.js');
    const env = { ...process.env, TESTPION_HOME: join(dir, 'home') };
    const saved = await run([cli, 'send', 'Veterinary API/Authentication/Get access token', '-w', ws.root, '-e', 'Development', '--json'], env);
    expect(saved.status).toBe(0);
    const out = JSON.parse(saved.stdout);
    expect(out).toMatchObject({ status: 200, body: { token_type: 'Bearer' } });
    expect(out.checks.every((c: { passed: boolean }) => c.passed)).toBe(true);
    const url = await run([cli, 'send', '{{baseUrl}}/health', '-w', ws.root, '-e', 'Development', '--json'], env);
    expect(JSON.parse(url.stdout)).toMatchObject({ status: 200, body: { status: 'ok' } });
    // an unknown name is a configuration error; --fail turns an HTTP error into exit 1
    expect((await run([cli, 'send', 'No such request', '-w', ws.root], env)).status).toBe(2);
    expect((await run([cli, 'send', '{{baseUrl}}/nope', '-w', ws.root, '-e', 'Development', '--fail'], env)).status).toBe(1);
  });

  it('CLI: `testpion import` takes a copied request and `testpion env` lists and orders environments (--json)', async () => {
    const cli = resolve('packages/cli/bin/testpion.js');
    const env = { ...process.env, TESTPION_HOME: join(dir, 'home') };
    const file = join(dir, 'copied.ps1');
    writeFileSync(file, 'Invoke-RestMethod -Uri "https://api.test/v1/owners" -Method "POST" -Headers @{ "x-api-key" = "key-LEAK-9" } -ContentType "application/json" -Body \'{"name":"Ada","password":"pw-LEAK-8"}\'');
    const r = await run([cli, 'import', file, '-w', ws.root, '--collection', 'From CLI', '--folder', 'Owners', '--json'], env);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ format: 'powershell', collection: 'From CLI', createdCollection: true, request: 'POST /v1/owners', method: 'POST' });
    expect(out.placeholders.map((p: { variable: string }) => p.variable).sort()).toEqual(['password', 'xApiKey']);
    const saved = readFileSync(join(ws.root, 'collections', `${out.collectionId}.json`), 'utf8');
    expect(saved).not.toMatch(/LEAK/);
    expect(saved).toContain('{{xApiKey}}');

    const order = await run([cli, 'env', 'order', 'Development', 'Production', '-w', ws.root, '--json'], env);
    expect(order.status).toBe(0);
    expect(JSON.parse(order.stdout).slice(0, 2)).toEqual(['Development', 'Production']);
    const list = await run([cli, 'env', 'list', '-w', ws.root, '--json'], env);
    const envs = JSON.parse(list.stdout) as Array<{ name: string; variables: string[] }>;
    expect(envs[0]!.name).toBe('Development');
    expect(list.stdout).not.toContain('demo-secret');
    expect((await run([cli, 'env', 'order', 'Nope', '-w', ws.root], env)).status).not.toBe(0);
    const diff = await run([cli, 'env', 'diff', 'Development', 'Production', '-w', ws.root, '--json'], env);
    expect(diff.status).toBe(1); // they differ
    const d = JSON.parse(diff.stdout);
    expect(d.rows.find((r: { key: string }) => r.key === 'baseUrl').status).toBe('different');
    expect(diff.stdout).not.toContain('demo-secret');
  });

  it('response history: CLI list/diff and MCP request_history/compare_responses', async () => {
    const cli = resolve('packages/cli/bin/testpion.js');
    const env = { ...process.env, TESTPION_HOME: join(dir, 'home') };
    const store = WorkspaceStore.open(ws.root);
    const payload = (name: string, body: unknown) => {
      const p = join(store.path('payloads'), name);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify(body));
      return p;
    };
    const base = { kind: 'http' as const, name: 'List patients', method: 'GET', url: 'http://127.0.0.1:4010/patients', collectionId: 'veterinary-api', requestId: 'req-list' };
    store.meta.addHistory({ ...base, id: 'h-old', timestamp: '2026-09-29T10:00:00.000Z', status: 200, durationMs: 50, size: 30, payloadPath: payload('h-old.json', { total: 2, items: [{ id: 1, token: 'tok-LEAK-7' }] }), responseMeta: { headers: [['content-type', 'application/json'], ['date', 'Mon']] } });
    store.meta.addHistory({ ...base, id: 'h-new', timestamp: '2026-09-29T11:00:00.000Z', status: 200, durationMs: 40, size: 45, payloadPath: payload('h-new.json', { total: 3, items: [{ id: 1, token: 'tok-LEAK-8' }, { id: 2 }] }), responseMeta: { headers: [['content-type', 'application/json'], ['date', 'Tue']] } });
    store.close();

    const list = await run([cli, 'history', 'list', '-w', ws.root, '--request', 'List patients', '--json'], env);
    expect(list.stderr).toBe('');
    expect(JSON.parse(list.stdout).map((h: { id: string }) => h.id)).toEqual(['h-new', 'h-old']);
    const stats = await run([cli, 'history', 'stats', '-w', ws.root, '--request', 'List patients', '--json'], env);
    expect(JSON.parse(stats.stdout)).toMatchObject({ count: 2, p50Ms: 40, maxMs: 50, failed: 0 });
    const diff = await run([cli, 'history', 'diff', 'h-old', 'h-new', '-w', ws.root, '--json'], env);
    const d = JSON.parse(diff.stdout);
    expect(d.diff.body.changes.map((c: { path: string }) => c.path)).toEqual(['$.total', '$.items[0].token', '$.items[1]']);
    expect(d.diff.headers).toEqual([{ name: 'date', kind: 'changed', before: 'Mon', after: 'Tue', volatile: true }]);

    const s = new McpSession({ id: 'hist', name: 'testpion', transport: 'stdio', command: process.execPath, args: [cli, 'mcp-server', '-w', ws.root], env: { TESTPION_HOME: join(dir, 'home') } });
    await s.connect(20_000);
    try {
      const text = async (tool: string, args: Record<string, unknown>) => mcpResultBody(await s.callTool(tool, args)).text;
      expect(JSON.parse(await text('request_history', { collection: 'Veterinary API', request: 'List patients' })).map((h: { id: string }) => h.id)).toEqual(['h-new', 'h-old']);
      expect(JSON.parse(await text('response_time_stats', { collection: 'Veterinary API', request: 'List patients' }))).toEqual({ count: 2, failed: 0, minMs: 40, meanMs: 45, p50Ms: 40, p95Ms: 50, maxMs: 50 });
      const cmp = await text('compare_responses', { before: 'h-old', after: 'h-new' });
      expect(JSON.parse(cmp).diff.summary).toBe('3 body changes');
      // token values in the bodies are masked for agents
      expect(cmp).not.toMatch(/LEAK/);
    } finally {
      await s.close();
    }
  });

  it('monitors: CLI add/run/list/results and MCP list_monitors/monitor_results/run_monitor', async () => {
    const cli = resolve('packages/cli/bin/testpion.js');
    const env = { ...process.env, TESTPION_HOME: join(dir, 'home') };
    const add = await run([cli, 'monitor', 'add', 'Diagnostics check', '--collection', 'Veterinary API', '--folder', 'Diagnostics', '--every', '10m', '-e', 'Development', '-w', ws.root, '--json'], env);
    expect(add.stderr).toBe('');
    expect(JSON.parse(add.stdout)).toMatchObject({ name: 'Diagnostics check', everyMinutes: 10, enabled: true });
    expect((await run([cli, 'monitor', 'add', 'Bad', '--collection', 'Veterinary API', '--every', '9d', '-w', ws.root], env)).status).toBe(2);
    const due = await run([cli, 'monitor', 'run', '--due', '-w', ws.root, '--json'], env);
    expect(due.status).toBe(0);
    expect(JSON.parse(due.stdout)).toEqual([expect.objectContaining({ name: 'Diagnostics check', status: 'passed', trigger: 'schedule' })]);
    // it just ran, so nothing is due
    expect(JSON.parse((await run([cli, 'monitor', 'run', '--due', '-w', ws.root, '--json'], env)).stdout)).toEqual([]);
    const list = JSON.parse((await run([cli, 'monitor', 'list', '-w', ws.root, '--json'], env)).stdout);
    expect(list[0]).toMatchObject({ schedule: 'every 10 minutes', due: false, lastResult: { status: 'passed' } });

    const s = new McpSession({ id: 'mon', name: 'testpion', transport: 'stdio', command: process.execPath, args: [cli, 'mcp-server', '-w', ws.root], env: { TESTPION_HOME: join(dir, 'home') } });
    await s.connect(20_000);
    try {
      const text = async (tool: string, args: Record<string, unknown> = {}) => mcpResultBody(await s.callTool(tool, args)).text;
      expect(JSON.parse(await text('list_monitors'))[0].name).toBe('Diagnostics check');
      const ran = JSON.parse(await text('run_monitor', { monitor: 'diagnostics check' }));
      expect(ran).toMatchObject({ status: 'passed', trigger: 'manual', failures: [] });
      expect(JSON.parse(await text('monitor_results', { monitor: 'Diagnostics check' })).map((r: { trigger: string }) => r.trigger)).toEqual(['manual', 'schedule']);
      expect(JSON.parse(await text('monitor_uptime', { monitor: 'Diagnostics check', days: 7 }))).toMatchObject({ uptime: 100, runs: 2, passed: 2 });
    } finally {
      await s.close();
    }
    const results = await run([cli, 'monitor', 'results', 'Diagnostics check', '-w', ws.root], env);
    expect(results.stdout).toContain('2/2 passed');
    expect((await run([cli, 'monitor', 'uptime', 'Diagnostics check', '-w', ws.root], env)).stdout).toContain('100% of 2 runs over 30 days');
    expect((await run([cli, 'monitor', 'remove', 'Diagnostics check', '-w', ws.root], env)).status).toBe(0);
    // nine CLI processes: slow on a loaded CI machine
  }, 90_000);

  it('compare a saved request across two environments (CLI env diff --request, MCP)', async () => {
    const cli = resolve('packages/cli/bin/testpion.js');
    const env = { ...process.env, TESTPION_HOME: join(dir, 'home') };
    const store = WorkspaceStore.open(ws.root);
    const dev = store.getEnvironment('Development')!;
    store.saveEnvironment({ ...dev, id: 'dev-copy', name: 'Dev copy' });
    store.close();
    const r = await run([cli, 'env', 'diff', 'Development', 'Dev copy', '--request', 'Health', '-w', ws.root, '--json'], env);
    const d = JSON.parse(r.stdout);
    expect(d).toMatchObject({ request: 'Health', left: { environment: 'Development', status: 200 }, right: { environment: 'Dev copy', status: 200 } });
    // the only body difference is the server's clock
    expect(d.diff.body.changes.map((c: { path: string }) => c.path)).toEqual(['$.time']);

    const s = new McpSession({ id: 'cmp', name: 'testpion', transport: 'stdio', command: process.execPath, args: [cli, 'mcp-server', '-w', ws.root], env: { TESTPION_HOME: join(dir, 'home') } });
    await s.connect(20_000);
    try {
      const out = JSON.parse(mcpResultBody(await s.callTool('compare_request_across_environments', { collection: 'Veterinary API', request: 'Health', left: 'Development', right: 'Dev copy' })).text);
      expect(out.left.status).toBe(200);
      const prod = await s.callTool('compare_request_across_environments', { collection: 'Veterinary API', request: 'Health', left: 'Development', right: 'Production' });
      expect(prod.isError).toBe(true);
    } finally {
      await s.close();
    }
  }, 90_000);

  it('CLI: `testpion docs` writes Markdown documentation with examples and no secrets', async () => {
    const cli = resolve('packages/cli/bin/testpion.js');
    const r = await run([cli, 'docs', 'Veterinary API', '-w', ws.root], { ...process.env, TESTPION_HOME: join(dir, 'home') });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('# Veterinary API');
    expect(r.stdout).toContain('### Get patient');
    expect(r.stdout).toContain('**Example: Patient not found** · `404 Not Found`');
    expect(r.stdout).not.toContain('demo-secret');
  });

  it('CLI: `testpion mock` serves the saved examples of a collection', async () => {
    const cli = resolve('packages/cli/bin/testpion.js');
    const p = spawn(process.execPath, [cli, 'mock', 'Veterinary API', '-w', ws.root, '-q'], { env: { ...process.env, TESTPION_HOME: join(dir, 'home') } });
    try {
      const url = await new Promise<string>((ok, fail) => {
        let out = '';
        const t = setTimeout(() => fail(new Error(`mock server did not start: ${out}`)), 15_000);
        p.stdout.on('data', (d) => {
          out += d;
          const m = /(http:\/\/127\.0\.0\.1:\d+)/.exec(out);
          if (m) {
            clearTimeout(t);
            ok(m[1]!);
          }
        });
      });
      const found = await fetch(`${url}/patients/42`);
      expect(found.status).toBe(200);
      expect(await found.json()).toMatchObject({ name: 'Rex' });
      expect((await fetch(`${url}/patients/999`)).status).toBe(404);
      expect((await fetch(`${url}/patients/1`, { headers: { 'x-mock-response-name': 'Patient not found' } })).status).toBe(404);
    } finally {
      p.kill();
    }
  });
  it('API coverage: CLI `testpion coverage` and the api_coverage MCP tool', async () => {
    const cli = resolve('packages/cli/bin/testpion.js');
    const env = { ...process.env, TESTPION_HOME: join(dir, 'home') };
    const runOut = await run([cli, 'run-collection', 'Veterinary API', '-w', ws.root, '-e', 'Development', '--folder', 'Authentication', 'Patients', '-q'], env);
    expect(runOut.status).toBe(0);

    const spec = join(ws.root, 'specs', 'veterinary-api.yaml');
    const r = await run([cli, 'coverage', spec, '-w', ws.root, '--json'], env);
    expect(r.status).toBe(0);
    const report = JSON.parse(r.stdout);
    const op = (k: string) => report.operations.find((o: { method: string; path: string }) => `${o.method} ${o.path}` === k);
    expect(op('GET /patients').covered).toBe(true);
    expect(op('POST /patients').testedStatuses).toContain('201');
    expect(op('DELETE /patients/{id}').covered).toBe(false);
    expect(report.sources.runs).toHaveLength(1);
    expect(report.summary.operations).toBe(6);

    // a coverage gate for CI
    const gate = await run([cli, 'coverage', spec, '-w', ws.root, '--min', '100'], env);
    expect(gate.status).toBe(1);

    const s = new McpSession({ id: 'cov', name: 'testpion', transport: 'stdio', command: process.execPath, args: [cli, 'mcp-server', '-w', ws.root], env });
    await s.connect(20_000);
    try {
      const out = JSON.parse(mcpResultBody(await s.callTool('api_coverage', { spec: 'specs/veterinary-api.yaml' })).text);
      expect(out.summary.covered).toBe(report.summary.covered);
      // paths outside the workspace are refused
      expect((await s.callTool('api_coverage', { spec: '../../outside.yaml' })).isError).toBe(true);
    } finally {
      await s.close();
    }
  }, 90_000);
  it('saved evaluations: `testpion eval list|run` and the list_evaluations / run_evaluation MCP tools', async () => {
    const cli = resolve('packages/cli/bin/testpion.js');
    const env = { ...process.env, TESTPION_HOME: join(dir, 'home') };
    ws.saveLibrary('evaluations', {
      folders: ['Intents'],
      items: [
        {
          id: 'ev-1',
          name: 'Intent check',
          folder: 'Intents',
          data: {
            name: 'Intent check',
            type: 'llm',
            provider: 'mock-llm',
            model: 'mock-gpt',
            temperature: 0,
            prompt: 'Classify the customer intent. Respond with JSON {"intent": "cancellation" | "refill" | "booking" | "other"}.\n\nCustomer: {{input}}',
            format: 'json',
            datasetFormat: 'jsonl',
            dataset: '{"input":"Cancel my appointment","expected":"cancellation"}\n{"input":"I need a refill","expected":"refill"}',
            expectedField: 'expected',
            evaluators: [{ type: 'exact-match', path: '$.intent', expected: '{{expected}}' }],
            concurrency: 2,
            retries: 0,
          },
        },
      ],
    });
    const list = await run([cli, 'eval', 'list', '-w', ws.root, '--json'], env);
    expect(JSON.parse(list.stdout)).toEqual([expect.objectContaining({ name: 'Intent check', folder: 'Intents', cases: 2, evaluators: ['exact-match'] })]);

    const out = join(dir, 'eval-out');
    const r = await run([cli, 'eval', 'run', 'intent check', '-w', ws.root, '-o', out, '-q'], env);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'))).toMatchObject({ total: 2, passed: 2 });
    expect((await run([cli, 'eval', 'run', 'nope', '-w', ws.root], env)).status).toBe(2);

    const s = new McpSession({ id: 'ev', name: 'testpion', transport: 'stdio', command: process.execPath, args: [cli, 'mcp-server', '-w', ws.root], env });
    await s.connect(20_000);
    try {
      expect(JSON.parse(mcpResultBody(await s.callTool('list_evaluations', {})).text)[0].name).toBe('Intent check');
      const res = JSON.parse(mcpResultBody(await s.callTool('run_evaluation', { name: 'Intent check', limit: 1 })).text);
      expect(res).toMatchObject({ total: 1, passed: 1 });
    } finally {
      await s.close();
    }
  }, 90_000);
  it('CLI: `testpion load --saved` runs a load test saved in the app, with variables resolved', async () => {
    const cli = resolve('packages/cli/bin/testpion.js');
    const env = { ...process.env, TESTPION_HOME: join(dir, 'home') };
    ws.saveLibrary('load-tests', {
      folders: [],
      items: [{ id: 'lt-1', name: 'Health smoke', data: { kind: 'http', method: 'GET', url: '{{baseUrl}}/health', headers: [], body: '', vus: 2, duration: 2, rampUp: 0, rampDown: 0, rps: '', thresholds: 'errors<1%' } }],
    });
    const json = join(dir, 'load.json');
    const r = await run([cli, 'load', '--saved', 'health smoke', '-w', ws.root, '-e', 'Development', '--duration', '1', '--json', json], env);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const out = JSON.parse(readFileSync(json, 'utf8'));
    expect(out.requests).toBeGreaterThan(0);
    // --duration from the command line wins over the saved 2 seconds
    expect(out.elapsedSec).toBeLessThan(2);
    expect(out.thresholds).toEqual([expect.objectContaining({ expr: 'errors<1%', passed: true })]);
    expect((await run([cli, 'load', '--saved', 'nope', '-w', ws.root], env)).status).toBe(2);
  }, 60_000);
});
