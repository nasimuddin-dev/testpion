/**
 * Development bridge: serves the backend over HTTP (POST /rpc, GET /events as SSE) so the UI can be
 * developed and tested in a regular browser. Binds to 127.0.0.1 only and requires a per-process token.
 * Secrets use an in-memory store in this mode (nothing is written to disk in plain text).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ApsError, isLoopbackHostHeader, normalizeError } from '@testpion/core';
import { Backend } from './backend.js';

/** Largest RPC request accepted (imports and uploaded files travel as JSON). */
const MAX_BODY = 64 * 1024 * 1024;

const port = Number(process.env.TESTPION_BRIDGE_PORT ?? 5174);
const token = process.env.TESTPION_BRIDGE_TOKEN ?? randomBytes(16).toString('hex');
const clients = new Set<ServerResponse>();
const tokenBytes = Buffer.from(token);
const validToken = (t: unknown) => typeof t === 'string' && t.length === token.length && timingSafeEqual(Buffer.from(t), tokenBytes);
const reply = (res: ServerResponse, status: number, body: unknown) => {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
};

const backend = new Backend({
  appDir: process.env.TESTPION_HOME || process.env.FLUXPION_HOME || join(homedir(), '.testpion-dev'),
  emit: (channel, payload) => {
    const data = `data: ${JSON.stringify({ channel, payload })}\n\n`;
    for (const c of clients) c.write(data);
  },
  openExternal: (url) => console.log(`[bridge] open ${url}`),
  examplesDir: process.env.TESTPION_EXAMPLES ?? join(process.cwd(), 'examples', 'public-workspace'),
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // DNS rebinding: a page on another name that resolves to this computer sends its own Host header
  if (!isLoopbackHostHeader(req.headers.host)) return reply(res, 421, { error: 'The bridge answers to localhost only' });
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const viz = /^\/viz\/([0-9a-f]{32})\/?$/.exec(url.pathname);
  if (viz && req.method === 'GET') {
    const page = backend.visualizationPage(viz[1]!);
    res.writeHead(page ? 200 : 404, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': Backend.VIZ_CSP, 'x-content-type-options': 'nosniff' });
    res.end(page ?? 'This visualization is no longer available.');
    return;
  }
  if (!validToken(url.searchParams.get('token')) && !validToken(req.headers['x-aps-token'])) {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname === '/rpc' && req.method === 'POST') {
    // collect bytes, then decode once (decoding per chunk splits multi-byte characters)
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req as AsyncIterable<Buffer>) {
      size += c.length;
      if (size > MAX_BODY) return reply(res, 413, { ok: false, error: normalizeError(new ApsError('ValidationError', `Request is larger than ${MAX_BODY / 1024 / 1024} MB`)) });
      chunks.push(c);
    }
    let call: { method?: unknown; params?: unknown };
    try {
      call = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return reply(res, 400, { ok: false, error: normalizeError(new ApsError('ValidationError', 'The request body is not valid JSON')) });
    }
    if (typeof call?.method !== 'string') return reply(res, 400, { ok: false, error: normalizeError(new ApsError('ValidationError', 'Missing "method"')) });
    try {
      reply(res, 200, { ok: true, data: (await backend.invoke(call.method, call.params)) ?? null });
    } catch (e) {
      // errors are plain objects (kind, message, suggestions …) the UI and AI agents can read
      reply(res, 200, { ok: false, error: normalizeError(e) });
    }
    return;
  }
  res.writeHead(404).end();
}

// an unexpected failure answers 500 instead of crashing the process (async handlers can't throw to Node)
createServer((req, res) => {
  handle(req, res).catch((e) => reply(res, 500, { ok: false, error: normalizeError(e) }));
}).listen(port, '127.0.0.1', () => {
  console.log(`[bridge] backend listening on http://127.0.0.1:${port} (token ${token})`);
});
