import type { Edit, N } from './ast.js';
import { chainOf } from './ast.js';

/**
 * The call-shaped part of the script converter: members and calls of Bruno's `req` / `res`, Thunder Client's `tc`,
 * Hoppscotch's `pw` / `hopp` and a few `bru.*` calls that need their arguments rearranged. The tables are data (and the
 * source of the documentation); `ruleFor` turns one syntax node into an edit. Everything it writes is `tp.*`.
 */

export type RuleTool = 'bruno' | 'thunder' | 'hoppscotch';

/** What a rule decided for a node. */
export interface RuleResult {
  edit?: Edit;
  /** The node's children were handled (the replacement holds their text): do not visit them. */
  skipChildren?: boolean;
  /** The API has no equivalent: the converter marks the line with a TODO and reports it. */
  missing?: { api: string; at: number };
  /** A constant moved into the request's settings (`req.setTimeout(5000)`). */
  lift?: { timeoutMs?: number; maxRedirects?: number };
  /** `bru.getProcessEnv('NAME')`: the name of an OS / .env value the script reads. */
  processEnv?: string;
}

type Args = string[];
interface CallRule {
  call: (a: Args, raw: N[]) => string;
}
interface PropRule {
  to: string;
}
type Rule = CallRule | PropRule | { missing: true } | { lift: 'timeoutMs' | 'maxRedirects' };

const HEADERS_OBJ = (list: string) => `${list}.toObject()`;

/** The first argument as a string literal's value, or undefined. */
const literalOf = (n: N | undefined): string | undefined => (n && n.type === 'Literal' && typeof n.value === 'string' ? n.value : undefined);

/* ------------------------------------------------------------------ Bruno: req and res */

export const BRU_REQ_RES: Record<string, Rule> = {
  'req.getUrl': { call: () => 'tp.request.url.toString()' },
  'req.setUrl': { call: (a) => `(tp.request.url = ${a[0]})` },
  'req.getMethod': { call: () => 'tp.request.method' },
  'req.setMethod': { call: (a) => `(tp.request.method = ${a[0]})` },
  'req.getName': { call: () => 'tp.info.requestName' },
  'req.getHeader': { call: (a) => `tp.request.headers.get(${a[0]})` },
  'req.getHeaders': { call: () => HEADERS_OBJ('tp.request.headers') },
  'req.setHeader': { call: (a) => `tp.request.headers.upsert({ key: ${a[0]}, value: ${a[1]} })` },
  'req.setHeaders': { call: (a) => `Object.entries(${a[0]} || {}).forEach(([key, value]) => tp.request.headers.upsert({ key, value }))` },
  'req.deleteHeader': { call: (a) => `tp.request.headers.remove(${a[0]})` },
  'req.getBody': { call: () => 'JSON.parse(tp.request.body.toString())' },
  'req.setBody': { call: (a) => `tp.request.body.update(${a[0]})` },
  'req.setTimeout': { lift: 'timeoutMs' },
  'req.setMaxRedirects': { lift: 'maxRedirects' },
  'req.getTimeout': { missing: true },
  'req.getAuthMode': { missing: true },
  'req.getTags': { missing: true },
  'req.onFail': { missing: true },
  'req.disableParsingResponseJson': { call: () => 'void 0' },
  'res.status': { to: 'tp.response.code' },
  'res.statusText': { to: 'tp.response.status' },
  'res.headers': { to: HEADERS_OBJ('tp.response.headers') },
  'res.body': { to: 'tp.response.json()' },
  'res.responseTime': { to: 'tp.response.responseTime' },
  'res.getStatus': { call: () => 'tp.response.code' },
  'res.getStatusText': { call: () => 'tp.response.status' },
  'res.getHeader': { call: (a) => `tp.response.headers.get(${a[0]})` },
  'res.getHeaders': { call: () => HEADERS_OBJ('tp.response.headers') },
  'res.getBody': { call: () => 'tp.response.json()' },
  'res.getResponseTime': { call: () => 'tp.response.responseTime' },
  'res.getSize': { call: () => 'tp.response.size().total' },
  'res.getUrl': { call: () => 'tp.request.url.toString()' },
  'res.setBody': { missing: true },
};

