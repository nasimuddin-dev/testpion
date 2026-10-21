/**
 * Cookies carried between the turns of a conversation (a RAG target with `conversation: { mode: 'server-session', cookies:
 * true }`): the session lives in a cookie the first answer sets, the next turn sends it back, an expired cookie is dropped,
 * two conversations never share one, and a target without the option sends none (as before). A local server; no key, no model.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConversationCookies, MemorySecretStore, WorkspaceStore, createEngineContext, defaultSettings, evaluationTests, parseSetCookie, runTests, targetProblems, withCookieHeader, type RagTarget, type SavedEvaluation, type TestResult } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';

const t = tempDir('tp-rag-cookies-');
let server: Server;
let base = '';
let store: WorkspaceStore;
const seen: Array<{ conversation: string; cookie: string }> = [];
let sessions = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as { message?: string }) : {};
      const cookie = String(req.headers.cookie ?? '');
      const sid = /(?:^|;\s*)sid=([^;]+)/.exec(cookie)?.[1];
      seen.push({ conversation: body.message ?? '', cookie });
      res.setHeader('content-type', 'application/json');
      if (!sid) {
        const id = `s${++sessions}`;
        res.setHeader('set-cookie', [`sid=${id}; Path=/; HttpOnly`, 'theme=dark; Path=/']);
        res.end(JSON.stringify({ answer: `Hello, a new session ${id}` }));
      } else {
        // the second answer ends the theme cookie
        if (/theme=dark/.test(cookie)) res.setHeader('set-cookie', ['theme=; Max-Age=0; Path=/']);
        res.end(JSON.stringify({ answer: `Welcome back to ${sid}` }));
      }
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  store = WorkspaceStore.create(join(t.dir, 'ws'), 'RAG cookies');
});
afterAll(async () => {
  server.close();
  store.close();
  t.cleanup();
});

const target = (cookies: boolean): RagTarget => ({
  protocol: 'http',
  step: { type: 'http', method: 'POST', url: `${base}/chat`, json: { message: '{{question}}' } },
  mapping: { answer: '$.answer', ...(cookies ? {} : { conversationId: '$.cid' }) },
  conversation: { mode: 'server-session', ...(cookies ? { cookies: true } : {}) },
});

async function run(tgt: RagTarget, turnsOf: string[][], concurrency = 2): Promise<TestResult[]> {
  store.saveLibrary('rag-targets', { folders: [], items: [{ id: 'cookie-rag', name: 'Cookie RAG', data: tgt }] });
  const d: SavedEvaluation = {
    name: 'Cookies',
    type: 'rag',
    provider: '',
    model: '',
    prompt: '',
    format: 'text',
    datasetFormat: 'jsonl',
    dataset: turnsOf.map((turns, i) => JSON.stringify({ id: `c${i + 1}`, turns, reference: 'x' })).join('\n'),
    expectedField: 'expected',
    evaluators: [{ type: 'answer-length', max: 100 }],
    concurrency,
    retries: 0,
    target: 'cookie-rag',
  };
  const ctx = createEngineContext({ store, secrets: new MemorySecretStore(), settings: defaultSettings(), aiSurface: 'cli' });
  const results: TestResult[] = [];
  try {
    await runTests({ name: d.name, tests: evaluationTests(d, { store }), services: ctx.services, concurrency: d.concurrency, onEvent: (e) => e.type === 'test-end' && results.push(e.result) });
  } finally {
    await ctx.dispose();
  }
  return results.sort((a, b) => a.id.localeCompare(b.id));
}

describe('a server-session target that keeps its session in a cookie', () => {
  it('without the option the run’s shared cookie jar does what it always did: its cookies reach every later call', async () => {
    seen.length = 0;
    sessions = 0;
    const [r] = await run(target(false), [['one', 'two']]);
    expect(seen.map((s) => s.cookie)).toEqual(['', 'sid=s1; theme=dark']);
    expect(r!.metadata?.rag).toBeDefined();
    // ... including another conversation's, which is what the option is for
    seen.length = 0;
    await run(target(false), [['alpha one', 'alpha two'], ['beta one']], 1);
    expect(seen.find((s) => s.conversation === 'beta one')!.cookie).not.toBe('');
  });

  it('with it the next turn carries the cookies of the last answer, an expired one is dropped, and conversations stay apart', async () => {
    seen.length = 0;
    sessions = 0;
    // one at a time: the second conversation starts after the first set its cookies, and still gets none of them
    const results = await run(target(true), [['alpha one', 'alpha two', 'alpha three'], ['beta one', 'beta two']], 1);
    const by = (prefix: string) => seen.filter((s) => s.conversation.startsWith(prefix)).map((s) => s.cookie);
    // the first turn of each conversation carries nothing; the later ones carry only their own session
    expect(by('alpha')[0]).toBe('');
    expect(by('beta')[0]).toBe('');
    const alpha = by('alpha');
    const beta = by('beta');
    expect(alpha[1]).toMatch(/^sid=s\d; theme=dark$/);
    expect(alpha[2]).toMatch(/^sid=s\d$/);
    expect(beta[1]).toMatch(/^sid=s\d; theme=dark$/);
    expect(alpha[1]!.split(';')[0]).not.toBe(beta[1]!.split(';')[0]);
    // the answer of the last turn is the sample; the cookie is nowhere in the stored result
    const stored = JSON.stringify(results);
    expect(stored).not.toMatch(/sid=s\d/);
    expect(results.map((r) => r.status)).toEqual(['passed', 'passed']);
  });

  it('a session cookie target does not need a conversation id mapping', () => {
    expect(targetProblems(target(true))).toEqual([]);
    expect(targetProblems({ ...target(false), mapping: { answer: '$.answer' } }).join(' ')).toMatch(/needs the conversation id/);
  });
});

describe('the cookie jar of a conversation', () => {
  it('reads Set-Cookie lines, forgets expired and emptied cookies, and writes one Cookie header', () => {
    expect(parseSetCookie('sid=abc; Path=/; HttpOnly')).toEqual({ name: 'sid', value: 'abc' });
    expect(parseSetCookie('sid=; Path=/')).toEqual({ name: 'sid' });
    expect(parseSetCookie('sid=abc; Max-Age=0')).toEqual({ name: 'sid' });
    expect(parseSetCookie('sid=abc; Expires=Thu, 01 Jan 1970 00:00:00 GMT')).toEqual({ name: 'sid' });
    expect(parseSetCookie('sid=abc; Expires=Fri, 01 Jan 2100 00:00:00 GMT')).toEqual({ name: 'sid', value: 'abc' });
    expect(parseSetCookie('no-equals')).toBeUndefined();
    expect(parseSetCookie('bad name=1')).toBeUndefined();
    const jar = new ConversationCookies();
    jar.take([['Set-Cookie', 'a=1; Path=/'], ['content-type', 'x'], ['set-cookie', 'b=2']]);
    jar.take([['set-cookie', 'a=3'], ['set-cookie', 'b=; Max-Age=0']]);
    expect(jar.header()).toBe('a=3');
    expect(jar.size).toBe(1);
    expect(jar.values()).toEqual(['3']);
  });

  it('adds to a Cookie header the target writes itself, in either shape of headers', () => {
    expect(withCookieHeader({ Accept: 'x' }, 'sid=1')).toEqual({ Accept: 'x', Cookie: 'sid=1' });
    expect(withCookieHeader({ cookie: 'theme=dark' }, 'sid=1')).toEqual({ cookie: 'theme=dark; sid=1' });
    expect(withCookieHeader([{ key: 'Accept', value: 'x' }], 'sid=1')).toEqual([{ key: 'Accept', value: 'x' }, { key: 'Cookie', value: 'sid=1' }]);
    expect(withCookieHeader(undefined, 'sid=1')).toEqual({ Cookie: 'sid=1' });
    expect(withCookieHeader({ A: 'b' }, '')).toEqual({ A: 'b' });
  });
});
