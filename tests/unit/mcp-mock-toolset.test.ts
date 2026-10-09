import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMcpMock, mockServeCommands, mockToolResult, mockToolsList, runMockScript } from '../../packages/core/src/index.js';
import { mockTools } from '../../packages/core/src/mcp-server/mock-tools.js';
import { runCliSync, tempDir } from '../helpers.js';

// A toolset: the tools of an MCP mock as an agent will see them, with script responses computed from the arguments.
const def = loadMcpMock(`
name: orders-mock
instructions: A fake order service.
tools:
  - name: get_order
    description: One order by id.
    inputSchema:
      type: object
      properties: { id: { type: string, description: Order id }, verbose: { type: boolean } }
      required: [id]
    annotations: { readOnlyHint: true }
    responses:
      - when: { id: "missing" }
        text: "No order {{args.id}}"
        isError: true
      - script: |
          (args) => ({ id: args.id, total: args.id.length * 10, items: args.verbose ? ['a', 'b'] : undefined })
  - name: refund
    description: Refund an order.
    inputSchema: { type: object, properties: { id: { type: string }, amount: { type: number } }, required: [id, amount] }
    responses:
      - script: |
          if (args.amount > 50) throw new Error('needs approval');
          return 'refunded ' + args.amount + ' on ' + args.id;
  - name: raw
    responses:
      - script: "(args) => ({ content: [{ type: 'text', text: 'raw ' + args.x }], isError: true })"
  - name: flagged
    responses:
      - script: "() => 'nope'"
        isError: true
  - name: echo
    responses:
      - text: "{{args.message}}"
      - when: { message: "json" }
        json: { ok: true }
`);

