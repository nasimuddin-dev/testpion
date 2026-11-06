/**
 * RPC handlers: the HTTP Debugger's rules (planning/http-debugger.md, DBG-3): profiles of rules in the workspace's
 * debugger/rules.json (committed, so a team shares them), presets, breakpoints held for the window, saved filter
 * presets, and comparing two exchanges.
 */
import {
  ApsError,
  autoBreakpointMode,
  hasCustomBreakpoint,
  parseAutoBreakpointMode,
  withAutoBreakpoint,
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
  atomicWriteAsync,
  debuggerRulesFileValue,
  stableText,
  checkRuleShape,
  parseHostsFile,
} from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { debuggerSpeedHandlers } from './debugger-speed.js';
import { approveRules, changesTraffic, rulesApproved } from '../debugger-rules-trust.js';
import { newDebuggerState, type DebuggerState } from './debugger-state.js';

export interface PendingBreakpoint {
  id: string;
  phase: 'request' | 'response';
  exchange: DebuggerExchange;
  since: string;
  resolve(edits: BreakpointEdits | undefined): void;
}

const RULES_FILE = 'debugger/rules.json';
const BREAKPOINT_WAIT_MS = 120_000;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const textOrAbsent = (v: unknown) => v === undefined || typeof v === 'string';

/** Why a rule read from the file cannot be used, in words; undefined: it can. The parts the proxy reads on every request have the type it expects. */
function loadedRuleProblem(r: unknown): string | undefined {
  if (!isObject(r)) return 'a rule is an object';
  const m = r.match;
  if (!isObject(m)) return 'a rule needs what it matches (match)';
  for (const k of ['host', 'url', 'method', 'application']) if (!textOrAbsent(m[k])) return `match.${k} is text`;
  if (m.where !== undefined && !(isObject(m.where) && typeof m.where.column === 'string' && typeof m.where.op === 'string' && typeof m.where.value === 'string' && textOrAbsent(m.where.value2)))
    return 'match.where needs a column, an operator and a value';
  for (const k of ['requestHeaders', 'responseHeaders'])
    if (r[k] !== undefined && !(Array.isArray(r[k]) && (r[k] as unknown[]).every((h) => isObject(h) && typeof h.name === 'string' && textOrAbsent(h.value)))) return `${k} is a list of header edits`;
  for (const k of ['requestBody', 'responseBody', 'color']) if (!textOrAbsent(r[k])) return `${k} is text`;
  for (const k of ['reply', 'redirect', 'remap', 'fault', 'frame', 'script', 'style']) if (r[k] !== undefined && !isObject(r[k])) return `${k} is an object`;
  return undefined;
}

/**
 * What debugger/rules.json holds, checked: the file is committed and shared, so it may be hand-edited, merged badly or written by
 * another tool. A profile that is not a list and a rule that the rule check (cleanRule) refuses are left out, with a warning each,
 * rather than failing on every request the proxy forwards. undefined: the file has no profiles at all.
 */
export function checkedRulesFile(raw: unknown, warn: (message: string) => void): DebuggerRulesFile | undefined {
  if (!isObject(raw) || !isObject(raw.profiles)) return undefined;
  const profiles: Record<string, DebuggerRule[]> = {};
  for (const [name, list] of Object.entries(raw.profiles)) {
    if (!Array.isArray(list) || name === '__proto__') {
      warn(`the profile "${name}" is not a list of rules: left out`);
      continue;
    }
    const kept: DebuggerRule[] = [];
    list.forEach((r: unknown, i) => {
      try {
        const problem = loadedRuleProblem(r);
        if (problem) throw new Error(problem);
        // fields this version does not know stay in the file; the id, the name and the switch are made whole
        kept.push({ ...(r as DebuggerRule), ...cleanRule(r as DebuggerRule) });
      } catch (e) {
        warn(`rule ${i + 1} of the profile "${name}" is left out: ${(e as Error).message}`);
      }
    });
    profiles[name] = kept;
  }
  const names = Object.keys(profiles);
  if (!names.length) return undefined;
  const presets = Array.isArray(raw.filterPresets) ? raw.filterPresets.filter((p): p is { name: string; filter: Record<string, unknown> } => isObject(p) && typeof p.name === 'string' && isObject(p.filter)) : undefined;
  if (raw.filterPresets !== undefined && presets?.length !== (raw.filterPresets as unknown[]).length) warn('filter presets that are not a name with a filter are left out');
  return { active: typeof raw.active === 'string' && Object.hasOwn(profiles, raw.active) ? raw.active : names[0]!, profiles, ...(presets ? { filterPresets: presets } : {}) };
}

