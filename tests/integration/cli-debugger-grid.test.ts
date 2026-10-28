import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { runCli, runCliSync, tempDir } from '../helpers.js';

// `testpion debugger exchanges | replay | snippet | programs`: the terminal twins of the grid's Select matching, group by,
// header columns, Resend several times, Copy as code and the program picker. They read the HAR file they are given.
let tmp: ReturnType<typeof tempDir>;
let har: string;
let api: Server;
let port = 0;
let hits = 0;
const run = (args: string[]) => runCliSync(args, { cwd: tmp.dir, home: join(tmp.dir, 'home'), env: { CI: '1' }, timeout: 60_000 });
const json = (r: { out: string }) => (JSON.parse(r.out) as { data: Record<string, any> }).data;

const entry = (id: string, o: { url: string; status: number; method?: string; size?: number; resHeaders?: Array<{ name: string; value: string }>; reqHeaders?: Array<{ name: string; value: string }>; body?: string }) => ({
  startedDateTime: '2026-10-28T10:00:00Z',
  time: 12,
  request: { method: o.method ?? 'GET', url: o.url, headers: o.reqHeaders ?? [], ...(o.body ? { postData: { mimeType: 'application/json', text: o.body } } : {}) },
  response: { status: o.status, statusText: '', headers: o.resHeaders ?? [], content: { size: o.size ?? 0, mimeType: 'application/json' } },
  _testpion: { id },
});

beforeAll(async () => {
  tmp = tempDir('tp-cli-debug-grid-');
  api = createServer((_req, res) => {
    hits++;
    res.writeHead(200).end('ok');
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
  port = (api.address() as { port: number }).port;
  har = join(tmp.dir, 's.har');
  writeFileSync(
    har,
    JSON.stringify({
      log: {
        version: '1.2',
        entries: [
          entry('a', { url: 'http://api.test/items', status: 200, size: 100, resHeaders: [{ name: 'X-Request-Id', value: 'r1' }] }),
          entry('b', { url: 'http://cdn.example.com/big', status: 500, size: 5000, resHeaders: [{ name: 'X-Request-Id', value: 'r2' }] }),
          entry('c', { url: 'http://api.test/login', status: 404, method: 'POST', reqHeaders: [{ name: 'Authorization', value: 'Bearer top-secret-value' }, { name: 'Content-Type', value: 'application/json' }], body: '{"a":1}' }),
          entry('l', { url: `http://127.0.0.1:${port}/x`, status: 200 }),
        ],
      },
    }),
  );
});
afterAll(async () => {
  await new Promise((r) => api.close(r));
  tmp.cleanup();
});

describe('debugger exchanges', () => {
  it('selects with --where, adds header columns, and refuses a condition it cannot read', () => {
    const r = run(['debugger', 'exchanges', har, '--where', 'status>=400 and size>1kb', '--column', 'response:x-request-id', '--json']);
    expect(r.status, r.err).toBe(0);
    const d = json(r);
    expect(d).toMatchObject({ total: 4, matched: 1, where: 'status>=400 and size>1kb' });
    expect(d.exchanges[0]).toMatchObject({ id: 'b', status: 500, columns: { 'response:x-request-id': 'r2' } });
    expect(run(['debug', 'exchanges', har, '--where', 'nonsense=1', '--json']).status).toBe(2);
    expect(run(['debug', 'exchanges', har, '--column', 'x-request-id', '--json']).status).toBe(2);
  });

  it('groups by domain with counts and failures', () => {
    const d = json(run(['debugger', 'exchanges', har, '--group-by', 'domain', '--json']));
    const by = Object.fromEntries((d.groups as Array<{ group: string; count: number; failed: number }>).map((g) => [g.group, g]));
    expect(by['api.test']).toMatchObject({ count: 2, failed: 1 });
    expect(by['cdn.example.com']).toMatchObject({ count: 1, failed: 1 });
    expect(run(['debugger', 'exchanges', har, '--group-by', 'colour', '--json']).status).toBe(2);
  });
});

describe('debugger snippet', () => {
  it('writes an entry as PowerShell, fetch or HTTPie with the secret masked', () => {
    for (const [lang, needle] of [['powershell', 'Invoke-RestMethod'], ['fetch', 'await fetch('], ['httpie', 'http POST']] as const) {
      const r = run(['debugger', 'snippet', har, 'c', '--lang', lang, '--json']);
      expect(r.status, r.err).toBe(0);
      expect(json(r).text).toContain(needle);
      expect(r.out).not.toContain('top-secret-value');
    }
    expect(run(['debugger', 'snippet', har, 'zzz', '--json']).status).toBe(2);
    expect(run(['debugger', 'snippet', har, 'a', '--lang', 'cobol', '--json']).status).toBe(2);
  });
});

describe('debugger replay', () => {
  it('--dry-run says what would be sent and sends nothing', async () => {
    const before = hits;
    const r = run(['debugger', 'replay', har, 'l', '--times', '5', '--dry-run', '--json']);
    expect(r.status, r.err).toBe(0);
    expect(json(r)).toMatchObject({ dryRun: true, options: { count: 5 }, remote: [] });
    expect(hits).toBe(before);
  });

  it('sends N times to a local server, in parallel, and counts them', async () => {
    const before = hits;
    const r = await runCli(['debugger', 'replay', har, '#4', '--times', '6', '--concurrency', '3', '--json'], { cwd: tmp.dir, home: join(tmp.dir, 'home'), env: { CI: '1' } });
    expect(r.status, r.err).toBe(0);
    const d = (JSON.parse(r.out) as { data: Record<string, any> }).data;
    expect(d).toMatchObject({ sent: 6, failed: 0, statuses: { '200': 6 }, options: { count: 6, concurrency: 3 } });
    expect(hits - before).toBe(6);
  });

  it('refuses several sends to a host that is not on this computer without --yes, and caps at 200', () => {
    const r = run(['debugger', 'replay', har, 'b', '--times', '5', '--json']);
    expect(r.status).toBe(2);
    expect(r.err + r.out).toMatch(/not on this computer/);
    const capped = json(run(['debugger', 'replay', har, 'b', '--times', '5000', '--dry-run', '--json']));
    expect(capped.options.count).toBe(200);
    expect(run(['debugger', 'replay', har, 'nope', '--json']).status).toBe(2);
  });
});

describe('debugger programs', () => {
  it('lists programs by name with their connections as JSON', () => {
    const r = run(['debugger', 'programs', '--json']);
    expect(r.status, r.err).toBe(0);
    const d = json(r);
    expect(Array.isArray(d.programs)).toBe(true);
  });
});
