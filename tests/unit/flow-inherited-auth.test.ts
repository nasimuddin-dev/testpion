import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { flowOfFile, loadTestsFromFile, WorkspaceStore, type TestCase } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';

// A flow step that has no auth of its own runs with the file's `defaults: auth:` — the designer's inspector shows that
// (source: "from defaults") instead of "No auth", and the step can override it.
const tmp = tempDir('tp-flow-auth-');
afterAll(() => tmp.cleanup());

const FILE = `defaults:
  auth: { type: bearer, token: '{{token}}' }
tests:
  - id: flat
    name: Flat step
    url: https://api.test/a
  - id: nested
    name: Nested request
    request: { method: POST, url: https://api.test/b }
  - id: own
    name: Own auth
    url: https://api.test/c
    auth: { type: basic, username: me, password: pw }
  - id: none
    name: Without auth
    request: { url: https://api.test/d, auth: { type: none } }
  - id: wait
    name: Wait
    type: delay
    ms: 10
`;

describe('auth inherited from defaults:', () => {
  const store = WorkspaceStore.create(join(tmp.dir, 'ws'), 'Auth');
  store.writeTestFile('auth-flow.yaml', FILE);

  it('the runner sends it for flat and nested-request steps; a step’s own auth (or none) overrides it', async () => {
    const tests: TestCase[] = [];
    for await (const t of loadTestsFromFile(join(store.root, 'tests', 'auth-flow.yaml'))) tests.push(t);
    const auth = (id: string) => {
      const t = tests.find((x) => x.id === id)!;
      return t.type === 'http' ? t.request.auth : undefined;
    };
    expect(auth('flat')).toMatchObject({ type: 'bearer', token: '{{token}}' });
    expect(auth('nested')).toMatchObject({ type: 'bearer', token: '{{token}}' });
    expect(auth('own')).toMatchObject({ type: 'basic', username: 'me' });
    expect(auth('none')).toMatchObject({ type: 'none' });
  });

  it('tests.flow (raw) names each step’s inherited auth and its source, only where it applies', async () => {
    const flow = await flowOfFile(store, 'auth-flow.yaml', { raw: true });
    const bearer = { type: 'bearer', token: '{{token}}' };
    expect(flow.inheritedAuth).toEqual({
      flat: { auth: bearer, from: 'defaults' },
      nested: { auth: bearer, from: 'defaults' },
      // their own auth wins; Inherit goes back to the defaults' one
      own: { auth: bearer, from: 'defaults', overridden: true },
      none: { auth: bearer, from: 'defaults', overridden: true },
    });
    // the terminal and agents (testpion flow --json, flow_graph) get it too, without a credential typed into the file
    const plain = await flowOfFile(store, 'auth-flow.yaml');
    expect(plain.inheritedAuth?.flat).toEqual({ auth: { type: 'bearer', token: '{{token}}' }, from: 'defaults' });
    store.writeTestFile('typed.yaml', "defaults:\n  auth: { type: basic, username: me, password: hunter2 }\ntests:\n  - { id: a, name: A, url: 'https://x.test' }\n");
    const typed = await flowOfFile(store, 'typed.yaml');
    expect(typed.inheritedAuth?.a?.auth).toEqual({ type: 'basic', username: 'me', password: '***' });
    expect((await flowOfFile(store, 'typed.yaml', { raw: true })).inheritedAuth?.a?.auth.password).toBe('hunter2');
  });
});
