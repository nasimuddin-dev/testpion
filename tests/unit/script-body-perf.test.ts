import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runTests, type TestCase } from '../../packages/core/src/index.js';
import { fakeServices } from '../helpers.js';

const SLACK = Number(process.env.TESTPION_PERF_SLACK ?? 1);
let server: Server;
let base = '';
const big = JSON.stringify({ items: Array.from({ length: 12_000 }, (_, i) => ({ id: i, name: `item ${i}`, tags: ['a', 'b'] })) });
beforeAll(async () => {
  server = createServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(big);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

// R-4: a test script's input held the response body twice (as text and parsed, as tp.data.body), both stringified into the VM
describe('a test script over a 600 KB JSON response', () => {
  it('sees the same body through tp.response and tp.data, and 30 runs take a moment', async () => {
    const script = [
      "tp.test('json', () => { tp.expect(tp.response.json().items.length).to.equal(12000); });",
      "tp.test('data', () => { tp.expect(tp.data.body.items.length).to.equal(12000); });",
      "tp.test('text', () => { tp.expect(typeof tp.response.text()).to.equal('string'); });",
    ].join('\n');
    const tests: TestCase[] = Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, name: `T${i}`, type: 'http', request: { method: 'GET', url: `${base}/${i}`, headers: [] }, testScript: script }) as TestCase);
    const t0 = performance.now();
    const summary = await runTests({ name: 'script-body', tests, services: fakeServices(), concurrency: 1 });
    const ms = performance.now() - t0;
    console.log(`30 scripted runs over ${(big.length / 1024).toFixed(0)} KB: ${ms.toFixed(0)} ms`);
    expect(summary.passed).toBe(30);
    expect(ms).toBeLessThan(20_000 * SLACK);
  }, 120_000);

  it('a plain-text body is the same text in tp.data.body', async () => {
    const text = createServer((_q, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end('hello'));
    await new Promise<void>((r) => text.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(text.address() as AddressInfo).port}/`;
      const summary = await runTests({
        name: 'text',
        tests: [{ id: 'a', name: 'A', type: 'http', request: { method: 'GET', url, headers: [] }, testScript: "tp.test('same', () => { tp.expect(tp.data.body).to.equal('hello'); });" } as TestCase],
        services: fakeServices(),
      });
      expect(summary.passed).toBe(1);
    } finally {
      text.closeAllConnections();
      await new Promise((r) => text.close(r));
    }
  });
});
