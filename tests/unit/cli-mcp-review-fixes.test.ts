import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ApsError, EnvSecretStore, MemorySecretStore, WorkspaceManager, WorkspaceStore, collectionRequests, copyVariableToEnvironment, createTestPionMcpServer, envNameForSecret, secretKeys } from '../../packages/core/src/index.js';
import { LIST_TOOLS, OUTPUT_SCHEMAS, SEND_TOOLS, contractCallResult, isContractResult, withToolContract } from '../../packages/core/src/mcp-server/tool-contract.js';
import type { Tool } from '../../packages/core/src/mcp-server/tool.js';
import { buildProgram } from '../../packages/cli/src/index.js';
import { commandPath, leafCommands, WRITE_COMMANDS } from '../../packages/cli/src/contract.js';
import { cliData, copyExample, runCliSync, tempDir } from '../helpers.js';

// Fixes from the review of the command line and the MCP server: writers missing from the CLI contract, answers that
// broke a tool's output schema, pages that stopped at a tool's own maximum, comments on items that are not there,
// `env copy` of a secret, the labels of `env list --group`, and team_comments on a read-only server.
const tmp = tempDir('tp-cli-mcp-fixes-');
const home = join(tmp.dir, 'home');
let ws = '';
let requestRef = '';
let requestItem: { kind: 'request'; collectionId: string; requestId: string };
beforeAll(() => {
  ws = copyExample('veterinary-workspace', join(tmp.dir, 'ws'));
  const store = WorkspaceStore.open(ws);
  const c = store.listCollections()[0]!;
  requestItem = { kind: 'request', collectionId: c.id, requestId: collectionRequests(c)[0]!.id };
  requestRef = `request:${requestItem.collectionId}:${requestItem.requestId}`;
  store.close();
});
afterAll(() => tmp.cleanup());