/** The rules file of the workspace, read once and kept on the state (the proxy asks for the active rules on every request). */
export function rulesOf(be: Backend, state: DebuggerState): DebuggerRulesFile {
  const file = be.ws.path(RULES_FILE);
  if (state.rules) {
    // a pull (or another editor) changed the file: read it again, so its rules wait for approval and a save here never writes the old copy over it
    const now = Date.now();
    if (now - (state.rulesCheckedAt ?? 0) < 2000) return state.rules;
    state.rulesCheckedAt = now;
    const s = statSync(file, { throwIfNoEntry: false });
    const sig = s ? `${s.size}:${s.mtimeMs}` : '';
    if (sig === state.rulesSig) {
      // the same file: what its rules read (a script file, a reply's files) may have changed with a pull, and that waits too
      state.rulesApproved = rulesApproved(be, state.rules);
      return state.rules;
    }
  }
  state.rulesCheckedAt = Date.now();
  state.rulesSig = ((s) => (s ? `${s.size}:${s.mtimeMs}` : ''))(statSync(file, { throwIfNoEntry: false }));
  let rules: DebuggerRulesFile | undefined;
  if (existsSync(file)) {
    try {
      rules = checkedRulesFile(JSON.parse(readFileSync(file, 'utf8')), (m) => be.logger.warn(`debugger/rules.json: ${m}`));
    } catch (e) {
      be.logger.warn(`debugger/rules.json could not be read: ${(e as Error).message}`);
    }
  }
  state.rules = rules ?? emptyRulesFile();
  if (!Object.keys(state.rules.profiles).length) state.rules.profiles.Default = defaultRules();
  // the file is shared through git: its rules that change traffic act only once allowed on this computer
  state.rulesApproved = rulesApproved(be, state.rules);
  return state.rules;
}

/** The rules the proxy applies: the active profile's, without the ones that change traffic while they wait for approval. */
export const activeRules = (be: Backend, state: DebuggerState): DebuggerRule[] => {
  const f = rulesOf(be, state);
  const rules = f.profiles[f.active] ?? [];
  return state.rulesApproved ? rules : rules.filter((r) => !changesTraffic(r));
};

/** The rules file written without holding the thread (a busy file is waited for with timers, see atomicWriteAsync). */
export async function saveRules(be: Backend, state: DebuggerState) {
  const f = rulesOf(be, state);
  await atomicWriteAsync(be.ws.path(RULES_FILE), stableText(debuggerRulesFileValue(f)));
  state.rulesSig = ((s) => (s ? `${s.size}:${s.mtimeMs}` : ''))(statSync(be.ws.path(RULES_FILE), { throwIfNoEntry: false }));
  // changed here while allowed: what was saved stays allowed (rules that came from elsewhere keep waiting until allowed)
  if (state.rulesApproved) approveRules(be, f);
  else state.rulesApproved = rulesApproved(be, f);
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

const validKinds = new Set(['ignore', 'only', 'highlight', 'modify', 'reply', 'redirect', 'breakpoint', 'remap', 'fault', 'frame', 'script']);

/** A rule as sent by the window or an agent, checked. */
export function cleanRule(r: Partial<DebuggerRule>, id?: string): DebuggerRule {
  if (!r || typeof r !== 'object') throw new ApsError('ValidationError', 'A rule is an object');
  if (!validKinds.has(String(r.kind)))
    throw new ApsError('ValidationError', `Unknown rule kind "${String(r.kind)}"`, { suggestions: ['One of ignore (filter out), only (capture only), highlight, modify, reply, redirect, breakpoint, remap, fault, frame, script.'] });
  const name = String(r.name ?? '').trim() || describeRule({ ...(r as DebuggerRule), name: '' });
  const problem = checkRuleShape(r as DebuggerRule);
  if (problem) throw new ApsError('ValidationError', problem);
  const where = r.match?.where;
  if (where) {
    if ((r.kind === 'only' || r.kind === 'ignore') && ['ip', 'status', 'type', 'duration', 'size'].includes(where.column))
      throw new ApsError('ValidationError', `Capture only and Filter out decide before the request is sent: "${where.column}" is not known yet`, { suggestions: ['Use the domain, URL, method or application, or a highlight rule.'] });
    if (where.regex || where.op === 'matches') {
      if (String(where.value).length > 500) throw new ApsError('ValidationError', 'The regular expression is too long (500 characters at most)');
      try {
        new RegExp(String(where.value));
      } catch (e) {
        throw new ApsError('ValidationError', `Not a valid regular expression: ${(e as Error).message}`);
      }
    }
  }
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
    ...(r.requestReplace?.length ? { requestReplace: r.requestReplace } : {}),
    ...(r.responseReplace?.length ? { responseReplace: r.responseReplace } : {}),
    ...(r.setStatus ? { setStatus: Number(r.setStatus) } : {}),
    ...(r.remap ? { remap: r.remap } : {}),
    ...(r.fault ? { fault: r.fault } : {}),
    ...(r.frame ? { frame: r.frame } : {}),
    ...(r.script ? { script: { ...(r.script.code !== undefined ? { code: String(r.script.code) } : {}), ...(r.script.file ? { file: String(r.script.file) } : {}), ...(r.script.timeoutMs ? { timeoutMs: Number(r.script.timeoutMs) } : {}) } } : {}),
  };
}

