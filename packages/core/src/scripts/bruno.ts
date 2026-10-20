import { convertScript } from './convert/index.js';

/**
 * Bruno's script API (`bru`, `req`, `res`, `test`) over the Postman-style `pm` object, so scripts
 * imported from Bruno run as they are. Loaded (like lodash) only for scripts that use it. Everything
 * reads `pm` when called, so this is evaluated before the prelude.
 */
export const BRUNO_SOURCE = String.raw`
(function () {
  var g = globalThis;
  var parse = function (t) { try { return JSON.parse(t); } catch (e) { return t; } };
  var at = function (obj, path) {
    return String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(function (k) { return k !== ''; })
      .reduce(function (o, k) { return o == null ? undefined : o[k]; }, obj);
  };
  var headersOf = function (list) {
    var o = {};
    list.all().forEach(function (h) { o[String(h.key).toLowerCase()] = h.value; });
    return o;
  };
  g.bru = {
    getEnvVar: function (k) { return pm.environment.get(k); },
    setEnvVar: function (k, v) { pm.environment.set(k, v); },
    hasEnvVar: function (k) { return pm.environment.has(k); },
    deleteEnvVar: function (k) { pm.environment.unset(k); },
    getEnvName: function () { return pm.environment.name; },
    getGlobalEnvVar: function (k) { return pm.globals.get(k); },
    setGlobalEnvVar: function (k, v) { pm.globals.set(k, v); },
    // runtime variables last for the rest of the run, like Bruno's
    getVar: function (k) { return pm.variables.get(k); },
    setVar: function (k, v) { pm.collectionVariables.set(k, v); },
    hasVar: function (k) { return pm.variables.has(k); },
    deleteVar: function (k) { pm.collectionVariables.unset(k); },
    getCollectionVar: function (k) { return pm.collectionVariables.get(k); },
    getFolderVar: function (k) { return pm.variables.get(k); },
    getRequestVar: function (k) { return pm.variables.get(k); },
    // the collection's .env values are imported as (secret) environment variables
    getProcessEnv: function (k) { return pm.variables.get(k); },
    getSecretVar: function (k) { return pm.variables.get(k); },
    interpolate: function (s) { return pm.variables.replaceIn(s); },
    getRequestName: function () { return pm.info.requestName; },
    setNextRequest: function (n) { pm.execution.setNextRequest(n); },
    runner: {
      setNextRequest: function (n) { pm.execution.setNextRequest(n); },
      skipRequest: function () { pm.execution.skipRequest(); },
      stopExecution: function () { pm.execution.setNextRequest(null); },
    },
    sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
    cwd: function () { return ''; },
  };
  g.req = {
    getUrl: function () { return pm.request.url.toString(); },
    setUrl: function (u) { pm.request.url = u; },
    getMethod: function () { return pm.request.method; },
    setMethod: function (m) { pm.request.method = m; },
    getName: function () { return pm.info.requestName; },
    getHeader: function (n) { return pm.request.headers.get(n); },
    getHeaders: function () { return pm.request.headers.toObject(); },
    setHeader: function (n, v) { pm.request.headers.upsert({ key: n, value: v }); },
    setHeaders: function (o) { Object.keys(o || {}).forEach(function (k) { pm.request.headers.upsert({ key: k, value: o[k] }); }); },
    deleteHeader: function (n) { pm.request.headers.remove(n); },
    getBody: function () { return parse(pm.request.body.toString()); },
    setBody: function (b) { pm.request.body.update(b); },
    getTimeout: function () { return undefined; },
    setTimeout: function () {},
    getAuthMode: function () { return ''; },
  };
  // res is a function too: res('data.items[0].id') reads a path of the body
  var res = function (path) { return at(res.getBody(), path); };
  var has = function () { return !!pm.response; };
  Object.defineProperties(res, {
    status: { get: function () { return has() ? pm.response.code : undefined; } },
    statusText: { get: function () { return has() ? pm.response.status : undefined; } },
    headers: { get: function () { return has() ? headersOf(pm.response.headers) : {}; } },
    body: { get: function () { return has() ? parse(pm.response.text()) : undefined; } },
    responseTime: { get: function () { return has() ? pm.response.responseTime : undefined; } },
  });
  res.getStatus = function () { return res.status; };
  res.getStatusText = function () { return res.statusText; };
  res.getHeader = function (n) { return res.headers[String(n).toLowerCase()]; };
  res.getHeaders = function () { return res.headers; };
  res.getBody = function () { return res.body; };
  res.getResponseTime = function () { return res.responseTime; };
  res.getUrl = function () { return pm.request.url.toString(); };
  g.res = res;
  if (typeof g.test !== 'function') g.test = function (name, fn) { pm.test(name, fn); };
})();
`;

