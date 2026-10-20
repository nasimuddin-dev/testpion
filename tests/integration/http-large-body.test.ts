import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdirSync, statSync } from 'node:fs';
import { executeHttp } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';

// Big downloads through the HTTP client: spooled to a payload file with only the preview in memory, and stopped in the
// middle. The server writes in 64 KB pieces: a server that writes a body in 230-byte pieces can leave a download
// hanging on Windows whatever the client (B-40d: the same stall with http.get, undici.request and fetch, none with
// curl), so a test of the client's own handling must not depend on that.
const SIZE = 20 * 1024 * 1024;
const PIECE = 64 * 1024;

let server: Server;
let base: string;
const tmp = tempDir('tp-large-body-');

beforeAll(async () => {
  const piece = Buffer.alloc(PIECE, 97);
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': SIZE });
    let sent = 0;
    const pump = () => {
      while (sent < SIZE) {
        const n = Math.min(PIECE, SIZE - sent);
        sent += n;
        if (!res.write(n === PIECE ? piece : piece.subarray(0, n))) return void res.once('drain', pump);
      }
      res.end();
    };
    pump();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  tmp.cleanup();
});

describe('a 20 MB download', () => {
  it('is spooled to a payload file and only the preview stays in memory', async () => {
    const r = (await executeHttp({ method: 'GET', url: `${base}/large`, headers: [], params: [] }, { payloadDir: tmp.dir, maxPreviewBytes: 1024, timeoutMs: 30_000 })).response;
    expect(r.size).toBe(SIZE);
    expect(r.truncated).toBe(true);
    expect(r.bodyPreview.length).toBeLessThan(2048);
    expect(r.payloadPath).toBeTruthy();
    expect(statSync(r.payloadPath!).size).toBe(SIZE);
    expect(readdirSync(tmp.dir)).toHaveLength(1);
  }, 60_000);

  it('can be cancelled in the middle of the body, and the next request is served', async () => {
    const ctrl = new AbortController();
    let seen = 0;
    const p = executeHttp({ method: 'GET', url: `${base}/large`, headers: [], params: [] }, {
      signal: ctrl.signal,
      timeoutMs: 0,
      onChunk: (c) => {
        seen += c.length;
        if (seen > 100_000) ctrl.abort();
      },
    });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    const again = (await executeHttp({ method: 'GET', url: `${base}/large`, headers: [], params: [] }, { discardBody: true, timeoutMs: 30_000 })).response;
    expect(again.size).toBe(SIZE);
  }, 60_000);
});
