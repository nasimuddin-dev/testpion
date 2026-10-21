import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createTestPionMcpServer, EnvSecretStore, WorkspaceManager, type WorkspaceStore } from '../../packages/core/src/index.js';
import { BIG_TOOLS, CONFIRM_TOOLS, decodeCursor, encodeCursor, fitResult, LIST_TOOLS, OUTPUT_SCHEMAS, snakeIdName } from '../../packages/core/src/mcp-server/tool-contract.js';

// The contract every MCP tool keeps (tool-contract.ts): descriptions in one shape, snake_case id parameters (the old
// names still accepted), pages on every list, a size cap with a named cut, confirmation before deleting or
// overwriting (asked through elicitation when the client can), output schemas on the run / send / check tools.
const dir = mkdtempSync(join(tmpdir(), 'tp-tool-contract-'));
const ws = join(dir, 'ws');
cpSync(join(process.cwd(), 'examples', 'veterinary-workspace'), ws, { recursive: true, filter: (p) => !/database\.sqlite|[\\/](runs|traces|payloads)([\\/]|$)/.test(p) });
let store: WorkspaceStore;
let client: Client;
let asking: Client;
const asked: string[] = [];
let answer: 'accept' | 'decline' = 'accept';

type Tools = Awaited<ReturnType<Client['listTools']>>['tools'];
let tools: Tools;

