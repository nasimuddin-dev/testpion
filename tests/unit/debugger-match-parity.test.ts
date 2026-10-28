/**
 * One matcher for chips and rules: the window's quick filters (@testpion/shared) and the engine's `ruleMatches` give the same
 * answer for the same rule and exchange, and the chips combine the way the engine's capture-only / filter-out rules do.
 */
import { describe, expect, it } from 'vitest';
import { matchesSpec, passesChips, patternRegExp, type DebuggerMatchRow, type DebuggerMatchSpec } from '../../packages/shared/src/debugger-match';
import { decideRequest, ruleMatches, type DebuggerRule } from '../../packages/core/src/debugger/rules';
import type { DebuggerExchange } from '../../packages/core/src/debugger/proxy';

const ex = (o: Partial<DebuggerMatchRow> = {}): DebuggerMatchRow => ({ host: 'api.example.com:443', url: 'https://api.example.com/orders/42?x=1', method: 'GET', application: 'chrome', serverAddress: '10.0.0.7:443', ...o });
const rule = (match: DebuggerMatchSpec, kind: DebuggerRule['kind'] = 'ignore'): DebuggerRule => ({ id: 'r', name: 'r', enabled: true, kind, match: match as DebuggerRule['match'] });
const engine = (match: DebuggerMatchSpec, row: DebuggerMatchRow) => ruleMatches(rule(match), { responseBodyBytes: 0, requestBodyBytes: 0, ...row } as unknown as DebuggerExchange, 'response');

const CASES: Array<[string, DebuggerMatchSpec, Partial<DebuggerMatchRow>]> = [
  ['everything', {}, {}],
  ['host with the port', { host: 'api.example.com:443' }, {}],
  ['host without the port', { host: 'api.example.com' }, {}],
  ['host glob', { host: '*.example.com' }, {}],
  ['host glob is case-insensitive', { host: 'API.Example.COM' }, {}],
  ['host that is not it', { host: 'other.example.com' }, {}],
  ['host with another port', { host: 'api.example.com:8443' }, {}],
  ['host with a port glob', { host: 'api.example.com:*' }, {}],
  ['url start glob', { url: 'https://api.example.com/orders/*' }, {}],
  ['url start that is not it', { url: 'https://api.example.com/users/*' }, {}],
  ['url glob with ?', { url: 'https://api.example.com/orders/4?*' }, {}],
  ['url regular expression', { url: '/orders\\/\\d+/' }, {}],
  ['url regular expression that is not it', { url: '/users\\/\\d+/' }, {}],
  ['one method', { method: 'GET' }, {}],
  ['method lower case', { method: 'get' }, {}],
  ['method list', { method: 'GET, POST' }, {}],
  ['method list with spaces', { method: 'POST PUT' }, {}],
  ['method that is not it', { method: 'DELETE' }, {}],
  ['application glob', { application: 'chr*' }, {}],
  ['application exact, other case', { application: 'CHROME' }, {}],
  ['application that is not it', { application: 'firefox' }, {}],
  ['application on a row without one', { application: 'chrome' }, { application: undefined }],
  ['ip equals', { where: { column: 'ip', op: 'equals', value: '10.0.0.7:443' } }, {}],
  ['ip equals, other address', { where: { column: 'ip', op: 'equals', value: '10.0.0.8:443' } }, {}],
  ['ip not equals', { where: { column: 'ip', op: 'not-equals', value: '10.0.0.8:443' } }, {}],
  ['ip contains', { where: { column: 'ip', op: 'contains', value: '10.0.0' } }, {}],
  ['ip starts with', { where: { column: 'ip', op: 'starts-with', value: '10.' } }, {}],
  ['ip ends with', { where: { column: 'ip', op: 'ends-with', value: ':80' } }, {}],
  ['ip on a row without one', { where: { column: 'ip', op: 'equals', value: '10.0.0.7:443' } }, { serverAddress: undefined }],
  ['host, method and url together', { host: 'api.example.com', method: 'GET,POST', url: '*orders*' }, {}],
  ['host and method, the method fails', { host: 'api.example.com', method: 'PUT' }, {}],
  ['another row: a tunnel', { host: 'api.example.com:443', method: 'CONNECT' }, { method: 'CONNECT', url: 'https://api.example.com:443' }],
  ['a host with regex characters', { host: 'a.b+c.test' }, { host: 'a.b+c.test:80' }],
];

describe('the window and the engine match alike', () => {
  for (const [name, match, row] of CASES)
    it(name, () => {
      const r = ex(row);
      expect(matchesSpec(match, r)).toBe(engine(match, r));
    });
});

describe('the compiled globs are cached in a bounded LRU', () => {
  it('returns the same RegExp for the same pattern and never grows without bound', () => {
    expect(patternRegExp('*.example.com')).toBe(patternRegExp('*.example.com'));
    for (let i = 0; i < 500; i++) patternRegExp(`host-${i}.test`);
    // a pattern used a moment ago is still compiled, one from long ago is simply compiled again
    const hot = patternRegExp('host-499.test');
    expect(patternRegExp('host-499.test')).toBe(hot);
    expect(patternRegExp('host-0.test')!.test('HOST-0.TEST')).toBe(true);
  });

  it('refuses a nested repetition and ignores a regular expression that is not valid', () => {
    expect(patternRegExp('/(a+)+$/')!.test('aaaaaaaaaaaaaaaaaaaaaaaaaaaa!')).toBe(false);
    expect(patternRegExp('/(unclosed/')).toBeUndefined();
  });
});

describe('chips combine like the engine', () => {
  const rows = [ex({ host: 'a.com' }), ex({ host: 'b.com' }), ex({ host: 'c.com' })];
  const only = (host: string) => ({ keep: true, match: { host } });
  const out = (host: string) => ({ keep: false, match: { host } });
  const kept = (chips: Array<{ keep: boolean; match: DebuggerMatchSpec }>) => rows.filter((r) => passesChips(r, chips)).map((r) => r.host);

  it('two Capture only chips keep the union, not the intersection', () => {
    expect(kept([only('a.com'), only('b.com')])).toEqual(['a.com', 'b.com']);
  });

  it('a Filter out chip hides what it matches, whatever the other chips say', () => {
    expect(kept([out('b.com')])).toEqual(['a.com', 'c.com']);
    expect(kept([only('a.com'), only('b.com'), out('b.com')])).toEqual(['a.com']);
    expect(kept([out('a.com'), out('c.com')])).toEqual(['b.com']);
  });

  it('no chips keep everything', () => {
    expect(kept([])).toEqual(['a.com', 'b.com', 'c.com']);
  });

  it('agrees with decideRequest for the same rules', () => {
    const cases: Array<Array<{ keep: boolean; host: string }>> = [
      [{ keep: true, host: 'a.com' }, { keep: true, host: 'b.com' }],
      [{ keep: true, host: 'a.com' }, { keep: false, host: 'a.com' }],
      [{ keep: false, host: 'b.com' }],
      [{ keep: true, host: '*.com' }, { keep: false, host: 'c.com' }],
    ];
    for (const chips of cases) {
      const rules = chips.map((c, i) => ({ ...rule({ host: c.host }, c.keep ? 'only' : 'ignore'), id: `r${i}` }));
      for (const r of rows) {
        const listed = !decideRequest(rules, { ...r, responseBodyBytes: 0, requestBodyBytes: 0 } as unknown as DebuggerExchange).ignore;
        expect(passesChips(r, chips.map((c) => ({ keep: c.keep, match: { host: c.host } }))), `${JSON.stringify(chips)} on ${r.host}`).toBe(listed);
      }
    }
  });
});