const cliRun = (args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => runCliSync([...args, '--json', '--non-interactive'], { home, cwd: opts.cwd ?? tmp.dir, env: { CI: '1', ...opts.env } });
const envelope = (out: string) => JSON.parse(out) as { status: string; data: unknown; errors: Array<{ message: string; hint?: string }>; warnings: string[] };

/* ------------------------------------------------------------------ the CLI contract */

/**
 * Every command is one of: a writer of the contract (WRITE_COMMANDS: --dry-run, the lock of an open workspace), a
 * command with a --dry-run of its own (or a plan, for git), or named in one of the three lists below. A new command
 * that is in none of them fails the test, so whoever adds it decides whether it writes.
 */

/** Commands that change nothing a workspace or the app folder keeps: they print, or write only the file named with --out. */
const READS = new Set([
  'eval list', 'eval compare', 'eval matrix', 'eval summary', 'eval diff', 'eval trajectory', 'eval review', 'eval versions', 'eval lint', 'eval version-diff', 'eval variants', 'eval estimate',
  'feedback', 'graphql-op', 'vars usages', 'vars unused', 'collections', 'jwt', 'attention', 'certificates', 'load-history', 'variable-flow', 'datasets show', 'requests', 'wait-for',
  'env matrix', 'env get', 'env list', 'env diff', 'import-report', 'workspace list', 'workspace trust list',
  'git check', 'git history', 'git blame', 'git stash list', 'git stash show', 'git textconv', 'git shared-sessions', 'git allowed-secrets', 'git status', 'git changes', 'git diff', 'git log', 'git activity', 'git incoming', 'diff',
  'trash list', 'doctor', 'diagnostics', 'agent-info', 'open', 'monitor list', 'monitor status', 'monitor results', 'monitor requests', 'monitor uptime', 'secrets',
  'history list', 'history stats', 'history activity', 'history scores', 'history flaky', 'history results', 'history test', 'history mcp-tools', 'history llm', 'history diff',
  'generate gaps', 'flows', 'flow', 'flow runs', 'flow report', 'ai tasks', 'ai proposals', 'ai usage', 'kinds', 'bundle inspect',
  'rag metrics', 'rag presets', 'rag metric show', 'rag metric list', 'rag metric validate', 'rag compare', 'rag matrix', 'rag label list', 'rag trend', 'rag probes list', 'rag targets',
  'item comment list', 'item comment open', 'item owners', 'settings get', 'lint collection', 'lint tests', 'lint openapi', 'openapi diff', 'openapi ops', 'openapi coverage',
  'debug show', 'debug exchanges', 'debug snippet', 'debug programs', 'debug diff', 'debug open', 'debug gateway',
]);

/** Commands that send, run or serve what was named: what they keep is the record of that (runs, history, results), as the app keeps it; a copy of the workspace would not show what they do. */
const RUNS = new Set([
  'test', 'run', 'run-collection', 'load', 'send', 'eval run', 'eval sample', 'serve flows', 'mcp-server', 'graphql-subscribe', 'record', 'mcp', 'ws', 'mqtt', 'kafka', 'grpc',
  'merge-driver', 'monitor run', 'monitor start', 'security run', 'ai attempt-fix', 'rag sample', 'rag run', 'rag rescore', 'rag map', 'rag ablate', 'rag probe', 'auth token',
  'mock collection', 'mock mcp', 'mock graphql', 'openapi fuzz', 'debug launch',
]);

/**
 * Commands that change something the workspace or this computer keeps and are not in the contract yet (no --dry-run, no
 * lock check). The list may only get shorter: a command leaves it by joining WRITE_COMMANDS.
 */
const WRITES_OUTSIDE_THE_CONTRACT = new Set<string>([]);

describe('the CLI contract names every command that writes', () => {
  const program = buildProgram();
  const leaves = leafCommands(program).map((c) => ({ c, path: commandPath(program, c) }));
  const has = (path: string, flag: string) => leaves.find((l) => l.path === path)!.c.options.some((o) => o.long === flag);

  it('every command is a writer of the contract, has a dry run of its own, or is in a list of this test', () => {
    const undecided = leaves.filter(({ c, path }) => !WRITE_COMMANDS.has(path) && !c.options.some((o) => o.long === '--dry-run') && !READS.has(path) && !RUNS.has(path) && !WRITES_OUTSIDE_THE_CONTRACT.has(path)).map((l) => l.path);
    expect(undecided, 'a new command: add it to WRITE_COMMANDS (packages/cli/src/contract.ts) when it writes, else to READS or RUNS here').toEqual([]);
    // the lists name real commands, each once, and none that the contract has
    const paths = new Set(leaves.map((l) => l.path));
    const listed = [...READS, ...RUNS, ...WRITES_OUTSIDE_THE_CONTRACT];
    expect(listed.filter((p) => !paths.has(p))).toEqual([]);
    expect(listed.filter((p) => WRITE_COMMANDS.has(p))).toEqual([]);
    expect(new Set(listed).size).toBe(listed.length);
    expect(WRITES_OUTSIDE_THE_CONTRACT.size).toBe(0);
  });

  it('the writers the review found are in it: --dry-run, and --force past the lock of an open workspace', () => {
    for (const path of ['monitor pause', 'monitor resume', 'env duplicate-group', 'env copy', 'workspace conventions', 'workspace note', 'item comment add', 'item comment resolve', 'item comment delete']) {
      expect(WRITE_COMMANDS.has(path), path).toBe(true);
      expect(has(path, '--dry-run'), `${path} --dry-run`).toBe(true);
      expect(has(path, '--force'), `${path} --force`).toBe(true);
    }
    // the commands that name a workspace of the list (not the one they run in) have no lock to pass
    for (const path of ['workspace create', 'workspace rename', 'workspace export']) expect(has(path, '--force'), path).toBe(false);
  });

  it('--dry-run of the new writers changes nothing and lists what would change', () => {
    const before = readFileSync(join(ws, 'workspace.json'), 'utf8');
    const note = cliRun(['workspace', 'note', 'Ask Ana before running against production', '-w', ws, '--dry-run']);
    expect(note.status, note.out + note.err).toBe(0);
    expect(note.out).toMatch(/workspace\.json/);
    expect(readFileSync(join(ws, 'workspace.json'), 'utf8')).toBe(before);
    const comment = cliRun(['item', 'comment', 'add', requestRef, 'Is this still used?', '-w', ws, '--dry-run']);
    expect(comment.status, comment.out + comment.err).toBe(0);
    expect(existsSync(join(ws, 'comments'))).toBe(false);
    const init = cliRun(['workspace', 'conventions', '--init', '-w', ws, '--dry-run']);
    expect(init.status, init.out + init.err).toBe(0);
    expect(existsSync(join(ws, 'conventions.yaml'))).toBe(false);
  });

  it('the writers that joined the contract: --dry-run of agents-md writes nothing; git identity and conflicts print a plan', () => {
    const agents = cliRun(['agents-md', '-w', ws, '--dry-run']);
    expect(agents.status, agents.out + agents.err).toBe(0);
    expect(agents.out).toMatch(/AGENTS\.md/);
    expect(existsSync(join(ws, 'AGENTS.md'))).toBe(false);
    const identity = cliRun(['git', 'identity', '--name', 'Ana', '--email', 'ana@example.com', '-w', ws, '--dry-run']);
    expect(identity.out).toMatch(/user\.name \\"Ana\\" and user\.email \\"ana@example\.com\\"/);
    const conflicts = cliRun(['git', 'conflicts', '--resolve', 'ours', '-w', ws, '--dry-run']);
    expect(conflicts.out).toMatch(/every conflicted file with \\"ours\\"/);
  });
});

/* ------------------------------------------------------------------ comments and owners */

describe('item comment and item owners', () => {
  it('outside a workspace they say so instead of answering from an empty scratch workspace', () => {
    const outside = tempDir('tp-no-workspace-');
    try {
      for (const args of [['item', 'comment', 'open'], ['item', 'comment', 'list', requestRef], ['item', 'comment', 'add', requestRef, 'hello'], ['item', 'owners', requestRef]]) {
        const r = cliRun(args, { cwd: outside.dir });
        expect(r.status, args.join(' ')).toBe(2);
        expect(envelope(r.out).errors[0]!.message, args.join(' ')).toMatch(/No workspace found/);
      }
    } finally {
      outside.cleanup();
    }
  });

  it('a comment on an item that is not there is refused with what a ref looks like, and nothing is written', () => {
    for (const ref of [`request:${requestItem.collectionId}:no-such-request`, 'request:no-such-collection:x', 'test:tests/no-such-file.yaml']) {
      const r = cliRun(['item', 'comment', 'add', ref, 'lost', '-w', ws]);
      expect(r.status, ref).toBe(2);
      const e = envelope(r.out).errors[0]!;
      expect(e.message, ref).toMatch(/no comment was added/);
      expect(e.hint, ref).toMatch(/request:<collectionId>:<requestId>/);
    }
    expect(existsSync(join(ws, 'comments'))).toBe(false);
    const ok = cliRun(['item', 'comment', 'add', requestRef, 'Is this still used?', '-w', ws]);
    expect(ok.status, ok.out + ok.err).toBe(0);
    expect(cliData<{ comment: { text: string } }>(ok.out).comment.text).toBe('Is this still used?');
  });
});

/* ------------------------------------------------------------------ environments */

describe('env copy and env list --group', () => {
  const dir = tempDir('tp-env-fixes-');
  const root = join(dir.dir, 'ws');
  beforeAll(() => {
    const store = WorkspaceStore.create(root, 'Tenants');
    store.saveEnvironment({ id: 'acme-staging', name: 'Staging', group: 'Acme', variables: [{ key: 'baseUrl', value: 'https://acme.test', enabled: true }, { key: 'apiKey', value: '', enabled: true, secret: true }] } as never);
    store.saveEnvironment({ id: 'globex-staging', name: 'Staging', group: 'Globex', variables: [] } as never);
    store.saveEnvironment({ id: 'acme-live', name: 'Live', group: 'Acme', variables: [] } as never);
    store.close();
  });
  afterAll(() => dir.cleanup());

  it('a secret is copied without its value on the command line (its store cannot be written): no failure after the file was written', () => {
    const r = cliRun(['env', 'copy', 'apiKey', '--from', 'acme-staging', '--to', 'acme-live', '-w', root], { env: { [envNameForSecret(secretKeys.envVar('acme-staging', 'apiKey'))]: 'sk-acme' } });
    expect(r.status, r.out + r.err).toBe(0);
    expect(cliData(r.out)).toMatchObject({ key: 'apiKey', secret: true, replaced: false, secretCopied: false });
    expect(readFileSync(join(root, 'environments', 'acme-live.json'), 'utf8')).not.toContain('sk-acme');
  });

  it('a secret store that fails leaves the target environment as it was', async () => {
    const store = WorkspaceStore.open(root);
    try {
      const secrets = new MemorySecretStore();
      await secrets.set(secretKeys.envVar('acme-staging', 'apiKey'), 'sk-acme');
      const failing = Object.assign(Object.create(secrets) as MemorySecretStore, {
        set: async () => {
          throw new ApsError('ConfigurationError', 'The keychain is locked');
        },
      });
      const file = join(root, 'environments', 'globex-staging.json');
      const before = readFileSync(file, 'utf8');
      await expect(copyVariableToEnvironment(store, 'acme-staging', 'globex-staging', 'apiKey', { secrets: failing })).rejects.toThrow(/keychain is locked/);
      expect(readFileSync(file, 'utf8')).toBe(before);
      // with a store that works: the value first, then the variable
      expect(await copyVariableToEnvironment(store, 'acme-staging', 'globex-staging', 'apiKey', { secrets })).toMatchObject({ secret: true, secretCopied: true });
      expect(secrets.get(secretKeys.envVar('globex-staging', 'apiKey'))).toBe('sk-acme');
    } finally {
      store.close();
    }
  });

  it('--group keeps the label an environment has in the whole workspace; a group nobody has is a warning with the groups there are', () => {
    const acme = cliRun(['env', 'list', '--group', 'Acme', '-w', root]);
    expect(acme.status, acme.out + acme.err).toBe(0);
    expect(cliData<Array<{ id: string; label: string }>>(acme.out).map((e) => [e.id, e.label])).toEqual(expect.arrayContaining([['acme-staging', 'Acme ▸ Staging'], ['acme-live', 'Live']]));
    expect(envelope(acme.out).warnings).toEqual([]);
    const none = cliRun(['env', 'list', '--group', 'Initech', '-w', root]);
    expect(none.status).toBe(0);
    expect(cliData(none.out)).toEqual([]);
    expect(envelope(none.out).warnings).toEqual(['No environment group "Initech". Groups: Acme, Globex']);
  });
});

/* ------------------------------------------------------------------ MCP */

describe('MCP: answers that are not a result of the tool', () => {
  let store: WorkspaceStore;
  const clients: Client[] = [];
  const connect = async (extra: Record<string, unknown> = {}) => {
    const mgr = new WorkspaceManager(home);
    store ??= mgr.open(ws);
    const server = createTestPionMcpServer({ store, secrets: new EnvSecretStore(), settings: mgr.loadSettings(), ...extra });
    const client = new Client({ name: 'test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    clients.push(client);
    return client;
  };
  afterAll(async () => {
    for (const c of clients) await c.close();
    store?.close();
  });
  const texts = (r: Awaited<ReturnType<Client['callTool']>>) => (r.content as Array<{ type: string; text: string }>).map((c) => c.text);

  it('a confirmation or a send-budget answer of a tool with an output schema passes the client’s schema check', async () => {
    // every send is over the budget; the client has listed the tools, so the SDK checks structured content against each output schema
    const client = await connect({ sendBudget: 0 });
    const tools = (await client.listTools()).tools;
    const declared = tools.filter((t) => t.outputSchema && (SEND_TOOLS.includes(t.name) || t.name === 'set_request_checks'));
    expect(declared.map((t) => t.name).sort()).toEqual(['run_collection', 'run_evaluation', 'run_monitor', 'run_tests', 'send_request', 'set_request_checks']);
    for (const t of declared) {
      const r = await client.callTool({ name: t.name, arguments: { collection: 'Veterinary API', request: 'x', checks: [], mode: 'replace' } });
      expect(r.isError, t.name).toBe(true);
      expect(r.structuredContent, t.name).toBeUndefined();
      expect(r._meta?.confirmation, t.name).toMatchObject({ confirmationRequired: true, changed: false });
      expect(JSON.parse(texts(r)[0]!), t.name).toMatchObject({ confirmationRequired: true, wouldDo: expect.any(String), hint: expect.stringMatching(/Ask the user/) });
    }
    // a tool without an output schema keeps the answer as structured content
    const del = await client.callTool({ name: 'delete_request', arguments: { collection: 'Veterinary API', request: 'x' } });
    expect(del.structuredContent).toMatchObject({ confirmationRequired: true });
    expect(Object.keys(OUTPUT_SCHEMAS).length).toBeGreaterThan(5);
  });

  it('team_comments: a read-only server lists and reads; `owner` is declared; a comment on an item that is not there is refused', async () => {
    const reader = await connect({ readOnly: true });
    const listed = (await reader.listTools()).tools.find((t) => t.name === 'team_comments')!;
    expect(listed.annotations).toMatchObject({ readOnlyHint: true });
    expect((listed.inputSchema.properties as Record<string, { enum?: string[] }>).action!.enum).toEqual(['open', 'list']);
    expect(Object.keys(listed.inputSchema.properties as object)).toEqual(expect.arrayContaining(['owner', 'ref']));
    expect((await reader.callTool({ name: 'team_comments', arguments: { action: 'open', owner: '@acme/payments' } })).isError).toBeFalsy();
    expect((await reader.callTool({ name: 'team_comments', arguments: { action: 'list', ref: requestItem } })).isError).toBeFalsy();
    const refused = await reader.callTool({ name: 'team_comments', arguments: { action: 'add', ref: requestItem, text: 'no' } });
    expect(refused.isError).toBe(true);
    expect(texts(refused).join('\n')).toMatch(/read-only/);

    const writer = await connect({ profile: 'verbose' });
    const full = (await writer.listTools()).tools.find((t) => t.name === 'team_comments')!;
    expect(full.annotations).toMatchObject({ readOnlyHint: false });
    expect(Object.keys(full.inputSchema.properties as object)).toEqual(expect.arrayContaining(['action', 'ref', 'owner', 'text', 'id']));
    const missing = { kind: 'request', collectionId: requestItem.collectionId, requestId: 'no-such-request' };
    const lost = await writer.callTool({ name: 'team_comments', arguments: { action: 'add', ref: missing, text: 'lost' } });
    expect(lost.isError).toBe(true);
    expect(texts(lost).join('\n')).toMatch(/no comment was added/);
    expect((await writer.callTool({ name: 'team_comments', arguments: { action: 'list', ref: missing } })).structuredContent).toEqual({ items: [] });
    const added = await writer.callTool({ name: 'team_comments', arguments: { action: 'add', ref: requestItem, text: 'From an agent' } });
    expect(added.isError).toBeFalsy();
    expect(added.structuredContent).toMatchObject({ text: 'From an agent' });
  });

  it('the maximum the wrapper knows of a list tool is the one its `limit` says', async () => {
    const client = await connect({ profile: 'verbose' });
    const tools = (await client.listTools()).tools;
    const capped = Object.entries(LIST_TOOLS).filter(([, l]) => l.max);
    expect(capped.map(([n]) => n).sort()).toEqual(['flow_runs', 'git_log', 'load_history', 'monitor_results', 'test_history']);
    // (the listed `limit` is the wrapper's page size; the tool's own maximum is what its module clamps to: 200 for each of these)
    for (const [name, l] of capped) {
      expect(tools.find((x) => x.name === name), name).toBeDefined();
      expect(l.max, name).toBe(200);
    }
  });
});

describe('MCP: a list tool with a maximum of its own', () => {
  // git_log as the wrapper sees it: 450 commits, its own `limit` up to 200
  const rows = Array.from({ length: 450 }, (_, i) => ({ hash: `c${i}` }));
  const asked: number[] = [];
  const fake: Tool = {
    name: 'git_log',
    description: 'Commits, newest first.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'How many (default 20, max 200)' } } },
    run: (a) => {
      asked.push(Number(a.limit));
      return rows.slice(0, Math.min(Math.max(Number(a.limit) || 20, 1), 200));
    },
  };
  const [tool] = withToolContract([fake], { docs: {} });
  const call = async (args: Record<string, unknown>) => {
    const r = await tool!.run(args);
    if (!isContractResult(r)) throw new Error('not a contract result');
    const out = contractCallResult(r);
    return { items: (out.structuredContent as { items: Array<{ hash: string }> }).items, s: out.structuredContent as { nextCursor?: string; total?: number; truncated?: boolean }, notes: out.content.slice(1).map((c) => c.text) };
  };

  it('pages up to the maximum, then says that there may be more instead of "that is all"', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let last: Awaited<ReturnType<typeof call>> | undefined;
    for (let page = 0; page < 10; page++) {
      last = await call({ limit: 80, ...(cursor ? { cursor } : {}) });
      seen.push(...last.items.map((i) => i.hash));
      cursor = last.s.nextCursor;
      if (!cursor) break;
    }
    // 80 + 80 + 40: every row the tool can give, each once
    expect(seen).toEqual(rows.slice(0, 200).map((r) => r.hash));
    expect(last!.s).toMatchObject({ truncated: true });
    expect(last!.s.total).toBeUndefined();
    expect(last!.s.nextCursor).toBeUndefined();
    expect(last!.notes.join('\n')).toMatch(/git_log reaches its first 200 rows only: there may be more/);
  });

  it('a list shorter than the maximum ends as before: a total, no note', async () => {
    rows.length = 120;
    const first = await call({ limit: 100 });
    expect(first.s).toMatchObject({ truncated: true });
    expect(first.s.nextCursor).toBeDefined();
    const second = await call({ limit: 100, cursor: first.s.nextCursor });
    expect(second.items).toHaveLength(20);
    expect(second.s).toMatchObject({ total: 120, truncated: false });
    expect(second.notes).toEqual([]);
  });
});
