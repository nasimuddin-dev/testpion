import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { convertScript, runScript, type ScriptTool } from '../../packages/core/src/index.js';
import { brunoToTp } from '../../packages/core/src/scripts/bruno.js';
import { BRU_TO_TP, POSTMAN_LEGACY_CALLS } from '../../packages/core/src/scripts/convert/coverage.js';
import { BRUNO_HEADER } from '../../packages/core/src/import/bruno-import.js';

// Script converter v2 (import-compat plan 4b): a corpus of snippets from the tools' documentation and real collections
// (tests/fixtures/import/scripts/sources.json), the output frozen in expected.json (UPDATE_GOLDEN=1 rewrites it, then
// read the diff), every conversion idempotent, and, for what can run offline, the same behaviour before and after.

const DIR = join(__dirname, '..', 'fixtures', 'import', 'scripts');
type Sources = Record<ScriptTool, Array<{ name: string; source: string }>>;
// two halves of the corpus: the first (sources.json / expected.json) and the one added with the other tools (sources-more.json /
// expected-more.json: Thunder Client and Hoppscotch, and more of every tool's snippets)
const first = JSON.parse(readFileSync(join(DIR, 'sources.json'), 'utf8')) as Partial<Sources>;
const more = JSON.parse(readFileSync(join(DIR, 'sources-more.json'), 'utf8')) as Partial<Sources>;
const sources = Object.fromEntries((['postman', 'insomnia', 'bruno', 'thunder', 'hoppscotch'] as ScriptTool[]).map((t) => [t, [...(first[t] ?? []), ...(more[t] ?? [])]])) as Sources;
const firstNames = new Set(Object.entries(first).flatMap(([t, l]) => (l ?? []).map((c) => `${t}/${c.name}`)));
const expectedFile = join(DIR, 'expected.json');
const expectedMoreFile = join(DIR, 'expected-more.json');
type Expected = Record<string, { code: string; status: string; changes: number; apis: string[] }>;
const results: Expected = {};
for (const [tool, list] of Object.entries(sources))
  for (const c of list) {
    const r = convertScript(c.source, tool as ScriptTool);
    results[`${tool}/${c.name}`] = { code: r.code, status: r.status, changes: r.changes, apis: r.findings.map((f) => f.api).filter(Boolean) };
  }
if (process.env.UPDATE_GOLDEN) {
  writeFileSync(expectedFile, JSON.stringify(Object.fromEntries(Object.entries(results).filter(([k]) => firstNames.has(k))), null, 2) + '\n');
  writeFileSync(expectedMoreFile, JSON.stringify(Object.fromEntries(Object.entries(results).filter(([k]) => !firstNames.has(k))), null, 2) + '\n');
}
const expected = { ...(JSON.parse(readFileSync(expectedFile, 'utf8')) as Expected), ...(JSON.parse(readFileSync(expectedMoreFile, 'utf8')) as Expected) };

describe('the script corpus', () => {
  for (const [key, want] of Object.entries(expected)) {
    it(`${key}`, () => {
      expect(results[key]).toEqual(want);
    });
  }
  it('has an expectation for every snippet and the other way round', () => {
    expect(Object.keys(expected).sort()).toEqual(Object.keys(results).sort());
    // the corpus: snippets from the tools' documentation and real collections (>= 200, five script APIs)
    expect(Object.keys(results).length).toBeGreaterThanOrEqual(200);
    for (const t of Object.keys(sources)) expect(sources[t as ScriptTool].length, t).toBeGreaterThanOrEqual(15);
  });
});

describe('every conversion is idempotent', () => {
  for (const [tool, list] of Object.entries(sources))
    for (const c of list)
      it(`${tool}/${c.name}`, () => {
        const once = convertScript(c.source, tool as ScriptTool);
        const twice = convertScript(once.code, tool as ScriptTool);
        expect(twice.code).toBe(once.code);
        expect(twice.changes).toBe(0);
      });
});

