import { describe, it, expect } from 'vitest';
import { exchangesFromHar, exchangesToHar, proxyShellLines, Redactor, type DebuggerExchange } from '@testpion/core';

// DBG-2: a session is a HAR file (every HTTP tool opens it) with TestPion's extras; it comes back whole, redacted.
const exchange = (over: Partial<DebuggerExchange> = {}): DebuggerExchange => ({
  id: 'dbg-1',
  startedAt: '2026-10-06T10:00:00.000Z',
  kind: 'http',
  method: 'POST',
  url: 'http://api.test/orders?token=s3cret',
  host: 'api.test',
  clientPort: 51000,
  application: 'node',
  requestHeaders: { 'content-type': 'application/json', authorization: 'Bearer abc.def.ghi' },
  requestBody: '{"a":1}',
  requestBodyBytes: 7,
  status: 201,
  statusText: 'Created',
  responseHeaders: { 'content-type': 'application/json' },
  responseBody: '{"id":9}',
  responseBodyBytes: 8,
  contentType: 'application/json',
  waitMs: 12,
  durationMs: 20,
  bookmarked: true,
  ...over,
});

describe('debugger sessions (HAR)', () => {
  it('round-trips an exchange through HAR with the program, the bookmark and the timings', () => {
    const har = exchangesToHar([exchange()], new Redactor(), '9.9');
    expect(har.log.creator).toEqual({ name: 'TestPion HTTP Debugger', version: '9.9' });
    const entry = har.log.entries[0]!;
    expect(entry.request.url).not.toContain('s3cret');
    expect(entry.request.headers.find((h) => h.name === 'authorization')?.value).toBe('***');
    expect(entry._testpion).toMatchObject({ id: 'dbg-1', application: 'node', bookmarked: true });
    const back = exchangesFromHar(JSON.parse(JSON.stringify(har)))[0]!;
    expect(back).toMatchObject({
      id: 'dbg-1',
      method: 'POST',
      host: 'api.test',
      application: 'node',
      status: 201,
      bookmarked: true,
      waitMs: 12,
      durationMs: 20,
      requestBody: '{"a":1}',
      responseBody: '{"id":9}',
    });
  });

  it("opens another tool's HAR (no extras) and ignores what is not an entry", () => {
    const har = {
      log: {
        entries: [
          {
            startedDateTime: '2026-01-01T00:00:00Z',
            time: 30,
            request: { method: 'GET', url: 'https://x.test/a', headers: [{ name: 'Accept', value: '*/*' }], bodySize: -1 },
            response: { status: 200, headers: [], content: { size: 5, mimeType: 'text/plain', text: 'hello' } },
            timings: { wait: 10, receive: 20 },
          },
          { nonsense: true },
        ],
      },
    };
    const list = exchangesFromHar(har);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      method: 'GET',
      host: 'x.test',
      status: 200,
      responseBody: 'hello',
      responseBodyBytes: 5,
      contentType: 'text/plain',
      waitMs: 10,
      durationMs: 30,
      requestHeaders: { accept: '*/*' },
    });
    expect(exchangesFromHar({ not: 'har' })).toEqual([]);
  });

  it('opens a HAR whose fields have the wrong types (a hand edit, another tool): what is usable, never a TypeError', () => {
    const har = {
      log: {
        entries: [
          null,
          'x',
          { request: { url: 5 } },
          {
            startedDateTime: 7,
            time: 'slow',
            comment: 42,
            request: { method: 3, url: 'https://x.test/b', headers: 'Accept: */*', postData: 'raw', bodySize: '9', httpVersion: null },
            response: { status: '200', headers: { a: 1 }, content: 'hello', bodySize: 4 },
            timings: [1, 2],
            _testpion: { id: 9, kind: 'nope', frames: 'x', events: { a: 1 }, rules: ['r', 2], tls: 'yes', clientPort: '1', highlightStyle: 'red', pid: 'p' },
          },
        ],
      },
    };
    const list = exchangesFromHar(har);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ method: 'GET', url: 'https://x.test/b', host: 'x.test', kind: 'http', requestHeaders: {}, responseHeaders: {}, requestBodyBytes: 0, responseBodyBytes: 4, clientPort: 0, rules: ['r'], durationMs: 0 });
    expect(list[0]!.id).toMatch(/^dbg-/);
    for (const k of ['frames', 'events', 'tls', 'status', 'pid', 'highlightStyle', 'application'] as const) expect(list[0]![k]).toBeUndefined();
    for (const bad of [null, 'x', 1, [], { log: null }, { log: { entries: 'x' } }]) expect(exchangesFromHar(bad)).toEqual([]);
  });

  it('gives the lines that make each shell send through the proxy', () => {
    const lines = proxyShellLines('http://127.0.0.1:8899');
    expect(lines.map((l) => l.shell)).toEqual(['bash / zsh', 'PowerShell', 'cmd', 'curl', 'Chrome / Edge']);
    expect(lines[0]!.lines).toContain('HTTPS_PROXY=http://127.0.0.1:8899');
    expect(lines[1]!.lines).toContain("$env:HTTP_PROXY = 'http://127.0.0.1:8899'");
  });
});
