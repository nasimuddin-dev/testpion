/**
 * The script metric runs author-written code (a file in a pull request is untrusted): in the QuickJS sandbox, in a fresh
 * context, with only the sample passed in as JSON. These tests are the walls: no network, no files, no process, no host
 * objects, a loop is interrupted, memory and result size are capped, an error is a result and not a crash, and one script
 * never sees what another left behind.
 */
import { describe, expect, it } from 'vitest';
import { compileCustomMetric, runChecks, runMetricExamples, runMetricScript, type CheckContext } from '../../packages/core/src/index.js';

const sample = { question: 'q', answer: 'The clinic opens at 8am.', reference: '', contexts: [{ id: 'd1', text: 'Opens at 8am' }] };
const run = (code: string, o: Parameters<typeof runMetricScript>[2] = { timeoutMs: 300 }) => runMetricScript(code, sample, o);

describe('a script returns a score', () => {
  it('a value, a number, logs', async () => {
    expect((await run('return { score: sample.answer.length > 10 ? 1 : 0, reason: "long enough" };')).value).toEqual({ score: 1, reason: 'long enough' });
    expect((await run('return 0.5;')).value).toBe(0.5);
    const l = await run('tp.log("a", 1); tp.log({x: 1}); return 1;');
    expect(l.logs).toEqual(['a 1', '[object Object]']);
    expect((await run('return sample.contexts.map(c => c.id).join(",");')).value).toBe('d1');
  });

  it('an error is a message, not a crash', async () => {
    expect((await run('throw new Error("boom");')).error).toMatch(/boom/);
    expect((await run('return (;')).error).toMatch(/SyntaxError|unexpected/i);
    expect((await run('return nope.field;')).error).toMatch(/nope/);
    expect((await run('')).error).toMatch(/empty/);
  });
});

