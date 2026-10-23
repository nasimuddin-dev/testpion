import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTestPionMcpServer, EnvSecretStore, WorkspaceManager } from '../../packages/core/src/index.js';
import { makeRepo, type TestRepo } from '../helpers-git';
import { tempDir } from '../helpers';

/**
 * Release C of "Everything under Git" for agents: git_fix_setup, git_large_files, git_track_large, git_share_session,
 * git_codeowners, git_allowed_secrets and git_secrets_fix_plan, through the same in-memory client / server pair as the other
 * MCP tests. What they write needs `confirm: true`; the allowlist can be read but not extended by an agent.
 */
const home = tempDir('tp-git-setup-mcp-home-');
let r: TestRepo;
let client: Client;

type Result = Awaited<ReturnType<Client['callTool']>>;
const texts = (res: Result) => (res.content as Array<{ type: string; text: string }>).map((c) => c.text);
async function call<T = any>(name: string, args: Record<string, unknown> = {}): Promise<{ res: Result; data: T }> {
  const res = await client.callTool({ name, arguments: args });
  let data: unknown;
  try {
    data = JSON.parse(texts(res)[0] ?? '');
  } catch {
    data = texts(res)[0];
  }
  return { res, data: data as T };
}

beforeAll(async () => {
  r = await makeRepo();
  // an older workspace: no diff driver in the attributes, a collection in the older form
  r.write('.gitattributes', '* text=auto eol=lf\ncollections/*.json merge=testpion\n');
  r.write('environments/staging.json', '{\r\n  "variables": [],\r\n  "name": "Staging",\r\n  "id": "staging"\r\n}\r\n');
  await r.commit('older');
  const mgr = new WorkspaceManager(home.dir);
  const store = mgr.open(r.ws);
  const server = createTestPionMcpServer({ store, secrets: new EnvSecretStore(), settings: mgr.loadSettings(), profile: 'verbose' }); // (the complete entries: the compact list leaves out when-not and the example)
  client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
}, 120_000);
afterAll(async () => {
  await client.close();
  r.cleanup();
  home.cleanup();
});

