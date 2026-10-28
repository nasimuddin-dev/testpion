/** The Debugger's inspector tabs: query and form parameters, cookies, and the advice for an error. */
import { describe, expect, it } from 'vitest';
import { adviceFor, cookiesOf, paramsOf } from '../../apps/desktop/src/components/debugger/ExchangeExtras';

const ex = (o: Record<string, unknown>) => ({ url: 'https://api.example.com/items', method: 'GET', requestHeaders: {}, requestBodyBytes: 0, responseBodyBytes: 0, ...o }) as never;

describe('paramsOf', () => {
  it('decodes the query string and a form body', () => {
    const p = paramsOf(ex({ url: 'https://x/a?q=hello+world&tag=a%26b&flag', requestHeaders: { 'Content-Type': 'application/x-www-form-urlencoded' }, requestBody: 'user=ann&pw=a%3Db' }));
    expect(p.query).toEqual([['q', 'hello world'], ['tag', 'a&b'], ['flag', '']]);
    expect(p.form).toEqual([['user', 'ann'], ['pw', 'a=b']]);
  });
  it('has nothing for a plain URL with a JSON body', () => {
    const p = paramsOf(ex({ requestHeaders: { 'content-type': 'application/json' }, requestBody: '{"a":1}' }));
    expect(p.query).toEqual([]);
    expect(p.form).toEqual([]);
  });
});

describe('cookiesOf', () => {
  it('splits the Cookie header and the Set-Cookie list without breaking an Expires date', () => {
    expect(cookiesOf(ex({ requestHeaders: { Cookie: 'a=1; b=2' } }), 'request')).toEqual([['a', '1'], ['b', '2']]);
    const set = cookiesOf(ex({ responseHeaders: { 'set-cookie': 'sid=abc; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT, theme=dark; Secure' } }), 'response');
    expect(set.map(([n]) => n)).toEqual(['sid', 'theme']);
    expect(set[0]![1]).toContain('Expires=Wed, 21 Oct 2026');
  });
});

describe('cookiesOf with masked headers', () => {
  it('takes the names from the exchange when the Cookie and Set-Cookie values are masked', () => {
    const e = ex({ requestHeaders: { cookie: '***' }, responseHeaders: { 'set-cookie': '***' }, auth: { scheme: 'none', cookies: ['sid', 'theme'], setCookies: ['sid'] } });
    expect(cookiesOf(e, 'request')).toEqual([['sid', '***'], ['theme', '***']]);
    expect(cookiesOf(e, 'response')).toEqual([['sid', '***']]);
  });
  it('does not split a value that holds a comma and a pair (prefs=a=1,b=2)', () => {
    expect(cookiesOf(ex({ responseHeaders: { 'set-cookie': 'prefs=a=1,b=2; Path=/' } }), 'response').map(([n]) => n)).toEqual(['prefs']);
  });
});

describe('adviceFor', () => {
  it('says what to do for a distrusted certificate, a refused connection and a 401', () => {
    expect(adviceFor(ex({ error: 'The program did not trust the TestPion root certificate (install it, or turn HTTPS decryption off for this host)' })).join(' ')).toContain('Keep this host encrypted');
    expect(adviceFor(ex({ error: 'connect ECONNREFUSED 127.0.0.1:3000' }))[0]).toContain('Nothing is listening');
    expect(adviceFor(ex({ status: 401 }))[0]).toContain('Auth tab');
    expect(adviceFor(ex({ status: 200 }))).toEqual([]);
  });
});
