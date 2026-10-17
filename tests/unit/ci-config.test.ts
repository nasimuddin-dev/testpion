import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ENGINE_VERSION, WorkspaceStore, ciCommand, ciConfig, ciSecrets, ciTargetOfRun, contextOfItem, finishedRun, parseItemRef, recordRun, type CiProvider, type RunSummary } from '../../packages/core/src/index.js';
import { cliData, runCli } from '../helpers.js';

const dir = mkdtempSync(join(tmpdir(), 'tp-ci-'));
const store = WorkspaceStore.create(join(dir, 'ws'), 'CI');
store.saveEnvironment({ id: 'staging', name: 'Staging', variables: [{ key: 'baseUrl', value: 'https://x', enabled: true }, { key: 'apiKey', value: '', enabled: true, secret: true } as never] });
store.saveProviders([{ id: 'openai', name: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', apiKey: '{{$secret.provider.openai.apiKey}}' }]);
store.saveCollection({ schemaVersion: '1.0', id: 'api', name: 'My API', version: 0, variables: [], items: [], updatedAt: '' } as never);
store.writeTestFile('regression.suite.yaml', 'name: Regression\ntests: [rest]\n');
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('CI pipeline generation', () => {
  it('writes valid YAML for each provider, pinned to this version, with secrets by name only', () => {
    for (const provider of ['github', 'gitlab', 'azure'] as CiProvider[]) {
      const c = ciConfig(store, { provider, suite: 'regression', environment: 'Staging', workspaceDir: 'api tests' });
      expect(() => parseYaml(c.content)).not.toThrow();
      expect(c.content).toContain(`--branch v${ENGINE_VERSION}`);
      expect(c.content).toContain('--suite regression -e Staging');
      expect(c.content).toContain('-w "api tests"');
      expect(c.content).toContain('TESTPION_SECRET_ENV_STAGING_APIKEY');
    }
    expect(ciConfig(store, { provider: 'github', suite: 'regression' }).path).toBe('.github/workflows/testpion.yml');
    const jenkins = ciConfig(store, { provider: 'jenkins', collection: 'My API' });
    expect(jenkins.path).toBe('Jenkinsfile');
    expect(jenkins.content).toContain("junit 'test-results/junit.xml'");
  });

  it('installs the CLI by building @testpion/shared before core and cli, for every provider (its dist/ is not in git)', () => {
    for (const provider of ['github', 'gitlab', 'azure', 'jenkins'] as CiProvider[]) {
      const c = ciConfig(store, { provider, suite: 'regression' });
      expect(c.content).toContain('npm ci --no-audit --no-fund && npm run build -w @testpion/shared -w @testpion/core -w @testpion/cli');
      expect(c.content).not.toMatch(/npm run build -w @testpion\/core/);
    }
  });

  it('names the secrets: environment secrets, and provider keys only for test runs', () => {
    expect(ciSecrets(store, 'Staging').map((s) => s.name)).toEqual(['TESTPION_SECRET_ENV_STAGING_APIKEY', 'TESTPION_SECRET_PROVIDER_OPENAI_APIKEY']);
    expect(ciConfig(store, { provider: 'github', collection: 'My API', environment: 'Staging' }).secrets.map((s) => s.name)).toEqual(['TESTPION_SECRET_ENV_STAGING_APIKEY']);
  });

  it('builds the CLI command for a suite, a collection with folders, or test paths', () => {
    expect(ciCommand({ provider: 'github', suite: 'smoke' })).toBe('testpion run -w . --suite smoke -r console junit html -o test-results');
    expect(ciCommand({ provider: 'github', collection: 'My API', folders: ['Auth flow'], environment: 'Staging' })).toBe('testpion run-collection "My API" -w . -e Staging --folder "Auth flow" -r console junit html -o test-results');
    expect(ciCommand({ provider: 'github', tests: ['rest', 'mcp/x.yaml'], workspaceDir: 'qa' })).toBe('testpion test qa/tests/rest qa/tests/mcp/x.yaml -w qa -r console junit html -o test-results');
    expect(ciCommand({ provider: 'github' })).toBe('testpion test tests -w . -r console junit html -o test-results');
  });

  it('runs one flow file: named in the pipeline, checked to be inside tests/ and there', () => {
    store.writeTestFile('rest/checkout.yaml', 'name: Checkout\ntests: []\n');
    const c = ciConfig(store, { provider: 'github', tests: ['tests/rest/checkout.yaml'] });
    expect(c.command).toContain('test tests/rest/checkout.yaml -w .');
    expect(c.content).toContain('Runs the TestPion tests rest/checkout.yaml');
    expect(() => ciConfig(store, { provider: 'github', tests: ['rest/nope.yaml'] })).toThrow(/No test file or folder "tests\/rest\/nope.yaml"/);
    expect(() => ciConfig(store, { provider: 'github', tests: ['../secrets.json'] })).toThrow(/not a path inside tests/);
  });

  it('runs one flow at scale (data rows or an environment matrix), keeps its timeline, and says how to run it here', () => {
    store.writeTestFile('rest/checkout.yaml', 'name: Checkout\ntests: []\n');
    const data = ciCommand({ provider: 'github', tests: ['rest/checkout.yaml'], data: 'datasets/users.csv', environment: 'Staging' }, 'testpion');
    expect(data).toBe('mkdir -p test-results && testpion test tests/rest/checkout.yaml -w . --data datasets/users.csv -e Staging --json > test-results/data-run.json');
    const matrix = ciCommand({ provider: 'github', tests: ['rest/checkout.yaml'], envMatrix: ['dev', 'staging'], allowProduction: true }, 'testpion');
    expect(matrix).toBe('mkdir -p test-results && testpion test tests/rest/checkout.yaml -w . --env-matrix dev staging --allow-production --json > test-results/env-matrix.json');
    const timeline = ciCommand({ provider: 'github', tests: ['rest/checkout.yaml'], timelineHtml: true }, 'testpion');
    expect(timeline).toBe('testpion test tests/rest/checkout.yaml -w . -r console junit html -o test-results || code=$?; testpion flow report rest/checkout.yaml -w . --html test-results/timeline.html; exit ${code:-0}');
    expect(() => ciCommand({ provider: 'github', tests: ['rest', 'mcp'], timelineHtml: true })).toThrow(/exactly one test file/);
    expect(() => ciCommand({ provider: 'github', tests: ['rest/checkout.yaml'], data: '', envMatrix: ['dev'] })).toThrow(/not both/);
    const c = ciConfig(store, { provider: 'gitlab', tests: ['rest/checkout.yaml'], timelineHtml: true });
    expect(parseYaml(c.content)).toBeTruthy();
    // on this computer: the installed CLI and this workspace's folder
    expect(c.localCommand).toContain(store.root.replace(/\\/g, '/'));
    expect(c.localCommand).toMatch(/^testpion test .*checkout\.yaml/);
  });

  it('adds a breaking-change check of an OpenAPI document on pull requests', () => {
    for (const provider of ['github', 'gitlab', 'azure', 'jenkins'] as CiProvider[]) {
      const c = ciConfig(store, { provider, openapi: './api/openapi.yaml' });
      expect(c.content, provider).toContain('openapi-diff');
      expect(c.content, provider).toContain('FETCH_HEAD:api/openapi.yaml');
      expect(c.content, provider).toContain('--fail-on-breaking');
      expect(ciConfig(store, { provider }).content, provider).not.toContain('openapi-diff');
    }
    expect(ciConfig(store, { provider: 'github', openapi: 'openapi.yaml' }).content).toContain("if: github.event_name == 'pull_request'");
  });

  it('starts the system under test and waits for its health URL before integration tests', () => {
    for (const provider of ['github', 'gitlab', 'azure', 'jenkins'] as CiProvider[]) {
      const c = ciConfig(store, { provider, suite: 'regression', start: 'npm start', waitFor: 'http://127.0.0.1:3000/health', waitSeconds: 120 });
      expect(c.content, provider).toContain('(npm start) &');
      expect(c.content, provider).toContain('wait-for http://127.0.0.1:3000/health --timeout 120');
      // the system starts before the tests run
      expect(c.content.indexOf('npm start'), provider).toBeLessThan(c.content.indexOf('--suite regression'));
      expect(ciConfig(store, { provider, suite: 'regression' }).content, provider).not.toContain('wait-for');
    }
  });

  it('rejects unknown providers, suites, collections and environments', () => {
    expect(() => ciConfig(store, { provider: 'travis' as CiProvider })).toThrow(/github, gitlab, azure, jenkins/);
    expect(() => ciConfig(store, { provider: 'github', suite: 'nope' })).toThrow(/No suite "nope"/);
    expect(() => ciConfig(store, { provider: 'github', collection: 'Nope' })).toThrow(/No collection/);
    expect(() => ciConfig(store, { provider: 'github', environment: 'Nope' })).toThrow(/No environment/);
    expect(() => ciConfig(store, { provider: 'github', suite: 'regression', collection: 'My API' })).toThrow(/one of/);
  });
});

describe('CI pipelines and the CLI JSON envelope', () => {
  // `test --data` / `--env-matrix` keep their result as test-results/<kind>.json: since 0.46 that file is the CLI's JSON
  // envelope ({ schema_version, command, status, data: { rows, summary } … }). No generated step may read the old shape.
  const providers: CiProvider[] = ['github', 'gitlab', 'azure', 'jenkins'];
  store.writeTestFile('rest/checkout.yaml', 'tests:\n  - { id: a, url: "{{baseUrl}}/a" }\n');
  const runs = [
    { kind: 'data-run', o: { tests: ['rest/checkout.yaml'], data: 'datasets/users.csv' } },
    { kind: 'env-matrix', o: { tests: ['rest/checkout.yaml'], envMatrix: ['Staging'] } },
  ];

  it('every provider keeps the envelope as an artifact and no step reads the old top-level shape', () => {
    for (const provider of providers)
      for (const r of runs) {
        const c = ciConfig(store, { provider, ...r.o });
        expect(c.content, `${provider} ${r.kind}`).toContain(`--json > test-results/${r.kind}.json`);
        expect(c.content, provider).toMatch(/test-results/);
        // a reader of the file goes through .data (none is generated today; a new one must)
        for (const line of c.content.split('\n').filter((l) => l.includes(`${r.kind}.json`) && !l.includes('--json >'))) expect(line, `${provider}: ${line}`).toMatch(/\.data\b/);
        expect(c.content).not.toMatch(/jq\s+['"]?\.(rows|summary|columns)\b/);
      }
  });

  it('a plain run keeps the reporters (junit for the CI test tab, html for people), not JSON', () => {
    for (const provider of providers) {
      const c = ciConfig(store, { provider, tests: ['rest/checkout.yaml'] });
      expect(c.content, provider).toContain('-r console junit html -o test-results');
      expect(c.content, provider).not.toContain('--json');
    }
  });
});


describe('a run for CI: "last" and --allow-production', () => {
  let clock = 0;
  const record = (runId: string, extra: Partial<RunSummary>) =>
    recordRun(store, { runId, name: runId, startedAt: new Date(Date.UTC(2026, 9, 14, 0, 0, clock++)).toISOString(), finishedAt: '', durationMs: 1, total: 1, passed: 1, failed: 0, skipped: 0, errors: 0, cancelled: false, scores: {}, reproducibility: {}, ...extra } as unknown as RunSummary, store.runDir(runId));

  it('"last" is the newest FINISHED run of test files or a collection: a newer stopped run, monitor run or evaluation is passed by', async () => {
    await record('run-tests', { origin: { kind: 'tests', paths: ['rest'] } });
    await record('run-stopped', { origin: { kind: 'tests', paths: ['mcp'] }, cancelled: true });
    await record('run-monitor', { name: 'Monitor · Health', files: ['rest/checkout.yaml'] });
    await record('run-eval', { name: 'Intent' });
    expect(finishedRun(store, 'last').runId).toBe('run-tests');
    expect(ciTargetOfRun(store, finishedRun(store, 'last')).target).toEqual({ tests: ['rest'] });
    // by id a run is taken as it is
    expect(finishedRun(store, 'run-stopped').runId).toBe('run-stopped');
    // an AI task's --item run:last reads the same run (and run:last:<resultId> one of its results)
    expect((await contextOfItem(store, parseItemRef('run:last'))).label).toBe('run-tests');
    await expect(contextOfItem(store, parseItemRef('run:last:res-9'))).rejects.toThrow('No result "res-9" in run run-tests');
  });

  it('`testpion ci --allow-production` puts it on the run line', async () => {
    const r = await runCli(['ci', 'github', '-w', store.root, '--suite', 'regression', '--allow-production', '--json']);
    expect(r.status, r.err).toBe(0);
    expect(cliData(r.out).command).toMatch(/--suite regression .*--allow-production$/);
  });

  it('the GitHub Action builds @testpion/shared first and has an allow-production input for every target', () => {
    const action = readFileSync(join(__dirname, '../../action.yml'), 'utf8');
    expect(action).toContain('npm run build -w @testpion/shared -w @testpion/core -w @testpion/cli');
    expect((parseYaml(action) as { inputs: Record<string, unknown> }).inputs['allow-production']).toBeTruthy();
    expect(action.match(/\$PROD/g)?.length).toBe(3);
  });
});