describe('the tools and their contract', () => {
  it('are listed with when / when not / example; the ones that write take confirm, the reads do not, and an agent cannot add to the allowlist', async () => {
    const tools = (await client.listTools()).tools;
    const by = (n: string) => tools.find((t) => t.name === n)!;
    const all = ['git_fix_setup', 'git_large_files', 'git_track_large', 'git_share_session', 'git_codeowners', 'git_allowed_secrets', 'git_secrets_fix_plan'];
    for (const n of all) {
      expect(by(n), n).toBeDefined();
      expect(by(n).description, n).toMatch(/\nWhen to use: .+\nWhen not: .+\nExample: \{/);
    }
    for (const n of ['git_fix_setup', 'git_track_large', 'git_share_session', 'git_codeowners']) expect(by(n).inputSchema.properties, n).toHaveProperty('confirm');
    for (const n of ['git_large_files', 'git_allowed_secrets', 'git_secrets_fix_plan']) expect(by(n).inputSchema.properties, n).not.toHaveProperty('confirm');
    expect(tools.map((t) => t.name).filter((n) => /allow/.test(n))).toEqual(['git_allowed_secrets']);
  });
});

describe('git_fix_setup', () => {
  it('without confirm it asks (and previews with the plan); dryRun is allowed as it is and writes nothing', async () => {
    const before = r.read('.gitattributes');
    const ask = await call('git_fix_setup', {});
    expect(ask.res.isError).toBe(true);
    expect(ask.res.structuredContent).toMatchObject({ confirmationRequired: true });
    expect(r.read('.gitattributes')).toBe(before);
    const dry = await call<{ dryRun: boolean; changed: boolean; steps: Array<{ id: string }>; rewritten: Array<{ file: string }> }>('git_fix_setup', { dryRun: true });
    expect(dry.res.isError).toBeFalsy();
    expect(dry.data).toMatchObject({ dryRun: true, changed: true });
    expect(dry.data.steps.map((s) => s.id)).toEqual(expect.arrayContaining(['gitattributes', 'stable-format']));
    expect(dry.data.rewritten.map((x) => x.file)).toContain('environments/staging.json');
    expect(r.read('.gitattributes')).toBe(before);
  });

  it('with confirm it fixes, returns an undoId, and a second run has nothing to do; git_undo puts the files back', async () => {
    const res = await call<{ applied: boolean; undoId: string }>('git_fix_setup', { confirm: true });
    expect(res.data).toMatchObject({ applied: true });
    expect(r.read('.gitattributes')).toContain('collections/*.json merge=testpion diff=testpion');
    expect(r.read('environments/staging.json')).toBe('{\n  "id": "staging",\n  "name": "Staging",\n  "variables": []\n}\n');
    const again = await call<{ changed: boolean }>('git_fix_setup', { dryRun: true });
    expect(again.data.changed).toBe(false);
    const undo = await call('git_undo', { id: res.data.undoId, confirm: true });
    expect(undo.res.isError).toBeFalsy();
    expect(r.read('environments/staging.json')).toContain('\r\n');
  });
});

describe('big files and shared sessions', () => {
  it('git_large_files lists a file over the policy; git_track_large writes a reference only with confirm, and the data is ignored', async () => {
    mkdirSync(join(r.ws, 'datasets'), { recursive: true });
    writeFileSync(join(r.ws, 'datasets', 'big.csv'), 'a,b\n' + '1,2222222222222222222222222222222222222222222222222222222\n'.repeat(110_000));
    const list = await call<{ files: Array<{ file: string; level: string }> }>('git_large_files');
    expect(list.data.files.map((f) => `${f.file} ${f.level}`)).toEqual(['datasets/big.csv warn']);
    const ask = await call('git_track_large', { file: 'datasets/big.csv', mode: 'reference' });
    expect(ask.res.structuredContent).toMatchObject({ confirmationRequired: true, preview: { applied: false, mode: 'reference' } });
    expect(existsSync(join(r.ws, 'datasets', 'big.csv.ref'))).toBe(false);
    const done = await call<{ applied: boolean; reference: { sha256: string } }>('git_track_large', { file: 'datasets/big.csv', mode: 'reference', source: 's3://team/big.csv', confirm: true });
    expect(done.data.applied).toBe(true);
    expect(existsSync(join(r.ws, 'datasets', 'big.csv.ref'))).toBe(true);
    const check = await call<{ references: Array<{ state: string }> }>('git_large_files', { check: true });
    expect(check.data.references.map((c) => c.state)).toEqual(['ok']);
    expect((await call('git_track_large', { file: 'datasets/big.csv', mode: 'zip', confirm: true })).res.isError).toBe(true);
  });

  it('git_share_session masks the copy, lists, and unshares', async () => {
    mkdirSync(join(r.ws, 'debugger'), { recursive: true });
    const har = {
      log: {
        version: '1.2',
        creator: { name: 'T', version: '0' },
        entries: [{ request: { method: 'GET', url: 'https://x/y', headers: [{ name: 'Authorization', value: 'Bearer abcdef0123456789abcdef0123456789' }] }, response: { status: 200 } }],
      },
    };
    writeFileSync(join(r.ws, 'debugger', 'bug.har'), JSON.stringify(har));
    const ask = await call('git_share_session', { name: 'bug' });
    expect(ask.res.structuredContent).toMatchObject({ confirmationRequired: true });
    const done = await call<{ applied: boolean; to: string }>('git_share_session', { name: 'bug', confirm: true });
    expect(done.data).toMatchObject({ applied: true, to: 'debugger/shared/bug.har' });
    expect(readFileSync(join(r.ws, 'debugger', 'shared', 'bug.har'), 'utf8')).not.toContain('abcdef0123456789');
    expect((await call<{ shared: Array<{ name: string }> }>('git_share_session', {})).data.shared.map((s) => s.name)).toEqual(['bug']);
    const gone = await call<{ removed: boolean }>('git_share_session', { name: 'bug', unshare: true, confirm: true });
    expect(gone.data.removed).toBe(true);
  });
});

describe('CODEOWNERS, the allowlist and the secret fix plan', () => {
  it('git_codeowners returns the text; with write and confirm it writes, and never over an existing file', async () => {
    const text = await call<{ written: boolean; text: string; lines: unknown[] }>('git_codeowners', { owner: '@acme/platform' });
    expect(text.data.written).toBe(false);
    expect(text.data.text).toMatch(/^\/environments\/\s+@acme\/platform$/m);
    expect(existsSync(join(r.repo, '.github', 'CODEOWNERS'))).toBe(false);
    const ask = await call('git_codeowners', { owner: '@acme/platform', write: true });
    expect(ask.res.structuredContent).toMatchObject({ confirmationRequired: true });
    const done = await call<{ written: boolean }>('git_codeowners', { owner: '@acme/platform', write: true, confirm: true });
    expect(done.data.written).toBe(true);
    const again = await call<{ written: boolean; reason: string }>('git_codeowners', { write: true, confirm: true });
    expect(again.data.written).toBe(false);
    expect(again.data.reason).toMatch(/never overwritten/);
  });

  it('git_allowed_secrets reads the allowlist; git_secrets_fix_plan names the variable each staged secret would become and writes nothing', async () => {
    expect((await call<{ entries: unknown[] }>('git_allowed_secrets')).data.entries).toEqual([]);
    r.write(
      'mcp-servers.json',
      JSON.stringify(
        {
          schemaVersion: '1.0',
          servers: [{ id: 'authed', name: 'Authed', transport: 'http', url: 'https://a/mcp', headers: [{ key: 'Authorization', value: 'Bearer abcdef0123456789abcdef0123456789' }] }],
        },
        null,
        2,
      ) + '\n',
    );
    await r.git('add', 'mcp-servers.json');
    const plan = await call<{ applied: boolean; fixed: Array<{ file: string; variable: string }> }>('git_secrets_fix_plan', {});
    expect(plan.data.applied).toBe(false);
    expect(plan.data.fixed).toHaveLength(1);
    expect(plan.data.fixed[0]).toMatchObject({ file: 'mcp-servers.json', variable: expect.stringMatching(/^\{\{\w+\}\}$/) });
    expect(JSON.stringify(plan.data)).not.toContain('abcdef0123456789');
    expect(r.read('mcp-servers.json')).toContain('abcdef0123456789');
  });
});
