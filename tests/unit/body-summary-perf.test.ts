import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Redactor, runTests, type TestCase } from '../../packages/core/src/index.js';
import { consoleBody } from '../../apps/desktop/backend/console-log.js';
import { fakeServices } from '../helpers.js';

const SLACK = Number(process.env.TESTPION_PERF_SLACK ?? 1);
const bigJson = (bytes: number) => JSON.stringify({ items: Array.from({ length: Math.ceil(bytes / 60) }, (_, i) => ({ id: i, name: `item ${i}`, token: 'sk-live-abcdef0123456789' })) });

// S-4: the console entry parsed, deep-copied and pretty-printed a whole 2 MB body to keep 16,000 characters of it
describe('the console body of a big response', () => {
  it('is cut before it is parsed: 2 MB in a few milliseconds, secrets still redacted, the rest counted', () => {
    const r = new Redactor();
    r.addSecret('sk-live-abcdef0123456789');
    const text = bigJson(2 * 1024 * 1024);
    let out = '';
    let ms = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      out = consoleBody(r, text)!;
      ms = Math.min(ms, performance.now() - t0);
    }
    console.log(`console body of ${(text.length / 1048576).toFixed(1)} MB: ${ms.toFixed(1)} ms`);
    expect(out.length).toBeLessThan(16_100);
    expect(out).toMatch(/… \[\d+ more characters\]$/);
    expect(out).not.toContain('sk-live-abcdef0123456789');
    expect(ms).toBeLessThan(20 * SLACK);
  });

  it('a secret that straddles the cut is not left half showing', () => {
    const r = new Redactor();
    const secret = 'SECRET' + 'x'.repeat(60);
    r.addSecret(secret);
    const text = 'a'.repeat(16_000 - 20) + secret + 'b'.repeat(100_000);
    const out = consoleBody(r, text)!;
    expect(out).not.toContain('SECRET');
    expect(out).not.toContain('xxxxx');
  });

  it('a small JSON body is still pretty-printed', () => {
    expect(consoleBody(new Redactor(), '{"a":1}')).toBe('{\n  "a": 1\n}');
  });
});

// R-3 / R-5: a result row kept 4,000 characters of the response (4.8 KB a row, 5.4 MB for 1,000 requests)
describe('a result row of a big response', () => {
  let server: Server;
  let base = '';
  let dir = '';
  beforeAll(async () => {
    const body = bigJson(1024 * 1024);
    server = createServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = mkdtempSync(join(tmpdir(), 'tp-body-summary-'));
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  it('is small: a 1 MB response gives a row of at most 2.5 KB', async () => {
    const resultsFile = join(dir, 'results.jsonl');
    const tests: TestCase[] = [{ id: 'big', name: 'Big', type: 'http', request: { method: 'GET', url: `${base}/big`, headers: [] }, assertions: [{ type: 'status', equals: 200 }] } as TestCase];
    const summary = await runTests({ name: 'big', tests, services: fakeServices(), resultsFile });
    expect(summary.passed).toBe(1);
    const row = readFileSync(resultsFile, 'utf8').trim();
    console.log(`result row for a 1 MB response: ${row.length} bytes`);
    expect(row.length).toBeLessThan(2500);
    expect(JSON.parse(row).output).toMatch(/more chars\]$/);
  });
});
