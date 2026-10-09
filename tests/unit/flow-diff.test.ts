import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitIdentity } from '../helpers.js';
import {
  WorkspaceStore,
  changesMarkdown,
  describeGitChanges,
  describeItemDiff,
  describeRevChanges,
  flowChanges,
  flowItemParts,
  gitCommit,
  gitInit,
  gitStatus,
  gitVersion,
  isFlowFile,
} from '../../packages/core/src/index.js';

const hasGit = !!(await gitVersion());

const before = `name: Checkout
defaults: { type: http }
tests:
  - id: login
    method: POST
    url: "{{baseUrl}}/login"
    extract: { token: $.token }
    assertions: [{ type: status, expected: 200 }]
  - id: cart
    dependsOn: login
    method: GET
    url: "{{baseUrl}}/cart"
    headers: { Authorization: "Bearer {{token}}" }
  - id: pay
    dependsOn: cart
    method: POST
    url: "{{baseUrl}}/pay"
    body: { amount: 10 }
  - id: old
    method: GET
    url: "{{baseUrl}}/old"
layout:
  login: [0, 0]
  cart: [200, 0]
`;

describe('flow files diffed by meaning', () => {
  it('knows test files from suites and other files', () => {
    expect(isFlowFile('tests/a/checkout.yaml')).toBe(true);
    expect(isFlowFile('tests/all.suite.yaml')).toBe(false);
    expect(isFlowFile('collections/x.json')).toBe(false);
  });

  it('steps added, removed, renamed and changed (with the parts), connections, rearranged', () => {
    const after = `name: Checkout
defaults: { type: http }
tests:
  - id: login
    method: POST
    url: "{{baseUrl}}/auth/login"
    extract: { token: $.access_token }
    assertions: [{ type: status, expected: 200 }, { type: exists, path: $.access_token }]
  - id: basket
    dependsOn: login
    method: GET
    url: "{{baseUrl}}/cart"
    headers: { Authorization: "Bearer {{token}}" }
  - id: pay
    dependsOn: login
    method: POST
    url: "{{baseUrl}}/pay"
    body: { amount: 20 }
    if: "{{total}} > 0"
    forEach: [{ n: 1 }]
    retries: 2
  - id: receipt
    dependsOn: pay
    method: GET
    url: "{{baseUrl}}/receipt"
layout:
  login: [0, 50]
  basket: [200, 0]
`;
    const ch = flowChanges('tests/checkout.yaml', before, after)!;
    const by = (t: string) => ch.find((c) => c.title === t);
    expect(by('flow Checkout')).toMatchObject({ change: 'changed', details: ['rearranged'] });
    expect(by('Checkout ▸ login')).toMatchObject({ change: 'changed', details: ['request line', 'extract', 'checks (1 → 2)'], itemId: 'login', itemKind: 'step' });
    expect(by('Checkout ▸ basket')).toMatchObject({ change: 'renamed', details: ['was cart'] });
    expect(by('Checkout ▸ pay')).toMatchObject({ change: 'changed', details: ['body', 'if', 'forEach', 'retries'] });
    expect(by('Checkout ▸ receipt')).toMatchObject({ change: 'added', details: ['step'] });
    expect(by('Checkout ▸ old')).toMatchObject({ change: 'removed', details: ['step'] });
    // pay now waits for login instead of the renamed cart step; receipt's own edge goes without saying
    expect(by('Checkout ▸ connections')).toMatchObject({ change: 'changed', details: ['added login → pay', 'removed basket → pay'] });
    expect(changesMarkdown(ch)).toContain('**Checkout ▸ pay**: body, if, forEach, retries');
  });

  it('a layout-only change is "rearranged", not a content change; comments alone are formatting', () => {
    const moved = before.replace('cart: [200, 0]', 'cart: [300, 40]');
    expect(flowChanges('tests/checkout.yaml', before, moved)).toEqual([{ file: 'tests/checkout.yaml', kind: 'test', change: 'changed', title: 'flow Checkout', details: ['rearranged'] }]);
    expect(flowChanges('tests/checkout.yaml', before, `# a note\n${before}`)).toEqual([
      { file: 'tests/checkout.yaml', kind: 'test', change: 'changed', title: 'flow Checkout', details: ['formatting or comments'] },
    ]);
  });

  it('added and removed files, file-level keys, a step renamed in words, and text that is not a flow', () => {
    expect(flowChanges('tests/checkout.yaml', undefined, before)).toEqual([{ file: 'tests/checkout.yaml', kind: 'test', change: 'added', title: 'flow Checkout', details: ['4 steps'] }]);
    expect(flowChanges('tests/checkout.yaml', before, undefined)![0]).toMatchObject({ change: 'removed' });
    const named = before
      .replace('  - id: old\n', '  - id: old\n    name: Legacy\n')
      .replace('defaults: { type: http }', 'defaults: { type: http }\nexpose: { tool: checkout }\noutput: { t: "{{token}}" }');
    const ch = flowChanges('tests/checkout.yaml', before, named)!;
    expect(ch[0]).toMatchObject({ title: 'flow Checkout', details: ['expose (MCP tool)', 'output'] });
    expect(ch[1]).toMatchObject({ title: 'Checkout ▸ Legacy', change: 'changed', details: ['description'] });
    const n2 = named.replace('name: Legacy', 'name: Older');
    expect(flowChanges('tests/checkout.yaml', named, n2)![0]).toMatchObject({ change: 'renamed', title: 'Checkout ▸ Older', details: ['renamed from "Legacy"'] });
    expect(flowChanges('tests/x.yaml', 'a: [', before)).toBeUndefined();
  });

  it('a step side by side, part by part', () => {
    const parts = flowItemParts('tests/checkout.yaml', before, 'cart')!;
    expect(parts['Request line']).toContain('{{baseUrl}}/cart');
    expect(parts.Headers).toContain('Bearer {{token}}');
    expect(parts['Depends on']).toBe('login');
    const file = flowItemParts('tests/checkout.yaml', before)!;
    expect(file.Steps).toBe('login\ncart ← login\npay ← cart\nold');
    expect(file.Layout).toContain('cart');
  });

  it.skipIf(!hasGit)('in git: the working folder and a commit range say what changed in a flow; Compare shows a step', async () => {
    const ws = join(mkdtempSync(join(tmpdir(), 'tp-flowdiff-')), 'ws');
    const store = WorkspaceStore.create(ws, 'Flows');
    await gitInit(ws);
    await gitIdentity(ws);
    mkdirSync(join(ws, 'tests'), { recursive: true });
    writeFileSync(join(ws, 'tests', 'checkout.yaml'), before);
    await gitCommit(ws, 'Flow', { paths: ['.'] });
    writeFileSync(join(ws, 'tests', 'checkout.yaml'), before.replace('amount: 10', 'amount: 11'));
    const st = await gitStatus(ws);
    const now = await describeGitChanges(ws, st.files);
    expect(now).toEqual([{ file: 'tests/checkout.yaml', kind: 'test', change: 'changed', title: 'Checkout ▸ pay', details: ['body'], itemId: 'pay', itemKind: 'step' }]);
    expect((await describeRevChanges(ws, 'HEAD')).map((c) => c.title)).toEqual(['Checkout ▸ pay']);
    const d = await describeItemDiff(ws, 'tests/checkout.yaml', 'pay');
    expect(d.parts.find((p) => p.part === 'Body')).toMatchObject({ differs: true, before: 'amount: 10', after: 'amount: 11' });
    store.close();
  });
});
