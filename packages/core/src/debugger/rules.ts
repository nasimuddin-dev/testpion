import type { DebuggerExchange } from './proxy.js';

/**
 * The HTTP Debugger's rules (planning/http-debugger.md, DBG-3): what the proxy does to the traffic that matches.
 * A rule matches on the request (host, URL, method, program) and, for highlights, on the response (status, time,
 * size). Kinds: `ignore` (not listed), `highlight` (a colour on the row), `modify` (headers added / removed, a body
 * replaced, a delay), `reply` (a canned response, the server never sees it), `redirect` (another host or scheme),
 * `breakpoint` (the request or the response pauses for editing). Rules live in profiles (sets switched as one).
 */
export type DebuggerRuleKind = 'ignore' | 'highlight' | 'modify' | 'reply' | 'redirect' | 'breakpoint';

export interface RuleMatch {
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
}

export interface HeaderEdit {
  op: 'set' | 'remove';
  name: string;
  value?: string;
}

export interface DebuggerRule {
  id: string;
  name: string;
  enabled: boolean;
  kind: DebuggerRuleKind;
  match: RuleMatch;
  /** highlight: a colour name (red, orange, yellow, green, blue, purple, grey). */
  color?: string;
  /** modify: edits to the request and the response headers, a body to replace, and a delay before forwarding. */
  requestHeaders?: HeaderEdit[];
  responseHeaders?: HeaderEdit[];
  requestBody?: string;
  responseBody?: string;
  delayMs?: number;
  /** reply: the canned response. */
  reply?: { status: number; headers?: Record<string, string>; body?: string; delayMs?: number };
  /** redirect: where the request goes instead (the path stays). */
  redirect?: { host: string; scheme?: 'http' | 'https' };
  /** breakpoint: which side pauses. */
  breakpoint?: 'request' | 'response';
}

export interface DebuggerRulesFile {
  active: string;
  profiles: Record<string, DebuggerRule[]>;
  /** Saved filter presets of the traffic grid. */
  filterPresets?: Array<{ name: string; filter: Record<string, unknown> }>;
}

export const RULE_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'grey'] as const;

/** A glob (`*` any run, `?` one character) or a /regular expression/ as a RegExp; empty means anything. */
export function patternToRegExp(pattern: string | undefined): RegExp | undefined {
  const p = pattern?.trim();
  if (!p) return undefined;
  const m = /^\/(.+)\/([a-z]*)$/.exec(p);
  if (m) {
    try {
      return new RegExp(m[1]!, m[2]!.includes('i') ? m[2]! : m[2]! + 'i');
    } catch {
      return undefined;
    }
  }
  return new RegExp(
    '^' +
      p
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
    'i',
  );
}

const statusOf = (e: Pick<DebuggerExchange, 'status' | 'error'>, want: RuleMatch['status']) => {
  if (want === undefined) return true;
  const s = e.status ?? 0;
  if (typeof want === 'number') return s === want;
  return want === 'ok' ? s >= 200 && s < 300 : want === 'redirect' ? s >= 300 && s < 400 : want === 'client-error' ? s >= 400 && s < 500 : want === 'server-error' ? s >= 500 : !!e.error;
};

