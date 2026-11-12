/**
 * The workspace's MCP server to a client of the 2026-07-28 revision (no handshake, no session; the v2 SDK on both
 * sides): the same tools, resources and prompts, a confirmation asked as "input required" instead of a request sent to
 * the client, and no tasks (they belong to 2025-11-25). The 2025 revisions are covered by every other MCP test, which
 * connect a client of the 1.x SDK.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createTestPionMcpServer, EnvSecretStore, WorkspaceManager, type WorkspaceStore } from '../../packages/core/src/index.js';
import { serveMcpOverTransport } from '../../packages/core/src/mcp-server/serve.js';

const dir = mkdtempSync(join(tmpdir(), 'tp-mcp-2026-'));
const ws = join(dir, 'ws');
cpSync(join(process.cwd(), 'examples', 'veterinary-workspace'), ws, { recursive: true, filter: (p) => !/database\.sqlite|[\\/](runs|traces|payloads)([\\/]|$)/.test(p) });
let store: WorkspaceStore;
const closers: Array<() => Promise<void>> = [];
const asked: string[] = [];
let answer: 'accept' | 'decline' = 'accept';
let made = 0;

async function connect(o: { asks?: boolean; mode?: 'auto' | 'legacy' } = {}): Promise<Client> {
  const mgr = new WorkspaceManager(join(dir, 'home'));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const serving = serveMcpOverTransport(() => {
    made++;
    return createTestPionMcpServer({ store, secrets: new EnvSecretStore(), settings: mgr.loadSettings() });
  }, b);
  const client = new Client({ name: 'test', version: '1' }, { capabilities: o.asks ? { elicitation: { form: {} } } : {}, versionNegotiation: { mode: o.mode ?? 'auto' } });
  if (o.asks)
    client.setRequestHandler('elicitation/create', async (req) => {
      asked.push(String((req.params as { message?: string }).message));
      return answer === 'accept' ? { action: 'accept', content: { confirm: true } } : { action: 'decline' };
    });
  await client.connect(a);
  closers.push(async () => {
    await client.close().catch(() => undefined);
    await serving.close();
  });
  return client;
}

beforeAll(() => {
  store = new WorkspaceManager(join(dir, 'home')).open(ws);
});
afterAll(async () => {
  for (const close of closers) await close();
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const FRESH = { cacheMode: 'refresh' as const };
const exists = (name: string) => JSON.stringify(store.listCollections().map((c) => store.getCollection(c.id))).includes(`"${name}"`);

describe('the workspace server on MCP 2026-07-28', () => {
  it('answers without a handshake: one server for the connection, the tools, a call, a resource and a prompt', async () => {
    const before = made;
    const client = await connect();
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    expect(client.getServerVersion()).toMatchObject({ name: 'testpion' });
    expect(client.getInstructions()).toMatch(/TestPion workspace/);
    const { tools } = await client.listTools({}, FRESH);
    expect(tools.length).toBeGreaterThan(200);
    expect(tools.find((t) => t.name === 'run_tests')).toMatchObject({ title: expect.any(String), annotations: expect.any(Object) });
    const r = await client.callTool({ name: 'list_collections', arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(JSON.stringify(r.structuredContent)).toContain('Veterinary API');
    const guide = await client.readResource({ uri: 'testpion://guide' }, FRESH);
    expect((guide.contents[0] as { text: string }).text).toContain('# TestPion for AI agents');
    expect((await client.listPrompts({}, FRESH)).prompts.length).toBeGreaterThan(0);
    // an unknown tool is an error result with what to do, as on every revision
    const unknown = await client.callTool({ name: 'no_such_tool', arguments: {} });
    expect(unknown.isError).toBe(true);
    expect(JSON.stringify(unknown.content)).toContain('search_tools');
    expect(made - before).toBe(1);
  }, 60_000);

  it('offers no tasks there (they are part of 2025-11-25), and does to a client of that revision', async () => {
    const modern = await connect();
    expect((modern.getServerCapabilities() as { tasks?: unknown }).tasks).toBeUndefined();
    const listed = (await modern.listTools({}, FRESH)).tools;
    expect(listed.filter((t) => (t as { execution?: unknown }).execution)).toEqual([]);
    const legacy = await connect({ mode: 'legacy' });
    expect(legacy.getNegotiatedProtocolVersion()).toBe('2025-11-25');
    expect((legacy.getServerCapabilities() as { tasks?: unknown }).tasks).toMatchObject({ list: {}, cancel: {}, requests: { tools: { call: {} } } });
    const run = (await legacy.listTools({}, FRESH)).tools.find((t) => t.name === 'run_tests') as { execution?: { taskSupport?: string } };
    expect(run.execution?.taskSupport).toBe('optional');
  }, 60_000);

  it('asks the person before deleting: a client that can ask shows the question (no keeps it, yes deletes), one that cannot is told to confirm', async () => {
    const del = { collection: 'Veterinary API', request: 'Create patient' };
    expect(exists('Create patient')).toBe(true);
    const plain = await connect();
    const told = await plain.callTool({ name: 'delete_request', arguments: del });
    expect(told.structuredContent).toMatchObject({ confirmationRequired: true, changed: false });
    expect(exists('Create patient')).toBe(true);
    const asking = await connect({ asks: true });
    answer = 'decline';
    const no = await asking.callTool({ name: 'delete_request', arguments: del });
    expect(no.structuredContent).toMatchObject({ confirmationRequired: true, hint: 'The user said no: nothing was changed.' });
    expect(asked.at(-1)).toMatch(/delete_request will delete the request "Create patient"/);
    expect(exists('Create patient')).toBe(true);
    answer = 'accept';
    const yes = await asking.callTool({ name: 'delete_request', arguments: del });
    expect(yes.isError).toBeFalsy();
    expect(exists('Create patient')).toBe(false);
    expect(asked).toHaveLength(2);
  }, 60_000);

  it('an answer that is not an answer asks again, and stops after the rounds the SDK allows', async () => {
    const client = await connect({ asks: true });
    client.setRequestHandler('elicitation/create', async () => ({ action: 'accept', content: { confirm: 'yes please' } }) as never);
    const r = await client.callTool({ name: 'delete_request', arguments: { collection: 'Veterinary API', request: 'Health' } }).catch((e: Error) => ({ isError: true, content: [{ type: 'text', text: e.message }], structuredContent: undefined }));
    // "yes please" is not `true`: nothing is deleted
    expect(exists('Health')).toBe(true);
    expect(r.isError).toBe(true);
  }, 60_000);
});
