/**
 * Serving an MCP server made here (the workspace's own, or a mock) to a client of any revision. The client's first
 * message says which it speaks: `server/discover` or a request with the 2026-07-28 envelope, or the `initialize`
 * handshake of the revisions before. The SDK decides from that and asks `make` for a server; the server code is the same
 * for both.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from '@modelcontextprotocol/server';
import { mcpServer, mcpServerStdio } from './sdk.js';

/** Over a pair of streams (the process's own stdin and stdout when none is given) until the client closes its end. */
export async function serveMcpOverStdio(make: () => Server, stdio?: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream }): Promise<void> {
  const { serveStdio, StdioServerTransport } = mcpServerStdio();
  const input = stdio?.input ?? process.stdin;
  const closed = new Promise<void>((resolve) => input.once('end', resolve).once('close', resolve));
  const serving = serveStdio(make, { transport: new StdioServerTransport(stdio?.input as never, stdio?.output as never) });
  await closed;
  await serving.close();
}

/** Over a transport that is already there (the in-memory pair of a mock inside the app). */
export function serveMcpOverTransport(make: () => Server, transport: unknown): { close(): Promise<void> } {
  return mcpServerStdio().serveStdio(make, { transport: transport as never });
}

const MAX_BODY = 16 * 1024 * 1024;

/**
 * Over Streamable HTTP on 127.0.0.1, at /mcp (any path is answered). Stateless on every revision: a request of the 2025
 * revisions gets a fresh server, as before; one of 2026-07-28 carries what the server needs with it.
 */
export async function serveMcpOverHttp(make: () => Server, opts: { port?: number } = {}): Promise<{ url: string; close(): Promise<void> }> {
  const handler = mcpServer().createMcpHandler(make);
  const json = (res: ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}) =>
    res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') return void json(res, 405, -32000, 'Method not allowed', { allow: 'POST' });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) return void json(res, 413, -32600, 'A request of more than 16 MB');
      chunks.push(c as Buffer);
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    const aborted = new AbortController();
    res.on('close', () => aborted.abort());
    const answer = await handler.fetch(new Request(`http://127.0.0.1${req.url ?? '/mcp'}`, { method: 'POST', headers, body: Buffer.concat(chunks), signal: aborted.signal }));
    res.writeHead(answer.status, Object.fromEntries(answer.headers));
    // a result is one JSON body; a call that reports on the way is a stream, passed on as it comes
    if (answer.body) for await (const part of answer.body as unknown as AsyncIterable<Uint8Array>) res.write(part);
    res.end();
  };
  const http = createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) json(res, 500, -32603, (e as Error).message);
      else res.end();
    });
  });
  await new Promise<void>((ok, fail) => {
    http.once('error', fail);
    http.listen(opts.port ?? 0, '127.0.0.1', () => ok());
  });
  return {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`,
    close: async () => {
      await new Promise<void>((ok) => {
        http.close(() => ok());
        http.closeAllConnections?.();
      });
      await handler.close();
    },
  };
}