/** The `bru.*` calls whose arguments need rearranging (the plain renames are in coverage.ts BRU_TO_TP). */
export const BRU_CALLS: Record<string, Rule> = {
  'bru.sendRequest': {
    call: (a) =>
      `((cfg, cb) => { const p = new Promise((resolve) => tp.sendRequest({ url: cfg.url, method: cfg.method || 'GET', header: Object.entries(cfg.headers || {}).map(([key, value]) => ({ key, value })), body: cfg.data === undefined ? undefined : { mode: 'raw', raw: typeof cfg.data === 'string' ? cfg.data : JSON.stringify(cfg.data) } }, (err, res) => resolve([err, res && { status: res.code, statusText: res.status, headers: res.headers.toObject(), data: (() => { try { return res.json(); } catch (e) { return res.text(); } })() }]))); return cb ? p.then(([err, res]) => cb(err, res)) : p.then(([err, res]) => { if (err) throw err; return res; }); })(${a[0]}, ${a[1] ?? 'undefined'})`,
  },
  'bru.cookies.jar': { call: () => 'tp.cookies.jar()' },
};

/* ------------------------------------------------------------------ Thunder Client */

export const THUNDER_RULES: Record<string, Rule> = {
  'tc.setVar': {
    call: (a, raw) => {
      const scope = literalOf(raw[2]);
      return `tp.${scope === 'global' ? 'globals' : scope === 'request' || scope === 'local' ? 'variables' : 'environment'}.set(${a[0]}, ${a[1]})`;
    },
  },
  'tc.getVar': {
    call: (a, raw) => {
      const scope = literalOf(raw[1]);
      return `tp.${scope === 'global' ? 'globals' : scope === 'request' || scope === 'local' ? 'variables' : 'environment'}.get(${a[0]})`;
    },
  },
  'tc.test': { call: (a) => `tp.test(${a.join(', ')})` },
  'tc.loadModule': { call: (a) => `require(${a[0]})` },
  'tc.runRequest': { call: (a) => `tp.execution.runRequest(${a.join(', ')})` },
  'tc.response.status': { to: 'tp.response.code' },
  'tc.response.json': { to: 'tp.response.json()' },
  'tc.response.text': { to: 'tp.response.text()' },
  'tc.response.headers': { to: HEADERS_OBJ('tp.response.headers') },
  'tc.response.time': { to: 'tp.response.responseTime' },
  'tc.response.size': { to: 'tp.response.size().total' },
  'tc.request.url': { to: 'tp.request.url.toString()' },
  'tc.request.method': { to: 'tp.request.method' },
  'tc.request.headers': { to: HEADERS_OBJ('tp.request.headers') },
  'tc.request.body': { to: 'tp.request.body.toString()' },
};

/* ------------------------------------------------------------------ Hoppscotch */

export const HOPPSCOTCH_RULES: Record<string, Rule> = {
  'pw.test': { call: (a) => `tp.test(${a.join(', ')})` },
  'pw.expect': { to: 'tp.expect' },
  'pw.env.get': { call: (a) => `tp.environment.get(${a[0]})` },
  'pw.env.getResolve': { call: (a) => `tp.variables.replaceIn('{{' + ${a[0]} + '}}')` },
  'pw.env.resolve': { call: (a) => `tp.variables.replaceIn(${a[0]})` },
  'pw.env.set': { call: (a) => `tp.environment.set(${a[0]}, ${a[1]})` },
  'pw.env.unset': { call: (a) => `tp.environment.unset(${a[0]})` },
  'pw.response.status': { to: 'tp.response.code' },
  'pw.response.body': { to: 'tp.response.json()' },
  'pw.response.headers': { to: 'tp.response.headers.all()' },
  'pw.response.responseTime': { to: 'tp.response.responseTime' },
  'hopp.test': { call: (a) => `tp.test(${a.join(', ')})` },
  'hopp.expect': { to: 'tp.expect' },
  'hopp.env.get': { call: (a) => `tp.environment.get(${a[0]})` },
  'hopp.env.set': { call: (a) => `tp.environment.set(${a[0]}, ${a[1]})` },
  'hopp.env.unset': { call: (a) => `tp.environment.unset(${a[0]})` },
  'hopp.env.active.get': { call: (a) => `tp.environment.get(${a[0]})` },
  'hopp.env.active.set': { call: (a) => `tp.environment.set(${a[0]}, ${a[1]})` },
  'hopp.env.active.unset': { call: (a) => `tp.environment.unset(${a[0]})` },
  'hopp.env.global.get': { call: (a) => `tp.globals.get(${a[0]})` },
  'hopp.env.global.set': { call: (a) => `tp.globals.set(${a[0]}, ${a[1]})` },
  'hopp.env.global.unset': { call: (a) => `tp.globals.unset(${a[0]})` },
  'hopp.response.statusCode': { to: 'tp.response.code' },
  'hopp.response.statusText': { to: 'tp.response.status' },
  'hopp.response.responseTime': { to: 'tp.response.responseTime' },
  'hopp.response.asJSON': { call: () => 'tp.response.json()' },
  'hopp.response.asText': { call: () => 'tp.response.text()' },
  'hopp.response.headers': { to: 'tp.response.headers.all()' },
  'hopp.request.url': { to: 'tp.request.url.toString()' },
  'hopp.request.method': { to: 'tp.request.method' },
  'hopp.request.headers': { to: 'tp.request.headers.all()' },
  'hopp.fetch': { missing: true },
  'hopp.cookies': { missing: true },
};

