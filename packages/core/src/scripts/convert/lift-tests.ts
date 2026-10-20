import type { CheckConfig } from '../../model/types.js';
import { applyEdits, parseScript, type Edit, type N } from './ast.js';

/**
 * Simple tests as structured assertions (import-compat plan 4b, "tests -> assertions"). A top-level
 * `tp.test("name", () => { … })` whose body is one of the 15 common shapes
 *
 *   tp.response.to.have.status(200)                 tp.expect(tp.response.code).to.eql(200)
 *   tp.expect(tp.response.responseTime).to.be.below(300)       tp.response.to.have.header("Content-Type")
 *   tp.expect(json.items).to.have.lengthOf(3)       tp.expect(json.id).to.be.a("number")      tp.expect(json.name).to.eql("Rex")
 *   tp.response.to.be.ok / json                      tp.expect(tp.response.text()).to.include("ok")  …
 *
 * (also with `pm.` and with `const json = tp.response.json();` before the expectation) is a TestPion assertion: it
 * shows in the request's Tests tab and is readable by AI without running the script. The rest of the script is kept
 * as it is. Nothing is guessed: a test that is not exactly one of these shapes stays a script.
 */

const NOPE = Symbol('not a constant');
type Value = unknown;

/** The constant a node stands for (numbers, strings, booleans, null, arrays, plain objects, regular expressions), else NOPE. */
function constant(n: N): Value {
  switch (n.type) {
    case 'Literal':
      return n.regex ? { regex: n.regex.pattern } : n.value;
    case 'TemplateLiteral':
      return n.expressions.length === 0 ? n.quasis.map((q: N) => q.value.cooked).join('') : NOPE;
    case 'UnaryExpression':
      if (n.operator === '-' && n.argument.type === 'Literal' && typeof n.argument.value === 'number') return -n.argument.value;
      return NOPE;
    case 'ArrayExpression': {
      const out: Value[] = [];
      for (const e of n.elements) {
        if (!e) return NOPE;
        const v = constant(e);
        if (v === NOPE) return NOPE;
        out.push(v);
      }
      return out;
    }
    case 'ObjectExpression': {
      const o: Record<string, Value> = {};
      for (const p of n.properties) {
        if (p.type !== 'Property' || p.computed || p.kind !== 'init') return NOPE;
        const k = p.key.type === 'Identifier' ? p.key.name : p.key.type === 'Literal' ? String(p.key.value) : undefined;
        const v = constant(p.value);
        if (k === undefined || v === NOPE) return NOPE;
        o[k] = v;
      }
      return o;
    }
    default:
      return NOPE;
  }
}

/** Chai's filler words: they say nothing. */
const FILLER = new Set(['to', 'be', 'been', 'is', 'that', 'which', 'and', 'has', 'have', 'with', 'at', 'of', 'same', 'deep']);

interface Chain {
  subject: N;
  /** The meaningful words in order (`not`, `a`, `property`, …). */
  words: string[];
  call?: { name: string; args: N[] };
}

/** `tp.expect(x).to.be.a("string")` → { subject: x, words: [], call: { name: 'a', args } }. */
function expectChain(e: N): Chain | undefined {
  let cur = e;
  let call: Chain['call'];
  const words: string[] = [];
  if (cur.type === 'CallExpression' && cur.callee.type === 'MemberExpression' && !cur.callee.computed) {
    call = { name: cur.callee.property.name, args: cur.arguments };
    cur = cur.callee.object;
  }
  while (cur.type === 'MemberExpression' && !cur.computed) {
    words.unshift(cur.property.name);
    cur = cur.object;
  }
  // the base is tp.expect(x) / pm.expect(x) / expect(x)
  if (cur.type !== 'CallExpression' || cur.arguments.length < 1) return undefined;
  const callee = cur.callee;
  const ok = (callee.type === 'Identifier' && callee.name === 'expect') || (callee.type === 'MemberExpression' && !callee.computed && callee.property.name === 'expect' && callee.object.type === 'Identifier' && (callee.object.name === 'tp' || callee.object.name === 'pm'));
  if (!ok) return undefined;
  return { subject: cur.arguments[0], words: words.filter((w) => !FILLER.has(w)), call };
}

