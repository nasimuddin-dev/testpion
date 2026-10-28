/**
 * One matcher for the HTTP Debugger's "what does this rule name" question, used by the window's quick filters (the chips)
 * and checked against the engine's `ruleMatches` by a parity test: a rule and the chip made from it hide the same rows.
 * Pure and browser-safe. Glob: `*` any run, `?` one character, case-insensitive, the whole text; a pattern between slashes
 * (`/orders\/\d+/`) is a regular expression, refused when it has a shape that can run for minutes (nested repetition).
 */

/** The part of a rule's match this matcher knows (the request side: host, URL, method, program, and a text condition). */
export interface DebuggerMatchSpec {
  host?: string;
  url?: string;
  method?: string;
  application?: string;
  where?: { column: string; op: string; value: string; regex?: boolean };
}

/** The part of an exchange this matcher reads. */
export interface DebuggerMatchRow {
  host: string;
  url: string;
  method: string;
  application?: string;
  user?: string;
  serverAddress?: string;
  contentType?: string;
}

/** A chip: "Capture only" (`keep`) or "Filter out" (not `keep`) applied to the rows already captured. */
export interface DebuggerChipLike {
  keep: boolean;
  match: DebuggerMatchSpec;
}

const MAX_TESTED = 4096;
const MAX_URL_TESTED = 16_384;
const MAX_PATTERN = 500;
const CACHE_SIZE = 200;
const NEVER = /(?!)/;

// bounded: least recently used, at most CACHE_SIZE compiled patterns (one per distinct rule or chip pattern)
const compiled = new Map<string, RegExp | null>();

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Nested repetition such as `(a+)+`: the classic shape that freezes a regular expression engine. */
const UNSAFE = /\([^)]*[+*][^)]*\)[+*{]|\([^)]*\{\d*,\d*\}[^)]*\)[+*{]/;

function build(p: string): RegExp | null {
  const m = /^\/(.+)\/([a-z]*)$/.exec(p);
  if (m) {
    if (m[1]!.length > MAX_PATTERN || UNSAFE.test(m[1]!)) return NEVER;
    try {
      return new RegExp(m[1]!, m[2]!.includes('i') ? m[2]! : m[2]! + 'i');
    } catch {
      return null; // not valid: ignored, as the engine ignores it
    }
  }
  let re = '';
  for (const c of p) re += c === '*' ? '.*' : c === '?' ? '.' : escapeRe(c);
  return new RegExp(`^${re}$`, 'i');
}

/** A glob (or /regex/) as a RegExp; empty means anything (undefined). Compiled once and kept in a small LRU. */
export function patternRegExp(pattern: string | undefined): RegExp | undefined {
  const p = pattern?.trim();
  if (!p) return undefined;
  let re = compiled.get(p);
  if (re === undefined) {
    re = build(p);
    if (compiled.size >= CACHE_SIZE) compiled.delete(compiled.keys().next().value as string);
  } else compiled.delete(p); // re-inserted below: most recently used last
  compiled.set(p, re);
  return re ?? undefined;
}

const test = (re: RegExp, text: string) => {
  re.lastIndex = 0;
  return re.test(text);
};

/** A host glob matches the host with its port, or without it. */
export function hostMatches(pattern: string | undefined, host: string): boolean {
  const re = patternRegExp(pattern);
  if (!re) return true;
  return test(re, host.slice(0, MAX_TESTED)) || test(re, host.replace(/:\d+$/, '').slice(0, MAX_TESTED));
}

/** A method pattern is one method or a list separated by commas or spaces. */
export function methodMatches(pattern: string | undefined, method: string): boolean {
  if (!pattern) return true;
  return pattern
    .toUpperCase()
    .split(/[\s,]+/)
    .filter(Boolean)
    .includes(method.toUpperCase());
}

function columnText(r: DebuggerMatchRow, column: string): string | undefined {
  switch (column) {
    case 'url':
      return r.url;
    case 'method':
      return r.method;
    case 'host':
      return r.host;
    case 'application':
      return r.application;
    case 'user':
      return r.user;
    case 'type':
      return r.contentType;
    case 'ip':
      return r.serverAddress;
    default:
      return undefined;
  }
}

/** A text condition on a column (equals, not equals, contains, starts with, ends with), case-insensitive. */
function conditionHolds(c: NonNullable<DebuggerMatchSpec['where']>, r: DebuggerMatchRow): boolean {
  const v = columnText(r, c.column);
  if (v === undefined || v === null) return c.op === 'not-equals';
  const text = v.slice(0, MAX_TESTED);
  if (c.regex || c.op === 'matches') {
    const re = patternRegExp(`/${c.value}/`);
    if (!re) return false;
    const hit = test(re, text);
    return c.op === 'not-equals' ? !hit : hit;
  }
  const low = text.toLowerCase();
  const want = c.value.toLowerCase();
  const n = Number(text);
  const a = Number(c.value);
  const numeric = Number.isFinite(n) && c.value.trim() !== '' && Number.isFinite(a);
  switch (c.op) {
    case 'equals':
      return numeric ? n === a : low === want;
    case 'not-equals':
      return numeric ? n !== a : low !== want;
    case 'contains':
      return low.includes(want);
    case 'starts-with':
      return low.startsWith(want);
    case 'ends-with':
      return low.endsWith(want);
    default:
      return false;
  }
}

/** Does a rule's match hold for an exchange that already has its response (what the window shows)? */
export function matchesSpec(m: DebuggerMatchSpec, r: DebuggerMatchRow): boolean {
  if (m.host && !hostMatches(m.host, r.host)) return false;
  const url = patternRegExp(m.url);
  if (url && !test(url, r.url.slice(0, MAX_URL_TESTED))) return false;
  if (!methodMatches(m.method, r.method)) return false;
  const app = patternRegExp(m.application);
  if (app && !test(app, (r.application ?? '').slice(0, MAX_TESTED))) return false;
  if (m.where && !conditionHolds(m.where, r)) return false;
  return true;
}

/**
 * Do the chips keep this row? As in the engine: when any "Capture only" chip exists, a row passes if ANY of them matches;
 * every "Filter out" chip excludes what it matches.
 */
export function passesChips(r: DebuggerMatchRow, chips: readonly DebuggerChipLike[]): boolean {
  let anyOnly = false;
  let onlyHit = false;
  for (const c of chips) {
    const hit = matchesSpec(c.match, r);
    if (c.keep) {
      anyOnly = true;
      if (hit) onlyHit = true;
    } else if (hit) return false;
  }
  return !anyOnly || onlyHit;
}