beforeAll(async () => {
  const mgr = new WorkspaceManager(join(dir, 'home'));
  store = mgr.open(ws);
  const connect = async (c: Client) => {
    const server = createTestPionMcpServer({ store, secrets: new EnvSecretStore(), settings: mgr.loadSettings() });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), c.connect(b)]);
  };
  client = new Client({ name: 'test', version: '1' });
  await connect(client);
  // a client that can be asked (MCP elicitation)
  asking = new Client({ name: 'asking', version: '1' }, { capabilities: { elicitation: {} } });
  asking.setRequestHandler(ElicitRequestSchema, async (req) => {
    asked.push(req.params.message);
    return answer === 'accept' ? { action: 'accept', content: { confirm: true } } : { action: 'decline' };
  });
  await connect(asking);
  tools = (await client.listTools()).tools;
}, 60_000);
afterAll(async () => {
  await client.close();
  await asking.close();
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const texts = (r: Awaited<ReturnType<Client['callTool']>>) => (r.content as Array<{ type: string; text: string }>).map((c) => c.text);

describe('the shape of every tool', () => {
  it('every description: what it does, when to use, when not, one example (whose arguments the tool takes)', () => {
    const bad: string[] = [];
    for (const t of tools) {
      const m = /\nWhen to use: (.+)\nWhen not: (.+)\nExample: (\{.*\})/.exec(t.description ?? '');
      if (!m) {
        bad.push(`${t.name}: no when / when not / example`);
        continue;
      }
      const example = JSON.parse(m[3]!) as Record<string, unknown>;
      const props = Object.keys(t.inputSchema.properties ?? {});
      for (const k of Object.keys(example)) if (!props.includes(k)) bad.push(`${t.name}: the example's "${k}" is not a parameter`);
      for (const k of t.inputSchema.required ?? []) if (!(k in example)) bad.push(`${t.name}: the example lacks the required "${k}"`);
    }
    expect(bad).toEqual([]);
  });

  it('id parameters are snake_case', () => {
    const camel = tools.flatMap((t) =>
      Object.keys(t.inputSchema.properties ?? {})
        .filter((k) => snakeIdName(k))
        .map((k) => `${t.name}.${k}`),
    );
    expect(camel).toEqual([]);
  });

  it('every list tool pages (limit, cursor), and every tool named list_* is one', () => {
    for (const t of tools.filter((x) => x.name.startsWith('list_'))) expect(LIST_TOOLS[t.name], t.name).toBeDefined();
    const missing = tools.filter((t) => LIST_TOOLS[t.name]).filter((t) => !t.inputSchema.properties?.cursor || !t.inputSchema.properties?.limit);
    expect(missing.map((t) => t.name)).toEqual([]);
    // every name in the lists is a real tool (a renamed tool must not drop out of the contract unnoticed)
    const names = new Set(tools.map((t) => t.name));
    expect([...Object.keys(LIST_TOOLS), ...BIG_TOOLS, ...Object.keys(CONFIRM_TOOLS), ...Object.keys(OUTPUT_SCHEMAS)].filter((n) => !names.has(n))).toEqual([]);
  });

  // Every tool that changes something (readOnlyHint false) asks first, unless it is listed here with the reason it can
  // not hurt: it only writes the person's own definitions the way the editor does (git brings the old version back), or
  // sends a request the person named. A tool that sends requests or spends money for an agent's own choice of target,
  // or writes a file outside the definitions, is in CONFIRM_TOOLS.
  const SENDS = 'its job is to send the requests the person asked for to the target they named (production needs --allow-production and allowProduction, the environment is the person’s)';
  const EDITS = 'edits a definition of the workspace the way the editor does: git brings the old version back and nothing leaves the computer';
  const NO_CONFIRM: Record<string, string> = {
    ...Object.fromEntries(
      ['send_request', 'grpc_call', 'realtime_exchange', 'graphql_operation', 'graphql_subscribe', 'run_collection', 'run_tests', 'run_monitor', 'compare_request_across_environments', 'flow_data_run', 'flow_env_matrix', 'mcp_server_tools', 'mcp_call_tool', 'run_evaluation'].map((n) => [n, SENDS]),
    ),
    // load_test and api_fuzz send many requests, but refuse an external target without their own explicit opt-in (checked in the tool)
    load_test: 'sends traffic only to a target the workspace owns or after the tool’s own explicit opt-in for an external one',
    api_fuzz: 'sends requests only to a target the workspace owns or after the tool’s own explicit opt-in for an external one',
    ...Object.fromEntries(
      [
        'save_test',
        'save_request',
        'update_request',
        'move_request',
        'create_collection',
        'create_folder',
        'set_collection_variable',
        'set_environment_variable',
        'reorder_environments',
        'review_result',
        'add_dataset_row',
        'convert_scripts',
        'save_monitor',
        'flow_add_step',
        'flow_connect',
        'flow_disconnect',
        'flow_update_step',
        'flow_set_output',
        'flow_annotate',
        'flow_from_exchanges',
        'import_arazzo',
        'debugger_capture',
        'debugger_save_to_collection',
        'git_propose_commit',
        'git_stage_item',
        'restore_item',
        'rag_probe_sets',
      ].map((n) => [n, EDITS]),
    ),
  };

  it('every tool that changes something is in CONFIRM_TOOLS or listed with the reason it needs no confirmation', () => {
    const writes = tools.filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name);
    expect(writes.length).toBeGreaterThan(40);
    expect(writes.filter((n) => !CONFIRM_TOOLS[n] && !NO_CONFIRM[n])).toEqual([]);
    // a reason is a sentence, and a tool that has since got a confirmation is taken off the list
    expect(Object.entries(NO_CONFIRM).filter(([n, why]) => why.length < 12 || CONFIRM_TOOLS[n] || !writes.includes(n))).toEqual([]);
  });

  it('every tool that deletes or overwrites takes confirm', () => {
    const destructive = tools.filter(
      (t) => /^(delete|remove)_|_remove_|_resolve$|_sync$|_tidy$|^rename_|^replace_/.test(t.name) || t.inputSchema.properties?.overwrite || t.inputSchema.properties?.remove,
    );
    expect(destructive.length).toBeGreaterThan(8);
    expect(destructive.filter((t) => !t.inputSchema.properties?.confirm).map((t) => t.name)).toEqual([]);
  });

  it('big results take response_format; the run, send and check tools have an output schema', () => {
    for (const n of ['send_request', 'run_tests', 'run_collection', 'get_request', 'collection_docs'])
      expect(tools.find((t) => t.name === n)!.inputSchema.properties?.response_format, n).toBeDefined();
    for (const n of ['send_request', 'run_tests', 'run_collection', 'run_evaluation', 'run_monitor', 'compare_runs', 'eval_compare', 'lint_tests', 'set_request_checks'])
      expect(tools.find((t) => t.name === n)!.outputSchema, n).toBeDefined();
  });
});

describe('pages', () => {
  it('a list comes a page at a time: the text is still the list, the next page is a cursor away', async () => {
    const all = JSON.parse(texts(await client.callTool({ name: 'list_tests', arguments: {} }))[0]!) as Array<{ file: string }>;
    expect(all.length).toBeGreaterThan(4);
    const first = await client.callTool({ name: 'list_tests', arguments: { limit: 2 } });
    const page = JSON.parse(texts(first)[0]!) as Array<{ file: string }>;
    expect(page).toEqual(all.slice(0, 2));
    const s = first.structuredContent as { items: unknown[]; total: number; nextCursor: string };
    expect(s).toMatchObject({ total: all.length });
    expect(texts(first)[1]).toMatch(/^Showing 1–2 of \d+\. Next page: call list_tests again with cursor: /);
    const second = await client.callTool({ name: 'list_tests', arguments: { limit: 2, cursor: s.nextCursor } });
    expect(JSON.parse(texts(second)[0]!)).toEqual(all.slice(2, 4));
    // the last page has no cursor
    const last = await client.callTool({ name: 'list_tests', arguments: { limit: 500 } });
    expect((last.structuredContent as { nextCursor?: string }).nextCursor).toBeUndefined();
    expect(texts(last)).toHaveLength(1);
  });

  it("a cursor of another tool or a broken one is refused with what to do; a tool's own limit fills the page", async () => {
    const r = await client.callTool({ name: 'list_tests', arguments: { cursor: encodeCursor('list_collections', 2) } });
    expect(r.isError).toBe(true);
    expect(texts(r)[0]).toMatch(/Not a cursor of list_tests/);
    expect(() => decodeCursor('x', '%%%')).toThrow(/Not a cursor/);
    expect(decodeCursor('x', encodeCursor('x', 7))).toBe(7);
    expect((await client.callTool({ name: 'recent_failures', arguments: { limit: 3 } })).isError).toBeFalsy();
  });
});

describe('names', () => {
  it('run_id, and the old runId still works', async () => {
    const t = tools.find((x) => x.name === 'run_breakdown')!;
    expect(t.inputSchema.required).toEqual(['run_id']);
    for (const args of [{ run_id: 'run-nope' }, { runId: 'run-nope' }]) {
      const r = await client.callTool({ name: 'run_breakdown', arguments: args });
      expect(texts(r)[0]).toMatch(/No finished run run-nope/);
    }
  });
});

describe('confirmation', () => {
  const del = { collection: 'Veterinary API', request: 'Create patient' };
  const exists = () => JSON.stringify(store.listCollections()).includes('"Create patient"');

  it('without confirm: nothing is deleted, the result says what would be', async () => {
    expect(exists()).toBe(true);
    const r = await client.callTool({ name: 'delete_request', arguments: del });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ confirmationRequired: true, changed: false, wouldDo: expect.stringMatching(/delete the request "Create patient" of the collection "Veterinary API"/) });
    expect(texts(r)[0]).toMatch(/confirm: true/);
    expect(exists()).toBe(true);
  });

  it('a tool with a dry run shows its preview; a call that does not delete (apply false) needs no confirm', async () => {
    const r = await client.callTool({ name: 'replace_in_collection', arguments: { collection: 'Veterinary API', find: '{{baseUrl}}', replace: '{{apiBase}}', apply: true } });
    expect(r.structuredContent).toMatchObject({ confirmationRequired: true, preview: expect.anything() });
    const dry = await client.callTool({ name: 'replace_in_collection', arguments: { collection: 'Veterinary API', find: '{{baseUrl}}', replace: '{{apiBase}}' } });
    expect(dry.isError).toBeFalsy();
    expect(JSON.stringify(store.listCollections())).toContain('{{baseUrl}}');
  });

  it('a client that can be asked asks the user: no keeps it, yes deletes', async () => {
    answer = 'decline';
    const no = await asking.callTool({ name: 'delete_request', arguments: del });
    expect(no.structuredContent).toMatchObject({ confirmationRequired: true, hint: 'The user said no: nothing was changed.' });
    expect(asked.at(-1)).toMatch(/delete_request will delete the request "Create patient"/);
    expect(exists()).toBe(true);
    answer = 'accept';
    const yes = await asking.callTool({ name: 'delete_request', arguments: del });
    expect(yes.isError).toBeFalsy();
    expect(exists()).toBe(false);
  });

  it('confirm: true goes ahead', async () => {
    const r = await client.callTool({ name: 'delete_request', arguments: { collection: 'Veterinary API', request: 'Health', confirm: true } });
    expect(r.isError).toBeFalsy();
    expect(JSON.stringify(store.listCollections())).not.toContain('"Health"');
  });
});

