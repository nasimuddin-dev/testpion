import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Redactor } from '../../packages/core/src/util/redact.js';
import { exchangesToHar, harPieces, strictHarRedactor } from '../../packages/core/src/debugger/har.js';
import { writeHarFile } from '../../packages/core/src/debugger/har-file.js';
import type { DebuggerExchange } from '../../packages/core/src/debugger/proxy.js';
import { expectWithin } from '../perf-budget.js';
import { tempDir } from '../helpers.js';

// Stop / Save / AutoSave / quit write the session as a stream: a session of 2,000 exchanges of 100 KB is never one block on the main thread.
const tmp = tempDir('tp-save-stream-');
afterAll(() => tmp.cleanup());

const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

function exchange(i: number, body: string): DebuggerExchange {
  return {
    id: `dbg-${i}`,
    startedAt: new Date(Date.UTC(2026, 9, 1, 10, 0, 0) + i).toISOString(),
    kind: 'http',
    method: 'GET',
    url: `https://api.test/items/${i}?access_token=abc${i}xyz`,
    host: 'api.test',
    clientPort: 1000 + i,
    requestHeaders: { authorization: `Bearer ${JWT}`, cookie: 'sid=secret', 'x-trace': `t-${i}` },
    requestBodyBytes: 0,
    status: 200,
    statusText: 'OK',
    responseHeaders: { 'set-cookie': 'sid=secret; HttpOnly', 'content-type': 'application/json', 'x-note': `token ${JWT}` },
    responseBody: body,
    responseBodyBytes: body.length,
    contentType: 'application/json',
    durationMs: 5,
  } as DebuggerExchange;
}

/** The longest stretch the event loop did not turn while `work` ran (a setImmediate heartbeat). */
async function longestBlock(work: () => Promise<void>): Promise<number> {
  let last = performance.now();
  let worst = 0;
  let running = true;
  const beat = () => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
    if (running) setImmediate(beat);
  };
  setImmediate(beat);
  await work();
  running = false;
  await new Promise((r) => setImmediate(r));
  return worst;
}

describe('the session written as a stream', () => {
  it('the pieces joined are the document exchangesToHar gives', async () => {
    const items = Array.from({ length: 25 }, (_, i) => exchange(i, `{"n":${i}}`));
    const red = new Redactor();
    let text = '';
    for await (const piece of harPieces(items, red, '9', { pieceBytes: 500 })) text += piece;
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(exchangesToHar(items, red, '9'))));
    expect(text.startsWith('{"log":{"version":"1.2"')).toBe(true);
    // an empty session is a valid document too
    let empty = '';
    for await (const piece of harPieces([], red)) empty += piece;
    expect(JSON.parse(empty).log.entries).toEqual([]);
  });

  it('the stricter redactor masks tokens by shape as well as by name', () => {
    const red = strictHarRedactor(new Redactor([])); // a user list that masks nothing by name
    const har = exchangesToHar([exchange(1, `{"jwt":"${JWT}","access_token":"abcdefghijklmnop123","k":"Authorization: Bearer abcdefghijklmnopqrstuvwxyz"}`)], red);
    const text = JSON.stringify(har);
    expect(text).not.toContain(JWT);
    expect(text).not.toContain('sid=secret');
    expect(text).not.toContain('abcdefghijklmnop123');
    expect(text).not.toContain('abc1xyz');
    const entry = har.log.entries[0]!;
    expect(entry.request.headers.find((h) => h.name === 'authorization')!.value).toBe('***');
    expect(entry.response.headers.find((h) => h.name === 'set-cookie')!.value).toBe('***');
    expect(entry.request.headers.find((h) => h.name === 'x-trace')!.value).toBe('t-1');
  });

  it('2,000 exchanges of 100 KB: written atomically, no stretch of 50 ms without the event loop, no temporary file left', async () => {
    const body = JSON.stringify({ rows: 'x'.repeat(100 * 1024 - 20) });
    const items = Array.from({ length: 2000 }, (_, i) => exchange(i, body));
    const file = join(tmp.dir, 'session.har');
    let ms = 0;
    const worst = await longestBlock(async () => {
      const t0 = performance.now();
      await writeHarFile(file, items, strictHarRedactor(new Redactor()), '1');
      ms = performance.now() - t0;
    });
    console.log(`2000 x 100 KB written in ${ms.toFixed(0)} ms`);
    expectWithin(worst, 50, 'longest block while writing a 200 MB session');
    expect(statSync(file).size).toBeGreaterThan(190 * 1024 * 1024);
    expect(readdirSync(tmp.dir).filter((f) => f.includes('.tmp'))).toEqual([]);
    // the document is whole: the head and the tail (parsing 200 MB here would be the test's own block)
    const fd = readFileSync(file).subarray(-40).toString('utf8');
    expect(fd.endsWith(']}}')).toBe(true);
  }, 120_000);

  it('a failing producer leaves the previous file and no temporary file', async () => {
    const file = join(tmp.dir, 'keep.har');
    await writeHarFile(file, [exchange(1, '{}')], new Redactor());
    const before = readFileSync(file, 'utf8');
    const boom = { ...exchange(2, '{}'), get requestHeaders(): never { throw new Error('boom'); } } as unknown as DebuggerExchange;
    await expect(writeHarFile(file, [exchange(3, '{}'), boom], new Redactor())).rejects.toThrow('boom');
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(existsSync(file)).toBe(true);
    expect(readdirSync(tmp.dir).filter((f) => f.startsWith('keep.har.tmp'))).toEqual([]);
  });
});
