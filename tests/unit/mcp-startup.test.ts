import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTestPionMcpServer, EnvSecretStore, WorkspaceManager, type WorkspaceStore } from '../../packages/core/src/index.js';

const SLACK = Number(process.env.TESTPION_PERF_SLACK ?? 1);
const dir = mkdtempSync(join(tmpdir(), 'tp-mcp-startup-'));
const ws = join(dir, 'ws');
let mgr: WorkspaceManager;
let store: WorkspaceStore;
beforeAll(() => {
  cpSync(join(process.cwd(), 'examples', 'veterinary-workspace'), ws, { recursive: true, filter: (p) => !/database\.sqlite|[\/](runs|traces|payloads)([\/]|$)/.test(p) });
  // M-2: a workspace with thousands of test files (a few of them exposed as flows)
  const tests = join(ws, 'tests', 'bulk');
  mkdirSync(tests, { recursive: true });
  for (let i = 0; i < 3000; i++) {
    const exposed = i % 1000 === 0 ? `expose:\n  tool: bulk_flow_${i}\n  description: Flow ${i}\n` : '';
    writeFileSync(join(tests, `t${i}.yaml`), `name: Bulk ${i}\n${exposed}tests:\n  - name: step\n    type: log\n    message: hello ${i}\n`);
  }
  mgr = new WorkspaceManager(join(dir, 'home'));
  store = mgr.open(ws);
});
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const connect = async (profile?: 'minimal' | 'verbose') => {
  const t0 = performance.now();
  const server = createTestPionMcpServer({ store, secrets: new EnvSecretStore(), settings: mgr.loadSettings(), profile });
  const made = performance.now() - t0;
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, made };
};

describe('the MCP server with 3,000 test files', () => {
  it('is made without reading them: construction in a few milliseconds, the flows appear at the first list', async () => {
    // (the first server of a process also loads the MCP SDK and its schema library: that is a one-time module cost, not the files)
    await (await connect()).client.close();
    const { client, made } = await connect();
    console.log(`createTestPionMcpServer with 3,000 test files: ${made.toFixed(0)} ms`);
    expect(made).toBeLessThan(150 * SLACK);
    const tools = (await client.listTools()).tools;
    expect(tools.filter((t) => t.name.startsWith('bulk_flow_')).map((t) => t.name)).toEqual(['bulk_flow_0', 'bulk_flow_1000', 'bulk_flow_2000']);
    await client.close();
  }, 60_000);
});

// M-1: every listed tool is in an agent's context
describe('tools/list size', () => {
  const size = async (profile?: 'minimal' | 'verbose') => {
    const { client } = await connect(profile);
    const list = await client.listTools();
    await client.close();
    return { bytes: JSON.stringify(list).length, count: list.tools.length };
  };
  it('the minimal profile stays under 40 KB', async () => {
    const { bytes, count } = await size('minimal');
    console.log(`minimal tools/list: ${count} tools, ${(bytes / 1024).toFixed(0)} KB`);
    expect(bytes).toBeLessThan(40 * 1024);
  });
  it('the full profile (compact entries, the default) stays under 200 KB for every tool', async () => {
    const { bytes, count } = await size();
    console.log(`full tools/list: ${count} tools, ${bytes} chars, headroom under the 200 KiB gate: ${200 * 1024 - bytes} chars`);
    expect(count).toBeGreaterThan(200);
    expect(bytes).toBeLessThan(200 * 1024);
    // the soft line: new tools need room (about 1 KB each); parameters many tools share are said once in the instructions, not per tool
    expect(bytes, 'less than 8 KB of headroom is left under the 200 KiB gate').toBeLessThan(200 * 1024 - 8 * 1024);
  });
  it('the verbose profile keeps the complete text and stays under 330 KB', async () => {
    const { bytes, count } = await size('verbose');
    console.log(`verbose tools/list: ${count} tools, ${(bytes / 1024).toFixed(0)} KB`);
    expect(bytes).toBeLessThan(330 * 1024);
  });
  it('search_tools with a name returns the complete entry the compact list leaves out', async () => {
    const { client } = await connect();
    const compact = (await client.listTools()).tools.find((t) => t.name === 'list_requests')!;
    const entry = (await client.callTool({ name: 'search_tools', arguments: { name: 'list_requests' } })) as { structuredContent?: { description: string; inputSchema: unknown } };
    expect(compact.description).not.toContain('Example:');
    expect(entry.structuredContent!.description).toContain('Example:');
    expect(entry.structuredContent!.description).toContain('When not:');
    expect(Object.keys((entry.structuredContent!.inputSchema as { properties: object }).properties)).toEqual(Object.keys(compact.inputSchema.properties as object));
    await client.close();
  });
});
