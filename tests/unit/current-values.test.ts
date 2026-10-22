import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CurrentValues,
  MemorySecretStore,
  Redactor,
  VariableScope,
  runTests,
  ProviderRegistry,
  McpManager,
  type ExecServices,
  type TestCase,
} from '../../packages/core/src/index.js';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'pl-cv-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('current values (pm.environment.set etc.)', () => {
  it('stores plain values in a local file and sensitive ones in the secret store', async () => {
    const secrets = new MemorySecretStore();
    const cv = new CurrentValues(join(dir, 'cv.json'), secrets, 'ws1');
    await cv.set('environment', 'Dev', 'page', 2, false);
    await cv.set('environment', 'Dev', 'accessToken', 'tok-SECRET', true);
    await cv.set('globals', '', 'g', 'x', false);
    const onDisk = readFileSync(join(dir, 'cv.json'), 'utf8');
    expect(onDisk).not.toContain('tok-SECRET');
    expect(new CurrentValues(join(dir, 'cv.json'), secrets, 'ws1').get('environment', 'Dev')).toEqual({ page: 2, accessToken: 'tok-SECRET' });
    expect(cv.summary()).toEqual({ environment: { Dev: 2 }, globals: 1, collectionVariables: {} });

    const vars = new VariableScope();
    vars.setScope('environment', { page: 1, baseUrl: 'http://x' });
    const r = new Redactor();
    cv.apply(vars, { environment: 'Dev' }, r);
    expect(vars.describe('page')).toMatchObject({ scope: 'environment', value: 2 });
    expect(vars.get('g')).toBe('x');
    expect(r.redactString('Bearer tok-SECRET')).toBe('Bearer [REDACTED]');

    await cv.reset('environment', 'Dev');
    expect(cv.get('environment', 'Dev')).toEqual({});
    expect(secrets.list()).toEqual([]);
  });

  it('lets a test script set an environment value used by later tests in the run', async () => {
    const vars = new VariableScope();
    vars.setScope('environment', { greeting: 'hello' });
    const persisted: Array<[string, string, unknown]> = [];
    const redactor = new Redactor();
    const services: ExecServices = {
      vars,
      providers: new ProviderRegistry([], vars, redactor),
      mcp: new McpManager(() => undefined),
      mcpServers: [],
      redactor,
      pricing: [],
      defaultTimeoutMs: 5000,
      persistVariable: (scope, key, value) => persisted.push([scope, key, value]),
    };
    const tests: TestCase[] = [
      { id: 'a', name: 'sets', type: 'llm', model: { provider: 'mock', name: 'mock' }, prompt: 'hi', testScript: `pm.environment.set('greeting', 'bonjour');` } as TestCase,
      { id: 'b', name: 'uses', type: 'llm', model: { provider: 'mock', name: 'mock' }, prompt: '{{greeting}}', dependsOn: ['a'], assertions: [{ type: 'contains', expected: 'bonjour' }] } as TestCase,
    ];
    const s = await runTests({ name: 'cv', tests, services });
    expect(s).toMatchObject({ passed: 2, failed: 0 });
    expect(persisted).toEqual([['environment', 'greeting', 'bonjour']]);
    expect(vars.describe('greeting')).toMatchObject({ scope: 'environment', value: 'bonjour' });
  });
});

// S-5: a token-refresh script sets a variable on every request; each set rewrote the file with an fsync
describe('deferred writes', () => {
  it('200 sets from a run are written once, readable at once, and flushed at the end', async () => {
    const path = join(dir, 'cv.json');
    const cv = new CurrentValues(path, new MemorySecretStore(), 'ws1');
    for (let i = 0; i < 200; i++) await cv.set('environment', 'Dev', 'token', `t${i}`, false, { defer: true });
    expect(cv.writes).toBe(0);
    expect(cv.get('environment', 'Dev')).toEqual({ token: 't199' });
    cv.flush();
    expect(cv.writes).toBe(1);
    expect(new CurrentValues(path, new MemorySecretStore(), 'ws1').get('environment', 'Dev')).toEqual({ token: 't199' });
    cv.flush();
    expect(cv.writes).toBe(1);
    await cv.set('environment', 'Dev', 'page', 2, false); // an explicit set is still written before it returns
    expect(cv.writes).toBe(2);
  });
});