// What Thunder Client's `tc` and Hoppscotch's `pw` / `hopp` do, written over the sandbox's pm (the semantics the converter assumes), so
// the original of a snippet can run here and be compared with its conversion.
const TC_SHIM = `
var __lc = function (l) { var o = {}; l.each(function (h) { o[String(h.key).toLowerCase()] = h.value; }); return o; };
var tc = {
  setVar: function (k, v, s) { return s === 'global' ? pm.globals.set(k, v) : pm.environment.set(k, v); },
  getVar: function (k, s) { return s === 'global' ? pm.globals.get(k) : pm.environment.get(k); },
  test: function (n, f) { return pm.test(n, f); },
  loadModule: function (n) { return require(n); },
  response: { get status() { return pm.response.code; }, get json() { return pm.response.json(); }, get text() { return pm.response.text(); }, get headers() { return __lc(pm.response.headers); }, get time() { return pm.response.responseTime; }, get size() { return pm.response.size().total; } },
  request: { get url() { return pm.request.url.toString(); }, get method() { return pm.request.method; } },
};
var expect = pm.expect;
`;
const PW_SHIM = `
var __m = function (x, neg) {
  var c = function () { return neg ? pm.expect(x).not : pm.expect(x); };
  return {
    get not() { return __m(x, !neg); },
    toBe: function (v) { return c().to.equal(v); }, toEqual: function (v) { return c().to.eql(v); },
    toBeLevel2xx: function () { return c().to.be.within(200, 299); }, toBeLevel4xx: function () { return c().to.be.within(400, 499); },
    toBeType: function (t) { return c().to.be.a(t); }, toHaveLength: function (n) { return c().to.have.lengthOf(n); }, toInclude: function (v) { return c().to.include(v); },
    toBeTruthy: function () { return c().to.be.ok; }, toBeLessThan: function (v) { return c().to.be.below(v); }, toBeGreaterThan: function (v) { return c().to.be.above(v); },
  };
};
var pw = {
  test: function (n, f) { return pm.test(n, f); }, expect: function (x) { return __m(x, false); },
  env: { get: function (k) { return pm.environment.get(k); }, set: function (k, v) { return pm.environment.set(k, v); }, unset: function (k) { return pm.environment.unset(k); }, resolve: function (s) { return pm.variables.replaceIn(s); }, getResolve: function (k) { return pm.variables.replaceIn('{{' + k + '}}'); } },
  response: { get status() { return pm.response.code; }, get body() { return pm.response.json(); }, get headers() { return pm.response.headers.all(); }, get responseTime() { return pm.response.responseTime; } },
};
var hopp = {
  test: pw.test, expect: pw.expect,
  env: { active: { get: pw.env.get, set: pw.env.set, unset: pw.env.unset }, global: { get: function (k) { return pm.globals.get(k); }, set: function (k, v) { return pm.globals.set(k, v); } } },
  response: { get statusCode() { return pm.response.code; }, asJSON: function () { return pm.response.json(); }, asText: function () { return pm.response.text(); } },
};
`;
const SHIMS: Partial<Record<ScriptTool, string>> = { thunder: TC_SHIM, hoppscotch: PW_SHIM };

describe('the converted script does what the original did', () => {
  // only what runs offline: no tp.sendRequest, no script that does not parse, no API TestPion lacks
  const skip = new Set(['legacy response helpers', 'sendRequest with callback', 'async await', 'does not parse', 'Postman API without equivalent', 'sendRequest has no equivalent', 'cookies have no equivalent', 'parent folders', 'request auth update', 'sleep stays', 'local insomnia variable', 'cookies jar', 'send request promise', 'send request callback', 'vault read', 'state across runs', 'run request', 'hopp fetch (no equivalent)', 'dataset sql (no equivalent)', 'mock matching (no equivalent)', 'syntax error kept', 'parent folders (no equivalent)', 'request auth update (no equivalent)', 'auth mode (no equivalent)', 'set body (no equivalent response)', 'visualizer table', 'cheerio html', 'own tc', 'own pw', 'set max redirects (lifted)']);
  const input = {
    variables: { token: 't-1', v: '2', host: 'https://h.test', a: '1', b: '2', c: '3', s: 'sec', API_KEY: 'k' },
    request: { method: 'GET', url: 'https://h.test/x', headers: [{ key: 'X-Req', value: '1' }] as Array<{ key: string; value: string }> },
    response: { status: 200, headers: [['content-type', 'application/json'], ['x-request-id', 'rid-9']] as Array<[string, string]>, body: '{"id":7,"token":"zz","name":"n","value":100}', time: 12 },
    info: { requestName: 'My request', environmentName: 'Dev' },
    cookies: { session: 's1' },
  };
  for (const [tool, list] of Object.entries(sources))
    for (const c of list.filter((x) => !skip.has(x.name))) {
      it(`${tool}/${c.name}`, async () => {
        // (Insomnia's API is Postman's: its original is the same script on pm.*; the old status text of responseCode.name was empty)
        const original = (SHIMS[tool as ScriptTool] ?? '') + (tool === 'insomnia' ? convertScript(c.source, 'insomnia', { alias: 'pm' }).code : c.source);
        // (an imported Bruno script starts with the marker line that loads the req / res shim)
        const head = tool === 'bruno' ? BRUNO_HEADER + '\n' : '';
        const before = await runScript(head + original, input);
        const after = await runScript(head + convertScript(c.source, tool as ScriptTool).code, input);
        const shape = (o: typeof before) => ({ tests: o.tests.map((t) => [t.name, t.passed]), logs: o.logs, sets: o.scopeSets, next: o.nextRequest, skip: o.skipRequest, failed: !!o.error });
        expect(shape(after)).toEqual(shape(before));
      });
    }
});

