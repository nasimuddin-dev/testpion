/**
 * The tp.* script API as a model needs it (AI-3 / AI-6 prompts, the `script` verifier's repair hints), read from the
 * sandbox itself: a script runs once in QuickJS and lists what `tp`, `tp.response`, `tp.response.to`, its headers and a
 * `tp.expect(…)` chain really have (methods, values, flags, chain words) — so the reference cannot drift from what a
 * script can use, and a member a model invents is named as such with the closest real one.
 *
 * `scriptReference()` is the compact text added to a task's instruction; `scriptApiProblems(code)` the static check of
 * a generated script (unknown members, `pm.*`, Jest style, a field read from the raw text, a method used as a
 * property), each problem saying what to write instead. Both are built once per process (`loadScriptApi`).
 */
import { runScript } from '../scripts/sandbox.js';
import { estimateTokens } from './types.js';

export type MemberKind = 'method' | 'value' | 'object' | 'flag' | 'word' | 'modifier';

export interface ScriptMember {
  name: string;
  kind: MemberKind;
  /** A value's type on a sample response (number, string …). */
  type?: string;
}

/** What the sandbox exposes, by object. */
export interface ScriptApi {
  tp: ScriptMember[];
  response: ScriptMember[];
  /** tp.response.to (and .have / .be: the same chain). */
  responseTo: ScriptMember[];
  headers: ScriptMember[];
  /** A tp.expect(value) chain. */
  expect: ScriptMember[];
  /** tp.variables (tp.environment, tp.globals and tp.collectionVariables have the same methods and `name`). */
  variables: ScriptMember[];
  /** Members of a JavaScript string (what `tp.response.body`, the raw text, has). */
  stringMembers: string[];
}

/**
 * Lists an object's own members in the sandbox. A getter is called on two values (`a`, `b`): one that returns the same
 * chain and never throws is a chain word (to, be …), one that returns another object a modifier (not, deep), anything
 * else an assertion flag (ok, true …) — read from behaviour, not from a list.
 */
const PROBE = String.raw`
const __kinds = (make, a, b) => {
  const oa = make(a);
  const out = [];
  for (const name of Object.getOwnPropertyNames(oa)) {
    if (name.startsWith('_')) continue;
    const d = Object.getOwnPropertyDescriptor(oa, name);
    if (d && d.get) {
      const get = (v) => { try { const o = make(v); const r = o[name]; return { ok: true, same: r === o, obj: !!r && (typeof r === 'object' || typeof r === 'function') }; } catch (e) { return { ok: false }; } };
      const ra = get(a), rb = get(b);
      out.push({ name, kind: !ra.ok || !rb.ok ? 'flag' : ra.same && rb.same ? 'word' : ra.obj && !ra.same ? 'modifier' : 'flag' });
    } else {
      const v = oa[name];
      out.push({ name, kind: typeof v === 'function' ? 'method' : v && typeof v === 'object' ? 'object' : 'value', type: v === null ? 'null' : typeof v });
    }
  }
  return out;
};
const __plain = (o) => __kinds(() => o, 0, 0);
console.log(JSON.stringify({
  tp: __plain(tp),
  response: __plain(tp.response),
  headers: __plain(tp.response.headers),
  expect: __kinds((v) => tp.expect(v), true, null),
  variables: __plain(tp.variables),
  probe: __plain(tp.response.to),
}));
`;

let cached: Promise<ScriptApi> | undefined;
let ready: ScriptApi | undefined;

async function probe(status: number, body: string): Promise<Record<string, ScriptMember[]>> {
  const out = await runScript(PROBE, { variables: {}, response: { status, headers: [['content-type', 'application/json']], body, time: 12 } }, { timeoutMs: 5000, maxRequests: 0 });
  const line = out.logs.find((l) => l.startsWith('{'));
  if (out.error || !line) throw new Error(`the script sandbox could not list its API: ${out.error ?? 'no output'}`);
  return JSON.parse(line) as Record<string, ScriptMember[]>;
}

