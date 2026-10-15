import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import {
  applyFlowEdit,
  createEngineContext,
  defaultWebhookPath,
  EnvSecretStore,
  flowDeployStatus,
  lintTestFile,
  parseWebhook,
  sameSecret,
  startFlowWebhookServer,
  webhookFlows,
  WorkspaceManager,
  type FlowWebhookCall,
  type FlowWebhookServer,
  type WorkspaceStore,
} from '../../packages/core/src/index.js';
import { copyExample, tempDir } from '../helpers.js';

// A flow behind a webhook: a test file's webhook: block, the flow edit that sets it, the lint, and the server that runs
// the flow when its path is called (inputs from the body, the flow's output in the answer, secrets, limits).
const tmp = tempDir('tp-flow-webhooks-');
const root = copyExample('public-workspace', join(tmp.dir, 'ws'));
let store: WorkspaceStore;
let server: FlowWebhookServer;
const calls: FlowWebhookCall[] = [];

const write = (rel: string, text: string) => {
  mkdirSync(join(root, 'tests', 'hooks'), { recursive: true });
  writeFileSync(join(root, 'tests', rel), text);
};

beforeAll(async () => {
  write(
    'hooks/greet.yaml',
    '# says hello\nname: Greet\nwebhook: { path: /hooks/greet }\nexpose:\n  tool: greet\n  inputs:\n    - { name: name }\n    - { name: punct, default: "!" }\noutput:\n  greeting: "hello {{name}}{{punct}}"\ntests:\n  - { id: say, name: Say, type: log, message: "hi {{name}}" }\n',
  );
  write('hooks/free.yaml', 'name: Free\nwebhook: true\noutput: { got: "{{color}}" }\ntests:\n  - { id: say, name: Say, type: log, message: "{{color}}" }\n');
  write('hooks/locked.yaml', 'name: Locked\nwebhook: { path: /hooks/locked, secret: "{{HOOK_SECRET}}" }\noutput: { ok: "yes" }\ntests:\n  - { id: say, name: Say, type: log, message: x }\n');
  write('hooks/fail.yaml', 'name: Fail\nwebhook: { path: /hooks/fail }\ntests:\n  - { id: boom, name: Boom, type: script, script: "throw new Error(\'kaput\')" }\n');
  write('hooks/slow.yaml', 'name: Slow\nwebhook: { path: /hooks/slow }\ntests:\n  - { id: wait, name: Wait, type: delay, ms: 700 }\n');
  write('hooks/zz-dup.yaml', 'name: Dup\nwebhook: { path: /hooks/greet }\ntests:\n  - { id: say, name: Say, type: log, message: x }\n');
  const mgr = new WorkspaceManager(join(tmp.dir, 'home'));
  store = mgr.open(root);
  server = await startFlowWebhookServer({
    store,
    port: 0,
    maxConcurrent: 1,
    // the app passes its own context; here the secret {{HOOK_SECRET}} is a variable of it
    context: (c) => createEngineContext({ store, secrets: new EnvSecretStore(), environment: c.environment, runtimeVars: { HOOK_SECRET: 's3cret' } }),
    onRun: (e) => calls.push(e),
  });
});
afterAll(async () => {
  await server?.close();
  store?.close();
  tmp.cleanup();
});