export function debuggerRulesHandlers(be: Backend): Handlers {
  const state: DebuggerState = (be.debugger ??= newDebuggerState());
  const file = () => rulesOf(be, state);
  const list = () => {
    const f = file();
    const rules = f.profiles[f.active] ?? [];
    return {
      active: f.active,
      profiles: Object.keys(f.profiles),
      rules: rules.map((r) => ({ ...r, summary: describeRule(r) })),
      activeCount: rules.filter((r) => r.enabled).length,
      // the filter strip's Breakpoints button: the managed rule's mode, and whether rules of the person's own also pause traffic
      autoBreakpoint: autoBreakpointMode(rules),
      customBreakpoint: hasCustomBreakpoint(rules),
      filterPresets: f.filterPresets ?? [],
      // how many requests each rule acted on in this capture
      hits: state.proxy?.ruleHits() ?? {},
      // rules that change traffic came with a pull or a clone (or were changed outside this app): they wait for "Allow on this computer"
      ...(state.rulesApproved ? {} : { needsApproval: true, waiting: Object.values(f.profiles).reduce((n, list) => n + list.filter((r) => r.enabled && changesTraffic(r)).length, 0) }),
    };
  };
  return {
    ...debuggerSpeedHandlers(be, state),
    'debug.rules': () => list(),
    /** "Allow on this computer": the rules as they are now change traffic here (debugger-rules-trust.ts). */
    'debug.approveRules': () => {
      approveRules(be, file());
      state.rulesApproved = true;
      be.host.emit('debug.rules', { active: file().active, count: activeRules(be, state).filter((r) => r.enabled).length });
      return list();
    },
    'debug.resetRuleHits': () => {
      state.proxy?.resetRuleHits();
      return list();
    },
    'debug.rulePresets': ({ host }: { host?: string } = {}) => rulePresets(host).map((p) => ({ id: p.id, label: p.label, summary: describeRule({ ...p.rule, id: p.id }) })),
    /** Host remapping (FG-4): the OS hosts file's entries as remap rules, switched off (the person turns on the ones wanted). */
    'debug.importHosts': async ({ path }: { path?: string } = {}) => {
      const hostsPath = path ?? (process.platform === 'win32' ? `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\drivers\\etc\\hosts` : '/etc/hosts');
      if (!existsSync(hostsPath)) throw new ApsError('ValidationError', `No hosts file at ${hostsPath}`);
      const f = file();
      const rules = (f.profiles[f.active] ??= []);
      const added: DebuggerRule[] = [];
      for (const h of parseHostsFile(readFileSync(hostsPath, 'utf8'))) {
        if (rules.some((r) => r.kind === 'remap' && r.match.host === h.host)) continue;
        const rule = cleanRule({ name: `Hosts file: ${h.host}`, enabled: false, kind: 'remap', match: { host: h.host }, remap: { to: h.address, preserveHost: true } });
        rules.push(rule);
        added.push(rule);
      }
      if (added.length) await saveRules(be, state);
      return { ...list(), imported: added.length, file: hostsPath };
    },
    /** Add a preset (filled in for a host when given), or save a rule (new or changed). */
    'debug.addPreset': async ({ preset, host }: { preset: string; host?: string }) => {
      const p = rulePresets(host).find((x) => x.id === preset);
      if (!p) throw new ApsError('ValidationError', `No preset "${preset}"`);
      const f = file();
      const rule = cleanRule(p.rule);
      (f.profiles[f.active] ??= []).push(rule);
      await saveRules(be, state);
      return { ...list(), rule };
    },
    'debug.saveRule': async ({ rule }: { rule: Partial<DebuggerRule> }) => {
      const f = file();
      const rules = (f.profiles[f.active] ??= []);
      const i = rule.id ? rules.findIndex((r) => r.id === rule.id) : -1;
      const clean = cleanRule(rule, i >= 0 ? rule.id : undefined);
      if (i >= 0) rules[i] = clean;
      else rules.push(clean);
      await saveRules(be, state);
      return { ...list(), rule: clean };
    },
    'debug.deleteRule': async ({ id }: { id: string }) => {
      const f = file();
      f.profiles[f.active] = (f.profiles[f.active] ?? []).filter((r) => r.id !== id);
      await saveRules(be, state);
      return list();
    },
    'debug.setRuleEnabled': async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const f = file();
      const r = (f.profiles[f.active] ?? []).find((x) => x.id === id);
      if (!r) throw new ApsError('ValidationError', 'No such rule');
      r.enabled = enabled;
      await saveRules(be, state);
      return list();
    },
    'debug.moveRule': async ({ id, to }: { id: string; to: number }) => {
      const f = file();
      const rules = f.profiles[f.active] ?? [];
      const i = rules.findIndex((r) => r.id === id);
      if (i < 0) throw new ApsError('ValidationError', 'No such rule');
      const [r] = rules.splice(i, 1);
      rules.splice(Math.max(0, Math.min(rules.length, to)), 0, r!);
      await saveRules(be, state);
      return list();
    },
    /** Profiles: a named set of rules, switched as one (Offline, Slow network, Mock payments, …). */
    'debug.profile': async ({ action, name, from }: { action: 'use' | 'create' | 'delete' | 'rename'; name: string; from?: string }) => {
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
      await saveRules(be, state);
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
        redirect: d.redirect?.host ?? (d.redirect?.rewrite ? 'the same host, another path' : undefined),
        breakpoint: d.breakpoint,
        delayMs: d.delayMs,
        fault: d.fault?.action,
        setStatus: d.setStatus,
        frames: d.frames?.length,
        requestHeaders: d.requestHeaders,
        responseHeaders: d.responseHeaders,
      };
    },

    /* ---- breakpoints */

    /** One-click automatic breakpoints (FG-5): the managed "Auto breakpoint" rule set to a mode (off removes it). */
    'debug.autoBreakpoint': async ({ mode }: { mode: string }) => {
      let m: ReturnType<typeof parseAutoBreakpointMode>;
      try {
        m = parseAutoBreakpointMode(mode);
      } catch (err) {
        throw new ApsError('ValidationError', (err as Error).message);
      }
      const f = file();
      f.profiles[f.active] = withAutoBreakpoint(f.profiles[f.active] ?? [], m);
      await saveRules(be, state);
      return list();
    },
    /** Let every held exchange go on as it was, or abort them all. */
    'debug.resumeAll': ({ abort }: { abort?: boolean } = {}) => {
      const all = [...(state.breakpoints?.values() ?? [])];
      for (const bp of all) bp.resolve(abort ? { abort: true } : undefined);
      return { released: all.length, held: state.breakpoints?.size ?? 0 };
    },

    'debug.breakpoints': () => [...(state.breakpoints?.values() ?? [])].map(({ id, phase, exchange, since }) => ({ id, phase, since, exchange })),
    /** Let a held exchange go on, with edits, as it was, or aborted. */
    'debug.resumeBreakpoint': ({ id, edits, abort }: { id: string; edits?: BreakpointEdits; abort?: boolean }) => {
      const bp = state.breakpoints?.get(id);
      if (!bp) throw new ApsError('ValidationError', 'That breakpoint is no longer held');
      bp.resolve(abort ? { abort: true } : edits);
      return { held: state.breakpoints?.size ?? 0 };
    },

    /* ---- filter presets of the traffic grid */

    'debug.saveFilterPreset': async ({ name, filter }: { name: string; filter: Record<string, unknown> }) => {
      const f = file();
      const n = name.trim();
      if (!n) throw new ApsError('ValidationError', 'A preset needs a name');
      f.filterPresets = [...(f.filterPresets ?? []).filter((p) => p.name !== n), { name: n, filter }];
      await saveRules(be, state);
      return f.filterPresets;
    },
    'debug.deleteFilterPreset': async ({ name }: { name: string }) => {
      const f = file();
      f.filterPresets = (f.filterPresets ?? []).filter((p) => p.name !== name);
      await saveRules(be, state);
      return f.filterPresets;
    },

    /* ---- compare two exchanges */

    'debug.compare': ({ a, b }: { a: string; b: string }) => {
      // in the session on screen (the live capture, or a saved session's tab)
      const shown = state.view?.() ?? state.exchanges;
      const ea = shown.find((x) => x.id === a);
      const eb = shown.find((x) => x.id === b);
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
