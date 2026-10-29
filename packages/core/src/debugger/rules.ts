import type { DebuggerExchange } from './proxy.js';
import { BoundedMap } from '../util/collections.js';
import { globToRegex } from '../util/glob.js';
import { compileUserRegex, safeTest } from '../util/safe-regex.js';

/**
 * The HTTP Debugger's rules (planning/http-debugger.md, DBG-3): what the proxy does to the traffic that matches.
 * A rule matches on the request (host, URL, method, program) and, for highlights, on the response (status, time,
 * size). Kinds: `ignore` (filter out: not listed), `only` (capture only: when any is on, only what one of them
 * matches is listed), `highlight` (a colour on the row), `modify` (headers added / removed, a body replaced, a delay),
 * `reply` (a canned response, the server never sees it), `redirect` (another host or scheme), `breakpoint` (the
 * request or the response pauses for editing). Rules live in profiles (sets switched as one). Every rule the user
 * makes: there is no built-in list of programs to hide.
 */
type DebuggerRuleKind = 'ignore' | 'only' | 'highlight' | 'modify' | 'reply' | 'redirect' | 'breakpoint' | 'remap' | 'fault' | 'frame' | 'script';

/** The JavaScript of a script rule (FG-21): its text or a file of the workspace, and how long a hook may run (default 100 ms). */
export interface ScriptSpec {
  code?: string;
  file?: string;
  timeoutMs?: number;
}

/** Whether the response must be held whole for this rule's `onResponse` (a script file may define it, so it is held too). */
export function scriptWantsResponse(r: Pick<DebuggerRule, 'script'>): boolean {
  const s = r.script;
  if (!s) return false;
  return s.code !== undefined ? /\bonResponse\b/.test(s.code) : true;
}

/** A find-and-replace on a body: the text as it is, or a regular expression (`$1` in `replace` is a group). */
export interface TextReplace {
  find: string;
  replace: string;
  regex?: boolean;
  ignoreCase?: boolean;
}

/** A failure to inject (FG-7): the connection dropped, no answer at all, the response cut, or an error status. `percent`: how often (default always). */
export interface FaultSpec {
  action: 'drop' | 'timeout' | 'truncate' | 'error';
  /** 1 to 100: the share of matching requests that fail. */
  percent?: number;
  /** truncate: the response body is cut after this many bytes. */
  bytes?: number;
  /** error: the status answered (default 503). */
  status?: number;
  /** timeout: how long the request hangs before the connection is closed (default 30 s, 5 minutes at most). */
  timeoutMs?: number;
}

/** What a rule does to the frames of a WebSocket connection (FG-26): drop them, change their text, pause them, or hold them back. */
export interface FrameSpec {
  /** Which way (default both): sent by the program, or received from the server. */
  direction?: 'sent' | 'received' | 'both';
  /** Only frames whose text contains this (or matches /regex/). */
  when?: string;
  action: 'drop' | 'replace' | 'break' | 'delay';
  /** replace: the text to find (empty: the whole frame) and what to put there. */
  find?: string;
  replace?: string;
  regex?: boolean;
  delayMs?: number;
}

/** A grid column a condition looks at. */
export type RuleColumn = 'status' | 'url' | 'method' | 'host' | 'application' | 'user' | 'type' | 'version' | 'ip' | 'duration' | 'size';
/** How a condition compares. */
export type RuleOperator = 'equals' | 'not-equals' | 'contains' | 'starts-with' | 'ends-with' | 'between' | 'greater-than' | 'less-than' | 'matches';

/** One condition on a column, as the Highlight Rule editor makes it: Status is between 400 and 499. */
export interface RuleCondition {
  column: RuleColumn;
  op: RuleOperator;
  value: string;
  /** The upper end of `between`. */
  value2?: string;
  /** `value` is a regular expression (any text operator then tests it). */
  regex?: boolean;
}

/** How a highlight shows: a text colour per theme (#rrggbb), bold, and on the whole row or the column only. */
export interface HighlightStyle {
  dark?: string;
  light?: string;
  bold?: boolean;
  row?: boolean;
}