/** Jest-style matchers of `pw.expect(x)` / `hopp.expect(x)` as chai (`tp.expect(x).to.equal(y)`). A `to` ending in `()` replaces the whole call. */
export const MATCHERS: Record<string, string> = {
  toBe: 'to.equal',
  toEqual: 'to.eql',
  toBeLevel2xx: 'to.be.within(200, 299)',
  toBeLevel3xx: 'to.be.within(300, 399)',
  toBeLevel4xx: 'to.be.within(400, 499)',
  toBeLevel5xx: 'to.be.within(500, 599)',
  toBeType: 'to.be.a',
  toHaveLength: 'to.have.lengthOf',
  toInclude: 'to.include',
  toContain: 'to.include',
  toMatch: 'to.match',
  toHaveProperty: 'to.have.property',
  toBeTruthy: 'to.be.ok',
  toBeFalsy: 'to.not.be.ok',
  toBeNull: 'to.be.null',
  toBeUndefined: 'to.be.undefined',
  toBeGreaterThan: 'to.be.above',
  toBeLessThan: 'to.be.below',
  toBeGreaterThanOrEqual: 'to.be.at.least',
  toBeLessThanOrEqual: 'to.be.at.most',
};
/** Matchers that take no argument: the rule's `to` replaces the whole call (`toBeLevel2xx()` → `to.be.within(200, 299)`). */
const NO_ARG = new Set(['toBeLevel2xx', 'toBeLevel3xx', 'toBeLevel4xx', 'toBeLevel5xx', 'toBeTruthy', 'toBeFalsy', 'toBeNull', 'toBeUndefined']);

const TABLES: Record<RuleTool, Record<string, Rule>> = { bruno: { ...BRU_REQ_RES, ...BRU_CALLS }, thunder: THUNDER_RULES, hoppscotch: HOPPSCOTCH_RULES };
/** The roots a tool's rules start from. */
export const RULE_ROOTS: Record<RuleTool, string[]> = { bruno: ['req', 'res', 'bru'], thunder: ['tc'], hoppscotch: ['pw', 'hopp'] };

/** Member chains from the longest: `tc.response.json.token` tries `tc.response.json.token`, then `tc.response.json`, then `tc.response`. */
function lookup(table: Record<string, Rule>, root: string, path: string[]): { rule: Rule; depth: number } | undefined {
  for (let d = path.length; d >= 1; d--) {
    const rule = table[`${root}.${path.slice(0, d).join('.')}`];
    if (rule) return { rule, depth: d };
  }
  return undefined;
}

/** The node covering the root and its first `depth` links of a chain whose outermost node is `outer` with `length` links. */
function linkNode(outer: N, length: number, depth: number): N {
  let n = outer;
  for (let i = length; i > depth; i--) n = n.object;
  return n;
}

/**
 * The edit for one node, if a rule of `tool` applies to it. `text` reads the source of a node; `free` says whether the
 * root identifier is the sandbox's global (not a script variable). Call nodes are visited first, so a call with a rule is
 * replaced whole; a bare member chain gets its leading links replaced.
 */