/** Does a script use Bruno's API (and so needs BRUNO_SOURCE)? */
export const USES_BRUNO = /^\/\/ Bruno script|\bbru\.(get|set|has|delete|interpolate|runner|sleep|setNextRequest)|\bres\.(getBody|getStatus|getHeader|getResponseTime)\b|\breq\.(get|set|delete)[A-Z]\w*\(/m;

/**
 * A Bruno script with `bru.*` rewritten to `tp.*` where TestPion has the same thing (the table is in convert/coverage.ts).
 * A `bru.*` call TestPion has nothing for (sendRequest, runRequest, cookies …) gets a `// TODO(import)` line above it
 * and is listed in `warnings`. The converter itself is scripts/convert (by syntax tree); this is its Bruno entry.
 */
export function brunoToTp(code: string): { code: string; changed: number; warnings: string[] } {
  const r = convertScript(code, 'bruno');
  return { code: r.code, changed: r.changes, warnings: [...new Set(r.findings.filter((f) => f.code === 'SCRIPT_API').map((f) => f.api))] };
}

/** The way back, for a Bruno export of a script that came from Bruno: each `tp.*` of the table as Bruno's `bru.*`. */
const TP_TO_BRU: Array<[RegExp, string]> = [
  // the response and request, back to Bruno's res / req (the converter's rules in convert/rules.ts, reversed)
  [/(?<![\w$.])tp\.response\.json\(\)/g, 'res.body'],
  [/(?<![\w$.])tp\.response\.code\b/g, 'res.status'],
  [/(?<![\w$.])tp\.response\.status\b/g, 'res.statusText'],
  [/(?<![\w$.])tp\.response\.responseTime\b/g, 'res.responseTime'],
  [/(?<![\w$.])tp\.response\.headers\.get(?=\s*\()/g, 'res.getHeader'],
  [/(?<![\w$.])tp\.response\.headers\.toObject\(\)/g, 'res.headers'],
  [/(?<![\w$.])tp\.request\.url\.toString\(\)/g, 'req.getUrl()'],
  [/(?<![\w$.])tp\.request\.headers\.get(?=\s*\()/g, 'req.getHeader'],
  [/(?<![\w$.])tp\.request\.headers\.remove(?=\s*\()/g, 'req.deleteHeader'],
  [/(?<![\w$.])tp\.cookies\.jar(?=\s*\()/g, 'bru.cookies.jar'],
  [/(?<![\w$.])tp\.test(?=\s*\()/g, 'test'],
  [/(?<![\w$.])tp\.expect(?=\s*\()/g, 'expect'],
  [/(?<![\w$.])tp\.execution\.setNextRequest\(null\)/g, 'bru.runner.stopExecution()'],
  [/(?<![\w$.])tp\.environment\.name\b/g, 'bru.getEnvName()'],
  [/(?<![\w$.])tp\.info\.requestName\b/g, 'bru.getRequestName()'],
  ...(
    [
      ['environment.get', 'getEnvVar'],
      ['environment.set', 'setEnvVar'],
      ['environment.has', 'hasEnvVar'],
      ['environment.unset', 'deleteEnvVar'],
      ['globals.get', 'getGlobalEnvVar'],
      ['globals.set', 'setGlobalEnvVar'],
      ['variables.get', 'getVar'],
      ['variables.has', 'hasVar'],
      // a request variable (vars:pre-request on import) is a runtime variable in Bruno's script API
      ['variables.set', 'setVar'],
      ['variables.replaceIn', 'interpolate'],
      ['collectionVariables.set', 'setVar'],
      ['collectionVariables.unset', 'deleteVar'],
      ['collectionVariables.get', 'getCollectionVar'],
      ['execution.setNextRequest', 'runner.setNextRequest'],
      ['execution.skipRequest', 'runner.skipRequest'],
    ] as const
  ).map(([tp, bru]): [RegExp, string] => [new RegExp(`(?<![\\w$.])tp\\.${tp.replace('.', '\\.')}(?=\\s*\\()`, 'g'), `bru.${bru}`]),
];

/** A script that came from Bruno, for Bruno again: its `tp.*` calls back to `bru.*` (strings and comments left alone). */
export function tpToBruno(code: string): string {
  return code.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\/)|[^"'`/]+|\//g, (m, skip: string | undefined) => (skip ? m : TP_TO_BRU.reduce((s, [re, to]) => s.replace(re, to), m)));
}

const literal = (raw: string): string => {
  const v = raw.trim();
  if (/^-?\d+(\.\d+)?$/.test(v) || /^(true|false|null)$/.test(v)) return v;
  if (/^["'].*["']$/.test(v)) return JSON.stringify(v.slice(1, -1));
  return JSON.stringify(v);
};

/**
 * Bruno's no-code assertions (`res.status: eq 200`, `res.body.id: isNumber` …) as a test script.
 * Unknown operators become a comment.
 */
export function brunoAssertionScript(list: Array<{ name: string; value: string; enabled?: boolean }>): string {
  const lines: string[] = [];
  for (const a of list) {
    if (a.enabled === false || !a.name) continue;
    const m = /^(\w+)\s*(.*)$/s.exec(String(a.value ?? '').trim());
    if (!m) continue;
    const [, op, arg = ''] = m;
    // the left side is an expression over res (res.status, res.body.items.length, res.headers['content-type'] …)
    const lhs = /^res(\.|\[|\(|$)/.test(a.name) ? a.name : `res(${JSON.stringify(a.name)})`;
    const list2 = () => `[${arg.split(',').map(literal).join(', ')}]`;
    const expr: Record<string, string> = {
      eq: `to.eql(${literal(arg)})`,
      neq: `to.not.eql(${literal(arg)})`,
      gt: `to.be.above(${literal(arg)})`,
      gte: `to.be.at.least(${literal(arg)})`,
      lt: `to.be.below(${literal(arg)})`,
      lte: `to.be.at.most(${literal(arg)})`,
      in: `to.be.oneOf(${list2()})`,
      notIn: `to.not.be.oneOf(${list2()})`,
      contains: `to.include(${literal(arg)})`,
      notContains: `to.not.include(${literal(arg)})`,
      length: `to.have.lengthOf(${literal(arg)})`,
      matches: `to.match(new RegExp(${literal(arg)}))`,
      notMatches: `to.not.match(new RegExp(${literal(arg)}))`,
      between: `to.be.within(${arg.split(',').map(literal).join(', ')})`,
      isEmpty: 'to.be.empty',
      isNotEmpty: 'to.not.be.empty',
      isNull: 'to.be.null',
      isUndefined: 'to.be.undefined',
      isDefined: 'to.not.be.undefined',
      isTruthy: 'to.be.ok',
      isFalsy: 'to.not.be.ok',
      isJson: "to.be.an('object')",
      isNumber: "to.be.a('number')",
      isString: "to.be.a('string')",
      isBoolean: "to.be.a('boolean')",
      isArray: "to.be.an('array')",
    };
    const name = JSON.stringify(`${a.name}: ${a.value}`);
    if (op === 'startsWith' || op === 'endsWith') lines.push(`test(${name}, function () { expect(String(${lhs}).${op}(${literal(arg)})).to.equal(true); });`);
    else if (expr[op!]) lines.push(`test(${name}, function () { expect(${lhs}).${expr[op!]}; });`);
    else lines.push(`// assertion not converted: ${a.name}: ${a.value}`);
  }
  return lines.join('\n');
}
