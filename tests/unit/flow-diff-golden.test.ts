import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { diffFlowSteps, flowChanges, flowDiffSummary, flowItemParts } from '../../packages/core/src/index.js';

/**
 * B-41a · the two flow-YAML step differs (the Git view's `flowChanges`, the AI review's `diffFlowSteps`) share one step
 * matcher. Their outputs were captured from the two separate implementations BEFORE they were unified
 * (tests/fixtures/flow-diff/golden.json); this test pins them byte for byte. Regenerate only on purpose:
 * `UPDATE_GOLDEN=1 npx vitest run tests/unit/flow-diff-golden.test.ts`, and say in the commit why the output moved.
 */
const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'flow-diff', 'golden.json');

const base = `name: Orders
description: the order lifecycle
tests:
  - id: create
    name: Create order
    method: POST
    url: "{{baseUrl}}/orders"
    headers: { Accept: application/json }
    body: { type: json, content: '{"item":"a"}' }
    extract: { orderId: $.id }
    assertions:
      - { type: status, expected: 201 }
  - id: get
    name: Get order
    dependsOn: [create]
    method: GET
    url: "{{baseUrl}}/orders/{{orderId}}"
    assertions:
      - { type: status, expected: 200 }
  - id: del
    name: Delete order
    dependsOn: [get]
    method: DELETE
    url: "{{baseUrl}}/orders/{{orderId}}"
layout:
  create: [0, 0]
  get: [200, 0]
`;