/** The sandbox's API, read once per process (see the module comment). */
export function loadScriptApi(): Promise<ScriptApi> {
  cached ??= (async () => {
    // responses that answer every flag differently (status class, JSON or not, a body or none): a getter that holds on all is a chain word
    const [a, ...others] = await Promise.all([probe(200, '{"id":1}'), probe(599, '<html>'), probe(100, '')]);
    const flags = new Set(others.flatMap((o) => o.probe!.filter((m) => m.kind === 'flag').map((m) => m.name)));
    const responseTo = a.probe!.map((m) => (m.kind === 'word' && flags.has(m.name) ? { ...m, kind: 'flag' as const } : m));
    const stringMembers = [...Object.getOwnPropertyNames(String.prototype), 'length'].filter((n) => n !== 'constructor');
    const api: ScriptApi = { tp: a.tp!, response: a.response!, responseTo, headers: a.headers!, expect: a.expect!, variables: a.variables!, stringMembers };
    ready = api;
    return api;
  })();
  cached.catch(() => (cached = undefined));
  return cached;
}

/** The API once it was read (undefined before the first `loadScriptApi()` finished). */
export const scriptApiIfLoaded = (): ScriptApi | undefined => ready;

/** Jest-style matchers the sandbox accepts for old scripts; TestPion writes chai style. Each with its chai form. */
export const JEST_TO_CHAI: Readonly<Record<string, string>> = {
  toBe: 'to.equal(v)',
  toEqual: 'to.eql(v)',
  toContain: 'to.include(v)',
  toMatch: 'to.match(re)',
  toBeTruthy: 'to.be.ok',
  toBeFalsy: 'to.not.be.ok',
  toBeDefined: 'to.exist',
  toBeUndefined: 'to.be.undefined',
  toBeNull: 'to.be.null',
  toBeGreaterThan: 'to.be.above(n)',
  toBeLessThan: 'to.be.below(n)',
  toHaveProperty: 'to.have.property(name)',
  toHaveLength: 'to.have.lengthOf(n)',
};

/** A Jest matcher of the expect chain (toObject of a scope is not one). */
const isJest = (name: string) => Object.prototype.hasOwnProperty.call(JEST_TO_CHAI, name);

/** What a member is in words: `json()`, `code (number)`, `ok`. */
const shown = (m: ScriptMember) =>
  m.kind === 'method' ? `${m.name}()` : m.kind === 'object' ? `${m.name}.…` : m.kind === 'value' && m.type && m.type !== 'undefined' ? `${m.name} (${m.type})` : m.name;

/** Notes on members that are easy to misuse (each name must exist in the sandbox: tested). */
export const MEMBER_NOTES: Readonly<Record<string, Record<string, string>>> = {
  response: { code: 'the status', status: 'the reason text', body: 'the raw text, a string', json: 'the parsed body', responseTime: 'ms, only when known' },
};

const note = (obj: string, m: ScriptMember) => {
  const n = MEMBER_NOTES[obj]?.[m.name];
  return n ? `${m.name}${m.kind === 'method' ? '()' : ''} (${n})` : shown(m);
};

/** One test that runs in the sandbox (tested): the shape every generated test should have. */
export const SCRIPT_EXAMPLE = `tp.test("returns the pet", () => {
  tp.response.to.have.status(200);
  const json = tp.response.json();
  tp.expect(json.id).to.be.a("number");
  tp.expect(json.name).to.be.a("string").and.not.be.empty;
});`;

