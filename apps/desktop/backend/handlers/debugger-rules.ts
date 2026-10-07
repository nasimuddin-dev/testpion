/**
 * RPC handlers: the HTTP Debugger's rules (planning/http-debugger.md, DBG-3): profiles of rules in the workspace's
 * debugger/rules.json (committed, so a team shares them), presets, breakpoints held for the window, saved filter
 * presets, and comparing two exchanges.
 */
import {
  ApsError,
  decideRequest,
  defaultRules,
  describeRule,
  diffResponses,
  emptyRulesFile,
  rulePresets,
  shortId,
  type BreakpointEdits,
  type DebuggerExchange,
  type DebuggerRule,
  type DebuggerRulesFile,
} from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { DebuggerState } from './debugger.js';

export interface PendingBreakpoint {
  id: string;
  phase: 'request' | 'response';
  exchange: DebuggerExchange;
  since: string;
  resolve(edits: BreakpointEdits | undefined): void;
}

const RULES_FILE = 'debugger/rules.json';
const BREAKPOINT_WAIT_MS = 120_000;

/** The rules file of the workspace, read once and kept on the state (the proxy asks for the active rules on every request). */
export function rulesOf(be: Backend, state: DebuggerState): DebuggerRulesFile {
  if (state.rules) return state.rules;
  const file = be.ws.path(RULES_FILE);
  let rules: DebuggerRulesFile | undefined;
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<DebuggerRulesFile>;
      if (raw && typeof raw === 'object' && raw.profiles && typeof raw.profiles === 'object')
        rules = { active: raw.active && raw.profiles[raw.active] ? raw.active : (Object.keys(raw.profiles)[0] ?? 'Default'), profiles: raw.profiles, filterPresets: raw.filterPresets };
    } catch (e) {
      be.logger.warn(`debugger/rules.json could not be read: ${(e as Error).message}`);
    }
  }
  state.rules = rules ?? emptyRulesFile();
  if (!Object.keys(state.rules.profiles).length) state.rules.profiles.Default = defaultRules();
  return state.rules;
}

export const activeRules = (be: Backend, state: DebuggerState): DebuggerRule[] => {
  const f = rulesOf(be, state);
  return f.profiles[f.active] ?? [];
};

function save(be: Backend, state: DebuggerState) {
  const f = rulesOf(be, state);
  mkdirSync(be.ws.path('debugger'), { recursive: true });
  be.lastOwnChange = Date.now(); // our own write: not news for the "changed outside TestPion" notice
  writeFileSync(be.ws.path(RULES_FILE), JSON.stringify(f, null, 2) + '\n');
  be.host.emit('debug.rules', { active: f.active, count: (f.profiles[f.active] ?? []).filter((r) => r.enabled).length });
}

/** The proxy hit a breakpoint: hold the exchange for the window (two minutes at most, then it goes on as it was). */
export function holdBreakpoint(be: Backend, state: DebuggerState, e: DebuggerExchange, phase: 'request' | 'response'): Promise<BreakpointEdits | undefined> {
  state.breakpoints ??= new Map();
  return new Promise((resolve) => {
    const id = shortId('bp-');
    const timer = setTimeout(() => {
      state.breakpoints?.delete(id);
      be.host.emit('debug.breakpoint', { id, released: true });
      resolve(undefined);
    }, BREAKPOINT_WAIT_MS);
    state.breakpoints!.set(id, {
      id,
      phase,
      exchange: e,
      since: new Date().toISOString(),
      resolve: (edits) => {
        clearTimeout(timer);
        state.breakpoints?.delete(id);
        be.host.emit('debug.breakpoint', { id, released: true });
        resolve(edits);
      },
    });
    be.host.emit('debug.breakpoint', { id, phase, exchange: e });
  });
}

const validKinds = new Set(['ignore', 'only', 'highlight', 'modify', 'reply', 'redirect', 'breakpoint']);

