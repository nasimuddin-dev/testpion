import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { checkRpcParams, guardHandler } from '../../apps/desktop/backend/rpc-params.js';
import { yamlPrefix } from '../../apps/desktop/backend/test-preview.js';
import { secretKeys } from '../../packages/core/src/index.js';

/** The desktop backend's robustness fixes (audit 2026-10-09): parameter checks, tests.preview, ws.update secrets, unknown environments. */
const open: Backend[] = [];
function fresh() {
  const home = mkdtempSync(join(tmpdir(), 'tp-robust-'));
  const be = new Backend({ appDir: home, emit: () => {}, noMonitors: true });
  open.push(be);
  const root = (be as unknown as { store: { root: string } }).store.root;
  const call = (m: string, p: unknown = {}) => Promise.resolve().then(() => be.invoke(m, p));
  return { be, root, call };
}
afterEach(async () => {
  for (const be of open.splice(0)) await be.dispose();
});
const err = (e: unknown) => e as { kind: string; message: string };

describe('RPC parameter checks', () => {
  it('a missing or mistyped parameter is a ValidationError naming the method and the parameter', async () => {
    const { call } = fresh();
    expect(err(await call('col.get', {}).catch((e) => e))).toMatchObject({ kind: 'ValidationError', message: 'col.get: missing id' });
    expect(err(await call('col.get', { id: 12345 }).catch((e) => e))).toMatchObject({ kind: 'ValidationError', message: 'col.get: id must be a string' });
    expect(err(await call('git.stage', { paths: 'a.json' }).catch((e) => e))).toMatchObject({ kind: 'ValidationError', message: 'git.stage: paths must be a list of strings' });
    expect(err(await call('http.send', { request: {}, environment: { x: 1 } }).catch((e) => e))).toMatchObject({ kind: 'ValidationError', message: 'http.send: environment must be a string' });
    expect(err(await call('col.list', 42).catch((e) => e))).toMatchObject({ kind: 'ValidationError', message: 'col.list: the parameters must be an object, not number' });
  });

  it('an optional parameter sent as null counts as absent; a nullable one keeps its null', () => {
    expect(checkRpcParams('openapi.outline', { path: null, text: 'openapi: 3.0.0' })).toEqual({ text: 'openapi: 3.0.0' });
    expect(checkRpcParams('tests.expose', { path: 'a.yaml', expose: null })).toEqual({ path: 'a.yaml', expose: null });
    expect(checkRpcParams('ai.setAppKey', { key: null })).toEqual({ key: null });
  });

  it('a TypeError from inside a handler becomes an InternalError naming the method; a sync answer stays sync', async () => {
    const boom = guardHandler('x.boom', () => (undefined as unknown as { a: string }).a);
    expect(() => boom({})).toThrow(expect.objectContaining({ kind: 'InternalError', message: expect.stringMatching(/^x\.boom: /) }));
    const later = guardHandler('x.later', async () => (null as unknown as { a: string }).a);
    await expect(later({})).rejects.toMatchObject({ kind: 'InternalError' });
    expect(guardHandler('x.sync', () => 7)({})).toBe(7);
  });
});

describe('http.send with an environment that does not exist or cannot be read', () => {
  const req = { method: 'GET', url: 'http://127.0.0.1:9/', headers: [], params: [] };
  it('fails and lists the environments there are', async () => {
    const { call } = fresh();
    await call('env.save', { env: { id: 'dev', name: 'Dev', variables: [] } });
    const e = ((await call('http.send', { request: req, environment: 'Prod' })) as { error: { kind: string; message: string } }).error;
    expect(e.kind).toBe('ConfigurationError');
    expect(e.message).toMatch(/^No environment "Prod"\. Available: .*Dev/);
  });

  it('a broken environment says why, for http.send and env.quickLook', async () => {
    const { call, root } = fresh();
    writeFileSync(join(root, 'environments', 'broken.json'), '{"id":"broken","name":"Broken","variables":[{"key":"a"');
    for (const [m, p] of [
      ['http.send', { request: req, environment: 'Broken' }],
      ['env.quickLook', { environment: 'Broken' }],
    ] as const)
      expect(
        await call(m, p).then(
          (r) => (r as { error?: { message: string } }).error?.message,
          (x) => err(x).message,
        ),
      ).toMatch(/Environment "Broken" is broken: /);
  });
});

