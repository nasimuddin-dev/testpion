import { describe, it, expect, afterAll } from 'vitest';
import { runCliSync } from '../helpers.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `testpion openapi-lint`: problems as file:line:column, exit 1 on errors (or the --fail-on level), a folder or the workspace's specs/.
const dir = mkdtempSync(join(tmpdir(), 'tp-oalint-'));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
const cli = (...args: string[]) => runCliSync(['openapi-lint', ...args], { cwd: dir });
const good = [
  'openapi: 3.0.0',
  'info: { title: Pets, version: "1" }',
  'servers: [{ url: "https://api.example.com" }]',
  'paths:',
  '  /pets:',
  '    get:',
  '      operationId: listPets',
  '      summary: List',
  '      tags: [pets]',
  '      responses: { "204": { description: none } }',
  '',
].join('\n');
const bad = good.replace('  /pets:', '  /pets/{id}:');

describe('CLI: openapi-lint', () => {
  it('passes a clean document and fails one with an error, with its place', () => {
    writeFileSync(join(dir, 'good.yaml'), good);
    writeFileSync(join(dir, 'bad.yaml'), bad);
    const ok = cli('good.yaml');
    expect(ok.status, ok.err).toBe(0);
    expect(ok.out).toMatch(/No problems/);
    const r = cli('bad.yaml');
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/bad\.yaml:6:5\s+error\s+\{id\} is in the path but not declared as a path parameter\s+path-param-undeclared/);
    expect(cli('bad.yaml', '--fail-on', 'none').status).toBe(0);
    expect(cli('bad.yaml', '--disable', 'path-param-undeclared').status).toBe(0);
    expect(cli('bad.yaml', '--disable', 'nope').err).toMatch(/Unknown rule: nope/);
  }, 120_000);

  it('reads a folder, the workspace specs/, and prints JSON', () => {
    mkdirSync(join(dir, 'specs'), { recursive: true });
    writeFileSync(join(dir, 'workspace.json'), JSON.stringify({ name: 'lint' }));
    writeFileSync(join(dir, 'specs', 'pets.yaml'), bad);
    const [json] = JSON.parse(cli('--json', '--fail-on', 'none').out) as Array<{ problems: Array<{ rule: string; line: number }> }>;
    expect(json.problems.map((p) => `${p.rule}@${p.line}`)).toEqual(['path-param-undeclared@6']);
    expect(cli('specs').status).toBe(1);
    const rules = JSON.parse(cli('--rules', '--json').out) as Array<{ id: string }>;
    expect(rules.map((x) => x.id)).toContain('example-valid');
  }, 120_000);
});
