import { describe, it, expect, afterAll } from 'vitest';
import { copyExample, runCliSync } from '../helpers.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpSession, mcpResultBody } from '../../packages/core/src/index.js';

// `testpion collections` and `testpion requests` show what a workspace holds, gRPC calls and connections
// included (the same as the list_collections / list_requests MCP tools).
const dir = mkdtempSync(join(tmpdir(), 'tp-cli-cols-'));
const ws = join(dir, 'ws');
copyExample('public-workspace', ws);
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
const cli = (...args: string[]) => runCliSync([...args, '-w', ws]);

describe('CLI: collections and requests', () => {
  it('lists collections with their gRPC calls and connections', () => {
    const r = cli('collections', '--json');
    expect(r.status, r.err).toBe(0);
    const rows = JSON.parse(r.out) as Array<{ id: string; requests: number; grpcCalls: number; connections: number }>;
    expect(rows.find((c) => c.id === 'grpc')).toMatchObject({ requests: 0, grpcCalls: 9, connections: 0 });
    expect(rows.find((c) => c.id === 'realtime')).toMatchObject({ grpcCalls: 0, connections: 6 });
    expect(rows.find((c) => c.id === 'httpbin')!.requests).toBeGreaterThan(5);
  }, 120_000);

  it('lists what one collection holds', () => {
    const grpc = JSON.parse(cli('requests', 'gRPC (grpcb.in)', '--json').out) as Array<{ kind: string; target: string }>;
    expect(grpc.map((r) => r.kind)).toEqual(Array(9).fill('grpc'));
    expect(grpc[0]!.target).toMatch(/\{\{grpcHost\}\} hello\.HelloService\//);
    const text = cli('requests', 'realtime').out;
    expect(text).toMatch(/MQTT\s+MQTT brokers \/ Mosquitto test broker/);
    const missing = cli('requests', 'nope');
    expect(missing.status).not.toBe(0);
    expect(missing.err).toMatch(/No collection "nope"/);
  }, 120_000);

  it('MCP: list_requests and get_request show the gRPC calls and connections', async () => {
    const s = new McpSession({ id: 'tp', name: 'testpion', transport: 'stdio', command: process.execPath, args: [join(process.cwd(), 'packages/cli/bin/testpion.js'), 'mcp-server', '-w', ws], env: { TESTPION_HOME: join(dir, 'home') } });
    await s.connect(20_000);
    try {
      const call = async (tool: string, args: Record<string, unknown>) => JSON.parse(mcpResultBody(await s.callTool(tool, args)).text) as any;
      const cols = await call('list_collections', {});
      expect(cols.find((c: any) => c.id === 'grpc')).toMatchObject({ grpcCalls: 9, connections: 0 });
      const items = await call('list_requests', { collection: 'WebSocket & MQTT' });
      expect(items.map((i: any) => i.kind)).toEqual(Array(6).fill('websocket'));
      const one = await call('get_request', { collection: 'gRPC (grpcb.in)', request: 'Add two numbers' });
      expect(one).toMatchObject({ kind: 'grpc', name: 'Add two numbers', method: 'addsvc.Add/Sum', target: '{{grpcHost}}' });
    } finally {
      await s.close();
    }
  }, 60_000);
});