const PAIRS: Record<string, [string, string]> = {
  identical: [base, base],
  'formatting only': [base, base.replace('description: the order lifecycle', 'description:   the order lifecycle   # comment')],
  'layout only': [base, base.replace('get: [200, 0]', 'get: [300, 40]')],
  'body and extract changed, a check added': [
    base,
    base
      .replace(`'{"item":"a"}'`, `'{"item":"b"}'`)
      .replace('extract: { orderId: $.id }', 'extract: { orderId: $.id, total: $.total }')
      .replace('      - { type: status, expected: 201 }', '      - { type: status, expected: 201 }\n      - { type: exists, path: $.id }'),
  ],
  'url and header changed': [base, base.replace('"{{baseUrl}}/orders"', '"{{baseUrl}}/v2/orders"').replace('Accept: application/json', 'Accept: text/plain')],
  'step renamed by id, same content': [base, base.replace('id: get\n    name: Get order', 'id: fetch\n    name: Fetch order').replace('dependsOn: [get]', 'dependsOn: [fetch]')],
  'step renamed by name only': [base, base.replace('name: Get order', 'name: Read order')],
  'step id changed, other content changed too': [
    base,
    base.replace('id: get', 'id: read').replace('dependsOn: [get]', 'dependsOn: [read]').replace('"{{baseUrl}}/orders/{{orderId}}"\n    assertions', '"{{baseUrl}}/orders/{{orderId}}/full"\n    assertions'),
  ],
  'step added and one removed': [
    base,
    base.replace(/ {2}- id: del[\s\S]*?\{\{orderId\}\}"\n/, '  - id: list\n    name: List orders\n    dependsOn: [create]\n    method: GET\n    url: "{{baseUrl}}/orders"\n'),
  ],
  'steps reordered': [
    base,
    `name: Orders
description: the order lifecycle
tests:
  - id: get
    name: Get order
    dependsOn: [create]
    method: GET
    url: "{{baseUrl}}/orders/{{orderId}}"
    assertions:
      - { type: status, expected: 200 }
  - id: create
    name: Create order
    method: POST
    url: "{{baseUrl}}/orders"
    headers: { Accept: application/json }
    body: { type: json, content: '{"item":"a"}' }
    extract: { orderId: $.id }
    assertions:
      - { type: status, expected: 201 }
  - id: del
    name: Delete order
    dependsOn: [get]
    method: DELETE
    url: "{{baseUrl}}/orders/{{orderId}}"
`,
  ],
  'connections changed': [base, base.replace('dependsOn: [get]', 'dependsOn: [create, get]').replace('id: get\n    name: Get order\n    dependsOn: [create]', 'id: get\n    name: Get order')],
  'scripts, if, forEach and a setting': [
    base,
    base.replace('    method: DELETE', '    testScript: tp.test("ok", () => {})\n    preRequestScript: tp.variables.set("a", 1)\n    if: "{{go}}"\n    forEach: [{ n: 1 }]\n    retries: 3\n    method: DELETE'),
  ],
  'steps without ids (named, then positional)': [
    'tests:\n  - name: First call\n    method: GET\n    url: /a\n  - method: GET\n    url: /b\n  - name: First call\n    method: GET\n    url: /c\n',
    'tests:\n  - name: First call\n    method: GET\n    url: /a\n  - method: GET\n    url: /b2\n  - name: First call\n    method: GET\n    url: /c\n  - method: GET\n    url: /d\n',
  ],
  'renamed by endpoint, numeric ids in the path': [
    'tests:\n  - id: a\n    name: One\n    method: GET\n    url: "{{baseUrl}}/users/42/orders?x=1"\n',
    'tests:\n  - id: b\n    name: Two\n    method: GET\n    url: "https://api.test/users/7/orders"\n',
  ],
  'graphql and mcp steps': [
    'tests:\n  - id: q\n    type: graphql\n    url: /gql\n    query: "{ a }"\n    variables: { a: 1 }\n  - id: m\n    type: mcp\n    server: s\n    tool: t\n    arguments: { a: 1 }\n',
    'tests:\n  - id: q\n    type: graphql\n    url: /gql\n    query: "{ a b }"\n    variables: { a: 2 }\n  - id: m\n    type: mcp\n    server: s\n    tool: t2\n    arguments: { a: 1 }\n',
  ],
  'request: block': [
    'tests:\n  - id: r\n    request:\n      method: GET\n      url: /a\n      headers: { A: "1" }\n',
    'tests:\n  - id: r\n    request:\n      method: GET\n      url: /b\n      headers: { A: "2" }\n',
  ],
  'a file added': ['', base],
  'a file removed': [base, ''],
  'flow renamed, defaults and expose changed': [base, base.replace('name: Orders', 'name: Order flow').replace('description: the order lifecycle', 'description: x\ndefaults: { type: http }\nexpose: { name: orders }')],
  'a single-step document': ['type: http\nurl: /a\nmethod: GET\n', 'type: http\nurl: /b\nmethod: GET\n'],
  'a bare list of steps': ['- id: a\n  method: GET\n  url: /a\n', '- id: a\n  method: GET\n  url: /b\n- id: c\n  method: GET\n  url: /c\n'],
  'not a flow': ['just: text\n', 'other: text\n'],
  'broken yaml': ['tests: [\n', base],
  'duplicate ids': ['tests:\n  - id: a\n    url: /1\n  - id: a\n    url: /2\n', 'tests:\n  - id: a\n    url: /1\n  - id: a\n    url: /3\n'],
  'same endpoint twice, matched in order': [
    'tests:\n  - id: x1\n    method: GET\n    url: /same\n    extract: { a: $.a }\n  - id: x2\n    method: GET\n    url: /same\n    extract: { b: $.b }\n',
    'tests:\n  - id: y1\n    method: GET\n    url: /same\n    extract: { b: $.b }\n  - id: y2\n    method: GET\n    url: /same\n    extract: { a: $.a }\n',
  ],
  'identical bodies swapped between removed and added': [
    'tests:\n  - id: a1\n    method: GET\n    url: /x\n  - id: a2\n    method: GET\n    url: /x\n  - id: keep\n    url: /k\n',
    'tests:\n  - id: b1\n    method: GET\n    url: /x\n  - id: b2\n    method: GET\n    url: /x\n  - id: keep\n    url: /k\n',
  ],
};

function capture() {
  const out: Record<string, unknown> = {};
  for (const [name, [a, b]] of Object.entries(PAIRS)) {
    const steps = diffFlowSteps(a, b);
    out[name] = {
      git: flowChanges('tests/f.yaml', a || undefined, b || undefined) ?? null,
      gitJson: flowChanges('tests/f.json', a || undefined, b || undefined) ?? null,
      ai: steps,
      aiSummary: flowDiffSummary(steps),
      partsA: flowItemParts('tests/f.yaml', a || undefined) ?? null,
      partsB: flowItemParts('tests/f.yaml', b || undefined, 'get') ?? null,
    };
  }
  return JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
}

describe('flow step differs: output pinned byte for byte (B-41a)', () => {
  const got = capture();
  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(GOLDEN)) {
    mkdirSync(dirname(GOLDEN), { recursive: true });
    writeFileSync(GOLDEN, JSON.stringify(got, null, 2) + '\n');
  }
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>;
  it('has a golden for every pair, and none left over', () => {
    expect(Object.keys(golden).sort()).toEqual(Object.keys(PAIRS).sort());
  });
  for (const name of Object.keys(PAIRS))
    it(`${name}: Git view and AI review outputs are unchanged`, () => {
      expect(got[name]).toEqual(golden[name]);
    });
});