const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(server.url + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('the webhook: block', () => {
  it('parses a map, a path or true; refuses bad paths and unknown keys', () => {
    expect(parseWebhook(undefined)).toBeUndefined();
    expect(parseWebhook(true)).toEqual({});
    expect(parseWebhook('/hooks/x/')).toEqual({ path: '/hooks/x' });
    expect(parseWebhook({ path: '/hooks/a', secret: '{{S}}' })).toEqual({ path: '/hooks/a', secret: '{{S}}' });
    expect(() => parseWebhook({ path: 'hooks/a' })).toThrow(/must start with \//);
    expect(() => parseWebhook({ path: '/hooks/../x' })).toThrow(/must start with/);
    expect(() => parseWebhook({ path: '/a b' })).toThrow(/must start with/);
    expect(() => parseWebhook({ path: '/a', token: 'x' })).toThrow(/takes path and secret/);
    expect(() => parseWebhook([1])).toThrow(/must be a map/);
    expect(defaultWebhookPath('orders/New Order.yaml')).toBe('/hooks/orders-new-order');
  });

  it('setWebhook writes it before output and the tests, keeps comments and CRLF; null removes it', () => {
    const text = '# a flow\r\nname: Flow\r\noutput:\r\n  a: "{{a}}"\r\ntests:\r\n  - { id: a, name: A, type: log, message: x } # step\r\n';
    const t = applyFlowEdit(text, { op: 'setWebhook', webhook: { path: '/hooks/flow', secret: '{{HOOK}}' } }, { file: 'flow.yaml' }).text;
    expect(t).toContain('# a flow\r\nname: Flow\r\nwebhook:\r\n  path: /hooks/flow\r\n  secret: "{{HOOK}}"\r\noutput:');
    expect(t).toContain('# step');
    expect(t).not.toMatch(/[^\r]\n/);
    // only the path changes: the secret stays; secret null removes it
    const moved = applyFlowEdit(t, { op: 'setWebhook', webhook: { path: '/hooks/other' } }).text;
    expect(moved).toContain('path: /hooks/other\r\n  secret: "{{HOOK}}"');
    expect(applyFlowEdit(moved, { op: 'setWebhook', webhook: { secret: null } }).text).not.toContain('secret');
    // a text is the path; {} the default
    expect(applyFlowEdit(text, { op: 'setWebhook', webhook: '/hooks/x' }).text).toContain('webhook:\r\n  path: /hooks/x');
    expect(applyFlowEdit(text, { op: 'setWebhook', webhook: {} }).text).toContain('webhook: {}');
    const back = applyFlowEdit(t, { op: 'setWebhook', webhook: null }).text;
    expect(back).toBe(text);
    expect(() => applyFlowEdit(text, { op: 'setWebhook', webhook: { path: 'nope' } })).toThrow(/must start with/);
  });

  it('lint: a bad block, and a path another flow uses', () => {
    expect(lintTestFile('name: X\nwebhook: { path: nope }\ntests: []\n').map((p) => `${p.severity}@${p.line}`)).toEqual(['error@2']);
    expect(lintTestFile('name: X\nwebhook: { path: /hooks/x }\ntests: []\n')).toEqual([]);
    const others = [{ file: 'a.yaml', path: '/hooks/x' }];
    expect(lintTestFile('name: X\nwebhook: { path: /hooks/x }\ntests: []\n', { file: '/w/tests/b.yaml', webhooks: others })[0]?.message).toMatch(/also used by tests\/a\.yaml/);
    // the file itself is not a duplicate of itself
    expect(lintTestFile('name: X\nwebhook: { path: /hooks/x }\ntests: []\n', { file: '/w/tests/a.yaml', webhooks: others })).toEqual([]);
    // the default path counts too
    expect(lintTestFile('name: X\nwebhook: true\ntests: []\n', { file: 'tests/x.yaml', webhooks: [{ file: 'y.yaml', path: '/hooks/x' }] })).toHaveLength(1);
  });

  it('finds the hooks of the workspace; a path used twice is served once', () => {
    const hooks = webhookFlows(store.path('tests'));
    expect(hooks.map((h) => `${h.file}=${h.path}${h.problem ? '!' : ''}`)).toEqual([
      'hooks/fail.yaml=/hooks/fail',
      'hooks/free.yaml=/hooks/hooks-free',
      'hooks/greet.yaml=/hooks/greet',
      'hooks/locked.yaml=/hooks/locked',
      'hooks/slow.yaml=/hooks/slow',
      'hooks/zz-dup.yaml=/hooks/greet!',
    ]);
    expect(hooks.find((h) => h.file === 'hooks/greet.yaml')?.inputs?.map((i) => i.name)).toEqual(['name', 'punct']);
  });

  it('compares secrets in constant time', () => {
    expect(sameSecret('abc', 'abc')).toBe(true);
    expect(sameSecret('abc', 'abd')).toBe(false);
    expect(sameSecret('ab', 'abc')).toBe(false);
  });
});

describe('the webhook server', () => {
  it('runs a flow with the body as its inputs and answers its output and steps', async () => {
    const r = await post('/hooks/greet', { name: 'Rex', extra: 'ignored' });
    expect(r.status).toBe(200);
    const b = (await r.json()) as Record<string, unknown>;
    expect(b).toMatchObject({ ok: true, output: { greeting: 'hello Rex!' }, steps: [{ name: 'Say', status: 'passed' }] });
    expect(String(b.runId)).toMatch(/^run-/);
    expect(typeof (b.steps as Array<{ ms: number }>)[0]!.ms).toBe('number');
    expect(calls.at(-1)).toMatchObject({ path: '/hooks/greet', status: 200, file: 'hooks/greet.yaml' });
  });

  it('declared inputs are required unless they have a default; GET takes the query', async () => {
    const r = await post('/hooks/greet', {});
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/Missing input: name/);
    const g = await fetch(`${server.url}/hooks/greet?name=Tom&punct=%3F`);
    expect(((await g.json()) as { output: unknown }).output).toEqual({ greeting: 'hello Tom?' });
  });

  it('without declared inputs every field is a variable; the default path works', async () => {
    const r = await post('/hooks/hooks-free/', { color: 'blue' });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { output: unknown }).output).toEqual({ got: 'blue' });
  });

  it('bad JSON is 400, an array body is 400, unknown paths 404, other methods 405', async () => {
    expect((await post('/hooks/greet', '{nope')).status).toBe(400);
    expect((await post('/hooks/greet', '[1,2]')).status).toBe(400);
    const nf = await post('/hooks/none', {});
    expect(nf.status).toBe(404);
    expect(((await nf.json()) as { hooks: string[] }).hooks).toContain('/hooks/greet');
    const put = await fetch(`${server.url}/hooks/greet`, { method: 'PUT', body: '{}' });
    expect(put.status).toBe(405);
    expect(put.headers.get('allow')).toBe('POST, GET');
  });

  it('a secret is checked: X-TestPion-Secret or Bearer, else 401', async () => {
    expect((await post('/hooks/locked', {})).status).toBe(401);
    expect((await post('/hooks/locked', {}, { 'x-testpion-secret': 'wrong' })).status).toBe(401);
    expect((await post('/hooks/locked', {}, { 'x-testpion-secret': 's3cret' })).status).toBe(200);
    expect((await post('/hooks/locked', {}, { authorization: 'Bearer s3cret' })).status).toBe(200);
  });

  it('a failing step is 422 with the step', async () => {
    const r = await post('/hooks/fail', {});
    expect(r.status).toBe(422);
    const b = (await r.json()) as { ok: boolean; failedStep: { name: string; error?: string } };
    expect(b.ok).toBe(false);
    expect(b.failedStep.name).toBe('Boom');
    expect(b.failedStep.error).toMatch(/kaput/);
  });

  it('a body over 1 MB is 413', async () => {
    const r = await post('/hooks/greet', JSON.stringify({ name: 'x'.repeat(1024 * 1024 + 10) }));
    expect(r.status).toBe(413);
  });

  it('beyond the concurrent runs it answers 429', async () => {
    // each call on its own connection (fetch would queue the second behind the first on one socket)
    const raw = (path: string) =>
      new Promise<{ status: number; headers: Record<string, unknown> }>((ok, fail) => {
        const req = request(server.url + path, { method: 'POST', agent: false, headers: { 'content-type': 'application/json' } }, (res) => {
          res.resume();
          res.on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers }));
        });
        req.on('error', fail);
        req.end('{"name":"x"}');
      });
    const slow = raw('/hooks/slow');
    await new Promise((r) => setTimeout(r, 200));
    const busy = await raw('/hooks/greet');
    expect(busy.status).toBe(429);
    expect(busy.headers['retry-after']).toBe('1');
    expect((await slow).status).toBe(200);
  });

  it('picks up a new flow without a restart, and hooks() lists them with their URLs', async () => {
    write('hooks/later.yaml', 'name: Later\nwebhook: { path: /hooks/later }\ntests:\n  - { id: a, name: A, type: log, message: x }\n');
    expect((await post('/hooks/later', {})).status).toBe(200);
    expect(server.hooks().find((h) => h.path === '/hooks/later')).toMatchObject({ file: 'hooks/later.yaml', url: `${server.url}/hooks/later`, secret: false });
    expect(server.hooks().find((h) => h.file === 'hooks/zz-dup.yaml')?.problem).toMatch(/already used/);
    rmSync(join(root, 'tests', 'hooks', 'later.yaml'));
  });

  it('survives a garbage request line', async () => {
    const { connect } = await import('node:net');
    await new Promise<void>((done) => {
      const s = connect(server.port, '127.0.0.1', () => s.write('GARBAGE\r\n\r\n'));
      s.on('data', () => s.destroy());
      s.on('close', () => done());
      s.on('error', () => done());
    });
    expect((await post('/hooks/greet', { name: 'ok' })).status).toBe(200);
  });
});

