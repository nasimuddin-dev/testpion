import { describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpSession } from '../../packages/core/src/index.js';

const listen = async (handler: (req: IncomingMessage) => void, respond: (res: import('node:http').ServerResponse) => void) => {
  const srv = createServer((req, res) => {
    handler(req);
    respond(res);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, port: (srv.address() as AddressInfo).port };
};

// GHSA-6prh-2h8m-c8cw: an MCP server that redirects must not receive the headers the person configured for another origin
describe('MCP HTTP transports do not follow redirects to another origin', () => {
  for (const transport of ['streamable-http', 'sse'] as const) {
    it(`${transport}: the second origin never sees the configured Authorization header`, async () => {
      const seen: Array<Record<string, string | string[] | undefined>> = [];
      const other = await listen(
        (req) => seen.push(req.headers),
        (res) => res.end('{}'),
      );
      const first = await listen(
        () => undefined,
        (res) => {
          res.statusCode = 302;
          res.setHeader('location', `http://localhost:${other.port}/mcp`);
          res.end();
        },
      );
      try {
        const session = new McpSession({ id: 'm', name: 'redirecting', transport, url: `http://127.0.0.1:${first.port}/mcp`, headers: [{ key: 'Authorization', value: 'Bearer sk-live-123' }] } as never, undefined, {});
        await expect(session.connect(5000)).rejects.toThrow(/Could not connect/);
        expect(seen).toEqual([]);
        await session.close().catch(() => undefined);
      } finally {
        first.srv.close();
        other.srv.close();
      }
    });
  }
});
