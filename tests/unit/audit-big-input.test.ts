import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Backend } from '../../apps/desktop/backend/backend.js';

/**
 * Robustness audit (2026-10-09): how long realistic big inputs block the backend's event loop. The backend runs
 * in Electron's main process, so a synchronous stretch freezes the whole window. Records into AUDIT_BIG_OUT.
 * Opt-in (AUDIT_RPC=1): it is a measurement, not a regression test.
 */
const OUT = process.env.AUDIT_BIG_OUT ?? join(tmpdir(), 'audit-big-input.json');

describe.skipIf(!process.env.AUDIT_RPC)('audit: big inputs block the event loop', () => {
  it('measures', { timeout: 600_000 }, async () => {
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => res.end('{"ok":true}'));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const be = new Backend({ appDir: mkdtempSync(join(tmpdir(), 'tp-audit-big-')), emit: () => {}, noMonitors: true });
    const root = (be as unknown as { store: { root: string } }).store.root;
    const MB = 1024 * 1024;
    const body = (n: number) => JSON.stringify({ data: 'x'.repeat(n * MB) });
    const req = (n: number) => ({ method: 'POST', url, headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }], params: [], body: { type: 'json', content: body(n) } });
    const out: Record<string, unknown> = {};
    // the longest gap between 10 ms ticks while the call runs = how long the window would freeze
    const measure = async (label: string, f: () => unknown) => {
      let last = performance.now();
      let worst = 0;
      const iv = setInterval(() => {
        const now = performance.now();
        worst = Math.max(worst, now - last);
        last = now;
      }, 10);
      const t0 = performance.now();
      let err: string | undefined;
      try {
        await f();
      } catch (e) {
        err = String((e as Error).message).slice(0, 120);
      }
      const now = performance.now();
      worst = Math.max(worst, now - last);
      clearInterval(iv);
      out[label] = { totalMs: Math.round(now - t0), longestBlockMs: Math.round(worst), err };
    };
    const h = be.handlers;
    for (const n of [1, 10]) {
      await measure(`http.send ${n}MB body`, () => h['http.send']!({ request: req(n) }));
      await measure(`http.code ${n}MB body`, () => h['http.code']!({ request: req(n), language: 'curl' }));
      await measure(`http.curl ${n}MB body`, () => h['http.curl']!({ request: req(n) }));
      await measure(`col.save ${n}MB body`, () => h['col.save']!({ schemaVersion: '1.0', id: `big${n}`, name: 'Big', version: 0, variables: [], updatedAt: '', items: [{ kind: 'http', id: 'r', name: 'r', request: req(n) }] }));
      await measure(`col.tree after ${n}MB`, () => h['col.tree']!({}));
      await measure(`ws.search after ${n}MB`, () => h['ws.search']!({ query: 'zzz' }));
      await measure(`env.save ${n}MB value`, () => h['env.save']!({ env: { id: `e${n}`, name: `E${n}`, variables: [{ key: 'v', value: 'y'.repeat(n * MB), enabled: true }] } }));
      await measure(`http.send with ${n}MB env`, () => h['http.send']!({ request: { method: 'GET', url, headers: [], params: [] }, environment: `E${n}` }));
      writeFileSync(join(root, 'tests', `big${n}.yaml`), `name: big\ntests:\n${Array.from({ length: n * 5000 }, (_, i) => `  - id: t${i}\n    type: http\n    request: { method: GET, url: "${url}" }\n`).join('')}`);
      await measure(`tests.preview ${n}x5000 tests`, () => h['tests.preview']!({ path: `big${n}.yaml` }));
      await measure(`tests.tree with ${n}x5000 tests`, () => h['tests.tree']!({}));
    }
    await be.dispose();
    server.close();
    writeFileSync(OUT, JSON.stringify(out, null, 1));
    console.log(out);
    expect(Object.keys(out).length).toBeGreaterThan(5);
  });
});