interface RuleMatch {
  /** Glob on the host (with port): api.test, *.example.com, localhost:*. */
  host?: string;
  /** Glob on the whole URL, or a regular expression between slashes: /orders\/\d+/. */
  url?: string;
  /** One method, or several separated by commas / spaces. */
  method?: string;
  /** Glob on the program's name. */
  application?: string;
  /** Highlights: the response's status class or an exact status. */
  status?: 'ok' | 'redirect' | 'client-error' | 'server-error' | 'error' | number;
  /** Highlights: slower than this. */
  minMs?: number;
  /** Highlights: a response body larger than this. */
  minBytes?: number;
  /** A condition on one column (the Highlight Rule editor; any kind may use it). */
  where?: RuleCondition;
  /** Only a request that carries no `Proxy-Authorization` (the "Require proxy sign-in" preset answers it with a 407). */
  noProxyAuth?: boolean;
}

export interface HeaderEdit {
  op: 'set' | 'remove';
  name: string;
  value?: string;
}

/** A canned response; with `file` or `folder` (map local, FG-6) the body is read from the workspace when the request comes. */
export interface ReplySpec {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  delayMs?: number;
  /** A file of the workspace (relative path; `$1` is a group of the rule's /URL regex/). */
  file?: string;
  /** A folder of the workspace: the request's path (after `stripPrefix`) names the file in it. */
  folder?: string;
  stripPrefix?: string;
}

/** A redirect: another host (and scheme), and/or a changed path (Map Remote). */
export interface RedirectSpec {
  host?: string;
  scheme?: 'http' | 'https';
  /** Change the path and query: text, or a regular expression with groups (`$1`). */
  rewrite?: { from: string; to: string; regex?: boolean };
  /** Keep the original Host header and TLS name (the remap rule's switch). */
  preserveHost?: boolean;
}

export interface DebuggerRule {
  id: string;
  name: string;
  enabled: boolean;
  kind: DebuggerRuleKind;
  match: RuleMatch;
  /** highlight: a colour name (red, orange, yellow, green, blue, purple, grey). */
  color?: string;
  /** highlight: the text colours, bold, whole row (when set, it is used instead of `color`). */
  style?: HighlightStyle;
  /** modify: edits to the request and the response headers, a body to replace, and a delay before forwarding. */
  requestHeaders?: HeaderEdit[];
  responseHeaders?: HeaderEdit[];
  requestBody?: string;
  responseBody?: string;
  delayMs?: number;
  /** reply: the canned response. */
  reply?: ReplySpec;
  /** redirect: where the request goes instead (the path stays unless `rewrite` changes it). */
  redirect?: RedirectSpec;
  /** modify: find-and-replace in the bodies, and a status to answer with instead of the server's. */
  requestReplace?: TextReplace[];
  responseReplace?: TextReplace[];
  setStatus?: number;
  /** remap (FG-4): the host (the rule's Host match) is reached at another host, IP or port. */
  remap?: { to: string; scheme?: 'auto' | 'http' | 'https'; preserveHost?: boolean };
  /** fault: a failure to inject. */
  fault?: FaultSpec;
  /** frame: what happens to WebSocket frames. */
  frame?: FrameSpec;
  /** breakpoint: which side pauses. */
  breakpoint?: 'request' | 'response';
  /** script (FG-21): `onRequest(ctx)` / `onResponse(ctx)`, see script-rules.ts. */
  script?: ScriptSpec;
}

export interface DebuggerRulesFile {
  active: string;
  profiles: Record<string, DebuggerRule[]>;
  /** Saved filter presets of the traffic grid. */
  filterPresets?: Array<{ name: string; filter: Record<string, unknown> }>;
}

/**
 * A glob (`*` any run, `?` one character) or a /regular expression/ as a RegExp; empty means anything. Compiled once per
 * pattern text: a rule is checked on every request (host, URL and program, again on the response).
 */