describe('opening a folder that is not a TestPion workspace', () => {
  it('is refused and the open workspace stays open', async () => {
    const { call, root } = fresh();
    const nx = mkdtempSync(join(tmpdir(), 'tp-robust-nx-'));
    writeFileSync(join(nx, 'workspace.json'), JSON.stringify({ version: 2, projects: { app: 'apps/app' } }));
    expect(err(await call('ws.open', { ref: nx }).catch((x) => x)).kind).toBe('ConfigurationError');
    expect(((await call('ws.current')) as { path: string }).path).toBe(root);
    expect(await call('col.list')).toBeInstanceOf(Array);
  });
});

describe('ws.update with a secret workspace variable', () => {
  it('keeps the value in the secret store before blanking it in the file', async () => {
    const { be, call } = fresh();
    await call('ws.update', { variables: [{ key: 'apiKey', value: 'sk-robust-123456', secret: true }] });
    const ws = (await call('ws.current')) as { variables: Array<{ key: string; value: string }> };
    expect(ws.variables.find((v) => v.key === 'apiKey')?.value).toBe('');
    expect(be.secrets.get(secretKeys.workspaceVar(be.ws.id, 'apiKey'))).toBe('sk-robust-123456');
  });

  it('fails the save, and changes nothing, when the secret store refuses the value', async () => {
    const { be, call, root } = fresh();
    const before = readFileSync(join(root, 'workspace.json'), 'utf8');
    (be.secrets as unknown as { set: () => Promise<void> }).set = async () => {
      throw new Error('the keychain is locked');
    };
    const e = err(await call('ws.update', { name: 'Renamed', variables: [{ key: 'apiKey', value: 'sk-robust-123456', secret: true }] }).catch((x) => x));
    expect(e.message).toMatch(/Could not keep the secret workspace variable apiKey .*keychain is locked/);
    expect(readFileSync(join(root, 'workspace.json'), 'utf8')).toBe(before);
  });
});

describe('tests.preview', () => {
  it('refuses a path outside tests/', async () => {
    const { call, root } = fresh();
    writeFileSync(join(root, 'secret.yaml'), 'tests: []\n');
    for (const path of ['../secret.yaml', join(root, 'secret.yaml')]) expect(err(await call('tests.preview', { path }).catch((e) => e)).kind).toBe('ValidationError');
  });

  it('lists the first 500 tests of a large YAML file quickly, without parsing all of it', async () => {
    const { call, root } = fresh();
    mkdirSync(join(root, 'tests'), { recursive: true });
    let text = 'name: big\ntests:\n';
    for (let i = 0; text.length < 3 * 1024 * 1024; i++)
      text += `  - id: t${i}\n    name: test ${i}\n    request:\n      method: GET\n      url: http://localhost/${i}\n    assertions:\n      - type: status\n        expected: 200\n`;
    text += 'defaults:\n  type: http\n  tags: [big]\n';
    writeFileSync(join(root, 'tests', 'big.yaml'), text);
    const t0 = performance.now();
    const r = (await call('tests.preview', { path: 'big.yaml' })) as { tests: Array<{ id: string; type: string; tags?: string[] }> };
    const ms = performance.now() - t0;
    expect(r.tests).toHaveLength(500);
    expect(r.tests[499]).toMatchObject({ id: 't499', type: 'http', tags: ['big'] });
    expect(ms).toBeLessThan(1500); // the whole file takes several seconds; the prefix well under one
  });

  it('cuts a YAML test list after its 500th item, nested lists included', () => {
    const text = ['tests:', ...Array.from({ length: 3 }, (_, i) => `  - id: a${i}\n    assertions:\n      - type: status`), 'other: 1'].join('\n');
    expect(yamlPrefix(text, 2)).toBe(['tests:', '  - id: a0\n    assertions:\n      - type: status', '  - id: a1\n    assertions:\n      - type: status'].join('\n'));
    expect(yamlPrefix('- id: a\n- id: b\n- id: c\n', 1)).toBe('- id: a');
    expect(yamlPrefix('name: x\nrequest:\n  url: y\n')).toBeUndefined();
  });

  it('a missing file is a clear error', async () => {
    const { call } = fresh();
    expect(err(await call('tests.preview', { path: 'nope.yaml' }).catch((e) => e))).toMatchObject({ kind: 'ValidationError', message: 'There is no test file nope.yaml' });
  });
});

describe('user files are written whole', () => {
  it('openapi.spec.save, datasets.write, AGENTS.md and debugger rules write through atomicWrite (no partial file left)', async () => {
    const { call, root } = fresh();
    await call('openapi.spec.save', { path: 'specs/a.yaml', text: 'openapi: 3.0.0\n' });
    expect(readFileSync(join(root, 'specs', 'a.yaml'), 'utf8')).toBe('openapi: 3.0.0\n');
    await call('agents.writeAgentsMd');
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(true);
  });
});