/** A rule as sent by the window or an agent, checked. */
function cleanRule(r: Partial<DebuggerRule>, id?: string): DebuggerRule {
  if (!r || typeof r !== 'object') throw new ApsError('ValidationError', 'A rule is an object');
  if (!validKinds.has(String(r.kind)))
    throw new ApsError('ValidationError', `Unknown rule kind "${String(r.kind)}"`, { suggestions: ['One of ignore (filter out), only (capture only), highlight, modify, reply, redirect, breakpoint.'] });
  const name = String(r.name ?? '').trim() || describeRule({ ...(r as DebuggerRule), name: '' });
  if (r.kind === 'redirect' && !r.redirect?.host?.trim()) throw new ApsError('ValidationError', 'A redirect rule needs a host (host:port)');
  if (r.kind === 'reply' && r.reply && (typeof r.reply.status !== 'number' || r.reply.status < 100 || r.reply.status > 599))
    throw new ApsError('ValidationError', 'A reply needs a status between 100 and 599');
  return {
    id: id ?? r.id ?? shortId('rule-'),
    name,
    enabled: r.enabled !== false,
    kind: r.kind as DebuggerRule['kind'],
    match: { ...(r.match ?? {}) },
    ...(r.color !== undefined ? { color: r.color } : {}),
    ...(r.style ? { style: { ...r.style } } : {}),
    ...(r.requestHeaders ? { requestHeaders: r.requestHeaders } : {}),
    ...(r.responseHeaders ? { responseHeaders: r.responseHeaders } : {}),
    ...(r.requestBody !== undefined ? { requestBody: r.requestBody } : {}),
    ...(r.responseBody !== undefined ? { responseBody: r.responseBody } : {}),
    ...(r.delayMs ? { delayMs: Number(r.delayMs) } : {}),
    ...(r.reply ? { reply: r.reply } : {}),
    ...(r.redirect ? { redirect: r.redirect } : {}),
    ...(r.breakpoint ? { breakpoint: r.breakpoint } : {}),
  };
}

