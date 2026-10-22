import { describe, expect, it } from 'vitest';
import { VariableScope, replaceInCollection, ruleMatches, runChecks, type Collection, type DebuggerExchange, type DebuggerRule } from '../../packages/core/src/index.js';
import { analyzeRegex, compileUserRegex, safeReplace, safeTest, unsafeRegexReason } from '../../packages/core/src/util/safe-regex.js';

// a regex typed by a person (Debugger rules, regex checks, find and replace) must not freeze the app
const EVIL = ['^(a+)+$', '(a*)*b', '^(.*)*x', '(a|aa)+$', '^(\\w|\\d)+$', '(x+x+)+y'];
const FINE = ['^/api/v\\d+/users/\\d+$', '(\\d+\\.)+', '^(GET|POST)+$', 'foo.*bar', '[a-z]+@[a-z]+\\.com', '(?:ab)+c', '^\\s*$', 'a{1,3}b', '(?<year>\\d{4})-\\d{2}'];

describe('regex guard', () => {
  it('refuses the shapes that take minutes on a short text', () => {
    for (const p of EVIL) expect(unsafeRegexReason(p), p).toMatch(/minutes on a short text/);
    expect(unsafeRegexReason('a'.repeat(501))).toMatch(/longer than 500/);
  });

  it('lets everyday patterns through', () => {
    for (const p of FINE) expect(unsafeRegexReason(p), p).toBeUndefined();
    expect(() => compileUserRegex('(a+')).toThrow(/Not a valid regular expression/);
  });

  it('a shape that can be slow runs with a deadline; the common ones run directly', () => {
    expect(analyzeRegex('(\\d+\\.)+x').watch).toBe(true);
    expect(analyzeRegex('.*a.*b.*c.*d').watch).toBe(true);
    expect(analyzeRegex('^/api/v\\d+/').watch).toBe(false);
    // not recognised as exponential, so it runs under the deadline
    expect(analyzeRegex('((a+)b?)+c')).toEqual({ watch: true });
    const re = compileUserRegex('(\\d+\\.)+x', 'i');
    expect(safeTest(re, '1.2.3.x').matched).toBe(true);
    const t0 = Date.now();
    const slow = safeTest(compileUserRegex('(?:[a-z]+\\.)+[0-9]+[a-z]*[a-z]*[a-z]*[a-z]*!', ''), 'a.'.repeat(30) + '1' + 'a'.repeat(5000), 50);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(typeof slow.matched).toBe('boolean');
  });

  it('a Debugger rule with an evil pattern never matches and returns at once; a good one still matches', () => {
    const e = { id: 'e', host: 'api.test', url: `http://api.test/${'a'.repeat(30)}!`, method: 'GET', requestHeaders: {}, responseBodyBytes: 0 } as unknown as DebuggerExchange;
    const rule = (url: string) => ({ id: 'r', name: 'r', enabled: true, match: { url }, action: { type: 'ignore' } }) as unknown as DebuggerRule;
    const t0 = Date.now();
    expect(ruleMatches(rule('/^(a+)+$/'), e, 'request')).toBe(false);
    expect(Date.now() - t0).toBeLessThan(200);
    expect(ruleMatches(rule('/api\\.test\\/a+/'), e, 'request')).toBe(true);
    expect(ruleMatches(rule('*api.test*'), e, 'request')).toBe(true);
  });

  it('a regex check on a 100 KB body answers at once for an evil pattern, with a message', async () => {
    const body = 'a'.repeat(100_000) + '!';
    const t0 = Date.now();
    const out = await runChecks([{ type: 'regex', pattern: '^(a+)+$' }], { testType: 'http', body, text: body } as never);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(out[0]!.passed).toBe(false);
    expect(out[0]!.message).toMatch(/invalid regex.*refused/);
    const ok = await runChecks([{ type: 'regex', pattern: '^a+!$' }], { testType: 'http', body, text: body } as never);
    expect(ok[0]!.passed).toBe(true);
  });

  it('find and replace refuses an evil pattern and still replaces with a good one', () => {
    const c = { schemaVersion: '1.0', id: 'c', name: 'c', version: 1, updatedAt: '', variables: [], items: [{ kind: 'http', id: 'r', name: 'r', request: { method: 'GET', url: 'http://old.test/aaa' } }] } as Collection;
    expect(() => replaceInCollection(c, { find: '(a+)+$', replace: 'x', regex: true })).toThrow(/refused/);
    const r = replaceInCollection(c, { find: 'old\\.(\\w+)', replace: 'new.$1', regex: true });
    expect(JSON.stringify(r.collection)).toContain('http://new.test/aaa');
    expect(safeReplace(compileUserRegex('(\\d+\\.)+x', 'g'), '1.2.x', 'Z')).toBe('Z');
  });
});

describe('template expansion', () => {
  it('self-referential and mutually referential variables end with the cycle named, not a hang', () => {
    const v = new VariableScope();
    v.setScope('environment', { a: '{{b}}', b: '{{a}}', self: 'x{{self}}', deep: '{{deep}}{{deep}}' });
    const t0 = Date.now();
    expect(v.resolve('{{a}}')).toBeTypeOf('string');
    expect(v.resolve('{{self}}')).toBeTypeOf('string');
    expect(v.resolve('{{deep}}').length).toBeLessThan(1_000_000);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect([...v.cycles].length).toBeGreaterThan(0);
  });

  it('an expansion that doubles at every level stays bounded', () => {
    const v = new VariableScope();
    const vars: Record<string, string> = { v0: 'x' };
    for (let i = 1; i <= 40; i++) vars[`v${i}`] = `{{v${i - 1}}}{{v${i - 1}}}`;
    v.setScope('environment', vars);
    const t0 = Date.now();
    const out = v.resolve('{{v40}}');
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(out.length).toBeLessThanOrEqual(10_000_000);
  });
});