export function patternToRegExp(pattern: string | undefined): RegExp | undefined {
  if (!pattern) return undefined;
  let re = patterns.get(pattern);
  if (re === undefined) patterns.set(pattern, (re = compilePattern(pattern.trim())));
  return re ?? undefined;
}
function compilePattern(p: string): RegExp | null {
  if (!p) return null;
  const m = /^\/(.+)\/([a-z]*)$/.exec(p);
  if (!m) return globToRegex(p);
  try {
    return compileUserRegex(m[1]!, m[2]!.includes('i') ? m[2]! : m[2]! + 'i', 'The rule');
  } catch (e) {
    // a pattern that can freeze the app (nested repetition) never matches; one that is not valid is ignored, as before
    return (e as { message?: string }).message?.includes('is refused') ? NEVER : null;
  }
}
/** Patterns of rules and filters, globs and /regular expressions/, keyed by their text; null: empty or not valid. */
const patterns = new BoundedMap<string, RegExp | null>(512); // bounded: 512 distinct patterns, the oldest goes first
const NEVER = /(?!)/;

/** Whether an exchange's status (or its failure) is what a rule or a filter asks for: a code, ok / redirect / client-error / server-error, or error. */
export function statusMatches(want: RuleMatch['status'], status: number | undefined, error: string | undefined): boolean {
  if (want === undefined) return true;
  const s = status ?? 0;
  if (typeof want === 'number') return s === want;
  return want === 'ok' ? s >= 200 && s < 300 : want === 'redirect' ? s >= 300 && s < 400 : want === 'client-error' ? s >= 400 && s < 500 : want === 'server-error' ? s >= 500 : !!error;
}

// the server's address is known once the request went out: like the response's columns, checked afterwards
const RESPONSE_COLUMNS: RuleColumn[] = ['status', 'type', 'duration', 'size', 'ip'];

/** Patterns compiled once (a rule is checked on every request), at most 200 kept; an invalid one is null. */
const compiled = new Map<string, RegExp | null>(); // bounded: cleared at 200 patterns
function regexOf(pattern: string): RegExp | null {
  let re = compiled.get(pattern);
  if (re === undefined) {
    try {
      re = compileUserRegex(pattern, 'i', 'The condition');
    } catch {
      re = null;
    }
    if (compiled.size >= 200) compiled.clear();
    compiled.set(pattern, re);
  }
  return re;
}
/** The text a condition tests, capped: a long URL or body can't make a pattern run for long. */
const MAX_TESTED = 4096;
const MAX_URL_TESTED = 16_384;

/** The value of a column for an exchange, as the grid shows it. */
function columnValue(e: DebuggerExchange, column: RuleColumn): string | number | undefined {
  switch (column) {
    case 'status':
      return e.status;
    case 'url':
      return e.url;
    case 'method':
      return e.method;
    case 'host':
      return e.host;
    case 'application':
      return e.application;
    case 'user':
      return e.user;
    case 'type':
      return e.contentType;
    case 'version':
      return e.httpVersion === '2' ? 'HTTP/2' : 'HTTP/1.1';
    case 'ip':
      return e.serverAddress;
    case 'duration':
      return e.durationMs;
    case 'size':
      return e.responseBodyBytes;
  }
}

/** Does one condition hold? Numbers compare as numbers (between is inclusive); text ignores case. */
export function conditionHolds(c: RuleCondition, e: DebuggerExchange): boolean {
  const v = columnValue(e, c.column);
  if (v === undefined || v === null) return c.op === 'not-equals';
  const text = String(v).slice(0, MAX_TESTED);
  const n = Number(v);
  const a = Number(c.value);
  const b = Number(c.value2);
  if (c.regex || c.op === 'matches') {
    const re = regexOf(c.value);
    if (!re) return false;
    const hit = safeTest(re, text).matched;
    return c.op === 'not-equals' ? !hit : hit;
  }
  const low = text.toLowerCase();
  const want = c.value.toLowerCase();
  switch (c.op) {
    case 'equals':
      return Number.isFinite(n) && c.value.trim() !== '' && Number.isFinite(a) ? n === a : low === want;
    case 'not-equals':
      return Number.isFinite(n) && c.value.trim() !== '' && Number.isFinite(a) ? n !== a : low !== want;
    case 'contains':
      return low.includes(want);
    case 'starts-with':
      return low.startsWith(want);
    case 'ends-with':
      return low.endsWith(want);
    case 'between':
      return Number.isFinite(n) && Number.isFinite(a) && Number.isFinite(b) && n >= Math.min(a, b) && n <= Math.max(a, b);
    case 'greater-than':
      return Number.isFinite(n) && Number.isFinite(a) && n > a;
    case 'less-than':
      return Number.isFinite(n) && Number.isFinite(a) && n < a;
    default:
      return false;
  }
}

