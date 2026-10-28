import { describe, expect, it } from 'vitest';
import { patternToRegExp, ruleMatches, type DebuggerExchange, type DebuggerRule } from '@testpion/core';
import { compileUserRegex, plainLimit, safeTest } from '../../packages/core/src/util/safe-regex.js';
import { expectWithin } from '../perf-budget';

/**
 * The Debugger checks every rule on every request, and again on the response (performance review 2026-10-27, item 6): a
 * glob is compiled once, and a watched expression only pays its deadline on a text where it could blow up.
 */
const ex = (i: number): DebuggerExchange => ({
  id: `x${i}`,
  startedAt: new Date().toISOString(),
  kind: 'http',
  method: 'GET',
  url: `https://api-${i % 40}.example.test/v1/items/${i}?page=${i % 7}`,
  host: `api-${i % 40}.example.test`,
  clientPort: 1,
  application: 'curl',
  requestHeaders: {},
  requestBodyBytes: 0,
  responseBodyBytes: 0,
});
const rule = (i: number, match: DebuggerRule['match']): DebuggerRule => ({ id: `r${i}`, name: `rule ${i}`, kind: 'highlight', enabled: true, match }) as DebuggerRule;

describe('rule patterns compiled once', () => {
  it('5,000 exchanges against 10 glob rules compile each glob once and take well under 20 ms of matching', () => {
    const rules = Array.from({ length: 10 }, (_, i) => rule(i, { host: `*nomatch-${i}.test`, url: `https://x-${i}.test/*`, application: `app-${i}*` }));
    const rows = Array.from({ length: 5000 }, (_, i) => ex(i));
    // a warm-up pass compiles the globs
    for (const r of rules) ruleMatches(r, rows[0]!, 'request');
    const t0 = performance.now();
    let hits = 0;
    for (const e of rows) for (const r of rules) if (ruleMatches(r, e, 'request')) hits++;
    const ms = performance.now() - t0;
    expect(hits).toBe(0);
    console.log(`50,000 ruleMatches over 10 glob rules: ${ms.toFixed(1)} ms`);
    expectWithin(ms / 10, 20, '5,000 ruleMatches x 10 glob rules (per 5,000 rows of the 50,000 checks, scaled)');
  });

  it('the same pattern returns the same compiled expression, a different one another', () => {
    expect(patternToRegExp('*.example.test')).toBe(patternToRegExp('*.example.test'));
    expect(patternToRegExp('*.example.test')).not.toBe(patternToRegExp('*.other.test'));
    expect(patternToRegExp('*.example.test')!.test('API.Example.test')).toBe(true);
    expect(patternToRegExp('  *.example.test ')!.test('a.example.test')).toBe(true);
    expect(patternToRegExp('   ')).toBeUndefined();
    expect(patternToRegExp('/(a+)+$/')!.test('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab')).toBe(false); // refused shape: never matches
    expect(patternToRegExp('/(/')).toBeUndefined(); // not valid: ignored
  });
});

describe('a watched expression pays its deadline only where it can blow up', () => {
  const url = 'https://one.example.test/v1/items/123?page=3';
  const watched = '.*\/api.*\/v1\/.*\/.*';

  it('a short URL runs directly: 5,000 tests of a watched rule in a few ms; the answer is the same', () => {
    const re = compileUserRegex(watched, 'i');
    expect(plainLimit(4, false)).toBeGreaterThan(url.length);
    expect(safeTest(re, url).matched).toBe(false); // "/api" is not in the path of this URL
    expect(safeTest(re, 'https://h.test/x/api/y/v1/z/w').matched).toBe(true);
    const t0 = performance.now();
    for (let i = 0; i < 5000; i++) safeTest(re, url);
    const ms = performance.now() - t0;
    console.log(`5,000 safeTest of a watched rule on a ${url.length}-char URL: ${ms.toFixed(1)} ms`);
    expectWithin(ms, 50, '5,000 tests of a watched expression on a short URL');
  });

  it('a long text still runs under the deadline and is cut off', () => {
    const re = compileUserRegex('.*a.*a.*a.*a.*a.*a.*b', '');
    const text = 'a'.repeat(4000);
    expect(text.length).toBeGreaterThan(plainLimit(6, false));
    const t0 = Date.now();
    const r = safeTest(re, text, 50);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r).toEqual({ matched: false, timedOut: true });
  });

  it('a repeated group with a repetition inside, a counted quantifier or a back-reference always gets the deadline', () => {
    expect(plainLimit(1, true)).toBe(0);
    const bounded = compileUserRegex('(?:a*b?){1,5}c.*d.*e.*f', '');
    const t0 = Date.now();
    expect(safeTest(bounded, 'a'.repeat(40) + 'x', 50).matched).toBe(false);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('the limit shrinks as repetitions are added, and a plain shape has none', () => {
    expect(plainLimit(4, false)).toBeGreaterThan(plainLimit(6, false));
    expect(plainLimit(6, false)).toBeGreaterThan(plainLimit(10, false));
    expect(plainLimit(4, false)).toBeGreaterThanOrEqual(80);
    expect(plainLimit(0, false)).toBe(0);
  });
});
