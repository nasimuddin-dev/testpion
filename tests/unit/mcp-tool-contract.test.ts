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
    // the complete entries: this file checks the shape of every description, which the default (compact) list shortens
    const server = createTestPionMcpServer({ store, secrets: new EnvSecretStore(), settings: mgr.loadSettings(), profile: 'verbose' });
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
        'debugger_no_decrypt',
        'debugger_save_to_collection',
        'git_propose_commit',
        'git_stage_item',
        'restore_item',
        // the person's own pass/fail label of a result, in labels/*.json (the editor of the matrix does the same)
        'rag_label',
        // adds one example to a custom metric's own file, as text, the way the editor does (git brings the old file back)
        'rag_make_metric_example',
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

// A client that cannot ask the person: `confirm: true` is only an argument, so an agent that read it in an API response would
// pass it. The server shows the person a one-time code instead, and only that code lets the call through.
describe('confirmation codes (clients that cannot be asked)', () => {
  const announced: Array<{ code: string; tool: string; what: string }> = [];
  let coded: Client;
  let sendBudgeted: Client;
  const connectWith = async (extra: Record<string, unknown>) => {
    const c = new Client({ name: 'coded', version: '1' });
    const server = createTestPionMcpServer({ store, secrets: new EnvSecretStore(), settings: new WorkspaceManager(join(dir, 'home')).loadSettings(), ...extra });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), c.connect(b)]);
    return c;
  };
  beforeAll(async () => {
    coded = await connectWith({ confirmCodes: { announce: (i: { code: string; tool: string; what: string }) => announced.push(i) } });
    sendBudgeted = await connectWith({ sendBudget: 2 });
  });
  afterAll(async () => {
    await coded.close();
    await sendBudgeted.close();
  });
  const del = { collection: 'No such collection', request: 'No such request' };
  const reached = (r: Awaited<ReturnType<Client['callTool']>>) => !(r.structuredContent as { confirmationRequired?: boolean } | undefined)?.confirmationRequired;

  it('confirm: true does nothing; the code goes to the person, not to the agent; the code works once, for the same arguments only', async () => {
    const first = await coded.callTool({ name: 'delete_request', arguments: { ...del, confirm: true } });
    expect(reached(first)).toBe(false);
    expect(announced).toHaveLength(1);
    const { code } = announced[0]!;
    expect(code).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
    expect(JSON.stringify(first)).not.toContain(code);
    expect(texts(first).join('\n')).toMatch(/confirmation code/);
    // a guess, or the code on other arguments, is refused
    expect(reached(await coded.callTool({ name: 'delete_request', arguments: { ...del, confirm: 'ABC-DEF' } }))).toBe(false);
    expect(reached(await coded.callTool({ name: 'delete_request', arguments: { collection: 'Another', request: 'x', confirm: code } }))).toBe(false);
    // the person's code, with the same arguments, goes through to the tool (which then answers that there is no such collection) …
    const ok = await coded.callTool({ name: 'delete_request', arguments: { ...del, confirm: code.toLowerCase() } });
    expect(reached(ok)).toBe(true);
    expect(texts(ok).join('\n')).toMatch(/collection/i);
    // … once
    expect(reached(await coded.callTool({ name: 'delete_request', arguments: { ...del, confirm: code } }))).toBe(false);
  });

  it('a run of calls that send stops at a budget per session, until the person says yes', async () => {
    const args = { collection: 'Veterinary API', request: 'No such request' };
    for (let i = 0; i < 2; i++) expect(reached(await sendBudgeted.callTool({ name: 'send_request', arguments: args })), `call ${i + 1}`).toBe(true);
    const third = await sendBudgeted.callTool({ name: 'send_request', arguments: args });
    expect(third.structuredContent).toMatchObject({ confirmationRequired: true, wouldDo: expect.stringMatching(/already made 2 calls that send requests/) });
    // without codes the old way still works: confirm: true lets another block through
    expect(reached(await sendBudgeted.callTool({ name: 'send_request', arguments: { ...args, confirm: true } }))).toBe(true);
    expect(reached(await sendBudgeted.callTool({ name: 'send_request', arguments: args }))).toBe(true);
  });

  it('a resource read keeps to the size caps of the contract', async () => {
    const r = await client.readResource({ uri: `testpion://collections/${encodeURIComponent(store.listCollections()[0]!.id)}` });
    const text = (r.contents[0] as { text: string }).text;
    expect(text.length).toBeLessThanOrEqual(20_000 + 100);
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

describe('agents at the edges (the 2026-10-22 review)', () => {
  it('a description is short enough for hosts that cut at about 1,200 characters; the rest is in the guide', async () => {
    const long = tools.filter((t) => (t.description ?? '').length > 1200).map((t) => `${t.name}: ${t.description!.length}`);
    expect(long).toEqual([]);
    const guide = await client.callTool({ name: 'testpion_guide', arguments: {} });
    expect(texts(guide).join('\n')).toContain('## Tool details');
  });

  it('every tool that calls the model takes max_cost_usd', () => {
    for (const name of ['ai_run_task', 'flow_generate', 'ai_triage_run', 'search_ask', 'write_script', 'rag_generate_testset']) {
      const t = tools.find((x) => x.name === name)!;
      expect(Object.keys((t.inputSchema as { properties: Record<string, unknown> }).properties), name).toContain('max_cost_usd');
    }
  });

  it('list_kinds is in the minimal profile and named in the instructions', async () => {
    const { MINIMAL_TOOLS } = await import('../../packages/core/src/mcp-server/tools/search-tools.js');
    expect(MINIMAL_TOOLS.has('list_kinds')).toBe(true);
    expect(client.getInstructions()).toContain('list_kinds');
  });

  it('a tool error carries { code, message, hint, retryable } for the client that reads structured content', async () => {
    const r = (await client.callTool({ name: 'get_request', arguments: { collection: 'No such collection', request: 'x' } })) as { isError?: boolean; structuredContent?: { error: { code: string; message: string; hint?: string; retryable: boolean } } };
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error.code).toBe('ConfigurationError');
    expect(r.structuredContent?.error.message).toMatch(/No such collection|not found|No collection/i);
    expect(typeof r.structuredContent?.error.retryable).toBe('boolean');
    const unknown = (await client.callTool({ name: 'no_such_tool', arguments: {} })) as { structuredContent?: { error: { hint?: string } } };
    expect(unknown.structuredContent?.error.hint).toMatch(/search_tools/);
  });

  it('creating twice is not a surprise: create_collection fails or reuses, create_folder reuses, save_request can refuse a second', async () => {
    const first = (await client.callTool({ name: 'create_collection', arguments: { name: 'Twice' } })) as { structuredContent?: { id: string; created: boolean } };
    expect(first.structuredContent?.created).toBe(true);
    const again = (await client.callTool({ name: 'create_collection', arguments: { name: 'Twice' } })) as { isError?: boolean };
    expect(again.isError).toBe(true);
    const reuse = (await client.callTool({ name: 'create_collection', arguments: { name: 'Twice', if_exists: 'reuse' } })) as { structuredContent?: { id: string; created: boolean } };
    expect(reuse.structuredContent).toMatchObject({ id: first.structuredContent!.id, created: false });
    const f1 = (await client.callTool({ name: 'create_folder', arguments: { collection: 'Twice', folder: 'A / B' } })) as { structuredContent?: { created: boolean } };
    const f2 = (await client.callTool({ name: 'create_folder', arguments: { collection: 'Twice', folder: 'A / B' } })) as { structuredContent?: { created: boolean } };
    expect([f1.structuredContent?.created, f2.structuredContent?.created]).toEqual([true, false]);
    const save = { collection: 'Twice', name: 'Ping', method: 'GET', url: 'https://a.test/ping', if_exists: 'fail' };
    expect(((await client.callTool({ name: 'save_request', arguments: save })) as { isError?: boolean }).isError).toBeFalsy();
    expect(((await client.callTool({ name: 'save_request', arguments: save })) as { isError?: boolean }).isError).toBe(true);
  });

  it('the page size is the one the CLI uses', async () => {
    const { SURFACE_PAGE } = await import('../../packages/core/src/util/page.js');
    const t = tools.find((x) => x.name === 'list_collections')!;
    // the parameter describes itself (the description no longer repeats it: tools/list size)
    expect((t.inputSchema.properties.limit as { description: string }).description).toContain(`default ${SURFACE_PAGE.limit}, max ${SURFACE_PAGE.max}`);
  });
});