/** Does the rule look at the response (its status, time, size, type or the server's address)? Then it waits for it. */
export function waitsForResponse(rule: DebuggerRule): boolean {
  const m = rule.match;
  return m.status !== undefined || m.minMs !== undefined || m.minBytes !== undefined || (!!m.where && RESPONSE_COLUMNS.includes(m.where.column));
}

/** Does the rule match this exchange? Response conditions (status, time, size) wait for the response. */
export function ruleMatches(rule: DebuggerRule, e: DebuggerExchange, phase: 'request' | 'response'): boolean {
  const m = rule.match;
  const host = patternToRegExp(m.host);
  if (host && !safeTest(host, e.host.slice(0, MAX_TESTED)).matched && !safeTest(host, e.host.replace(/:\d+$/, '').slice(0, MAX_TESTED)).matched) return false;
  const url = patternToRegExp(m.url);
  if (url && !safeTest(url, e.url.slice(0, MAX_URL_TESTED)).matched) return false;
  if (
    m.method &&
    !m.method
      .toUpperCase()
      .split(/[\s,]+/)
      .filter(Boolean)
      .includes(e.method.toUpperCase())
  )
    return false;
  const app = patternToRegExp(m.application);
  if (app && !safeTest(app, (e.application ?? '').slice(0, MAX_TESTED)).matched) return false;
  if (m.noProxyAuth && e.requestHeaders['proxy-authorization']) return false;
  if (waitsForResponse(rule)) {
    if (phase === 'request') return false;
    if (!statusMatches(m.status, e.status, e.error)) return false;
    if (m.minMs !== undefined && (e.durationMs ?? 0) < m.minMs) return false;
    if (m.minBytes !== undefined && e.responseBodyBytes < m.minBytes) return false;
  }
  if (m.where && !conditionHolds(m.where, e)) return false;
  return true;
}

/** Apply header edits to a header map (names lower-cased, as the proxy keeps them). */
export function applyHeaderEdits(headers: Record<string, string>, edits: HeaderEdit[] | undefined): Record<string, string> {
  if (!edits?.length) return headers;
  const out = { ...headers };
  for (const ed of edits) {
    const name = ed.name.trim().toLowerCase();
    if (!name) continue;
    if (ed.op === 'remove') delete out[name];
    else out[name] = ed.value ?? '';
  }
  return out;
}

