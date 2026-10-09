/**
 * JavaScript that runs inside the QuickJS sandbox before every user script. It implements the
 * scripting API: `tp.*` (chai-style `tp.expect`, `tp.response.to.have.status`,
 * variable scopes, `tp.request`, `tp.info`, `postman.setNextRequest`, `CryptoJS`; Postman scripts use it as `pm.*`) plus the older
 * `aps.*` alias with jest-style `expect(x).toBe(y)`.
 *
 * Only JSON crosses the sandbox boundary: `__input_json` in, `JSON.stringify(__out)` out. The host
 * functions are pure helpers (hash, HMAC, base64, uuid).
 */
export const PRELUDE = String.raw`
const __in = JSON.parse(__input_json);
const __out = {
  vars: {}, unset: [], tests: [], logs: [], request: __in.request || null, error: null,
  scopeSets: { environment: {}, globals: {}, collectionVariables: {} },
  scopeUnsets: { environment: [], globals: [], collectionVariables: [] },
  nextRequest: undefined, jarOps: [], visualizer: undefined,
};
const __fmt = (v) => { try { return v === undefined ? 'undefined' : JSON.stringify(v); } catch (e) { return String(v); } };
const __deepEq = (a, b) => {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => __deepEq(a[k], b[k]));
};
const __typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : v instanceof RegExp ? 'regexp' : typeof v);

/* ---------------- variable scopes ---------------- */
// merged view: globals < collection < environment < data < local (runtime)
const __scopes = {
  globals: Object.assign({}, __in.globals || {}),
  collectionVariables: Object.assign({}, __in.collectionVariables || {}),
  environment: Object.assign({}, __in.environment || {}),
  iterationData: Object.assign({}, __in.iterationData || {}),
};
const __local = Object.assign({}, __in.variables || {});
function __resolve(key) {
  if (Object.prototype.hasOwnProperty.call(__local, key)) return __local[key];
  for (const s of ['iterationData', 'environment', 'collectionVariables', 'globals'])
    if (Object.prototype.hasOwnProperty.call(__scopes[s], key)) return __scopes[s][key];
  return undefined;
}
// JSON Schema validation (draft-07 / 2019-09 keywords, formats) runs on the host with Ajv; errors come back as text.
function __schemaCheck(data, schema) {
  if (!schema || typeof schema !== 'object') return { valid: false, errors: ['a JSON schema object is required'] };
  return JSON.parse(__host_schema(JSON.stringify(schema), JSON.stringify(data === undefined ? null : data)));
}
// tv4, as used by older Postman scripts: tv4.validate(data, schema) → boolean, with tv4.error.
const tv4 = {
  error: null,
  validate(data, schema) { const r = __schemaCheck(data, schema); tv4.error = r.valid ? null : { message: r.errors[0] || 'invalid' }; return r.valid; },
  validateResult(data, schema) { const r = __schemaCheck(data, schema); return { valid: r.valid, error: r.valid ? null : { message: r.errors[0] || 'invalid' }, missing: [] }; },
  validateMultiple(data, schema) { const r = __schemaCheck(data, schema); return { valid: r.valid, errors: r.errors.map((m) => ({ message: m })), missing: [] }; },
};
function __replaceIn(str) {
  return String(str).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, k) => { let v = __resolve(k.trim()); if (v === undefined && k.trim()[0] === '$') v = JSON.parse(__host_dynamic(k.trim())) ?? undefined; return v === undefined ? m : typeof v === 'object' ? JSON.stringify(v) : String(v); });
}
function __scope(name) {
  const store = __scopes[name];
  return {
    get: (k) => store[k],
    set: (k, v) => { store[k] = v; __local[k] = v; __out.scopeSets[name][k] = v; },
    unset: (k) => { delete store[k]; delete __local[k]; __out.scopeUnsets[name].push(k); },
    has: (k) => Object.prototype.hasOwnProperty.call(store, k),
    clear: () => { for (const k of Object.keys(store)) { delete store[k]; __out.scopeUnsets[name].push(k); } },
    toObject: () => Object.assign({}, store),
    replaceIn: __replaceIn,
    name,
  };
}
const __variables = {
  get: (k) => __resolve(k),
  set: (k, v) => { __local[k] = v; __out.vars[k] = v; },
  unset: (k) => { delete __local[k]; __out.unset.push(k); },
  has: (k) => __resolve(k) !== undefined,
  toObject: () => Object.assign({}, __scopes.globals, __scopes.collectionVariables, __scopes.environment, __scopes.iterationData, __local),
  replaceIn: __replaceIn,
};

/* ---------------- chai-style assertions ---------------- */
function __chai(actual, state) {
  const st = Object.assign({ neg: false, deep: false, own: false }, state || {});
  const self = {};
  const assert = (cond, msg, negMsg) => {
    if (st.neg ? cond : !cond) throw new Error(st.neg ? (negMsg || 'expected not: ' + msg) : msg);
    return self;
  };
  const S = __fmt(actual);
  const chainWords = ['to', 'be', 'been', 'is', 'that', 'which', 'and', 'has', 'have', 'with', 'at', 'of', 'same', 'but', 'does', 'still', 'also'];
  for (const w of chainWords) Object.defineProperty(self, w, { get: () => self });
  Object.defineProperty(self, 'not', { get: () => __chai(actual, Object.assign({}, st, { neg: !st.neg })) });
  Object.defineProperty(self, 'deep', { get: () => __chai(actual, Object.assign({}, st, { deep: true })) });
  Object.defineProperty(self, 'own', { get: () => __chai(actual, Object.assign({}, st, { own: true })) });
  const flag = (name, cond, msg) => Object.defineProperty(self, name, { get: () => assert(cond(), msg) });
  flag('true', () => actual === true, 'expected ' + S + ' to be true');
  flag('false', () => actual === false, 'expected ' + S + ' to be false');
  flag('null', () => actual === null, 'expected ' + S + ' to be null');
  flag('undefined', () => actual === undefined, 'expected ' + S + ' to be undefined');
  flag('NaN', () => Number.isNaN(actual), 'expected ' + S + ' to be NaN');
  flag('ok', () => !!actual, 'expected ' + S + ' to be truthy');
  flag('exist', () => actual !== null && actual !== undefined, 'expected value to exist');
  flag('empty', () => (typeof actual === 'string' || Array.isArray(actual) ? actual.length === 0 : actual && typeof actual === 'object' ? Object.keys(actual).length === 0 : false), 'expected ' + S + ' to be empty');
  const typeCheck = (t) => assert(__typeOf(actual) === String(t).toLowerCase(), 'expected ' + S + ' to be a ' + t);
  self.a = typeCheck; self.an = typeCheck;
  const eq = (v) => (st.deep ? assert(__deepEq(actual, v), 'expected ' + S + ' to deeply equal ' + __fmt(v)) : assert(actual === v, 'expected ' + S + ' to equal ' + __fmt(v)));
  self.equal = eq; self.equals = eq; self.eq = eq;
  self.eql = (v) => assert(__deepEq(actual, v), 'expected ' + S + ' to deeply equal ' + __fmt(v));
  self.above = self.gt = self.greaterThan = (n) => assert(actual > n, 'expected ' + S + ' to be above ' + n);
  self.below = self.lt = self.lessThan = (n) => assert(actual < n, 'expected ' + S + ' to be below ' + n);
  self.least = self.gte = (n) => assert(actual >= n, 'expected ' + S + ' to be at least ' + n);
  self.most = self.lte = (n) => assert(actual <= n, 'expected ' + S + ' to be at most ' + n);
  self.within = (a, b) => assert(actual >= a && actual <= b, 'expected ' + S + ' to be within ' + a + '..' + b);
  const inc = (v) => {
    let ok = false;
    if (typeof actual === 'string') ok = actual.indexOf(v) >= 0;
    else if (Array.isArray(actual)) ok = actual.some((x) => (st.deep || typeof v === 'object' ? __deepEq(x, v) : x === v));
    else if (actual && typeof actual === 'object' && v && typeof v === 'object') ok = Object.keys(v).every((k) => __deepEq(actual[k], v[k]));
    return assert(ok, 'expected ' + S + ' to include ' + __fmt(v));
  };
  self.include = inc; self.includes = inc; self.contain = inc; self.contains = inc;
  self.property = function (name, val) {
    const has = actual !== null && actual !== undefined && (st.own ? Object.prototype.hasOwnProperty.call(Object(actual), name) : name in Object(actual));
    if (arguments.length > 1) {
      assert(has && (st.deep ? __deepEq(actual[name], val) : actual[name] === val), 'expected ' + S + ' to have property ' + name + ' of ' + __fmt(val));
    } else assert(has, 'expected ' + S + ' to have property ' + __fmt(name));
    return st.neg ? self : __chai(actual[name]);
  };
  self.ownProperty = (name) => assert(actual !== null && actual !== undefined && Object.prototype.hasOwnProperty.call(Object(actual), name), 'expected ' + S + ' to have own property ' + name);
  /* chainable like chai: .lengthOf(3) or .lengthOf.at.least(1) / .above(n) / .within(a, b) */
  const lengthOf = () => {
    const len = actual !== null && actual !== undefined ? (actual instanceof Map || actual instanceof Set ? actual.size : actual.length) : undefined;
    const fn = (n) => assert(len === n, 'expected ' + S + ' to have length ' + n + ' but got ' + len);
    const sub = __chai(len, st);
    for (const k of ['above', 'gt', 'greaterThan', 'below', 'lt', 'lessThan', 'least', 'gte', 'most', 'lte', 'within', 'equal', 'eq']) fn[k] = sub[k];
    for (const w of ['at', 'be', 'is', 'of']) Object.defineProperty(fn, w, { get: () => fn });
    return fn;
  };
  Object.defineProperty(self, 'lengthOf', { get: lengthOf });
  Object.defineProperty(self, 'length', { get: lengthOf });
  self.match = (re) => assert(new RegExp(re).test(String(actual)), 'expected ' + S + ' to match ' + re);
  self.jsonSchema = (schema) => { const r = __schemaCheck(actual, schema); return assert(r.valid, 'expected ' + S + ' to match the JSON schema: ' + r.errors.join('; ')); };
  self.string = (s) => assert(String(actual).indexOf(s) >= 0, 'expected ' + S + ' to contain ' + __fmt(s));
  self.oneOf = (arr) => assert(arr.some((x) => __deepEq(x, actual)), 'expected ' + S + ' to be one of ' + __fmt(arr));
  self.keys = function () {
    const want = Array.isArray(arguments[0]) ? arguments[0] : Array.prototype.slice.call(arguments);
    return assert(actual && want.every((k) => Object.prototype.hasOwnProperty.call(actual, k)), 'expected ' + S + ' to have keys ' + __fmt(want));
  };
  self.members = (arr) => assert(Array.isArray(actual) && arr.every((m) => actual.some((x) => __deepEq(x, m))), 'expected ' + S + ' to have members ' + __fmt(arr));
  self.instanceOf = (C) => assert(actual instanceof C, 'expected instance');
  self.satisfy = (fn) => assert(!!fn(actual), 'expected ' + S + ' to satisfy the predicate');
  self.status = (code) => assert(actual && (actual.code === code || actual.status === code), 'expected status ' + code);
  /* jest-style aliases so expect(x).toBe(y) keeps working */
  self.toBe = (e) => assert(actual === e, 'expected ' + S + ' to be ' + __fmt(e));
  self.toEqual = (e) => assert(__deepEq(actual, e), 'expected ' + S + ' to equal ' + __fmt(e));
  self.toContain = (e) => inc(e);
  self.toMatch = (re) => self.match(re);
  self.toBeTruthy = () => assert(!!actual, 'expected ' + S + ' to be truthy');
  self.toBeFalsy = () => assert(!actual, 'expected ' + S + ' to be falsy');
  self.toBeDefined = () => assert(actual !== undefined, 'expected value to be defined');
  self.toBeUndefined = () => assert(actual === undefined, 'expected value to be undefined');
  self.toBeNull = () => assert(actual === null, 'expected ' + S + ' to be null');
  self.toBeGreaterThan = (n) => assert(actual > n, 'expected ' + S + ' > ' + n);
  self.toBeLessThan = (n) => assert(actual < n, 'expected ' + S + ' < ' + n);
  self.toHaveProperty = (k) => assert(actual != null && Object(actual)[k] !== undefined, 'expected object to have property ' + k);
  self.toHaveLength = (n) => assert(actual != null && actual.length === n, 'expected length ' + n + ', got ' + (actual && actual.length));
  return self;
}
const expect = (v) => __chai(v);
expect.fail = (msg) => { throw new Error(msg === undefined ? 'expect.fail()' : String(msg)); };

/* ---------------- xml2Json (Postman: xml2js with explicitArray false) ---------------- */
// attributes go under "$", text under "_" when the element also has attributes or children,
// repeated elements become arrays, an empty element is "".
function __xmlDecode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k[0] === '#') return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
    return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[k];
  });
}
function xml2Json(xml) {
  const src = String(xml);
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/gi;
  const root = { children: {}, text: '', attrs: null, order: [] };
  const stack = [root];
  let m;
  const add = (parent, name, value) => {
    if (Object.prototype.hasOwnProperty.call(parent.children, name)) {
      const cur = parent.children[name];
      parent.children[name] = Array.isArray(cur) && cur.__many ? cur : Object.assign([cur], { __many: true });
      parent.children[name].push(value);
    } else parent.children[name] = value;
  };
  const finish = (node) => {
    const text = node.text.trim();
    const keys = Object.keys(node.children);
    if (!keys.length && !node.attrs) return text;
    const o = {};
    if (node.attrs) o.$ = node.attrs;
    if (text) o._ = text;
    for (const k of keys) { const v = node.children[k]; o[k] = Array.isArray(v) && v.__many ? v.slice() : v; }
    return o;
  };
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2] !== undefined) {
      if (stack.length < 2) throw new Error('xml2Json: </' + m[2] + '> has no opening tag');
      if (top.name !== m[2]) throw new Error('xml2Json: the XML is not well-formed (</' + m[2] + '> closes <' + top.name + '>)');
      const node = stack.pop();
      add(stack[stack.length - 1], node.name, finish(node));
    } else if (m[3] !== undefined) {
      let attrs = null;
      const ar = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let a;
      while ((a = ar.exec(m[4] || ''))) (attrs = attrs || {})[a[1]] = __xmlDecode(a[2] !== undefined ? a[2] : a[3]);
      const node = { name: m[3], children: {}, text: '', attrs };
      if (m[5]) add(top, node.name, finish(node));
      else stack.push(node);
    } else if (m[6] !== undefined) top.text += __xmlDecode(m[6]);
  }
  if (stack.length > 1) throw new Error('xml2Json: the XML is not well-formed (unclosed <' + stack[stack.length - 1].name + '>)');
  const out = {};
  for (const k of Object.keys(root.children)) out[k] = root.children[k];
  return out;
}

/* ---------------- timers: callbacks run after the script, in delay order (no real waiting) ---------------- */
const __timers = [];
let __timerSeq = 0;
function setTimeout(fn, ms) { const id = ++__timerSeq; if (typeof fn === 'function') __timers.push({ id: id, fn: fn, at: Number(ms) || 0, args: Array.prototype.slice.call(arguments, 2) }); return id; }
const setInterval = setTimeout; // runs once: there is no clock to repeat on
const clearTimeout = (id) => { const i = __timers.findIndex((t) => t.id === id); if (i >= 0) __timers.splice(i, 1); };
const clearInterval = clearTimeout;
const setImmediate = (fn) => setTimeout(fn, 0);
function __runTimers() {
  for (let n = 0; __timers.length && n < 1000; n++) {
    __timers.sort((a, b) => a.at - b.at || a.id - b.id);
    const t = __timers.shift();
    const base = t.at;
    // timers created inside a callback are relative to its time
    const before = __timers.length;
    t.fn.apply(null, t.args);
    for (let i = before; i < __timers.length; i++) __timers[i].at += base;
  }
}

/* ---------------- request ---------------- */
function __headerList(list) {
  const arr = list;
  const find = (k) => arr.findIndex((h) => String(h.key).toLowerCase() === String(k).toLowerCase());
  return {
    get: (k) => { const i = find(k); return i >= 0 ? arr[i].value : undefined; },
    has: (k) => find(k) >= 0,
    add: (h) => { arr.push({ key: h.key, value: String(h.value) }); },
    push: (h) => { arr.push({ key: h.key, value: String(h.value) }); },
    upsert: (h) => { const i = find(h.key); if (i >= 0) arr[i].value = String(h.value); else arr.push({ key: h.key, value: String(h.value) }); },
    remove: (k) => { const i = find(k); if (i >= 0) arr.splice(i, 1); },
    each: (fn) => arr.forEach(fn),
    toObject: () => { const o = {}; arr.forEach((h) => { o[h.key] = h.value; }); return o; },
    all: () => arr.slice(),
    count: () => arr.length,
  };
}
// Postman's Url object over a URL string that may hold {{variables}} (kept as written)
function __urlObject(r) {
  const split = () => {
    const s = String(r.url || '');
    const hash = s.indexOf('#');
    const noHash = hash >= 0 ? s.slice(0, hash) : s;
    const q = noHash.indexOf('?');
    const base = q >= 0 ? noHash.slice(0, q) : noHash;
    const m = /^([a-z][a-z0-9+.-]*:\/\/)?([^/]*)(.*)$/i.exec(base) || [];
    return { scheme: m[1] || '', authority: m[2] || '', path: m[3] || '', query: q >= 0 ? noHash.slice(q + 1) : '', hash: hash >= 0 ? s.slice(hash) : '' };
  };
  const parseQuery = (qs) => (qs ? qs.split('&').filter((p) => p !== '').map((p) => { const i = p.indexOf('='); return i >= 0 ? { key: p.slice(0, i), value: p.slice(i + 1) } : { key: p, value: null }; }) : []);
  const build = (u, params) => {
    const qs = params.map((p) => (p.value === null || p.value === undefined ? p.key : p.key + '=' + p.value)).join('&');
    r.url = u.scheme + u.authority + u.path + (qs ? '?' + qs : '') + u.hash;
  };
  const withQuery = (fn) => { const u = split(); const params = parseQuery(u.query); fn(params); build(u, params); };
  const query = {
    get: (k) => { const p = parseQuery(split().query).find((x) => x.key === k); return p ? p.value : undefined; },
    has: (k) => parseQuery(split().query).some((x) => x.key === k),
    add: (p) => withQuery((ps) => ps.push(typeof p === 'string' ? parseQuery(p)[0] : { key: String(p.key), value: p.value === undefined ? null : String(p.value) })),
    upsert: (p) => withQuery((ps) => { const i = ps.findIndex((x) => x.key === p.key); const v = { key: String(p.key), value: p.value === undefined ? null : String(p.value) }; if (i >= 0) ps[i] = v; else ps.push(v); }),
    remove: (k) => withQuery((ps) => { for (let i = ps.length - 1; i >= 0; i--) if (ps[i].key === (typeof k === 'object' ? k.key : k)) ps.splice(i, 1); }),
    clear: () => withQuery((ps) => ps.splice(0, ps.length)),
    all: () => parseQuery(split().query),
    each: (fn) => parseQuery(split().query).forEach(fn),
    count: () => parseQuery(split().query).length,
    toObject: () => { const o = {}; parseQuery(split().query).forEach((p) => { o[p.key] = p.value; }); return o; },
  };
  const hostPort = () => { const a = split().authority.replace(/^[^@]*@/, ''); const m = /^(\[[^\]]*\]|[^:]*)(?::(.*))?$/.exec(a) || []; return { host: m[1] || '', port: m[2] }; };
  return {
    toString: () => r.url,
    update: (u) => { r.url = String(u); },
    getHost: () => hostPort().host,
    getRemote: () => { const h = hostPort(); return h.port ? h.host + ':' + h.port : h.host; },
    getPath: () => split().path || '/',
    getQueryString: () => split().query,
    getPathWithQuery: () => { const u = split(); return (u.path || '/') + (u.query ? '?' + u.query : ''); },
    get protocol() { return split().scheme.replace('://', ''); },
    get host() { return hostPort().host.split('.'); },
    get port() { return hostPort().port; },
    get path() { return split().path.split('/').filter((x) => x !== ''); },
    query: query,
    addQueryParams: (ps) => (Array.isArray(ps) ? ps : [ps]).forEach((p) => query.add(p)),
    removeQueryParams: (ks) => (Array.isArray(ks) ? ks : [ks]).forEach((k) => query.remove(k)),
  };
}
let __request;
if (__out.request) {
  const r = __out.request;
  r.headers = r.headers || [];
  const __url = __urlObject(r);
  __request = {
    get method() { return r.method; },
    set method(m) { r.method = String(m).toUpperCase(); },
    get url() { return __url; },
    set url(u) { r.url = String(u); },
    headers: __headerList(r.headers),
    addHeader: (h) => __headerList(r.headers).add(h),
    removeHeader: (k) => __headerList(r.headers).remove(k),
    get body() { return { raw: r.body, mode: 'raw', toString: () => r.body || '', update: (b) => { r.body = typeof b === 'string' ? b : JSON.stringify(b); } }; },
  };
}

/* ---------------- response ---------------- */
let __response;
if (__in.response) {
  const res = __in.response;
  const hdrs = (res.headers || []).map((h) => ({ key: h[0], value: h[1] }));
  const code = res.status;
  const reasons = { 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 422: 'Unprocessable Entity', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable' };
  const jsonBody = () => JSON.parse(res.body || 'null');
  const respAssert = (neg) => {
    const a = (cond, msg) => { if (neg ? cond : !cond) throw new Error((neg ? 'expected not: ' : '') + msg); return chain; };
    const chain = {};
    ['to', 'have', 'be', 'and', 'a', 'an'].forEach((w) => Object.defineProperty(chain, w, { get: () => chain }));
    Object.defineProperty(chain, 'not', { get: () => respAssert(!neg) });
    chain.status = (s) => (typeof s === 'number' ? a(code === s, 'expected response to have status code ' + s + ' but got ' + code) : a(String(reasons[code] || '').toLowerCase() === String(s).toLowerCase(), 'expected response to have status reason ' + s));
    chain.header = (k, v) => { const h = hdrs.find((x) => x.key.toLowerCase() === String(k).toLowerCase()); return v === undefined ? a(!!h, 'expected response to have header ' + k) : a(!!h && h.value === String(v), 'expected header ' + k + ' to be ' + v + ' but got ' + (h && h.value)); };
    chain.body = (b) => (b === undefined ? a(!!res.body, 'expected response to have a body') : a(typeof b === 'string' ? res.body === b : __deepEq(jsonBody(), b), 'expected response body to match'));
    chain.jsonBody = (path, val) => { let j; try { j = jsonBody(); } catch (e) { return a(false, 'expected response body to be JSON'); } if (path === undefined) return a(true, ''); const v = String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), j); return val === undefined ? a(v !== undefined, 'expected JSON body to have ' + path) : a(__deepEq(v, val), 'expected JSON body ' + path + ' to equal ' + __fmt(val)); };
    chain.jsonSchema = (schema) => { let j; try { j = jsonBody(); } catch (e) { return a(false, 'expected response body to be JSON'); } const r = __schemaCheck(j, schema); return a(r.valid, 'expected response body to match the JSON schema: ' + r.errors.join('; ')); };
    chain.responseTime = { below: (n) => a((res.time || 0) < n, 'expected response time below ' + n + 'ms') };
    const flag = (n, cond, msg) => Object.defineProperty(chain, n, { get: () => a(cond(), msg) });
    flag('ok', () => code === 200, 'expected response to be ok (200) but got ' + code);
    flag('success', () => code >= 200 && code < 300, 'expected a 2xx response but got ' + code);
    flag('info', () => code >= 100 && code < 200, 'expected a 1xx response');
    flag('redirection', () => code >= 300 && code < 400, 'expected a 3xx response');
    flag('error', () => code >= 400, 'expected an error response but got ' + code);
    flag('clientError', () => code >= 400 && code < 500, 'expected a 4xx response but got ' + code);
    flag('serverError', () => code >= 500, 'expected a 5xx response but got ' + code);
    flag('accepted', () => code === 202, 'expected 202');
    flag('badRequest', () => code === 400, 'expected 400');
    flag('unauthorized', () => code === 401, 'expected 401');
    flag('forbidden', () => code === 403, 'expected 403');
    flag('notFound', () => code === 404, 'expected 404');
    flag('rateLimited', () => code === 429, 'expected 429');
    flag('json', () => { try { jsonBody(); return true; } catch (e) { return false; } }, 'expected response body to be JSON');
    flag('withBody', () => !!res.body, 'expected response to have a body');
    return chain;
  };
  __response = {
    code, status: reasons[code] || '', responseTime: res.time, responseSize: (res.body || '').length,
    headers: __headerList(hdrs),
    json: jsonBody, text: () => res.body || '',
    body: res.body,
    header(name) { return this.headers.get(name); },
    cookies: { get: (n) => (__in.cookies || {})[n], has: (n) => Object.prototype.hasOwnProperty.call(__in.cookies || {}, n), toObject: () => Object.assign({}, __in.cookies || {}) },
    get to() { return respAssert(false).to; },
    size() {
      const body = Number(__host_bytelen(res.body || ''));
      const header = hdrs.reduce((n, h) => n + Number(__host_bytelen(h.key + ': ' + h.value)) + 2, 0);
      return { body: body, header: header, total: body + header };
    },
  };
}

/* ---------------- cookie jar ---------------- */
// tp.cookies.jar(): a copy of the workspace jar; changes are recorded in __out.jarOps and applied by the host.
// Postman's jar methods are callback based; the callback runs synchronously here and the value is also returned.
const __jar = (__in.jar || []).map((c) => Object.assign({}, c));
const __hostOf = (u) => { const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/:?#]+)/i.exec(String(u)); return m ? m[1].toLowerCase() : ''; };
const __jarMatch = (host, c) => (c.hostOnly ? host === c.domain : host === c.domain || host.endsWith('.' + c.domain));
const __cb = (cb, err, v) => { if (typeof cb === 'function') cb(err, v); return v; };
const __cookieView = (c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires, secure: !!c.secure, httpOnly: !!c.httpOnly });
function __cookieJar() {
  return {
    get(url, name, cb) { const h = __hostOf(url); const c = __jar.find((x) => x.name === name && __jarMatch(h, x)); return __cb(cb, null, c ? c.value : undefined); },
    getAll(url, cb) { const h = __hostOf(url); return __cb(cb, null, __jar.filter((x) => __jarMatch(h, x)).map(__cookieView)); },
    set(url, name, value, cb) {
      if (name && typeof name === 'object') { cb = value; value = name.value; name = name.name; }
      if (typeof value === 'function') { cb = value; value = ''; }
      const h = __hostOf(url);
      const c = { name: String(name), value: String(value == null ? '' : value), domain: h, path: '/', hostOnly: true };
      const i = __jar.findIndex((x) => x.name === c.name && x.domain === h && x.path === '/');
      if (i >= 0) __jar[i] = c; else __jar.push(c);
      __out.jarOps.push({ op: 'set', url: String(url), name: c.name, value: c.value });
      return __cb(cb, null, __cookieView(c));
    },
    unset(url, name, cb) {
      const h = __hostOf(url);
      for (let i = __jar.length - 1; i >= 0; i--) if (__jar[i].name === name && __jar[i].domain === h) __jar.splice(i, 1);
      __out.jarOps.push({ op: 'unset', url: String(url), name: String(name) });
      return __cb(cb, null);
    },
    clear(url, cb) {
      const h = __hostOf(url);
      for (let i = __jar.length - 1; i >= 0; i--) if (__jar[i].domain === h) __jar.splice(i, 1);
      __out.jarOps.push({ op: 'clear', url: String(url) });
      return __cb(cb, null);
    },
  };
}

/* ---------------- tp.sendRequest ---------------- */
// The sandbox is synchronous, so requests are replayed: on the first pass a call is recorded in
// __out.pendingRequests and its callback does not run; the host sends it and runs the script again
// with the response in __in.sent, and this time the callback runs straight away with it.
// responses are keyed by request signature + occurrence, so calls added by callbacks don't shift them
const __sendSeen = {};
const __sent = __in.sent || [];
__out.pendingRequests = [];
function __normRequest(req) {
  if (typeof req === 'string') return { method: 'GET', url: req, headers: [], body: undefined };
  const r = req || {};
  const url = typeof r.url === 'string' ? r.url : r.url && (r.url.raw || String(r.url));
  const hs = r.header || r.headers || [];
  const headers = Array.isArray(hs) ? hs.map((h) => ({ key: String(h.key), value: String(h.value) })) : Object.keys(hs).map((k) => ({ key: k, value: String(hs[k]) }));
  let body;
  const b = r.body;
  if (typeof b === 'string') body = b;
  else if (b && b.mode === 'raw') body = b.raw;
  else if (b && b.mode === 'urlencoded') body = { urlencoded: (b.urlencoded || []).map((f) => ({ key: String(f.key), value: String(f.value) })) };
  else if (b && typeof b === 'object' && !b.mode) body = JSON.stringify(b);
  return { method: String(r.method || 'GET').toUpperCase(), url: String(url || ''), headers, body };
}
function __responseObject(res) {
  const hdrs = (res.headers || []).map((h) => ({ key: h[0], value: h[1] }));
  return {
    code: res.status, status: res.statusText || '', responseTime: res.time, responseSize: (res.body || '').length,
    headers: __headerList(hdrs),
    json: () => JSON.parse(res.body || 'null'), text: () => res.body || '',
    body: res.body,
  };
}
function __sendRequest(req, cb) {
  const n = __normRequest(req);
  const sig = n.method + ' ' + n.url + ' ' + JSON.stringify(n.headers) + ' ' + JSON.stringify(n.body === undefined ? null : n.body);
  __sendSeen[sig] = (__sendSeen[sig] || 0) + 1;
  const key = sig + '#' + __sendSeen[sig];
  const done = __sent.find((x) => x.key === key);
  if (done) {
    if (typeof cb === 'function') {
      if (done.error) cb(new Error(done.error), null);
      else cb(null, __responseObject(done.response));
      return;
    }
    // without a callback: a promise, for "const res = await tp.sendRequest(…)"
    return done.error ? Promise.reject(new Error(done.error)) : Promise.resolve(__responseObject(done.response));
  }
  __out.pendingRequests.push({ key: key, request: n });
  // not sent yet: the script waits here; the next pass has the response
  if (typeof cb !== 'function') return new Promise(() => {});
}

/* ---------------- libraries ---------------- */
const __word = (hex) => ({ __hex: hex, toString: (enc) => (enc && enc.__b64 ? __host_hex2b64(hex) : hex), sigBytes: hex.length / 2 });
const CryptoJS = {
  SHA256: (m) => __word(__host_hash('sha256', String(m))),
  SHA1: (m) => __word(__host_hash('sha1', String(m))),
  SHA512: (m) => __word(__host_hash('sha512', String(m))),
  MD5: (m) => __word(__host_hash('md5', String(m))),
  HmacSHA256: (m, k) => __word(__host_hmac('sha256', String(k), String(m))),
  HmacSHA1: (m, k) => __word(__host_hmac('sha1', String(k), String(m))),
  HmacSHA512: (m, k) => __word(__host_hmac('sha512', String(k), String(m))),
  enc: {
    Hex: { __hex: true, stringify: (w) => w.__hex, parse: (h) => __word(h) },
    Base64: { __b64: true, stringify: (w) => (w && w.__hex !== undefined ? __host_hex2b64(w.__hex) : __host_b64(String(w))), parse: (s) => __word(__host_b642hex(s)) },
    Utf8: { parse: (s) => String(s), stringify: (w) => (w && w.__hex !== undefined ? __host_hex2utf8(w.__hex) : String(w)) },
  },
};
const btoa = (s) => __host_b64(String(s));
const atob = (s) => __host_unb64(String(s));
const __packages = {};
function __requirePackage(name) {
  if (__packages[name]) return __packages[name].exports;
  const src = JSON.parse(__host_package(name));
  if (src === null) throw new Error('tp.require("' + name + '"): there is no package with that name in this workspace (packages/' + name + '.js)');
  const module = { exports: {} };
  __packages[name] = module;
  const run = new Function('module', 'exports', 'tp', 'pm', 'require', src + '\n//# sourceURL=package:' + name);
  run(module, module.exports, pm, pm, (n) => (['ajv', 'atob', 'btoa', 'chai', 'cheerio', 'crypto-js', 'csv-parse/lib/sync', 'csv-parse/sync', 'lodash', 'moment', 'tv4', 'uuid', 'xml2js'].includes(n) ? require(n) : __requirePackage(n)));
  return module.exports;
}
// cheerio (as in Postman): $ = cheerio.load(html); $('title').text(), $('a').attr('href'), $('li').each(…)
const cheerio = {
  load(html) {
    const src = String(html == null ? '' : html);
    const q = (path, op, sel) => {
      const r = JSON.parse(__host_html(src, JSON.stringify(path || []), op, sel == null ? '' : String(sel)));
      if (r && r.error) throw new Error('cheerio: ' + r.error);
      return r;
    };
    const wrap = (nodes) => {
      const w = { length: nodes.length, cheerio: '[cheerio object]' };
      nodes.forEach((n, i) => { w[i] = n; });
      const at = (i) => nodes[i < 0 ? nodes.length + i : i];
      w.text = () => nodes.map((n) => n.text).join('');
      w.html = () => (nodes[0] ? nodes[0].html : null);
      w.attr = (k) => (nodes[0] ? nodes[0].attrs[String(k).toLowerCase()] : undefined);
      w.val = () => w.attr('value');
      w.data = (k) => w.attr('data-' + k);
      w.hasClass = (c) => nodes.some((n) => String(n.attrs['class'] || '').split(/\s+/).indexOf(c) >= 0);
      w.is = (sel) => nodes.some((n) => q([], 'find', sel).some((m) => JSON.stringify(m.path) === JSON.stringify(n.path)));
      w.eq = (i) => wrap(at(i) ? [at(i)] : []);
      w.first = () => w.eq(0);
      w.last = () => w.eq(-1);
      w.get = (i) => (i === undefined ? nodes.slice() : at(i));
      w.toArray = () => nodes.map((n) => wrap([n]));
      w.find = (sel) => wrap(nodes.flatMap((n) => q(n.path, 'find', sel)));
      w.children = (sel) => wrap(nodes.flatMap((n) => q(n.path, 'children', sel)));
      w.parent = () => wrap(nodes.flatMap((n) => q(n.path, 'parent', '')));
      w.filter = (f) => wrap(nodes.filter((n, i) => (typeof f === 'function' ? f.call(wrap([n]), i, wrap([n])) : wrap([n]).is(f))));
      w.each = (fn) => { for (let i = 0; i < nodes.length; i++) if (fn.call(wrap([nodes[i]]), i, wrap([nodes[i]])) === false) break; return w; };
      w.map = (fn) => { const out = nodes.map((n, i) => fn.call(wrap([n]), i, wrap([n]))).filter((x) => x != null); return { length: out.length, get: (i) => (i === undefined ? out : out[i]), toArray: () => out }; };
      return w;
    };
    const $ = (sel) => (sel && typeof sel === 'object' && sel.cheerio ? sel : wrap(q([], 'find', sel)));
    $.html = () => src;
    $.text = () => wrap(q([], 'find', 'body')).text() || wrap(q([], 'find', 'html')).text();
    $.root = () => ({ text: $.text, html: $.html, find: (sel) => $(sel) });
    return $;
  },
};
// More of the modules Postman's sandbox offers to require()
// ajv: new Ajv().compile(schema) → validate(data), with validate.errors (JSON Schema checked on the host)
function __Ajv() {}
__Ajv.prototype.compile = function (schema) {
  const validate = function (data) {
    const r = __schemaCheck(data, schema);
    validate.errors = r.valid ? null : r.errors.map((e) => ({ message: String(e), instancePath: '' }));
    return r.valid;
  };
  validate.errors = null;
  return validate;
};
__Ajv.prototype.validate = function (schema, data) {
  const v = this.compile(schema);
  const ok = v(data);
  this.errors = v.errors;
  return ok;
};
__Ajv.prototype.addFormat = function () { return this; };
__Ajv.prototype.addSchema = function () { return this; };
__Ajv.prototype.errorsText = function (errors) { return (errors || this.errors || []).map((e) => e.message).join(', ') || 'No errors'; };
// xml2js: parseString(xml, [options], callback) with the xml2Json object
const __xml2js = {
  parseString: (xml, opts, cb) => {
    const done = typeof opts === 'function' ? opts : cb;
    let out;
    try { out = xml2Json(xml); } catch (e) { return done(e, null); }
    done(null, out);
  },
  parseStringPromise: (xml) => Promise.resolve(xml2Json(xml)),
};
// csv-parse/lib/sync: parse(text, { columns, skip_empty_lines, delimiter }) → rows
function __csvParse(input, options) {
  const o = options || {};
  const d = o.delimiter || ',';
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  const s = String(input);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === d) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const kept = o.skip_empty_lines || o.skipEmptyLines ? rows.filter((r) => r.some((x) => x !== '')) : rows;
  const trimmed = o.trim ? kept.map((r) => r.map((x) => x.trim())) : kept;
  if (!o.columns) return trimmed;
  const head = Array.isArray(o.columns) ? o.columns : trimmed.shift() || [];
  return trimmed.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}
const require = (name) => {
  if (name === 'ajv') return __Ajv;
  if (name === 'chai') return { expect: expect, assert: (v, m) => { if (!v) throw new Error(m || 'assertion failed'); } };
  if (name === 'atob') return atob;
  if (name === 'btoa') return btoa;
  if (name === 'xml2js') return __xml2js;
  if (name === 'csv-parse/lib/sync' || name === 'csv-parse/sync') return name === 'csv-parse/sync' ? { parse: __csvParse } : __csvParse;
  if (name === 'cheerio') return cheerio;
  if (name === 'crypto-js') return CryptoJS;
  if (name === 'uuid') return { v4: () => __host_uuid() };
  if (name === 'tv4') return tv4;
  if (name === 'lodash' && typeof _ === 'function') return _;
  if (name === 'moment' && typeof moment === 'function') return moment;
  throw new Error('require("' + name + '") is not available in the sandbox (supported: ajv, atob, btoa, chai, cheerio, crypto-js, csv-parse/lib/sync, lodash, moment, tv4, uuid, xml2js)');
};

/* ---------------- tp (pm, aps) ---------------- */
// tests with a done callback that is never called fail at the end
const __pendingDone = [];
function __pmTest(name, fn) {
  const rec = (err) => __out.tests.push(err ? { name: String(name), passed: false, message: String((err && err.message) || err) } : { name: String(name), passed: true });
  try {
    if (typeof fn !== 'function') return rec(new Error('tp.test needs a function'));
    // function (done) { … done(); } as in Postman
    if (fn.length > 0) {
      let settled = false;
      const done = (err) => { if (!settled) { settled = true; rec(err); } };
      __pendingDone.push(() => done(new Error('done() was not called')));
      fn(done);
      return;
    }
    const r = fn();
    // async tests: the result counts when the promise settles
    if (r && typeof r.then === 'function') return void r.then(() => rec(), (e) => rec(e || new Error('rejected')));
    rec();
  } catch (e) { rec(e); }
}
// tp.test.skip: listed as skipped, not run
__pmTest.skip = (name) => { __out.tests.push({ name: String(name), passed: true, skipped: true, message: 'skipped' }); };
const pm = {
  test: __pmTest,
  expect,
  variables: __variables,
  // tp.environment.name is the active environment's name, as in Postman
  environment: Object.assign(__scope('environment'), { name: (__in.info && __in.info.environmentName) || undefined }),
  globals: __scope('globals'),
  collectionVariables: __scope('collectionVariables'),
  iterationData: { get: (k) => __scopes.iterationData[k], has: (k) => Object.prototype.hasOwnProperty.call(__scopes.iterationData, k), toObject: () => Object.assign({}, __scopes.iterationData), toJSON: () => Object.assign({}, __scopes.iterationData) },
  request: __request,
  response: __response,
  info: Object.assign({ eventName: __in.response ? 'test' : 'prerequest', iteration: 0, iterationCount: 1, requestName: '', requestId: '' }, __in.info || {}),
  cookies: { get: (n) => (__in.cookies || {})[n], has: (n) => Object.prototype.hasOwnProperty.call(__in.cookies || {}, n), toObject: () => Object.assign({}, __in.cookies || {}), jar: __cookieJar },
  sendRequest: __sendRequest,
  // Postman Vault: TestPion keeps secrets in (secret) variables, so the vault reads and writes those
  vault: {
    get: (k) => Promise.resolve(__variables.get(String(k))),
    set: (k, v) => Promise.resolve(void pm.environment.set(String(k), v)),
    unset: (k) => Promise.resolve(void pm.environment.unset(String(k))),
  },
  // Postman's package library: workspace packages (packages/<name>.js) as CommonJS modules
  require: (name) => __requirePackage(String(name)),
  execution: {
    setNextRequest: (n) => { __out.nextRequest = n === null ? null : String(n); },
    skipRequest: () => { __out.skipRequest = true; },
    // [collection, folders…, request]; .current is the request
    location: Object.assign(((__in.info && __in.info.location) || [(__in.info && __in.info.requestName) || '']).slice(), { current: (__in.info && __in.info.requestName) || '' }),
  },
  // Postman Visualizer: a Handlebars template and its data, rendered by the host (Visualize tab)
  visualizer: {
    set: (template, data, options) => {
      let d = data === undefined ? {} : data;
      try { d = JSON.parse(JSON.stringify(d)); } catch (e) { throw new Error('tp.visualizer.set: data must be JSON-serialisable'); }
      __out.visualizer = { template: String(template), data: d, options: options === undefined ? undefined : options };
    },
    clear: () => { __out.visualizer = null; },
  },
  uuid: () => __host_uuid(),
  crypto: {
    sha256: (s) => __host_hash('sha256', String(s)),
    md5: (s) => __host_hash('md5', String(s)),
    hmacSha256: (key, s) => __host_hmac('sha256', String(key), String(s)),
    base64: (s) => __host_b64(String(s)),
  },
  data: __in.data,
};
const postman = {
  setNextRequest: (n) => { __out.nextRequest = n === null ? null : String(n); },
  setEnvironmentVariable: (k, v) => pm.environment.set(k, v),
  getEnvironmentVariable: (k) => pm.environment.get(k),
  setGlobalVariable: (k, v) => pm.globals.set(k, v),
  getGlobalVariable: (k) => pm.globals.get(k),
  clearEnvironmentVariable: (k) => pm.environment.unset(k),
  clearGlobalVariable: (k) => pm.globals.unset(k),
  clearEnvironmentVariables: () => pm.environment.clear(),
  clearGlobalVariables: () => pm.globals.clear(),
  getResponseHeader: (n) => (__response ? __response.headers.get(n) : undefined),
  getResponseCookie: (n) => { const v = (__in.cookies || {})[n]; return v === undefined ? undefined : { name: n, value: v }; },
};
const tests = {};
// TestPion's own name for the API: tp.* and Postman's pm.* are the same object
const tp = pm;
const aps = pm;
// legacy Postman sandbox globals (pre-pm API)
const responseCode = __in.response ? { code: __in.response.status, name: '', detail: '' } : undefined;
const responseBody = __in.response ? __in.response.body || '' : undefined;
const responseTime = __in.response ? __in.response.time : undefined;
const responseHeaders = __in.response ? Object.fromEntries((__in.response.headers || []).map((h) => [h[0], h[1]])) : undefined;
const environment = __scopes.environment;
const globals = __scopes.globals;
const data = __scopes.iterationData;
// legacy aps.response helpers
if (__response) { __response.header = (n) => __response.headers.get(n); }
const console = {
  log: (...a) => __out.logs.push(a.map((x) => (typeof x === 'string' ? x : __fmt(x))).join(' ')),
};
console.info = console.log; console.warn = console.log; console.error = console.log; console.debug = console.log;
`;

/** Appended after the user script: legacy `tests["name"] = bool` assertions from old Postman scripts. */
export const EPILOGUE = String.raw`
for (const f of __pendingDone) f();
for (const k of Object.keys(tests)) __out.tests.push({ name: k, passed: !!tests[k], message: tests[k] ? undefined : 'tests["' + k + '"] was false' });
`;