export function ruleFor(tool: RuleTool, node: N, parent: N | undefined, key: string | undefined, text: (n: N) => string, free: (name: string) => boolean): RuleResult | undefined {
  const table = TABLES[tool];
  const roots = RULE_ROOTS[tool];

  // ---- pw.expect(x).toBe(y): the matcher after the call
  if (tool === 'hoppscotch' && node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed) {
    const name: string = node.callee.property.name;
    let base: N = node.callee.object;
    if (base.type === 'MemberExpression' && !base.computed && base.property.name === 'not') base = base.object;
    const to = MATCHERS[name];
    if (to && base.type === 'CallExpression' && base.callee.type === 'MemberExpression') {
      const ch = chainOf(base.callee);
      if (ch && (ch.root.name === 'pw' || ch.root.name === 'hopp') && ch.path.join('.') === 'expect' && free(ch.root.name)) {
        return { edit: NO_ARG.has(name) ? { start: node.callee.property.start, end: node.end, text: to } : { start: node.callee.property.start, end: node.callee.property.end, text: to } };
      }
    }
  }

  // ---- res('data.items[0].id'): Bruno's response function reads a path of the body
  if (tool === 'bruno' && node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'res' && free('res') && node.arguments.length === 1)
    return { edit: { start: node.start, end: node.end, text: `require('lodash').get(tp.response.json(), ${text(node.arguments[0])})` } };

  // ---- a call with its own rule
  if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
    const ch = chainOf(node.callee);
    if (ch && roots.includes(ch.root.name) && free(ch.root.name)) {
      const hit = table[`${ch.root.name}.${ch.path.join('.')}`];
      if (hit && 'call' in hit) {
        const raw: N[] = node.arguments;
        return { edit: { start: node.start, end: node.end, text: hit.call(raw.map(text), raw) }, skipChildren: true };
      }
      if (hit && 'lift' in hit) {
        const n = node.arguments[0];
        if (n && n.type === 'Literal' && typeof n.value === 'number') {
          const stmt = parent?.type === 'ExpressionStatement' ? parent : undefined;
          const note = `// ${text(node)}: now the request's ${hit.lift === 'timeoutMs' ? 'timeout' : 'maximum redirects'} setting`;
          return { edit: stmt ? { start: stmt.start, end: stmt.end, text: note } : { start: node.start, end: node.end, text: 'undefined' }, lift: { [hit.lift]: n.value }, skipChildren: true };
        }
        return { missing: { api: `${ch.root.name}.${ch.path.join('.')}`, at: node.start } };
      }
      if (hit && 'missing' in hit) return { missing: { api: `${ch.root.name}.${ch.path.join('.')}`, at: node.start } };
      // bru.getProcessEnv('NAME')
      if (tool === 'bruno' && ch.root.name === 'bru' && ch.path.join('.') === 'getProcessEnv') {
        const lit = literalOf(node.arguments[0]);
        if (lit) return { processEnv: lit };
      }
    }
  }

  // ---- a member chain: the leading links with a rule
  // (a chain broken by a computed link, `tc.response.json[0].id`, is handled at its longest leading part)
  if (node.type === 'MemberExpression' && !(parent?.type === 'MemberExpression' && key === 'object' && chainOf(parent))) {
    const ch = chainOf(node);
    if (ch && roots.includes(ch.root.name) && free(ch.root.name)) {
      const hit = lookup(table, ch.root.name, ch.path);
      if (hit && 'to' in hit.rule) return { edit: { start: linkNode(node, ch.path.length, hit.depth).start, end: linkNode(node, ch.path.length, hit.depth).end, text: hit.rule.to }, skipChildren: false };
      if (hit && 'missing' in hit.rule) return { missing: { api: `${ch.root.name}.${ch.path.slice(0, hit.depth).join('.')}`, at: node.start } };
    }
  }

  // ---- `test(…)` / `expect(…)` as Bruno scripts use them (globals of the shim)
  if (tool === 'bruno' && node.type === 'CallExpression' && node.callee.type === 'Identifier' && (node.callee.name === 'test' || node.callee.name === 'expect') && free(node.callee.name))
    return { edit: { start: node.callee.start, end: node.callee.end, text: `tp.${node.callee.name}` } };
  if ((tool === 'thunder' || tool === 'hoppscotch') && node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'expect' && free('expect')) return { edit: { start: node.callee.start, end: node.callee.end, text: 'tp.expect' } };
  return undefined;
}
