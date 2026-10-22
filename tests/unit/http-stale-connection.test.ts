import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { executeHttp } from '../../packages/core/src/index.js';

// A pooled keep-alive connection the server closed between two requests (its idle timer, a load balancer recycling it): the second
// request used to fail with "other side closed" - one request of 2,600 in a busy run. A request that can be sent again goes once more.
let server: Server;
let base = '';
const seen: string[] = [];
let dropNext = false;
beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (dropNext) {
      dropNext = false;
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

// (the first requests open the pool's connection; by the third one it is a pooled one)
const warm = async (path: string) => {
  for (let i = 0; i < 3; i++) await executeHttp({ method: 'GET', url: `${base}${path}${i}`, headers: [] } as never);
};

describe('a connection closed by the server between requests', () => {
  it('is replaced for a GET: the request succeeds on a new connection, sent twice at the server', async () => {
    await warm('/warm');
    seen.length = 0;
    dropNext = true;
    const { response } = await executeHttp({ method: 'GET', url: `${base}/stale`, headers: [] } as never);
    expect(response.status).toBe(200);
    expect(seen).toEqual(['GET /stale', 'GET /stale']);
    expect(response.connection?.reused).toBe(false);
  });

  it('is not replayed for a POST (it may have been processed)', async () => {
    await warm('/warm2');
    seen.length = 0;
    dropNext = true;
    await expect(executeHttp({ method: 'POST', url: `${base}/once`, headers: [], body: { type: 'text', content: 'x' } } as never)).rejects.toThrow();
    expect(seen).toEqual(['POST /once']);
  });
});