describe('size', () => {
  it('concise cuts long texts and lists and names each cut; detailed keeps more; the whole result fits a cap', () => {
    const big = { body: 'x'.repeat(50_000), rows: Array.from({ length: 300 }, (_, i) => ({ i })) };
    const c = fitResult(big, 'concise');
    expect((c.value as { body: string }).body).toMatch(/^x{2000}… \[48000 more characters\]$/);
    expect((c.value as { rows: unknown[] }).rows).toHaveLength(50);
    expect(c.cuts).toEqual([
      { path: 'body', shown: 2000, total: 50_000, unit: 'characters' },
      { path: 'rows', shown: 50, total: 300, unit: 'items' },
    ]);
    const d = fitResult(big, 'detailed');
    expect((d.value as { rows: unknown[] }).rows).toHaveLength(300);
    const huge = fitResult({ items: Array.from({ length: 500 }, () => 'y'.repeat(20_000)) }, 'detailed');
    expect(JSON.stringify(huge.value).length).toBeLessThanOrEqual(400_000);
    expect(fitResult('z'.repeat(30_000), 'concise').cuts).toEqual([{ path: '(result)', shown: 20_000, total: 30_000, unit: 'characters' }]);
    expect(fitResult({ a: 1 }, 'concise')).toEqual({ value: { a: 1 }, cuts: [] });
  });

  it('a cut result says what was cut and how to get more', async () => {
    const r = await client.callTool({ name: 'collection_docs', arguments: { collection: 'Veterinary API' } });
    const all = await client.callTool({ name: 'collection_docs', arguments: { collection: 'Veterinary API', response_format: 'detailed' } });
    expect(texts(all)[0]!.length).toBeGreaterThanOrEqual(texts(r)[0]!.length);
    if (texts(r).length > 1) expect(texts(r)[1]).toMatch(/^Truncated — .*response_format: "detailed"/);
    const bad = await client.callTool({ name: 'collection_docs', arguments: { collection: 'Veterinary API', response_format: 'everything' } });
    expect(texts(bad)[0]).toMatch(/response_format is "concise" or "detailed"/);
  });
});