interface Ctx {
  /** Names bound to the response JSON (`const json = tp.response.json()`). */
  json: Set<string>;
  text: (n: N) => string;
}

type Subject = { kind: 'status' } | { kind: 'time' } | { kind: 'json'; path: string } | { kind: 'text' } | { kind: 'header'; name: string };

/** `a.b[0].c` over the response JSON → `$.a.b[0].c`. */
function jsonPath(n: N, c: Ctx): string | undefined {
  const parts: string[] = [];
  let cur = n;
  while (cur.type === 'MemberExpression') {
    if (!cur.computed) parts.unshift(`.${cur.property.name}`);
    else if (cur.property.type === 'Literal' && typeof cur.property.value === 'number') parts.unshift(`[${cur.property.value}]`);
    else if (cur.property.type === 'Literal' && typeof cur.property.value === 'string') parts.unshift(`['${cur.property.value.replace(/'/g, "\\'")}']`);
    else return undefined;
    cur = cur.object;
  }
  const isJson = (x: N) => (x.type === 'Identifier' && c.json.has(x.name)) || (x.type === 'CallExpression' && c.text(x.callee).replace(/^pm\./, 'tp.') === 'tp.response.json' && x.arguments.length === 0);
  if (!isJson(cur)) return undefined;
  return `$${parts.join('')}`;
}

