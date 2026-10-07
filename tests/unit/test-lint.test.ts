import { describe, it, expect } from 'vitest';
import { lintTestFile, testEditorGuide, testFileJsonSchema, testKeys } from '@testpion/core';

// The test-file editor's knowledge: which keys exist, and what is wrong in a file, with positions.
describe('test files: lint and keys', () => {
  it('flags unknown types, check types and keys, with positions; good files pass', () => {
    const text = [
      'name: Orders',
      'defaults:',
      '  type: http',
      'tests:',
      '  - id: list',
      '    name: List',
      '    method: GET',
      '    url: "{{baseUrl}}/orders"',
      '    assertions:',
      '      - { type: status, expected: 200 }',
      '  - id: create',
      '    name: Create',
      '    dependsOn: list',
      '    method: POST',
      '    url: "{{baseUrl}}/orders"',
      '    json: { name: x }',
      '    assertions:',
      '      - { type: json-path, path: $.id }',
      '',
    ].join('\n');
    expect(lintTestFile(text, { file: 'orders.yaml' })).toEqual([]);

    const bad = [
      'tests:',
      '  - name: Bad',
      '    type: htp',
      '    methd: GET',
      '    url: /x',
      '    assertions:',
      '      - { type: statuss }',
      '  - name: Dep',
      '    url: /y',
      '    dependsOn: nobody',
      '    method: FETCH',
      '',
    ].join('\n');
    const problems = lintTestFile(bad);
    const brief = problems.map((p) => `${p.severity} L${p.line}: ${p.message.split(':')[0]}`);
    expect(brief).toEqual([
      'error L3: Unknown test type "htp"',
      'warning L4: "methd" is not read',
      'error L7: Unknown check type "statuss"',
      'info L10: No test with id "nobody" in this file (fine when it is in another file of the run)',
      'warning L11: "FETCH" is not an HTTP method',
    ]);
    expect(problems[1]!.message).toContain('did you mean "method"');
    expect(problems[0]!.column).toBe(5);
  });

  it('a file that is not YAML, or not a map, says so', () => {
    expect(lintTestFile('tests: [')[0]!.severity).toBe('error');
    expect(lintTestFile('- just: a list')[0]!.message).toMatch(/A test file is a map/);
  });

  it('suites have their own keys', () => {
    expect(lintTestFile('name: Smoke\ntests: [rest]\nconcurency: 2\n', { suite: true }).map((p) => p.message)).toEqual([
      '"concurency" is not a suite key (name, description, tests, concurrency, retries, environment, tags)',
    ]);
  });

  it('offers keys by context and type, and a JSON Schema', () => {
    expect(testKeys('test', 'http').map((k) => k.key)).toContain('url');
    expect(testKeys('test', 'http').map((k) => k.key)).not.toContain('query');
    expect(testKeys('test', 'graphql').map((k) => k.key)).toContain('query');
    expect(testKeys('assertion').find((k) => k.key === 'type')!.values).toContain('json-schema');
    const g = testEditorGuide();
    expect(g.httpMethods).toContain('PATCH');
    expect(Object.keys(g.byType).sort()).toEqual(['agent', 'graphql', 'grpc', 'http', 'llm', 'mcp', 'rag', 'websocket']);
    const schema = testFileJsonSchema() as { oneOf: unknown[]; definitions: { assertion: { properties: { type: { enum: string[] } } } } };
    expect(schema.oneOf).toHaveLength(2);
    expect(schema.definitions.assertion.properties.type.enum).toContain('status');
  });

  it('reads checks: as assertions:, and checks its check types too', async () => {
    const { normalizeTest } = await import('@testpion/core');
    expect(normalizeTest({ name: 'x', type: 'http', url: 'http://a', checks: [{ type: 'status', expected: 200 }] }).assertions).toEqual([{ type: 'status', expected: 200 }]);
    const ok = ['name: x', 'type: graphql', 'url: http://a/graphql', 'query: subscription { a }', 'waitMs: 500', 'checks:', '  - type: status', '    expected: 101'].join('\n');
    expect(lintTestFile(ok)).toEqual([]);
    const bad = ['name: x', 'type: http', 'url: http://a', 'checks:', '  - type: statuss', '    expected: 200'].join('\n');
    expect(lintTestFile(bad).map((p) => p.message).join(' | ')).toMatch(/statuss/);
    const both = ['name: x', 'type: http', 'url: http://a', 'assertions: []', 'checks: []'].join('\n');
    expect(lintTestFile(both).map((p) => p.message).join(' | ')).toMatch(/only assertions: is read/);
  });
});
