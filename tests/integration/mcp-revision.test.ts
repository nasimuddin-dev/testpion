/**
 * The MCP revision a connection speaks (N-6): Streamable HTTP asks the server first (server/discover) and speaks
 * 2026-07-28 when it is offered; servers of the 2025 revisions get the handshake they know, on every transport.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpSession, checkMcpServer, loadMcpMock, startMcpMockHttp, type McpServerConfig } from '@testpion/core';
import { cliPath, runCli } from '../helpers.js';

const fixture = join(process.cwd(), 'tests', 'fixtures', 'mcp-modern-server.mjs');
const servers: ChildProcess[] = [];
const start = (...args: string[]) =>
  new Promise<string>((resolve, reject) => {
    const p = spawn(process.execPath, [fixture, ...args]);
    servers.push(p);
    let out = '';
    const t = setTimeout(() => reject(new Error(`the fixture did not start: ${out}`)), 20_000);
    p.stdout.on('data', (d) => {
      out += d;
      const m = /listening (\d+)/.exec(out);
      if (m) {
        clearTimeout(t);
        resolve(`http://127.0.0.1:${m[1]}/mcp`);
      }
    });
    p.stderr.on('data', (d) => (out += d));
  });

let strict = '';
let both = '';
beforeAll(async () => {
  [strict, both] = await Promise.all([start('strict'), start()]);
}, 30_000);
afterAll(() => {
  for (const p of servers) p.kill();
});

const open = async (cfg: Partial<McpServerConfig> & { transport: McpServerConfig['transport'] }) => {
  const s = new McpSession({ id: 't', name: 't', ...cfg } as McpServerConfig);
  await s.connect(20_000);
  return s;
};

describe('the MCP revision of a connection', () => {
  it('speaks 2026-07-28 with a server that offers it: discovery, a call, and the check of the server', async () => {
    const s = await open({ transport: 'streamable-http', url: strict });
    try {
      const d = await s.discover();
      expect(d.protocolVersion).toBe('2026-07-28');
      expect(d.serverInfo).toMatchObject({ name: 'modern', version: '1.0.0' });
      expect(d.instructions).toBe('A server of the 2026-07-28 revision.');
      expect(d.tools.map((t) => t.name)).toEqual(['echo']);
      const r = await s.callTool('echo', { text: 'hello' });
      expect(r).toMatchObject({ isError: false, content: [{ type: 'text', text: 'hello' }] });
      // the trace shows the question that came first, and no 2025 handshake
      expect(s.events.some((e) => e.direction === 'outgoing' && e.method === 'server/discover')).toBe(true);
      expect(s.events.some((e) => e.direction === 'outgoing' && e.method === 'initialize')).toBe(false);
      const c = await checkMcpServer(s, {});
      expect(c.protocolVersion).toBe('2026-07-28');
      expect(c.conformance.errors).toBe(0);
    } finally {
      await s.close();
    }
  }, 40_000);

  it('protocol legacy does not ask first: a 2026-only server refuses it with its reason, one that serves both answers in 2025', async () => {
    await expect(open({ transport: 'streamable-http', url: strict, protocol: 'legacy' })).rejects.toThrow(/Unsupported protocol version/);
    const s = await open({ transport: 'streamable-http', url: both, protocol: 'legacy' });
    try {
      expect((await s.discover()).protocolVersion).toMatch(/^2025-/);
      expect(s.events.some((e) => e.method === 'server/discover')).toBe(false);
    } finally {
      await s.close();
    }
  }, 40_000);

  it('a server of the 2025 revisions is asked, says no, and gets the handshake it knows (HTTP, a local program asked to, a mock)', async () => {
    const mockFile = join(process.cwd(), 'examples', 'public-workspace', 'mocks', 'weather.mcp-mock.yaml');
    const mock = await startMcpMockHttp(loadMcpMock(readFileSync(mockFile, 'utf8')));
    try {
      for (const cfg of [
        { transport: 'streamable-http' as const, url: mock.url },
        { transport: 'mock' as const, mockFile, protocol: 'auto' as const },
        { transport: 'stdio' as const, command: process.execPath, args: [cliPath, 'mcp-server', '-w', join(process.cwd(), 'examples', 'public-workspace'), '--read-only'], protocol: 'auto' as const },
      ]) {
        const s = await open(cfg);
        try {
          const d = await s.discover();
          expect(d.protocolVersion, cfg.transport).toBe('2025-11-25');
          expect(d.tools.length, cfg.transport).toBeGreaterThan(0);
        } finally {
          await s.close();
        }
      }
    } finally {
      await mock.close();
    }
  }, 60_000);

  it('the command line: --url asks first, --protocol legacy does not', async () => {
    const auto = await runCli(['mcp', '--url', strict, '--check', '--json']);
    expect(auto.status, auto.err).toBe(0);
    expect(JSON.parse(auto.out).data.protocolVersion).toBe('2026-07-28');
    const legacy = await runCli(['mcp', '--url', strict, '--protocol', 'legacy', '--json']);
    expect(legacy.status).not.toBe(0);
    expect(legacy.out + legacy.err).toMatch(/Unsupported protocol version/);
  }, 60_000);
});
