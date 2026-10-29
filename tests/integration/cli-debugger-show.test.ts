import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCliSync, tempDir } from '../helpers.js';

// `testpion debugger show <har> <id|#n> --view …`: the terminal twin of the Debugger's content views and of the MCP `debugger_exchange` view option.
let tmp: ReturnType<typeof tempDir>;
const run = (args: string[]) => runCliSync(args, { cwd: tmp.dir, home: join(tmp.dir, 'home'), env: { CI: '1' }, timeout: 60_000 });
const json = (r: { out: string }) => (JSON.parse(r.out) as { data: Record<string, any> }).data;
let file = '';

beforeAll(() => {
  tmp = tempDir('tp-cli-debug-show-');
  file = join(tmp.dir, 's.har');
  const entry = (id: string, method: string, url: string, reqType: string | undefined, reqBody: string | undefined, resType: string, resBody: string, headers: Record<string, string> = {}) => ({
    startedDateTime: '2026-10-28T10:00:00Z',
    time: 1,
    request: { method, url, headers: reqType ? [{ name: 'content-type', value: reqType }] : [], ...(reqBody ? { postData: { mimeType: reqType, text: reqBody } } : {}) },
    response: { status: 200, headers: [{ name: 'content-type', value: resType }, ...Object.entries(headers).map(([name, value]) => ({ name, value }))], content: { size: resBody.length, mimeType: resType, text: resBody } },
    _testpion: { id },
  });
  writeFileSync(
    file,
    JSON.stringify({
      log: {
        version: '1.2',
        entries: [
          entry('x', 'GET', 'http://api.test/o.xml', undefined, undefined, 'application/xml', '<a id="1"><b>hi</b></a>'),
          entry('m', 'GET', 'http://api.test/mp', undefined, undefined, 'application/x-msgpack', '81a16101'),
          entry('g', 'POST', 'http://api.test/graphql', 'application/json', JSON.stringify({ query: 'mutation Save { save { id } }' }), 'application/json', '{"errors":[{"message":"nope"}]}'),
          entry('a', 'POST', 'https://api.openai.com/v1/chat/completions', 'application/json', JSON.stringify({ model: 'gpt-4o', stream: true, messages: [{ role: 'user', content: 'key sk-abcdefghijklmnopqrstuvwx please' }] }), 'text/event-stream', 'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\ndata: [DONE]\n\n'),
          entry('c', 'GET', 'http://api.test/c', undefined, undefined, 'application/json', '{}', { 'cache-control': 'no-store' }),
        ],
      },
    }),
  );
});
afterAll(() => tmp.cleanup());

describe('debugger show', () => {
  it('lists the views that fit, by id or place', () => {
    const r = run(['debugger', 'show', file, 'x', '--json']);
    expect(r.status, r.err).toBe(0);
    expect(json(r)).toMatchObject({ id: 'x', view: 'list', ok: true, data: { views: ['xml'] } });
    expect(json(run(['debugger', 'show', file, '#2', '--json'])).data.views).toEqual(['msgpack']);
  });

  it('prints an XML tree, decodes MessagePack and reads a GraphQL call', () => {
    expect(run(['debugger', 'show', file, 'x', '--view', 'xml']).out).toContain('<b> hi');
    expect(json(run(['debugger', 'show', file, 'm', '--view', 'msgpack', '--json'])).data).toMatchObject({ value: { a: 1 } });
    const g = json(run(['debugger', 'show', file, 'g', '--view', 'graphql', '--json']));
    expect(g).toMatchObject({ ok: true, data: { label: 'mutation Save', errors: [{ message: 'nope' }] } });
  });

  it('reads an LLM call: streamed answer put back together, tokens, cost, key masked', () => {
    const r = json(run(['debugger', 'show', file, 'a', '--view', 'ai', '--json']));
    expect(r).toMatchObject({ ok: true, data: { provider: 'openai', model: 'gpt-4o', stream: true, output: { text: 'Hello' }, usage: { inputTokens: 10, outputTokens: 2 } } });
    expect(r.data.cost.usd).toBeGreaterThan(0);
    expect(JSON.stringify(r)).not.toContain('abcdefghijkl');
    expect(run(['debugger', 'show', file, 'a', '--view', 'ai']).out).toContain('Answer');
    expect(json(run(['debugger', 'show', file, 'x', '--view', 'ai', '--json']))).toMatchObject({ ok: false });
  });

  it('says in words whether a response is cached', () => {
    expect(json(run(['debugger', 'show', file, 'c', '--view', 'caching', '--json']))).toMatchObject({ ok: true, data: { verdict: 'not-cacheable' } });
  });

  it('a view that cannot be made says why: ok false with --json, exit 2 without; unknown views and entries are refused', () => {
    expect(json(run(['debugger', 'show', file, 'x', '--view', 'msgpack', '--json']))).toMatchObject({ ok: false, error: expect.stringMatching(/does not look like MessagePack/) });
    expect(run(['debugger', 'show', file, 'c', '--view', 'tls']).status).toBe(2);
    expect(run(['debugger', 'show', file, 'x', '--view', 'bogus']).status).toBe(2);
    expect(run(['debugger', 'show', file, 'nope', '--view', 'xml']).status).toBe(2);
    expect(readFileSync(file, 'utf8')).toContain('o.xml');
  });
});