/** The reference added to a task's instruction (see the module comment): every member listed is real. */
export function scriptReference(api: ScriptApi): string {
  const tp = api.tp.filter((m) => !['sendRequest', 'vault', 'require', 'visualizer', 'data'].includes(m.name));
  const by = (list: ScriptMember[], kind: MemberKind) => list.filter((m) => m.kind === kind && !isJest(m.name));
  return [
    'TestPion script API (read from the sandbox; anything not listed is undefined). Write tp.*, chai style:',
    `- tp: ${tp.map(shown).join(', ')}`,
    `- tp.response: ${api.response
      .filter((m) => m.name !== 'to')
      .map((m) => note('response', m))
      .join(', ')}; headers: ${by(api.headers, 'method').map(shown).join(', ')}`,
    `- tp.response.to.have / .to.be: ${[...by(api.responseTo, 'method'), ...by(api.responseTo, 'object')].map(shown).join(', ')}; flags (no call): ${by(api.responseTo, 'flag')
      .map((m) => m.name)
      .join(', ')}`,
    `- tp.expect(value): chain words ${by(api.expect, 'word')
      .map((m) => m.name)
      .join(', ')}; ${by(api.expect, 'modifier')
      .map((m) => m.name)
      .join(', ')}; methods ${by(api.expect, 'method').map(shown).join(', ')}; flags (no call) ${by(api.expect, 'flag')
      .map((m) => m.name)
      .join(', ')}`,
    `- tp.variables / tp.environment: ${by(api.variables, 'method').map(shown).join(', ')}`,
    'Example:',
    SCRIPT_EXAMPLE,
  ].join('\n');
}

/** The reference's size in tokens (a budget test keeps it small). */
export const scriptReferenceTokens = (api: ScriptApi) => estimateTokens(scriptReference(api));

/* ------------------------------------------------------------------ the static check of a generated script */

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1]!.toLowerCase() === b[j - 1]!.toLowerCase() ? 0 : 1));
  return d[a.length]![b.length]!;
}

/** The closest real member, when one is close enough to be what was meant. */
function closest(name: string, list: ScriptMember[]): ScriptMember | undefined {
  let best: ScriptMember | undefined;
  let score = Infinity;
  for (const m of list) {
    if (isJest(m.name)) continue;
    const s = distance(name, m.name) - (m.name.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(m.name.toLowerCase()) ? 2 : 0);
    if (s < score) ((score = s), (best = m));
  }
  return best && score <= Math.max(2, Math.floor(name.length / 2)) ? best : undefined;
}

const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

/** The index just after the bracket that closes the one at `open` (strings skipped), or -1. */
function closeOf(code: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  for (let i = open; i < code.length; i++) {
    const c = code[i]!;
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < code.length && code[i] !== c; i++) if (code[i] === '\\') i++;
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]!);
    else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return i + 1;
    }
  }
  return -1;
}

