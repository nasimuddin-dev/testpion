import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTestPionMcpServer, EnvSecretStore, WorkspaceManager, type WorkspaceStore } from '../../packages/core/src/index.js';

// What makes the MCP server easy for agents: titles and behaviour hints on tools, structured results,
// resources (guide, workspace, collections), prompts, and tools to write checks and test files.
const dir = mkdtempSync(join(tmpdir(), 'tp-agent-kit-'));
const ws = join(dir, 'ws');
cpSync(join(process.cwd(), 'examples', 'public-workspace'), ws, { recursive: true, filter: (p) => !/database\.sqlite|[\\/](runs|traces|payloads)([\\/]|$)/.test(p) });
let store: WorkspaceStore;
let client: Client;

beforeAll(async () => {
  const mgr = new WorkspaceManager(join(dir, 'home'));
  store = mgr.open(ws);
  const server = createTestPionMcpServer({ store, secrets: new EnvSecretStore(), settings: mgr.loadSettings() });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
});
afterAll(async () => {
  await client.close();
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('MCP server for agents', () => {
  it('gives every tool a title and behaviour hints', async () => {
    const { tools } = await client.listTools();
    expect(tools.every((t) => t.title && t.annotations && typeof t.annotations.readOnlyHint === 'boolean')).toBe(true);
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(by.list_collections!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(by.send_request!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    expect(by.save_request!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(by.decode_jwt!.title).toBe('Decode JWT');
  });

  it('returns results as structured content too', async () => {
    const r = await client.callTool({ name: 'list_collections', arguments: {} });
    expect((r.structuredContent as { items: Array<{ id: string }> }).items.some((c) => c.id === 'httpbin')).toBe(true);
    expect(JSON.parse((r.content as Array<{ text: string }>)[0]!.text)).toEqual((r.structuredContent as { items: unknown }).items);
  });

  it('serves a guide, the workspace and collections as resources', async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual(expect.arrayContaining(['testpion://guide', 'testpion://workspace', 'testpion://attention', 'testpion://collections/httpbin']));
    const guide = (await client.readResource({ uri: 'testpion://guide' })).contents[0] as { text: string };
    expect(guide.text).toMatch(/json-schema/);
    expect(guide.text).toMatch(/tests:\n/);
    const overview = JSON.parse(((await client.readResource({ uri: 'testpion://workspace' })).contents[0] as { text: string }).text);
    expect(overview.collections.length).toBeGreaterThan(3);
    const docs = (await client.readResource({ uri: 'testpion://collections/httpbin' })).contents[0] as { text: string; mimeType: string };
    expect(docs.mimeType).toBe('text/markdown');
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toContain('testpion://collections/{collection}/requests/{request}');
  });

  it('offers prompts for the common jobs', async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(expect.arrayContaining(['investigate_failures', 'write_tests', 'debug_request', 'api_health_report', 'import_and_test']));
    const p = await client.getPrompt({ name: 'write_tests', arguments: { collection: 'HTTP basics (httpbin)' } });
    expect((p.messages[0]!.content as { text: string }).text).toMatch(/set_request_checks/);
    await expect(client.getPrompt({ name: 'debug_request', arguments: { collection: 'x' } })).rejects.toThrow(/Missing: request/);
  });

  it('sets the checks of a saved request (unknown types are refused)', async () => {
    const id = store.listCollections().find((c) => c.id === 'httpbin')!;
    const first = id.items.flatMap(function all(n): any[] {
      return n.kind === 'folder' ? n.items.flatMap(all) : [n];
    })[0]!;
    const bad = await client.callTool({ name: 'set_request_checks', arguments: { collection: 'httpbin', request: first.id, checks: [{ type: 'statuss', expected: 200 }] } });
    expect(bad.isError).toBe(true);
    expect((bad.content as Array<{ text: string }>)[0]!.text).toMatch(/Unknown check type: statuss/);
    const ok = await client.callTool({ name: 'set_request_checks', arguments: { collection: 'httpbin', request: first.id, checks: [{ type: 'latency', max: 9000 }], mode: 'replace', confirm: true } });
    expect(ok.isError).toBeFalsy();
    const saved = store.listCollections().find((c) => c.id === 'httpbin')!;
    const again = JSON.stringify(saved);
    expect(again).toContain('"max":9000');
  });

  it('writes a test file only when it parses and uses known checks', async () => {
    const good = `tests:\n  - id: t1\n    name: Health\n    type: http\n    method: GET\n    url: "{{httpbin}}/get"\n    assertions:\n      - { type: status, expected: 200 }\n`;
    const r = await client.callTool({ name: 'write_test_file', arguments: { path: 'agent/health.yaml', content: good } });
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ path: 'tests/agent/health.yaml', tests: [{ id: 't1', name: 'Health', type: 'http', checks: 1 }] });
    expect(readFileSync(join(ws, 'tests', 'agent', 'health.yaml'), 'utf8')).toBe(good);
    const again = await client.callTool({ name: 'write_test_file', arguments: { path: 'agent/health.yaml', content: good } });
    expect((again.content as Array<{ text: string }>)[0]!.text).toMatch(/overwrite: true/);
    const unknown = await client.callTool({ name: 'write_test_file', arguments: { path: 'agent/bad.yaml', content: good.replace('status', 'stat') } });
    expect((unknown.content as Array<{ text: string }>)[0]!.text).toMatch(/Unknown check type: stat/);
    expect(existsSync(join(ws, 'tests', 'agent', 'bad.yaml'))).toBe(false);
    const outside = await client.callTool({ name: 'write_test_file', arguments: { path: '../evil.yaml', content: good } });
    expect(outside.isError).toBe(true);
  });
});
