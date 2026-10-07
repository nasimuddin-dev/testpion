import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

// run-collection --method GET: a smoke run that only sends the requests that read.
const run = promisify(execFile);
const dir = mkdtempSync(join(tmpdir(), 'tp-method-'));
const seen: string[] = [];
let server: Server;
let base = '';
beforeAll(async () => {
  server = createServer((req, res) => (seen.push(`${req.method} ${req.url}`), res.end('{}')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const cli = async (...args: string[]) => {
  try {
    const r = await run(process.execPath, [join(process.cwd(), 'packages/cli/bin/testpion.js'), ...args], {
      encoding: 'utf8',
      cwd: dir,
      env: { ...process.env, NO_COLOR: '1', TESTPION_HOME: join(dir, 'home') },
    });
    return { status: 0, out: r.stdout + r.stderr };
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    return { status: x.code ?? -1, out: `${x.stdout ?? ''}${x.stderr ?? ''}` };
  }
};

describe('CLI: run-collection --method', () => {
  it('sends only the requests with those methods', async () => {
    const item = (name: string, method: string, path: string) => ({ name, request: { method, url: `${base}${path}` } });
    writeFileSync(
      join(dir, 'c.json'),
      JSON.stringify({
        info: { name: 'Shop', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
        item: [item('List', 'GET', '/items'), item('Create', 'POST', '/items'), { name: 'Admin', item: [item('Health', 'GET', '/health'), item('Delete', 'DELETE', '/items/1')] }],
      }),
    );
    const r = await cli('run-collection', join(dir, 'c.json'), '--method', 'GET');
    expect(r.status, r.out).toBe(0);
    expect(seen.sort()).toEqual(['GET /health', 'GET /items']);
    const none = await cli('run-collection', join(dir, 'c.json'), '--method', 'PATCH');
    expect(none.status).toBe(2);
    expect(none.out).toMatch(/No PATCH requests to run/);
  }, 60_000);
});