function subjectOf(n: N, c: Ctx): Subject | undefined {
  const t = c.text(n).replace(/\s+/g, '').replace(/^pm\./, 'tp.');
  if (t === 'tp.response.code') return { kind: 'status' };
  if (t === 'tp.response.responseTime') return { kind: 'time' };
  if (t === 'tp.response.text()') return { kind: 'text' };
  const h = /^tp\.response\.headers\.get\((['"])(.+)\1\)$/.exec(t);
  if (h) return { kind: 'header', name: h[2]! };
  const p = jsonPath(n, c);
  return p === undefined ? undefined : { kind: 'json', path: p };
}

/** The assertion for one expectation, or undefined. */
function assertionFor(ch: Chain, c: Ctx): CheckConfig | undefined {
  const s = subjectOf(ch.subject, c);
  if (!s) return undefined;
  const not = ch.words.includes('not');
  const words = ch.words.filter((w) => w !== 'not');
  const name = ch.call?.name;
  const arg = ch.call ? ch.call.args.map(constant) : [];
  if (arg.some((a) => a === NOPE)) return undefined;
  const a0 = arg[0];
  const word = words.length === 1 ? words[0] : undefined;
  if (s.kind === 'status' && !not) {
    if (name && ['eql', 'equal', 'equals', 'eq'].includes(name) && typeof a0 === 'number') return { type: 'status', expected: a0 };
    if (name === 'oneOf' && Array.isArray(a0) && a0.every((x) => typeof x === 'number')) return { type: 'status', expected: a0 };
    if (name === 'within' && typeof arg[0] === 'number' && typeof arg[1] === 'number' && arg[1] - arg[0] === 99 && arg[0] % 100 === 0) return { type: 'status', expected: `${arg[0] / 100}xx` };
    return undefined;
  }
  if (s.kind === 'time' && !not) {
    if (name && ['below', 'lessThan', 'lt', 'under'].includes(name) && typeof a0 === 'number') return { type: 'latency', max: a0 };
    if (name && ['most', 'lte'].includes(name) && typeof a0 === 'number') return { type: 'latency', max: a0 };
    return undefined;
  }
  if (s.kind === 'header' && !not) {
    if (!name && (word === 'exist' || word === 'ok')) return { type: 'header', header: s.name };
    if (name && ['eql', 'equal', 'equals', 'include', 'contain', 'string'].includes(name) && typeof a0 === 'string') return { type: 'header', header: s.name, expected: a0 };
    return undefined;
  }
  if (s.kind === 'text' && !not) {
    if (name && ['include', 'contain', 'string', 'contains'].includes(name) && typeof a0 === 'string') return { type: 'contains', expected: a0 };
    if (name === 'match' && a0 && typeof a0 === 'object' && 'regex' in (a0 as object)) return { type: 'regex', pattern: (a0 as { regex: string }).regex };
    return undefined;
  }
  if (s.kind === 'json') {
    if (s.path === '$') {
      if (!name && !not && (word === 'object' || word === 'json')) return { type: 'is-json' };
      return undefined;
    }
    if (!name && word === 'exist') return { type: not ? 'not-exists' : 'exists', path: s.path };
    if (not) return undefined;
    if (!name && word === 'ok') return { type: 'exists', path: s.path };
    if (!name && ['null', 'true', 'false'].includes(word ?? '')) return { type: 'equals', path: s.path, expected: word === 'null' ? null : word === 'true' };
    if (name && ['eql', 'equal', 'equals', 'eq'].includes(name) && a0 !== undefined && (typeof a0 !== 'object' || a0 === null)) return { type: 'equals', path: s.path, expected: a0 };
    if (name && ['eql'].includes(name) && a0 !== undefined) return { type: 'equals', path: s.path, expected: a0 };
    if (name && ['a', 'an'].includes(name) && typeof a0 === 'string' && ['string', 'number', 'boolean', 'array', 'object', 'null'].includes(a0)) return { type: 'type', path: s.path, expected: a0 };
    if (name && ['lengthOf', 'length'].includes(name) && typeof a0 === 'number') return { type: 'length', path: s.path, expected: a0 };
    if (name && ['above', 'greaterThan', 'gt', 'least'].includes(name) && typeof a0 === 'number') return { type: 'greater-than', path: s.path, expected: name === 'least' ? a0 - 1 : a0 };
    if (name && ['below', 'lessThan', 'lt', 'most'].includes(name) && typeof a0 === 'number') return { type: 'less-than', path: s.path, expected: name === 'most' ? a0 + 1 : a0 };
    if (name && ['include', 'contain', 'contains'].includes(name) && (typeof a0 === 'string' || typeof a0 === 'number')) return { type: 'contains', path: s.path, expected: a0 };
    if (name === 'property' && typeof a0 === 'string' && arg.length === 1) return { type: 'exists', path: `${s.path}.${a0}` };
    if (name === 'match' && a0 && typeof a0 === 'object' && 'regex' in (a0 as object)) return { type: 'regex', path: s.path, pattern: (a0 as { regex: string }).regex };
  }
  return undefined;
}

/** `tp.response.to.have.status(200)` and friends: the chai-http style Postman adds to `pm.response`. */
function responseAssertion(e: N, c: Ctx): CheckConfig | undefined {
  let cur = e;
  let call: { name: string; args: N[] } | undefined;
  const words: string[] = [];
  if (cur.type === 'CallExpression' && cur.callee.type === 'MemberExpression' && !cur.callee.computed) {
    call = { name: cur.callee.property.name, args: cur.arguments };
    cur = cur.callee.object;
  }
  const isResponse = (n: N) => /^(tp|pm)\.response$/.test(c.text(n).replace(/\s+/g, ''));
  while (cur.type === 'MemberExpression' && !cur.computed && !isResponse(cur)) {
    words.unshift(cur.property.name);
    cur = cur.object;
  }
  if (!isResponse(cur)) return undefined;
  const w = words.filter((x) => !FILLER.has(x));
  const arg = call ? call.args.map(constant) : [];
  if (arg.some((a) => a === NOPE)) return undefined;
  if (call?.name === 'status' && typeof arg[0] === 'number') return { type: 'status', expected: arg[0] };
  if (call?.name === 'header' && typeof arg[0] === 'string') return { type: 'header', header: arg[0], ...(typeof arg[1] === 'string' ? { expected: arg[1] } : {}) };
  if (!call && w.length === 1) {
    if (w[0] === 'ok' || w[0] === 'success') return { type: 'status', expected: '2xx' };
    if (w[0] === 'clientError') return { type: 'status', expected: '4xx' };
    if (w[0] === 'serverError') return { type: 'status', expected: '5xx' };
    if (w[0] === 'json') return { type: 'is-json' };
  }
  if (call?.name === 'jsonSchema' && arg[0] && typeof arg[0] === 'object') return { type: 'json-schema', schema: arg[0] };
  return undefined;
}

export interface LiftResult {
  code: string;
  assertions: CheckConfig[];
  /** Tests that were lifted (removed from the script). */
  lifted: number;
}

/** The statements of a test function's body, or undefined when it is not a plain function with a block / expression body. */
function bodyOf(fn: N): N[] | undefined {
  if (fn.type !== 'FunctionExpression' && fn.type !== 'ArrowFunctionExpression') return undefined;
  if (fn.params.length) return undefined;
  if (fn.body.type === 'BlockStatement') return fn.body.body;
  return [{ type: 'ExpressionStatement', expression: fn.body, start: fn.body.start, end: fn.body.end } as N];
}

function liftOne(call: N, code: string): CheckConfig | undefined {
  const [nameArg, fn] = call.arguments;
  if (!nameArg || !fn || call.arguments.length !== 2 || nameArg.type !== 'Literal' || typeof nameArg.value !== 'string') return undefined;
  const body = bodyOf(fn);
  if (!body || !body.length) return undefined;
  const c: Ctx = { json: new Set(), text: (n) => code.slice(n.start, n.end) };
  const stmts = [...body];
  // `const jsonData = tp.response.json();` before the expectation
  while (stmts.length > 1 && stmts[0]!.type === 'VariableDeclaration') {
    const d = stmts[0]!.declarations;
    if (d.length !== 1 || d[0].id.type !== 'Identifier' || !d[0].init) return undefined;
    if (c.text(d[0].init).replace(/\s+/g, '').replace(/^pm\./, 'tp.') !== 'tp.response.json()') return undefined;
    c.json.add(d[0].id.name);
    stmts.shift();
  }
  if (stmts.length !== 1 || stmts[0]!.type !== 'ExpressionStatement') return undefined;
  const e = stmts[0]!.expression as N;
  const check = responseAssertion(e, c) ?? ((): CheckConfig | undefined => {
    const ch = expectChain(e);
    return ch ? assertionFor(ch, c) : undefined;
  })();
  return check ? { ...check, name: nameArg.value } : undefined;
}

/**
 * The simple tests of a script as assertions. `apply: false` only counts them (`lifted` = how many could be, the code is
 * returned unchanged): the import report offers the lift with that number.
 */
export function liftTests(code: string, apply = true): LiftResult {
  let parsed;
  try {
    parsed = parseScript(code);
  } catch {
    return { code, assertions: [], lifted: 0 };
  }
  const assertions: CheckConfig[] = [];
  const edits: Edit[] = [];
  for (const st of parsed.ast.body as N[]) {
    if (st.type !== 'ExpressionStatement' || st.expression.type !== 'CallExpression') continue;
    const call = st.expression as N;
    const t = code.slice(call.callee.start, call.callee.end).replace(/\s+/g, '');
    if (t !== 'tp.test' && t !== 'pm.test') continue;
    const a = liftOne(call, code);
    if (!a) continue;
    assertions.push(a);
    edits.push({ start: st.start, end: st.end, text: '' });
  }
  if (!apply) return { code, assertions, lifted: assertions.length };
  const out = edits.length ? applyEdits(code, edits).replace(/\n{3,}/g, '\n\n').replace(/^\s+/, '') : code;
  return { code: out, assertions, lifted: assertions.length };
}