/** Does the rule match this exchange? Response conditions (status, time, size) wait for the response. */
export function ruleMatches(rule: DebuggerRule, e: DebuggerExchange, phase: 'request' | 'response'): boolean {
  const m = rule.match;
  const host = patternToRegExp(m.host);
  if (host && !host.test(e.host) && !host.test(e.host.replace(/:\d+$/, ''))) return false;
  const url = patternToRegExp(m.url);
  if (url && !url.test(e.url)) return false;
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
  if (app && !app.test(e.application ?? '')) return false;
  const needsResponse = m.status !== undefined || m.minMs !== undefined || m.minBytes !== undefined;
  if (needsResponse) {
    if (phase === 'request') return false;
    if (!statusOf(e, m.status)) return false;
    if (m.minMs !== undefined && (e.durationMs ?? 0) < m.minMs) return false;
    if (m.minBytes !== undefined && e.responseBodyBytes < m.minBytes) return false;
  }
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
  const where = [r.match.method, r.match.host, r.match.url, r.match.application && `from ${r.match.application}`].filter(Boolean).join(' ') || 'everything';
  switch (r.kind) {
    case 'ignore':
      return `Ignore ${where}`;
    case 'highlight': {
      const when = [
        r.match.status !== undefined && `status ${r.match.status}`,
        r.match.minMs !== undefined && `slower than ${r.match.minMs} ms`,
        r.match.minBytes !== undefined && `larger than ${r.match.minBytes} B`,
      ]
        .filter(Boolean)
        .join(', ');
      return `Highlight ${where}${when ? ` when ${when}` : ''} in ${r.color ?? 'yellow'}`;
    }
    case 'modify': {
      const what = [
        r.requestHeaders?.length && `${r.requestHeaders.length} request header${r.requestHeaders.length > 1 ? 's' : ''}`,
        r.responseHeaders?.length && `${r.responseHeaders.length} response header${r.responseHeaders.length > 1 ? 's' : ''}`,
        r.requestBody !== undefined && 'the request body',
        r.responseBody !== undefined && 'the response body',
        r.delayMs && `a ${r.delayMs} ms delay`,
      ]
        .filter(Boolean)
        .join(', ');
      return `Modify ${where}: ${what || 'nothing yet'}`;
    }
    case 'reply':
      return `Reply to ${where} with ${r.reply?.status ?? 200}${r.reply?.delayMs ? ` after ${r.reply.delayMs} ms` : ''}`;
    case 'redirect':
      return `Redirect ${where} to ${r.redirect?.scheme ? `${r.redirect.scheme}://` : ''}${r.redirect?.host ?? '?'}`;
    case 'breakpoint':
      return `Pause the ${r.breakpoint ?? 'request'} of ${where}`;
  }
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
      label: 'No caching',
      rule: {
        name: 'No cache',
        enabled: true,
        kind: 'modify',
        match,
        requestHeaders: [
          { op: 'remove', name: 'If-None-Match' },
          { op: 'remove', name: 'If-Modified-Since' },
        ],
        responseHeaders: [
          { op: 'set', name: 'Cache-Control', value: 'no-store' },
          { op: 'remove', name: 'ETag' },
        ],
      },
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
    { id: 'redirect-local', label: 'Redirect to localhost:3000', rule: { name: 'To localhost', enabled: true, kind: 'redirect', match, redirect: { host: 'localhost:3000', scheme: 'http' } } },
    { id: 'break-request', label: 'Pause every request', rule: { name: 'Breakpoint', enabled: true, kind: 'breakpoint', match, breakpoint: 'request' } },
    { id: 'ignore', label: 'Ignore (hide from the list)', rule: { name: 'Ignore', enabled: true, kind: 'ignore', match } },
    { id: 'highlight', label: 'Highlight in blue', rule: { name: 'Highlight', enabled: true, kind: 'highlight', match, color: 'blue' } },
  ];
}

export function emptyRulesFile(): DebuggerRulesFile {
  return { active: 'Default', profiles: { Default: defaultRules() } };
}

/** What the rules decide for a request before it is forwarded. */
export interface RequestDecision {
  ignore: boolean;
  highlight?: string;
  requestHeaders?: HeaderEdit[];
  requestBody?: string;
  delayMs: number;
  reply?: NonNullable<DebuggerRule['reply']>;
  redirect?: NonNullable<DebuggerRule['redirect']>;
  breakpoint?: 'request' | 'response';
  responseHeaders?: HeaderEdit[];
  responseBody?: string;
  /** The names of the rules that acted. */
  applied: string[];
}

/** Fold the active rules into one decision for this request (the first reply / redirect / breakpoint wins; edits add up). */
export function decideRequest(rules: DebuggerRule[], e: DebuggerExchange): RequestDecision {
  const d: RequestDecision = { ignore: false, delayMs: 0, applied: [] };
  for (const r of rules) {
    if (!r.enabled || !ruleMatches(r, e, 'request')) continue;
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
        d.delayMs += r.delayMs ?? 0;
        break;
      case 'reply':
        d.reply ??= r.reply ?? { status: 200 };
        break;
      case 'redirect':
        if (r.redirect?.host) d.redirect ??= r.redirect;
        break;
      case 'breakpoint':
        d.breakpoint ??= r.breakpoint ?? 'request';
        break;
    }
    d.applied.push(r.name);
  }
  return d;
}

/** Highlights that depend on the response (status, time, size), once it is in. */
export function highlightForResponse(rules: DebuggerRule[], e: DebuggerExchange): string | undefined {
  for (const r of rules) if (r.enabled && r.kind === 'highlight' && ruleMatches(r, e, 'response')) return r.color ?? 'yellow';
  return undefined;
}