describe('the coverage tables', () => {
  it('map to tp.* names only', () => {
    for (const to of [...Object.values(BRU_TO_TP), ...Object.values(POSTMAN_LEGACY_CALLS)]) expect(to).toMatch(/^tp\./);
  });
  it('brunoToTp (the old entry) is the converter: its table, warnings and idempotence', () => {
    const src = 'bru.getEnvName(); bru.hasVar("a"); bru.deleteVar("a"); bru.cookies.jar(); res.setBody(1);';
    const once = brunoToTp(src);
    expect(once.code.split('\n').at(-1)).toBe('tp.environment.name; tp.variables.has("a"); tp.collectionVariables.unset("a"); tp.cookies.jar(); res.setBody(1);');
    expect(once.warnings).toEqual(['res.setBody']);
    expect(brunoToTp(once.code).code).toBe(once.code);
  });
  it('an Insomnia script can be converted to pm.* (kept for Postman) or tp.*', () => {
    expect(convertScript("insomnia.environment.set('a', 1);", 'insomnia', { alias: 'pm' }).code).toBe("pm.environment.set('a', 1);");
    expect(convertScript("insomnia.baseEnvironment.set('a', 1);", 'insomnia', { alias: 'pm' }).code).toBe("pm.environment.set('a', 1);");
  });
});

describe('scope and syntax edge cases', () => {
  const tp = (code: string) => convertScript(code, 'postman').code;
  it('keeps a pm that a function, arrow, catch, destructuring or loop declares', () => {
    expect(tp('const f = (pm) => pm.x; f({ x: 1 }); pm.test("a", () => {});')).toBe('const f = (pm) => pm.x; f({ x: 1 }); tp.test("a", () => {});');
    expect(tp('for (const pm of list) { pm.run(); } pm.y();')).toBe('for (const pm of list) { pm.run(); } tp.y();');
    expect(tp('function g({ pm }) { return pm.z; }\npm.k();')).toBe('function g({ pm }) { return pm.z; }\ntp.k();');
  });
  it('converts pm in default parameter values and computed keys, and in nested template expressions', () => {
    expect(tp('function h(a = pm.variables.get("a")) { return `${a}-${pm.info.requestName}`; }')).toBe('function h(a = tp.variables.get("a")) { return `${a}-${tp.info.requestName}`; }');
    expect(tp('const o = { [pm.info.requestName]: 1, pm: 2 };')).toBe('const o = { [tp.info.requestName]: 1, pm: 2 };');
  });
  it('handles regex literals, division, and labels without confusing them with code', () => {
    expect(tp('const r = /pm\\.x/g; const d = 4 / 2 / 1; outer: for (;;) { break outer; } pm.a();')).toBe('const r = /pm\\.x/g; const d = 4 / 2 / 1; outer: for (;;) { break outer; } tp.a();');
  });
  it('accepts top-level await and return, and a hashbang', () => {
    expect(tp('await pm.sendRequest("u"); return pm.x;')).toBe('await tp.sendRequest("u"); return tp.x;');
    expect(tp('#!/usr/bin/env node\npm.a();')).toBe('#!/usr/bin/env node\ntp.a();');
  });
  it('reports where a script does not parse, and leaves it as written', () => {
    const r = convertScript('pm.test("a" function () {});', 'postman');
    expect(r.status).toBe('kept');
    expect(r.code).toBe('pm.test("a" function () {});');
    expect(r.findings[0]).toMatchObject({ code: 'SCRIPT_PARSE_ERROR', line: 1 });
    expect(r.reason).toMatch(/does not parse \(line 1, column/);
  });
  it('leaves TODO markers once, above the line, with its indentation', () => {
    const src = 'if (x) {\n  res.setBody({}); req.getTimeout();\n}';
    const r = convertScript(src, 'bruno');
    expect(r.code).toBe("if (x) {\n  // TODO(import): res.setBody, req.getTimeout has no TestPion equivalent yet: rewrite this line with TestPion's script API (sendRequest, cookies …)\n  res.setBody({}); req.getTimeout();\n}");
    expect(r.findings.map((f) => f.api)).toEqual(['res.setBody', 'req.getTimeout']);
    // and a second conversion leaves the marker alone
    expect(convertScript(r.code, 'bruno').code).toBe(r.code);
  });
  it('a long script converts quickly', () => {
    const big = Array.from({ length: 3000 }, (_, i) => `pm.test("t${i}", function () { pm.expect(pm.response.code).to.equal(200); });`).join('\n');
    // best of three: a shared CI runner can stall one sample (2.1 s was measured once against a 2 s budget)
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const r = convertScript(big, 'postman');
      expect(r.changes).toBe(9000);
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(2000);
  });
});