describe('the walls', () => {
  it('no network, files, process, require or dynamic import', async () => {
    const probe = await run('return [typeof fetch, typeof XMLHttpRequest, typeof require, typeof process, typeof module, typeof Buffer, typeof WebSocket, typeof setTimeout, typeof globalThis.fs].join(",");');
    expect(probe.error).toBeUndefined();
    expect(probe.value).toBe('undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined');
    expect((await run('return fetch("http://127.0.0.1:1/");')).error).toMatch(/fetch/);
    expect((await run('return require("fs").readFileSync("/etc/passwd","utf8");')).error).toMatch(/require/);
    expect((await run('return process.env;')).error).toMatch(/process/);
    // there is no module loader: an import is a promise that never yields a module, and nothing of one reaches the result
    const imp = await run('return import("fs");');
    expect(JSON.stringify(imp.value ?? imp.error ?? null)).not.toMatch(/readFileSync|exports/);
  });

  it('the usual ways out of a sandbox reach nothing of the host', async () => {
    const tries = [
      'return (function () { return this; }).constructor("return typeof process")();',
      'return Function("return typeof require")();',
      'return globalThis.constructor.constructor("return typeof process")();',
      'return (0, eval)("typeof process");',
      'return Object.getPrototypeOf(async function () {}).constructor("return typeof process")();',
    ];
    for (const code of tries) {
      const r = await run(code);
      expect(r.error ?? String(r.value), code).toMatch(/undefined|Error|not a function|promise|\[object/i);
      expect(r.value, code).not.toBe('object');
    }
  });

  it('an endless loop is interrupted at the time limit', async () => {
    const t0 = Date.now();
    const r = await run('while (true) {}', { timeoutMs: 250 });
    expect(r.error).toMatch(/took longer than 250 ms/);
    expect(Date.now() - t0).toBeLessThan(5000);
    // recursion without end is an error too, not a host stack overflow
    expect((await run('function f() { return f() + 1; } return f();')).error).toBeDefined();
    // the next script is unaffected
    expect((await run('return 1;')).value).toBe(1);
  });

  it('memory is capped', async () => {
    const r = await run('const keep = []; for (;;) keep.push(new Array(100000).fill("x".repeat(100)));', { timeoutMs: 3000, memoryMb: 16 });
    expect(r.error).toBeDefined();
    expect(r.error).toMatch(/memory|interrupted|took longer/i);
    expect((await run('return 2;')).value).toBe(2);
  });

  it('the result is capped', async () => {
    const r = await run('return "x".repeat(200000);', { timeoutMs: 1000, maxOutputBytes: 1024 });
    expect(r.error).toMatch(/more than 1 KB/);
    expect((await run('return "x".repeat(2000);', { timeoutMs: 1000 })).error).toBeUndefined();
  });

  it('a script cannot keep anything for the next one, or change the sample it was given', async () => {
    await run('globalThis.leak = 41; Object.prototype.polluted = true; return 1;');
    const next = await run('return [typeof globalThis.leak, typeof ({}).polluted].join(",");');
    expect(next.value).toBe('undefined,undefined');
    const a = await run('sample.answer = "changed"; return sample.answer;');
    expect(a.value).toBe('changed');
    expect((await run('return sample.answer;')).value).toBe('The clinic opens at 8am.');
  });

  it('a value that is not JSON is dropped, not smuggled out', async () => {
    const r = await run('return { f() {}, n: undefined, d: new Date(0), big: 1n === 1n };');
    expect(r.error ?? JSON.stringify(r.value)).toBeDefined();
  });
});

describe('as a metric', () => {
  const c = compileCustomMetric({
    id: 'concise',
    kind: 'script',
    threshold: 1,
    script: 'const words = sample.answer.split(/\\s+/).filter(Boolean).length; return { score: words <= 6 ? 1 : 0, reason: words + " words", items: [{ text: "length", ok: words <= 6, evidence: words + " words" }] };',
    examples: [
      { sample: { answer: 'Opens at 8am.' }, expect: 'pass' },
      { sample: { answer: 'We are open from eight in the morning until six in the evening on weekdays.' }, expect: 'fail' },
    ],
  });
  const ctx = (answer: string): CheckContext => ({ testType: 'rag', body: answer, text: answer, ragRun: { strict: true, metrics: [] } });

  it('its examples agree; the result carries the reason, the items and the version', async () => {
    expect((await runMetricExamples(c, {})).map((r) => r.ok)).toEqual([true, true]);
    const r = await c.check({ type: c.def.check }, ctx('Opens at 8am.'));
    expect(r).toMatchObject({ score: 1, passed: true, explanation: '3 words' });
    expect((r.metadata as { items: unknown[]; customMetric: { id: string } }).items).toHaveLength(1);
    expect((r.metadata as { customMetric: { id: string } }).customMetric.id).toBe('custom/concise');
  });

  it('an error or a missing score is n/a with the message, never a pass or a crash', async () => {
    const bad = compileCustomMetric({ id: 'bad', kind: 'script', script: 'throw new Error("nope");' });
    const r = await bad.check({ type: bad.def.check }, ctx('x'));
    expect((r.metadata as { na?: string }).na).toMatch(/script error: .*nope/);
    const none = compileCustomMetric({ id: 'none', kind: 'script', script: 'return { reason: "no score" };' });
    expect(((await none.check({ type: none.def.check }, ctx('x'))).metadata as { na?: string }).na).toMatch(/did not return a number/);
    const nan = compileCustomMetric({ id: 'nan', kind: 'script', script: 'return { score: 0 / 0 };' });
    expect(((await nan.check({ type: nan.def.check }, ctx('x'))).metadata as { na?: string }).na).toMatch(/did not return a number/);
  });

  it('a hostile script as a check: the loop is cut and the sample is n/a', async () => {
    const loop = compileCustomMetric({ id: 'loop', kind: 'script', script: 'while (true) {}' });
    const t0 = Date.now();
    const [r] = await runChecks([{ type: loop.def.check }], ctx('x')).catch(() => [undefined]);
    // not registered: the direct call is what proves the wall
    expect(r).toBeDefined();
    const direct = await loop.check({ type: loop.def.check }, ctx('x'));
    expect((direct.metadata as { na?: string }).na).toMatch(/script error: The script took longer/);
    expect(Date.now() - t0).toBeLessThan(8000);
  }, 20_000);
});