describe('deploy status', () => {
  it('names the webhook (served or not), the MCP tool and CI', () => {
    expect(flowDeployStatus(store, 'hooks/greet.yaml', { serving: { url: 'http://127.0.0.1:9' } })).toMatchObject({
      file: 'hooks/greet.yaml',
      webhook: { path: '/hooks/greet', url: 'http://127.0.0.1:9/hooks/greet', serving: true, secret: false },
      mcp: { name: 'greet' },
    });
    expect(flowDeployStatus(store, 'hooks/locked.yaml').webhook).toEqual({ path: '/hooks/locked', serving: false, secret: true });
    expect(flowDeployStatus(store, 'hooks/zz-dup.yaml').webhook?.problem).toMatch(/already used/);
    expect(flowDeployStatus(store, 'hooks/fail.yaml').mcp).toBeUndefined();
    // a pipeline that runs the file
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.github', 'workflows', 'api.yml'), 'jobs:\n  t:\n    steps:\n      - run: testpion test tests/hooks/fail.yaml -w .\n');
    expect(flowDeployStatus(store, 'hooks/fail.yaml')).toMatchObject({ ci: true, ciFiles: ['.github/workflows/api.yml'] });
    expect(flowDeployStatus(store, 'hooks/greet.yaml').ci).toBe(false);
  });
});
