import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { McpSession, dumpMcpMock, loadMcpMock, mcpResultBody, mockFromDiscovery, mockToolResult, startMcpMockHttp } from '../../packages/core/src/index.js';

const def = loadMcpMock(`
name: customer-mock
instructions: A fake customer service
tools:
  - name: search_customer
    description: Look up a customer by id.
    inputSchema:
      type: object
      properties: { customer_id: { type: string } }
      required: [customer_id]
    responses:
      - when: { customer_id: "999" }
        text: "No customer {{args.customer_id}}"
        isError: true
      - json: { id: "123", name: "Ada Lovelace", tier: gold }
  - name: echo
    responses:
      - text: "you said {{args.message}}"
resources:
  - uri: clinic://hours
    name: Opening hours
    mimeType: text/plain
    text: Mon-Fri 8-18
prompts:
  - name: summarize
    arguments: [{ name: topic, required: true }]
    messages:
      - role: user
        text: "Summarize {{topic}} in one line."
`);

describe('MCP mock server', () => {
  it('picks responses by arguments and fills templates', async () => {
    expect(await mockToolResult(def, 'search_customer', { customer_id: '999' })).toEqual({ content: [{ type: 'text', text: 'No customer 999' }], isError: true });
    expect((await mockToolResult(def, 'search_customer', { customer_id: '1' })).structuredContent).toEqual({ id: '123', name: 'Ada Lovelace', tier: 'gold' });
    expect((await mockToolResult(def, 'echo', { message: 'hi' })).content).toEqual([{ type: 'text', text: 'you said hi' }]);
    // dynamic variables: a fresh value per call; a whole-string placeholder keeps its type
    const dyn = { name: 'dyn', tools: [{ name: 'new_order', responses: [{ json: { id: '{{$guid}}', qty: '{{$randomInt(3,3)}}', note: 'by {{$randomFirstName}} for {{args.who}}' } }] }] };
    const o = (await mockToolResult(dyn as never, 'new_order', { who: 'Ada' })).structuredContent as { id: string; qty: number; note: string };
    expect(o.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(o.qty).toBe(3);
    expect(o.note).toMatch(/^by [A-Z]\w+ for Ada$/);
    expect((await mockToolResult(def, 'nope')).isError).toBe(true);
    // placeholders in JSON responses: a whole-string placeholder keeps the argument's type
    const templ = { name: 't', tools: [{ name: 'forecast', responses: [{ json: { city: '{{args.city}}', days: '{{args.days}}', note: 'for {{args.city}}', list: ['{{args.city}}'] } }] }] };
    expect((await mockToolResult(templ as never, 'forecast', { city: 'Paris', days: 3 })).structuredContent).toEqual({ city: 'Paris', days: 3, note: 'for Paris', list: ['Paris'] });
  });

  it('serves tools, resources and prompts over Streamable HTTP to a real MCP client', async () => {
    const mock = await startMcpMockHttp(def);
    const s = new McpSession({ id: 'm', name: 'mock', transport: 'streamable-http', url: mock.url });
    try {
      await s.connect(10_000);
      const d = await s.discover();
      expect(d.serverInfo?.name).toBe('customer-mock');
      expect(d.tools.map((t) => t.name)).toEqual(['search_customer', 'echo']);
      const ok = await s.callTool('search_customer', { customer_id: '123' });
      expect(ok.isError).toBe(false);
      expect(mcpResultBody(ok).body).toMatchObject({ name: 'Ada Lovelace' });
      expect((await s.callTool('search_customer', { customer_id: '999' })).isError).toBe(true);
      expect(JSON.stringify((await s.readResource('clinic://hours')).contents)).toContain('Mon-Fri 8-18');
      expect(JSON.stringify((await s.getPrompt('summarize', { topic: 'billing' })).messages)).toContain('Summarize billing in one line.');
    } finally {
      await s.close();
      await mock.close();
    }
  });

  it('records a mock from a server discovery and round-trips as YAML', async () => {
    const rec = mockFromDiscovery(
      'recorded',
      { tools: [{ name: 't', inputSchema: { type: 'object' } }], resources: [{ uri: 'a://b', name: 'B' }], resourceTemplates: [], prompts: [] },
      [{ tool: 't', args: { x: 1 }, result: { content: [{ type: 'text', text: 'one' }] } }],
      { 'a://b': 'hello' },
    );
    const back = loadMcpMock(dumpMcpMock(rec));
    expect(back.tools![0]!.responses).toEqual([{ when: { x: 1 }, content: [{ type: 'text', text: 'one' }] }]);
    expect(back.resources![0]!.text).toBe('hello');
    expect((await mockToolResult(back, 't', { x: 1 })).content).toEqual([{ type: 'text', text: 'one' }]);
    expect(() => loadMcpMock('tools: []')).toThrow(/name/);
  });

  it('runs as a stdio MCP server from the CLI (how agents start it)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-mock-'));
    const file = join(dir, 'customer.mcp-mock.yaml');
    writeFileSync(file, dumpMcpMock(def));
    const s = new McpSession({ id: 'cli', name: 'cli-mock', transport: 'stdio', command: process.execPath, args: [resolve('packages/cli/bin/testpion.js'), 'mock-mcp', file] });
    try {
      await s.connect(20_000);
      const r = await s.callTool('echo', { message: 'from an agent' });
      expect(mcpResultBody(r).text).toBe('you said from an agent');
    } finally {
      await s.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