/** One line that says what a rule does, for lists and the rules bar. */
export function describeRule(r: DebuggerRule): string {
  const cond = r.match.where ? describeCondition(r.match.where) : '';
  const where = [r.match.method, r.match.host, r.match.url, r.match.application && `from ${r.match.application}`, r.match.noProxyAuth && 'without proxy sign-in', cond && `where ${cond}`].filter(Boolean).join(' ') || 'everything';
  switch (r.kind) {
    case 'ignore':
      return `Filter out ${where}`;
    case 'only':
      return `Capture only ${where}`;
    case 'highlight': {
      const when = [
        r.match.status !== undefined && `status ${r.match.status}`,
        r.match.minMs !== undefined && `slower than ${r.match.minMs} ms`,
        r.match.minBytes !== undefined && `larger than ${r.match.minBytes} B`,
      ]
        .filter(Boolean)
        .join(', ');
      return `Highlight ${where}${when ? ` when ${when}` : ''} in ${r.style?.dark ?? r.style?.light ?? r.color ?? 'yellow'}${r.style?.bold ? ', bold' : ''}${r.style?.row ? ', whole row' : ''}`;
    }
    case 'modify': {
      const what = [
        r.requestHeaders?.length && `${r.requestHeaders.length} request header${r.requestHeaders.length > 1 ? 's' : ''}`,
        r.responseHeaders?.length && `${r.responseHeaders.length} response header${r.responseHeaders.length > 1 ? 's' : ''}`,
        r.requestBody !== undefined && 'the request body',
        r.responseBody !== undefined && 'the response body',
        r.requestReplace?.length && `${r.requestReplace.length} replacement${r.requestReplace.length > 1 ? 's' : ''} in the request body`,
        r.responseReplace?.length && `${r.responseReplace.length} replacement${r.responseReplace.length > 1 ? 's' : ''} in the response body`,
        r.setStatus && `status ${r.setStatus}`,
        r.delayMs && `a ${r.delayMs} ms delay`,
      ]
        .filter(Boolean)
        .join(', ');
      return `Modify ${where}: ${what || 'nothing yet'}`;
    }
    case 'reply':
      return `Reply to ${where} with ${r.reply?.file ? `the file ${r.reply.file}` : r.reply?.folder ? `a file of the folder ${r.reply.folder}` : (r.reply?.status ?? 200)}${r.reply?.delayMs ? ` after ${r.reply.delayMs} ms` : ''}`;
    case 'redirect':
      return `Redirect ${where} to ${r.redirect?.host ? `${r.redirect.scheme ? `${r.redirect.scheme}://` : ''}${r.redirect.host}` : 'the same host'}${r.redirect?.rewrite ? `, path ${r.redirect.rewrite.from} becomes ${r.redirect.rewrite.to}` : ''}`;
    case 'script':
      return `Run a script on ${where}${r.script?.file ? `: ${r.script.file}` : ''}`;
    case 'remap':
      return `Reach ${r.match.host || 'every host'} at ${r.remap?.to ?? '?'}${r.remap?.scheme && r.remap.scheme !== 'auto' ? ` over ${r.remap.scheme}` : ''}${r.remap?.preserveHost ? ', keeping the Host header' : ''}`;
    case 'fault': {
      const f = r.fault;
      const how = !f ? 'nothing yet' : f.action === 'drop' ? 'drop the connection' : f.action === 'timeout' ? 'never answer' : f.action === 'truncate' ? `cut the response after ${f.bytes ?? 0} bytes` : `answer ${f.status ?? 503}`;
      return `For ${where}: ${how}${f && f.percent !== undefined && f.percent < 100 ? ` in ${f.percent}% of requests` : ''}`;
    }
    case 'frame': {
      const f = r.frame;
      const what = !f ? 'nothing yet' : f.action === 'drop' ? 'drop' : f.action === 'break' ? 'pause' : f.action === 'delay' ? `hold back ${f.delayMs ?? 0} ms` : 'change the text of';
      return `WebSocket ${where}: ${what} ${f?.direction === 'sent' ? 'frames the program sends' : f?.direction === 'received' ? 'frames the server sends' : 'frames in both directions'}${f?.when ? ` that contain ${f.when}` : ''}`;
    }
    case 'breakpoint':
      return `Pause the ${r.breakpoint ?? 'request'} of ${where}`;
  }
}

const COLUMN_LABEL: Record<RuleColumn, string> = { status: 'Status', url: 'URL', method: 'Method', host: 'Domain', application: 'Application', user: 'User', type: 'Type', version: 'Version', ip: 'IP address', duration: 'Duration (ms)', size: 'Size (bytes)' };
const OP_LABEL: Record<RuleOperator, string> = {
  equals: 'is',
  'not-equals': 'is not',
  contains: 'contains',
  'starts-with': 'starts with',
  'ends-with': 'ends with',
  between: 'is between',
  'greater-than': 'is greater than',
  'less-than': 'is less than',
  matches: 'matches',
};

/** "Status is between 400 and 499". */
export function describeCondition(c: RuleCondition): string {
  return `${COLUMN_LABEL[c.column]} ${c.regex && c.op !== 'matches' ? 'matches' : OP_LABEL[c.op]} ${c.value}${c.op === 'between' ? ` and ${c.value2 ?? '?'}` : ''}`;
}

/** The rules a fresh profile starts with: errors, slow and large responses stand out. */
export function defaultRules(): DebuggerRule[] {
  return [
    { id: 'hl-errors', name: 'Errors', enabled: true, kind: 'highlight', match: { status: 'error' }, color: 'red' },
    { id: 'hl-5xx', name: 'Server errors', enabled: true, kind: 'highlight', match: { status: 'server-error' }, color: 'red' },
    { id: 'hl-4xx', name: 'Client errors', enabled: true, kind: 'highlight', match: { status: 'client-error' }, color: 'orange' },
    { id: 'hl-slow', name: 'Slow (over 2 s)', enabled: true, kind: 'highlight', match: { minMs: 2000 }, color: 'yellow' },
    { id: 'hl-large', name: 'Large (over 1 MB)', enabled: true, kind: 'highlight', match: { minBytes: 1024 * 1024 }, color: 'purple' },
  ];
}