describe('MCP mock toolset', () => {
  it('a script response computes the answer from the arguments: text or JSON, an error when it throws', async () => {
    const r = await mockToolResult(def, 'get_order', { id: 'abc', verbose: true });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toEqual({ id: 'abc', total: 30, items: ['a', 'b'] });
    expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual({ id: 'abc', total: 30, items: ['a', 'b'] });
    // `when` still wins over the script
    expect(await mockToolResult(def, 'get_order', { id: 'missing' })).toEqual({ content: [{ type: 'text', text: 'No order missing' }], isError: true });
    // a body with `return` and a string result
    expect(await mockToolResult(def, 'refund', { id: 'o1', amount: 20 })).toEqual({ content: [{ type: 'text', text: 'refunded 20 on o1' }] });
    const failed = await mockToolResult(def, 'refund', { id: 'o1', amount: 80 });
    expect(failed.isError).toBe(true);
    expect((failed.content[0] as { text: string }).text).toMatch(/Script error in the mock response of refund: Error: needs approval/);
    // a `{ content }` object is sent as is; `isError` on the response marks a script's answer
    expect(await mockToolResult(def, 'raw', { x: 1 })).toEqual({ content: [{ type: 'text', text: 'raw 1' }], isError: true });
    expect(await mockToolResult(def, 'flagged', {})).toEqual({ content: [{ type: 'text', text: 'nope' }], isError: true });
  });

  it('runMockScript takes a function expression or a body; the sandbox has no Node access', async () => {
    expect(await runMockScript('args => args.n * 2', { n: 21 })).toBe(42);
    expect(await runMockScript('async (args) => ({ n: args.n })', { n: 1 })).toEqual({ n: 1 });
    expect(await runMockScript('return Object.keys(args)', { a: 1, b: 2 })).toEqual(['a', 'b']);
    await expect(runMockScript('(args) => require("fs").readFileSync("x")', {})).rejects.toThrow(/ScriptError|not defined|require/);
  });

  it('lists the tools with their arguments and how they answer', () => {
    const list = mockToolsList(def);
    expect(list.map((t) => t.name)).toEqual(['get_order', 'refund', 'raw', 'flagged', 'echo']);
    expect(list[0]).toMatchObject({
      name: 'get_order',
      description: 'One order by id.',
      arguments: ['id*', 'verbose'],
      annotations: { readOnlyHint: true },
      responses: { count: 2, kinds: ['text', 'script'], when: 1 },
    });
    expect(list[4]!.responses).toEqual({ count: 2, kinds: ['text', 'json'], when: 1 });
    expect(list[2]!.inputSchema).toEqual({ type: 'object', properties: {} });
    expect(list[2]!.arguments).toEqual([]);
  });

  it('gives the command lines that serve a file to an agent', () => {
    const s = mockServeCommands('mocks/orders.mcp-mock.yaml');
    expect(s.stdio).toBe('testpion mock-mcp mocks/orders.mcp-mock.yaml');
    expect(s.http).toBe('testpion mock-mcp mocks/orders.mcp-mock.yaml --http -p 3333');
    expect(s.url).toBe('http://127.0.0.1:3333/mcp');
    expect(JSON.parse(s.agentConfig)).toEqual({ mcpServers: { orders: { command: 'testpion', args: ['mock-mcp', 'mocks/orders.mcp-mock.yaml'] } } });
    expect(mockServeCommands('my mocks/a.mcp-mock.yaml', 4000).stdio).toBe('testpion mock-mcp "my mocks/a.mcp-mock.yaml"');
  });

  describe('CLI: testpion mock-mcp <file> --list', () => {
    const t = tempDir('tp-mock-list-');
    afterAll(t.cleanup);
    const file = join(t.dir, 'orders.mcp-mock.yaml');
    writeFileSync(
      file,
      [
        'name: orders-mock',
        'tools:',
        '  - name: get_order',
        '    description: One order by id.',
        '    inputSchema: { type: object, properties: { id: { type: string } }, required: [id] }',
        '    responses:',
        '      - script: "(args) => ({ id: args.id })"',
        '  - name: ping',
        '',
      ].join('\n'),
    );

    it('MCP tool mock_tools lists a mock file of the workspace (never a file outside it)', async () => {
      const safePath = (rel: string) => {
        if (rel.startsWith('..')) throw new Error('escapes');
        return join(t.dir, rel);
      };
      const [tool] = mockTools({ store: { safePath } as never });
      const out = (await tool!.run({ file: 'orders.mcp-mock.yaml' })) as { name: string; tools: Array<{ name: string }>; serve: { stdio: string } };
      expect(out.name).toBe('orders-mock');
      expect(out.tools.map((x) => x.name)).toEqual(['get_order', 'ping']);
      expect(out.serve.stdio).toBe('testpion mock-mcp orders.mcp-mock.yaml');
      await expect(async () => tool!.run({ file: '../outside.yaml' })).rejects.toThrow(/escapes/);
    });

    it('prints the toolset, and as JSON with --json', () => {
      const text = runCliSync(['mock-mcp', file, '--list'], { cwd: t.dir });
      expect(text.status, text.err).toBe(0);
      expect(text.out).toMatch(/MCP mock "orders-mock"/);
      expect(text.out).toMatch(/get_order\(id\*\) {2}One order by id\./);
      expect(text.out).toMatch(/1 script response/);
      expect(text.out).toMatch(/ping\(\)/);
      expect(text.out).toMatch(/no response \(echoes the call\)/);
      expect(text.out).toMatch(/Serve it: testpion mock-mcp/);
      const json = runCliSync(['mock-mcp', file, '--list', '--json'], { cwd: t.dir });
      expect(json.status, json.err).toBe(0);
      const out = JSON.parse(json.out) as { name: string; tools: Array<{ name: string; arguments: string[]; responses: { kinds: string[] } }>; serve: { stdio: string } };
      expect(out.name).toBe('orders-mock');
      expect(out.tools.map((x) => x.name)).toEqual(['get_order', 'ping']);
      expect(out.tools[0]).toMatchObject({ arguments: ['id*'], responses: { kinds: ['script'] } });
      expect(out.serve.stdio).toContain('mock-mcp');
    });
  });
});