/** The `.member` / `.member(…)` chain from `at`: each name and whether it is called. */
function chainAt(code: string, at: number): Array<{ name: string; call: boolean }> {
  const out: Array<{ name: string; call: boolean }> = [];
  let i = at;
  for (;;) {
    const m = /^\s*\.\s*([A-Za-z_$][\w$]*)/.exec(code.slice(i));
    if (!m) return out;
    i += m[0].length;
    const call = /^\s*\(/.test(code.slice(i));
    out.push({ name: m[1]!, call });
    if (call) {
      const end = closeOf(code, code.indexOf('(', i));
      if (end < 0) return out;
      i = end;
    }
  }
}

const listOf = (list: ScriptMember[], n = 14) =>
  list
    .filter((m) => !isJest(m.name) && m.kind !== 'word')
    .slice(0, n)
    .map(shown)
    .join(', ');

/** A member used as a property though it is a method (or called though it is a flag): what to write. */
function useOf(path: string, m: ScriptMember, call: boolean): string | undefined {
  if (m.kind === 'method' && !call) return `${path}.${m.name} is a method: call it, ${path}.${m.name}(…)`;
  if (m.kind === 'flag' && call) return `${path}.${m.name} is a flag, not a method: write ${path}.${m.name} without ()`;
  return undefined;
}

/** Problems of the chain after tp.expect(…) or tp.response.to (see the module comment). */
function chainProblems(path: string, chain: Array<{ name: string; call: boolean }>, list: ScriptMember[], o: { jest?: boolean } = {}): string[] {
  const out: string[] = [];
  for (let k = 0; k < chain.length; k++) {
    const { name, call } = chain[k]!;
    const m = list.find((x) => x.name === name);
    if (m && isJest(name) && o.jest) {
      out.push(`${name}() is Jest style; TestPion scripts use chai style: tp.expect(value).${JEST_TO_CHAI[name] ?? 'to.equal(v)'}`);
      return out;
    }
    if (!m) {
      const c = closest(name, list);
      out.push(`${path}…${name} is not part of the TestPion script API${c ? `: did you mean ${shown(c)}?` : ''} (${path} has ${listOf(list)})`);
      return out;
    }
    const wrong = useOf(path, m, call);
    if (wrong) return [...out, wrong];
    // a value or a nested chain (lengthOf, a property's chain) is not ours to follow
    if (m.kind === 'value' || m.kind === 'object' || name === 'lengthOf' || name === 'length' || (m.kind === 'method' && name === 'responseTime')) return out;
  }
  return out;
}

/**
 * What is wrong with a generated script's use of the API, each with what to write instead (see the module comment).
 * Empty when it only uses real members.
 */
export function scriptApiProblems(source: string, api: ScriptApi): string[] {
  const code = stripComments(source);
  const out = new Set<string>();
  // pm.* / postman.*: the same member under tp.*
  for (const m of code.matchAll(/(^|[^\w$.])(pm|postman)\s*\.\s*([A-Za-z_$][\w$]*)((?:\s*\.\s*[A-Za-z_$][\w$]*)*)(\s*\()?/g)) {
    const rest = m[4]!.replace(/\s+/g, '');
    const tpName = m[2] === 'postman' ? (m[3] === 'setNextRequest' ? 'tp.execution.setNextRequest' : `tp.${m[3]}`) : `tp.${m[3]}${rest}`;
    out.add(`${m[2]}.${m[3]}${rest}${m[5] ? '()' : ''} is Postman's name: TestPion scripts use ${tpName}${m[5] ? '()' : ''}`);
  }
  // bare expect(…): the sandbox has it for old scripts; TestPion writes tp.expect(…)
  if (/(^|[^\w$.])expect\s*\(/.test(code)) out.add('expect(…) on its own is the old global: write tp.expect(value)');
  for (const m of code.matchAll(/(^|[^\w$.])tp\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
    const at = (m.index ?? 0) + m[0].length;
    const name = m[2]!;
    const top = api.tp.find((x) => x.name === name);
    if (!top) {
      const c = closest(name, api.tp);
      out.add(`tp.${name} is not part of the TestPion script API${c ? `: did you mean tp.${shown(c)}?` : ''} (tp has ${listOf(api.tp, 30)})`);
      continue;
    }
    if (name === 'expect') {
      const open = code.indexOf('(', at);
      const end = open >= 0 && /^\s*$/.test(code.slice(at, open)) ? closeOf(code, open) : -1;
      if (end > 0) for (const p of chainProblems('tp.expect(value)', chainAt(code, end), api.expect, { jest: true })) out.add(p);
      continue;
    }
    if (name !== 'response') continue;
    const chain = chainAt(code, at);
    const first = chain[0];
    if (!first) continue;
    const r = api.response.find((x) => x.name === first.name);
    if (!r) {
      const c = closest(first.name, api.response);
      out.add(`tp.response.${first.name} is not part of the TestPion script API${c ? `: did you mean tp.response.${shown(c)}?` : ''} (tp.response has ${listOf(api.response, 20)})`);
      continue;
    }
    const wrong = useOf('tp.response', r, first.call);
    if (wrong) {
      out.add(wrong);
      continue;
    }
    const next = chain[1];
    if (r.name === 'body' && next && !api.stringMembers.includes(next.name))
      out.add(`tp.response.body is the response text (a string), so tp.response.body.${next.name} is undefined: read a field with tp.response.json().${next.name}`);
    if (r.name === 'to') for (const p of chainProblems('tp.response.to', chain.slice(1), api.responseTo)) out.add(p);
    if (r.name === 'headers' && next) {
      const h = api.headers.find((x) => x.name === next.name);
      if (!h) {
        const c = closest(next.name, api.headers);
        out.add(`tp.response.headers.${next.name} is not part of the TestPion script API${c ? `: did you mean tp.response.headers.${shown(c)}?` : ''} (headers has ${listOf(api.headers)})`);
      }
    }
  }
  return [...out];
}
