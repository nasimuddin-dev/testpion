import { describe, expect, it } from 'vitest';
import { runScript } from '../../packages/core/src/index.js';

const input = () => ({ request: { method: 'GET', url: 'http://x', headers: [] }, vars: {}, environment: {} }) as never;
const seen = async (expr: string) => (await runScript(`tp.environment.set('v', String(${expr}));`, input())).scopeSets.environment.v;

describe('script isolation across the shared runtime', () => {
  it('a global set by one script is invisible to the next', async () => {
    await runScript(`leaked = 1; globalThis.other = 2; var x = 3;`, input());
    expect(await seen(`typeof leaked + typeof other`)).toBe('undefinedundefined');
  });

  it('per-run objects (tests, logs, variables) start fresh', async () => {
    const a = await runScript(`tp.test('a', () => {}); console.log('first'); tp.variables.set('k', '1'); tests['legacy'] = true;`, input());
    expect(a.tests.map((t) => t.name)).toEqual(['a', 'legacy']);
    const b = await runScript(`tp.test('b', () => {});`, input());
    expect(b.tests.map((t) => t.name)).toEqual(['b']);
    expect(b.logs).toEqual([]);
    expect(b.vars.k).toBeUndefined();
  });

  it('changes to built-ins and libraries do not survive', async () => {
    await runScript(`Array.prototype.evil = 1; Object.prototype.polluted = true; JSON.parse = () => 42;`, input());
    expect(await seen(`[].evil + ':' + ({}).polluted + ':' + JSON.parse('7')`)).toBe('undefined:undefined:7');
    await runScript(`_.mixin({ shout: (s) => s.toUpperCase() }); _.get = () => 'hijacked';`, input());
    expect(await seen(`typeof _.shout + ':' + _.get({ a: 1 }, 'a')`)).toBe('undefined:1');
  });

  it('a throwing script does not poison the next', async () => {
    const bad = await runScript(`globalThis.half = 1; throw new Error('boom');`, input());
    expect(bad.error).toMatch(/boom/);
    expect(await seen(`typeof half`)).toBe('undefined');
  });

  it('a timed-out script does not poison the next', async () => {
    const slow = await runScript(`globalThis.spin = 1; Promise.resolve().then(() => { globalThis.later = 1; }); while (true) {}`, input(), { timeoutMs: 100 });
    expect(slow.error).toMatch(/timed out/);
    expect(await seen(`typeof spin + typeof later`)).toBe('undefinedundefined');
    const ok = await runScript(`tp.test('fine', () => {});`, input());
    expect(ok.error).toBeUndefined();
    expect(ok.tests[0].passed).toBe(true);
  });

  it('a script that runs out of memory does not poison the next', async () => {
    const big = await runScript(`const a = []; for (;;) a.push(new Array(10000).fill('x'));`, input(), { memoryMb: 8 });
    expect(big.error).toBeTruthy();
    expect(await seen(`1 + 1`)).toBe('2');
  });
});