/** The user agents of the "User agent" presets (what Fiddler's User-Agents menu offers, as plain words). */
export const USER_AGENTS: Array<{ id: string; label: string; value: string }> = [
  { id: 'chrome', label: 'Chrome (Windows)', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' },
  { id: 'firefox', label: 'Firefox (Windows)', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0' },
  { id: 'safari', label: 'Safari (Mac)', value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15' },
  { id: 'iphone', label: 'iPhone', value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' },
  { id: 'android', label: 'Android phone', value: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36' },
  { id: 'bot', label: 'Search bot', value: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
];

/** Ready-made rules to add with one click, filled in for a host when one is given. */
export function rulePresets(host?: string): Array<{ id: string; label: string; rule: Omit<DebuggerRule, 'id'> }> {
  const match: RuleMatch = host ? { host } : {};
  return [
    { id: 'header', label: 'Add a request header', rule: { name: 'Add a header', enabled: true, kind: 'modify', match, requestHeaders: [{ op: 'set', name: 'X-Debug', value: 'testpion' }] } },
    {
      id: 'cors',
      label: 'CORS: allow every origin',
      rule: {
        name: 'Allow CORS',
        enabled: true,
        kind: 'modify',
        match,
        responseHeaders: [
          { op: 'set', name: 'Access-Control-Allow-Origin', value: '*' },
          { op: 'set', name: 'Access-Control-Allow-Headers', value: '*' },
          { op: 'set', name: 'Access-Control-Allow-Methods', value: '*' },
        ],
      },
    },
    {
      id: 'no-cache',
      label: 'Disable caching',
      rule: {
        name: 'Disable caching',
        enabled: true,
        kind: 'modify',
        match,
        requestHeaders: [
          { op: 'remove', name: 'If-None-Match' },
          { op: 'remove', name: 'If-Modified-Since' },
          { op: 'set', name: 'Cache-Control', value: 'no-cache' },
          { op: 'set', name: 'Pragma', value: 'no-cache' },
        ],
        responseHeaders: [
          { op: 'set', name: 'Cache-Control', value: 'no-store' },
          { op: 'remove', name: 'ETag' },
        ],
      },
    },
    { id: 'no-encoding', label: 'Remove all encodings', rule: { name: 'Remove all encodings', enabled: true, kind: 'modify', match, requestHeaders: [{ op: 'remove', name: 'Accept-Encoding' }] } },
    { id: 'gzip', label: 'Ask for gzip', rule: { name: 'Ask for gzip', enabled: true, kind: 'modify', match, requestHeaders: [{ op: 'set', name: 'Accept-Encoding', value: 'gzip' }] } },
    ...USER_AGENTS.map((u) => ({ id: `ua-${u.id}`, label: `User agent: ${u.label}`, rule: { name: `User agent: ${u.label}`, enabled: true, kind: 'modify' as const, match, requestHeaders: [{ op: 'set' as const, name: 'User-Agent', value: u.value }] } })),
    {
      id: 'require-auth',
      label: 'Require proxy sign-in (plain HTTP)',
      rule: { name: 'Require proxy sign-in', enabled: true, kind: 'reply', match: { url: 'http://*', ...match, noProxyAuth: true }, reply: { status: 407, headers: { 'proxy-authenticate': 'Basic realm="TestPion"', 'content-type': 'text/plain' }, body: 'Proxy authentication required (TestPion rule)' } },
    },
    { id: 'slow', label: 'Slow network: 2 s delay', rule: { name: 'Slow down', enabled: true, kind: 'modify', match, delayMs: 2000 } },
    {
      id: 'offline',
      label: 'Offline: reply 503',
      rule: { name: 'Offline', enabled: true, kind: 'reply', match, reply: { status: 503, headers: { 'content-type': 'application/json' }, body: '{"error":"service unavailable (TestPion rule)"}' } },
    },
    {
      id: 'reply-200',
      label: 'Reply with an empty 200',
      rule: { name: 'Canned 200', enabled: true, kind: 'reply', match, reply: { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' } },
    },
    { id: 'status-500', label: 'Answer 500 instead of the real status', rule: { name: 'Status 500', enabled: true, kind: 'modify', match, setStatus: 500 } },
    { id: 'remap-local', label: 'Reach this host at localhost:3000 (keep the Host header)', rule: { name: 'Host to localhost', enabled: true, kind: 'remap', match, remap: { to: 'localhost:3000', preserveHost: true } } },
    { id: 'fault-drop', label: 'Drop the connection', rule: { name: 'Drop connection', enabled: true, kind: 'fault', match, fault: { action: 'drop' } } },
    { id: 'fault-timeout', label: 'Never answer (timeout)', rule: { name: 'Timeout', enabled: true, kind: 'fault', match, fault: { action: 'timeout' } } },
    { id: 'fault-20', label: 'Fail 20% of requests with 503', rule: { name: 'Fail 20%', enabled: true, kind: 'fault', match, fault: { action: 'error', status: 503, percent: 20 } } },
    { id: 'fault-cut', label: 'Cut each response after 1 KB', rule: { name: 'Cut responses', enabled: true, kind: 'fault', match, fault: { action: 'truncate', bytes: 1024 } } },
    { id: 'ws-drop', label: 'WebSocket: drop what the server sends', rule: { name: 'Drop server frames', enabled: true, kind: 'frame', match, frame: { direction: 'received', action: 'drop' } } },
    { id: 'ws-break', label: 'WebSocket: pause every frame', rule: { name: 'Pause frames', enabled: true, kind: 'frame', match, frame: { direction: 'both', action: 'break' } } },
    { id: 'redirect-local', label: 'Redirect to localhost:3000', rule: { name: 'To localhost', enabled: true, kind: 'redirect', match, redirect: { host: 'localhost:3000', scheme: 'http' } } },
    { id: 'break-request', label: 'Pause every request', rule: { name: 'Breakpoint', enabled: true, kind: 'breakpoint', match, breakpoint: 'request' } },
    { id: 'ignore', label: 'Filter out (hide from the list)', rule: { name: 'Filter out', enabled: true, kind: 'ignore', match } },
    { id: 'only', label: 'Capture only this', rule: { name: 'Capture only', enabled: true, kind: 'only', match } },
    { id: 'highlight', label: 'Highlight in blue', rule: { name: 'Highlight', enabled: true, kind: 'highlight', match, color: 'blue' } },
  ];
}

export function emptyRulesFile(): DebuggerRulesFile {
  return { active: 'Default', profiles: { Default: defaultRules() } };
}

/** What the rules decide for a request before it is forwarded. */
interface RequestDecision {
  ignore: boolean;
  highlight?: string;
  requestHeaders?: HeaderEdit[];
  requestBody?: string;
  delayMs: number;
  reply?: NonNullable<DebuggerRule['reply']>;
  redirect?: RedirectSpec;
  breakpoint?: 'request' | 'response';
  requestReplace?: TextReplace[];
  responseReplace?: TextReplace[];
  setStatus?: number;
  /** A failure to inject that the proxy carries out (an `error` fault is a reply instead). */
  fault?: FaultSpec;
  /** The frame rules of a WebSocket upgrade. */
  frames?: FrameSpec[];
  /** The response is held whole (rules edit it, or a fault cuts it). */
  hold: boolean;
  /** Response breakpoints that wait for the response itself (a status condition): checked when the headers arrive. */
  lateBreakpoints?: DebuggerRule[];
  responseHeaders?: HeaderEdit[];
  responseBody?: string;
  /** The script rules that matched: the proxy runs their hooks (script-rules.ts). */
  scripts?: DebuggerRule[];
  /** The names of the rules that acted, and their ids (hit counts). */
  applied: string[];
  appliedIds: string[];
}

/** Fold the active rules into one decision for this request (the first reply / redirect / breakpoint wins; edits add up). */
export function decideRequest(rules: DebuggerRule[], e: DebuggerExchange, rand: () => number = Math.random): RequestDecision {
  const d: RequestDecision = { ignore: false, delayMs: 0, hold: false, applied: [], appliedIds: [] };
  // capture only: when any is on, a request none of them matches is not listed
  const only = rules.filter((r) => r.enabled && r.kind === 'only');
  if (only.length) {
    const hit = only.filter((r) => ruleMatches(r, e, 'request'));
    if (!hit.length) return { ...d, ignore: true };
    d.appliedIds.push(...hit.map((r) => r.id));
  }
  for (const r of rules) {
    if (r.enabled && r.kind === 'breakpoint' && r.breakpoint === 'response' && waitsForResponse(r)) (d.lateBreakpoints ??= []).push(r);
    if (!r.enabled || r.kind === 'only' || !ruleMatches(r, e, 'request')) continue;
    switch (r.kind) {
      case 'ignore':
        d.ignore = true;
        break;
      case 'highlight':
        d.highlight ??= r.color ?? 'yellow';
        break;
      case 'modify':
        if (r.requestHeaders?.length) d.requestHeaders = [...(d.requestHeaders ?? []), ...r.requestHeaders];
        if (r.responseHeaders?.length) d.responseHeaders = [...(d.responseHeaders ?? []), ...r.responseHeaders];
        if (r.requestBody !== undefined) d.requestBody = r.requestBody;
        if (r.responseBody !== undefined) d.responseBody = r.responseBody;
        if (r.requestReplace?.length) d.requestReplace = [...(d.requestReplace ?? []), ...r.requestReplace];
        if (r.responseReplace?.length) d.responseReplace = [...(d.responseReplace ?? []), ...r.responseReplace];
        if (r.setStatus) d.setStatus = r.setStatus;
        d.delayMs += r.delayMs ?? 0;
        break;
      case 'reply':
        d.reply ??= replyFor(r, e);
        break;
      case 'redirect':
        if (r.redirect?.host || r.redirect?.rewrite) d.redirect ??= r.redirect;
        break;
      case 'remap':
        if (r.remap?.to) d.redirect ??= { host: r.remap.to, scheme: r.remap.scheme === 'http' || r.remap.scheme === 'https' ? r.remap.scheme : undefined, preserveHost: r.remap.preserveHost };
        break;
      case 'fault': {
        const f = r.fault;
        // a failure that happens in some of the requests only: the dice are thrown once per request
        if (!f || (f.percent !== undefined && f.percent < 100 && rand() * 100 >= f.percent)) continue;
        if (f.action === 'error') d.reply ??= { status: f.status ?? 503, headers: { 'content-type': 'text/plain' }, body: 'Failure injected by a TestPion rule' };
        else d.fault ??= f;
        break;
      }
      case 'frame':
        if (r.frame) (d.frames ??= []).push(r.frame);
        break;
      case 'breakpoint':
        d.breakpoint ??= r.breakpoint ?? 'request';
        break;
      case 'script':
        if (r.script) (d.scripts ??= []).push(r);
        if (r.script && scriptWantsResponse(r)) d.hold = true;
        break;
    }
    d.applied.push(r.name);
    d.appliedIds.push(r.id);
  }
  d.hold ||= !!(d.responseHeaders || d.responseBody !== undefined || d.responseReplace || d.setStatus || d.fault?.action === 'truncate');
  return d;
}

/** The canned response of a reply rule; a file name gets the groups of the rule's /URL regex/ (`$1`). */
function replyFor(r: DebuggerRule, e: DebuggerExchange): ReplySpec {
  const reply = r.reply ?? { status: 200 };
  if (!reply.file || !reply.file.includes('$') || !r.match.url || !/^\/.+\/[a-z]*$/.test(r.match.url.trim())) return reply;
  const m = patternToRegExp(r.match.url)?.exec(e.url.slice(0, MAX_URL_TESTED));
  return { ...reply, file: reply.file.replace(/\$(\d)/g, (_s, n: string) => m?.[Number(n)] ?? '') };
}

/** The highlight rule that matches once the response is in (its colour, style and id). */
export function highlightRuleForResponse(rules: DebuggerRule[], e: DebuggerExchange): DebuggerRule | undefined {
  return rules.find((r) => r.enabled && r.kind === 'highlight' && ruleMatches(r, e, 'response'));
}