export function debuggerRulesHandlers(be: Backend): Handlers {
  const state: DebuggerState = (be.debugger ??= { exchanges: [] });
  const file = () => rulesOf(be, state);
  const list = () => {
    const f = file();
    const rules = f.profiles[f.active] ?? [];
    return {
      active: f.active,
      profiles: Object.keys(f.profiles),
      rules: rules.map((r) => ({ ...r, summary: describeRule(r) })),
      activeCount: rules.filter((r) => r.enabled).length,
      filterPresets: f.filterPresets ?? [],
      // how many requests each rule acted on in this capture
      hits: state.proxy?.ruleHits() ?? {},
    };
  };
  return {
    'debug.rules': () => list(),
    'debug.resetRuleHits': () => {
      state.proxy?.resetRuleHits();
      return list();
    },
    'debug.rulePresets': ({ host }: { host?: string } = {}) => rulePresets(host).map((p) => ({ id: p.id, label: p.label, summary: describeRule({ ...p.rule, id: p.id }) })),
    /** Add a preset (filled in for a host when given), or save a rule (new or changed). */
    'debug.addPreset': ({ preset, host }: { preset: string; host?: string }) => {
      const p = rulePresets(host).find((x) => x.id === preset);
      if (!p) throw new ApsError('ValidationError', `No preset "${preset}"`);
      const f = file();
      const rule = cleanRule(p.rule);
      (f.profiles[f.active] ??= []).push(rule);
      save(be, state);
      return { ...list(), rule };
    },
    'debug.saveRule': ({ rule }: { rule: Partial<DebuggerRule> }) => {
      const f = file();
      const rules = (f.profiles[f.active] ??= []);
      const i = rule.id ? rules.findIndex((r) => r.id === rule.id) : -1;
      const clean = cleanRule(rule, i >= 0 ? rule.id : undefined);
      if (i >= 0) rules[i] = clean;
      else rules.push(clean);
      save(be, state);
      return { ...list(), rule: clean };
    },
    'debug.deleteRule': ({ id }: { id: string }) => {
      const f = file();
      f.profiles[f.active] = (f.profiles[f.active] ?? []).filter((r) => r.id !== id);
      save(be, state);
      return list();
    },
    'debug.setRuleEnabled': ({ id, enabled }: { id: string; enabled: boolean }) => {
      const f = file();
      const r = (f.profiles[f.active] ?? []).find((x) => x.id === id);
      if (!r) throw new ApsError('ValidationError', 'No such rule');
      r.enabled = enabled;
      save(be, state);
      return list();
    },
    'debug.moveRule': ({ id, to }: { id: string; to: number }) => {
      const f = file();
      const rules = f.profiles[f.active] ?? [];
      const i = rules.findIndex((r) => r.id === id);
      if (i < 0) throw new ApsError('ValidationError', 'No such rule');
      const [r] = rules.splice(i, 1);
      rules.splice(Math.max(0, Math.min(rules.length, to)), 0, r!);
      save(be, state);
      return list();
    },
    /** Profiles: a named set of rules, switched as one (Offline, Slow network, Mock payments, …). */
    'debug.profile': ({ action, name, from }: { action: 'use' | 'create' | 'delete' | 'rename'; name: string; from?: string }) => {
      const f = file();
      const n = name.trim();
      if (!n) throw new ApsError('ValidationError', 'A profile needs a name');
      if (action === 'use') {
        if (!f.profiles[n]) throw new ApsError('ValidationError', `No profile "${n}"`);
        f.active = n;
      } else if (action === 'create') {
        if (f.profiles[n]) throw new ApsError('ValidationError', `A profile "${n}" exists`);
        f.profiles[n] = from && f.profiles[from] ? f.profiles[from]!.map((r) => ({ ...r, id: shortId('rule-') })) : defaultRules();
        f.active = n;
      } else if (action === 'delete') {
        if (Object.keys(f.profiles).length <= 1) throw new ApsError('ValidationError', 'The last profile stays');
        delete f.profiles[n];
        if (f.active === n) f.active = Object.keys(f.profiles)[0]!;
      } else if (action === 'rename') {
        if (!from || !f.profiles[from]) throw new ApsError('ValidationError', `No profile "${from ?? ''}"`);
        f.profiles[n] = f.profiles[from]!;
        delete f.profiles[from];
        if (f.active === from) f.active = n;
      }
      save(be, state);
      return list();
    },
    /** What the active rules would do to a request like this one (the Rules tab's "test a URL"). */
    'debug.ruleCheck': ({ method = 'GET', url, application }: { method?: string; url: string; application?: string }) => {
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        throw new ApsError('ValidationError', 'A full URL, with http:// or https://');
      }
      const e: DebuggerExchange = {
        id: 'check',
        startedAt: new Date().toISOString(),
        kind: 'http',
        method: method.toUpperCase(),
        url: u.href,
        host: u.host,
        clientPort: 0,
        application,
        requestHeaders: {},
        requestBodyBytes: 0,
        responseBodyBytes: 0,
      };
      const d = decideRequest(activeRules(be, state), e);
      return {
        applied: d.applied,
        ignore: d.ignore,
        highlight: d.highlight,
        reply: d.reply?.status,
        redirect: d.redirect?.host,
        breakpoint: d.breakpoint,
        delayMs: d.delayMs,
        requestHeaders: d.requestHeaders,
        responseHeaders: d.responseHeaders,
      };
    },

    /* ---- breakpoints */

    'debug.breakpoints': () => [...(state.breakpoints?.values() ?? [])].map(({ id, phase, exchange, since }) => ({ id, phase, since, exchange })),
    /** Let a held exchange go on, with edits, as it was, or aborted. */
    'debug.resumeBreakpoint': ({ id, edits, abort }: { id: string; edits?: BreakpointEdits; abort?: boolean }) => {
      const bp = state.breakpoints?.get(id);
      if (!bp) throw new ApsError('ValidationError', 'That breakpoint is no longer held');
      bp.resolve(abort ? { abort: true } : edits);
      return { held: state.breakpoints?.size ?? 0 };
    },
    'debug.resumeAll': () => {
      for (const bp of [...(state.breakpoints?.values() ?? [])]) bp.resolve(undefined);
      return { held: 0 };
    },

    /* ---- filter presets of the traffic grid */

    'debug.saveFilterPreset': ({ name, filter }: { name: string; filter: Record<string, unknown> }) => {
      const f = file();
      const n = name.trim();
      if (!n) throw new ApsError('ValidationError', 'A preset needs a name');
      f.filterPresets = [...(f.filterPresets ?? []).filter((p) => p.name !== n), { name: n, filter }];
      save(be, state);
      return f.filterPresets;
    },
    'debug.deleteFilterPreset': ({ name }: { name: string }) => {
      const f = file();
      f.filterPresets = (f.filterPresets ?? []).filter((p) => p.name !== name);
      save(be, state);
      return f.filterPresets;
    },

    /* ---- compare two exchanges */

    'debug.compare': ({ a, b }: { a: string; b: string }) => {
      const ea = state.exchanges.find((x) => x.id === a);
      const eb = state.exchanges.find((x) => x.id === b);
      if (!ea || !eb) throw new ApsError('ValidationError', 'Both exchanges must be in the session');
      const red = be.logger.redactor;
      const comparable = (e: DebuggerExchange) => ({
        status: e.error ? `error: ${e.error}` : e.status,
        durationMs: e.durationMs,
        size: e.responseBodyBytes,
        headers: Object.entries(e.responseHeaders ?? {}).map(([k, v]) => [k, red.isSensitiveKey(k) ? '***' : v] as [string, string]),
        body: e.responseBody ? red.redactString(e.responseBody) : undefined,
      });
      return {
        before: { id: ea.id, timestamp: ea.startedAt, status: ea.status, label: `${ea.method} ${red.redactUrl(ea.url)}` },
        after: { id: eb.id, timestamp: eb.startedAt, status: eb.status, label: `${eb.method} ${red.redactUrl(eb.url)}` },
        diff: diffResponses(comparable(ea), comparable(eb)),
        bodyMissing: !!(ea.responseBodyTruncated || eb.responseBodyTruncated || (ea.responseBodyBytes && !ea.responseBody) || (eb.responseBodyBytes && !eb.responseBody)),
      };
    },
  };
}
