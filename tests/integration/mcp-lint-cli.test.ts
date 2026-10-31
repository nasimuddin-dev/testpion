import { describe, expect, it } from 'vitest';
import { cliData, runCli } from '../helpers.js';

/** `testpion mcp --lint`: how easy a server's tools are for an AI agent to use, read from a real server over stdio. */
describe('testpion mcp --lint', () => {
  it('checks the example server and says it in words and as JSON', async () => {
    const json = await runCli(['mcp', '--lint', '--json', '--', 'node', 'examples/servers/mcp-server.mjs']);
    expect(json.status).toBe(0);
    const r = cliData<{ tools: number; errors: number; findings: Array<{ level: string; tool?: string; code: string; text: string }>; listTokens: number; text: string; serverInfo?: { name: string } }>(json.out);
    expect(r.serverInfo?.name).toBe('customer-mcp');
    expect(r.tools).toBe(4);
    expect(r.errors).toBe(0);
    expect(r.listTokens).toBeGreaterThan(100);
    expect(r.findings.map((f) => f.code)).toContain('no-parameter-descriptions');
    const words = await runCli(['mcp', '--lint', '--', 'node', 'examples/servers/mcp-server.mjs']);
    expect(words.out).toContain('4 tools: 0 errors');
    expect(words.out).toContain('delete_customer');
  }, 60_000);
});
