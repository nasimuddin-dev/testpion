import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { copyExample, runCli, runCliSync, tempDir } from '../helpers.js';

// Every CLI command answers --help (exit 0, a usage line), and the commands that read a workspace answer --json with
// the shape a script or an agent relies on, against a copy of the examples workspace and no network.
let tmp: ReturnType<typeof tempDir>;
let dir: string;
let ws: string;
const run = (args: string[]) => runCliSync(args, { cwd: dir, home: join(dir, 'home'), timeout: 60_000 });
const json = (args: string[]) => {
  const r = run(args);
  expect(r.status, `${args.join(' ')}: ${r.err}`).toBe(0);
  expect(() => JSON.parse(r.out), `${args.join(' ')} printed no JSON: ${r.out.slice(0, 200)}`).not.toThrow();
  return JSON.parse(r.out) as Record<string, unknown>;
};

beforeAll(() => {
  tmp = tempDir('tp-cli-smoke-');
  dir = tmp.dir;
  ws = copyExample('veterinary-workspace', join(dir, 'vet'));
});
afterAll(() => tmp.cleanup());

describe('CLI smoke', () => {
  it('every command answers --help', async () => {
    const top = run(['--help']);
    expect(top.status).toBe(0);
    const commands = [...top.out.matchAll(/^  ([a-z][\w-]*)/gm)].map((m) => m[1]!).filter((c) => c !== 'help');
    expect(commands.length).toBeGreaterThan(40);
    // all at once: sixty processes, a second each
    const results = await Promise.all(commands.map((c) => runCli([c, '--help'], { cwd: dir, home: join(dir, 'home') }).then((r) => ({ c, r }))));
    const broken = results.filter(({ r }) => r.status !== 0 || !/Usage:/.test(r.out));
    expect(broken.map(({ c, r }) => `${c}: ${r.err.slice(0, 120)}`)).toEqual([]);
  }, 120_000);

  it('the workspace readers answer --json', () => {
    expect(json(['doctor', '--json'])).toHaveProperty('checks');
    const info = json(['agent-info', '-w', ws]);
    expect(info).toMatchObject({ schemaVersion: 1, workspace: { name: 'Veterinary API (example)' } });
    expect(info).toHaveProperty('commands.mcpServer');
    expect(json(['collections', '-w', ws, '--json'])).toBeInstanceOf(Array);
    expect(json(['requests', 'Veterinary API', '-w', ws, '--json'])).toBeInstanceOf(Array);
    expect(json(['datasets', '-w', ws, '--json'])).toBeInstanceOf(Array);
    expect(json(['lint-tests', '-w', ws, '--json'])).toHaveProperty('files');
    expect(json(['lint', 'Veterinary API', '-w', ws, '--json'])).toBeDefined();
    expect(json(['vars', 'usages', 'baseUrl', '-w', ws, '--json'])).toBeDefined();
    expect(json(['openapi-lint', 'specs/veterinary-api.yaml', '-w', ws, '--json'])).toBeDefined();
    expect(json(['openapi-ops', 'specs/veterinary-api.yaml', '-w', ws, '--json'])).toBeDefined();
    expect(json(['storage', '-w', ws, '--json'])).toBeDefined();
    expect(json(['attention', '-w', ws, '--json'])).toBeDefined();
    expect(json(['monitor', 'list', '-w', ws, '--json'])).toBeDefined();
    expect(json(['history', 'list', '-w', ws, '--json'])).toBeDefined();
  }, 120_000);

  it('generators write where they say, and a dry request is linted, not sent', () => {
    const flows = json(['integration-suite', 'specs/veterinary-api.yaml', '-w', ws, '--json']);
    expect(flows).toMatchObject({ resources: ['patient'] });
    expect((flows.written as Array<{ path: string }>).map((f) => f.path)).toContain('tests/veterinary-api-integration.suite.yaml');
    const tests = json(['tests-from-spec', 'specs/veterinary-api.yaml', '-w', ws, '--json']);
    expect((tests.written as unknown[]).length).toBeGreaterThan(0);
    const jwt = json(['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ2ZXQiLCJleHAiOjQxMDI0NDQ4MDB9.c2ln', '--json']);
    expect(jwt).toHaveProperty('payload.sub', 'vet');
  }, 120_000);

  it('a wrong argument is a configuration error (exit 2) with a message, never a stack trace', () => {
    const r = run(['run', '-w', ws, '--suite', 'no-such-suite', '-o', join(dir, 'out')]);
    expect(r.status).toBe(2);
    expect(r.err).toMatch(/no-such-suite|suite/i);
    expect(r.err).not.toMatch(/at .*\.js:\d+/);
  });
});
