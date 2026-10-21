/**
 * The keys of the third release's flow blocks, as the loader reads them (pure: no runner, no I/O): `until:` (Wait until),
 * `finally:` (clean-up that always runs), `parallel:` (a parallel group), a Set variable block's `set:` and `scope:`,
 * an Assert block's `subject:`. Each reader answers the value, or a text saying what is wrong (the lint shows it at the
 * key; the loader throws it).
 */
import type { SetScope, UntilSpec } from '../model/types.js';

/** The longest a Wait until polls: one hour. */
const MAX_UNTIL_MS = 3_600_000;
/** The longest wait between two tries: ten minutes. */
const MAX_EVERY_MS = 600_000;
const UNTIL_DEFAULTS = { everyMs: 2000, timeoutMs: 60_000, backoff: 1, maxEveryMs: 30_000 } as const;
const SET_SCOPES: SetScope[] = ['run', 'environment', 'collection', 'global'];

/** `2s`, `500ms`, `1.5m`, `1h` or a number of milliseconds: the milliseconds, or a text when it is not a duration. */
export function durationMs(v: unknown, what: string): number | string {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v) : `${what} is a duration (2s, 500ms, 1m), not ${v}`;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(String(v ?? ''));
  if (!m) return `${what} is a duration (2s, 500ms, 1m), not ${JSON.stringify(v)}`;
  const unit = (m[2] ?? 'ms').toLowerCase();
  return Math.round(Number(m[1]) * (unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : unit === 's' ? 1000 : 1));
}

/** A step's `until:` ({ if, every, timeout, backoff, maxEvery }, or just the expression): undefined without one, a text when it is not one. */
export function untilOf(raw: Record<string, unknown>): UntilSpec | string | undefined {
  const u = raw.until;
  if (u === undefined || u === null) return undefined;
  const spec = typeof u === 'string' ? { if: u } : u;
  if (typeof spec !== 'object' || Array.isArray(spec)) return 'until: is { if: "<expression>", every: 2s, timeout: 60s, backoff: 1.5 } (or just the expression)';
  const s = spec as Record<string, unknown>;
  const expr = s.if ?? s.condition;
  if (expr === undefined || expr === null || String(expr).trim() === '') return 'until: needs if: the expression to wait for (e.g. until: { if: "$.status == \'done\'" })';
  const every = s.every === undefined ? UNTIL_DEFAULTS.everyMs : durationMs(s.every, 'until.every');
  if (typeof every === 'string') return every;
  if (every < 1 || every > MAX_EVERY_MS) return `until.every waits 1 ms to 10 minutes between tries, not ${String(s.every)}`;
  const timeout = s.timeout === undefined ? UNTIL_DEFAULTS.timeoutMs : durationMs(s.timeout, 'until.timeout');
  if (typeof timeout === 'string') return timeout;
  if (timeout < 1 || timeout > MAX_UNTIL_MS) return `until.timeout is 1 ms to one hour, not ${String(s.timeout)}`;
  const backoff = s.backoff === undefined ? UNTIL_DEFAULTS.backoff : Number(s.backoff);
  if (!Number.isFinite(backoff) || backoff < 1 || backoff > 10) return `until.backoff multiplies the wait after each try: 1 (the same wait) to 10, not ${JSON.stringify(s.backoff)}`;
  const maxEvery = s.maxEvery === undefined ? Math.max(every, UNTIL_DEFAULTS.maxEveryMs) : durationMs(s.maxEvery, 'until.maxEvery');
  if (typeof maxEvery === 'string') return maxEvery;
  if (maxEvery < every || maxEvery > MAX_EVERY_MS) return `until.maxEvery caps the wait between tries: from every (${every} ms) to 10 minutes`;
  return { if: String(expr).trim(), everyMs: every, timeoutMs: timeout, backoff, maxEveryMs: maxEvery };
}

/** `finally: true`: true, false, undefined, or a text when it is not a yes/no. */
export function finallyOf(raw: Record<string, unknown>): boolean | string | undefined {
  const f = raw.finally;
  if (f === undefined || f === null) return undefined;
  if (f === true || f === 'true') return true;
  if (f === false || f === 'false') return false;
  return `finally: is true (a clean-up step that runs after the others, whatever happened) or false, not ${JSON.stringify(f)}`;
}

/** `parallel: <group>` (true is the group "parallel"): the group's name, undefined, or a text when it is not one. */
export function parallelOf(raw: Record<string, unknown>): string | undefined | { problem: string } {
  const p = raw.parallel;
  if (p === undefined || p === null || p === false) return undefined;
  if (p === true) return 'parallel';
  if ((typeof p === 'string' || typeof p === 'number') && String(p).trim()) return String(p).trim();
  return { problem: `parallel: names the group of steps that may run at the same time (e.g. parallel: lookups), not ${JSON.stringify(p)}` };
}

/** The longest `pace:` waits between two paced steps: one minute. */
const MAX_PACE_MS = 60_000;

/** `pace: 250ms`: the least time between the starts of two paced steps of a run (a rate limit: 250ms is four requests a second), in ms; undefined, or a text when it is not a duration. */
export function paceOf(raw: Record<string, unknown>): number | string | undefined {
  const p = raw.pace ?? raw.paceMs;
  if (p === undefined || p === null || p === false) return undefined;
  const ms = durationMs(p, 'pace');
  if (typeof ms === 'string') return ms;
  return ms < 1 || ms > MAX_PACE_MS ? `pace: is 1 ms to one minute between two requests (pace: 250ms), not ${JSON.stringify(p)}` : ms;
}

/** A Set variable block's scope (default run), or a text when it is not one. */
export function setScopeOf(raw: Record<string, unknown>): SetScope | { problem: string } {
  const s = raw.scope ?? 'run';
  const v = String(s).toLowerCase();
  const alias: Record<string, SetScope> = { runtime: 'run', globals: 'global', env: 'environment', collectionvariables: 'collection' };
  const scope = (alias[v] ?? v) as SetScope;
  return SET_SCOPES.includes(scope) ? scope : { problem: `scope: is ${SET_SCOPES.join(', ')} (where the values are written), not ${JSON.stringify(s)}` };
}

/** The problems of the control keys of a step, in the order the lint reports them (the loader throws the first). */
export function controlProblems(raw: Record<string, unknown>, type: string): Array<{ key: string; message: string }> {
  const out: Array<{ key: string; message: string }> = [];
  const until = untilOf(raw);
  if (typeof until === 'string') out.push({ key: 'until', message: until });
  else if (until && (raw.repeat !== undefined || raw.forEach !== undefined || raw.for_each !== undefined))
    out.push({ key: 'until', message: 'A step has until: or a loop (repeat: / forEach:), not both: poll in one step, loop in another' });
  else if (until && ['condition', 'set', 'assert', 'log', 'delay', 'script'].includes(type)) out.push({ key: 'until', message: `until: polls a request; a ${type} step has none to run again` });
  const pace = paceOf(raw);
  if (typeof pace === 'string') out.push({ key: 'pace', message: pace });
  const fin = finallyOf(raw);
  if (typeof fin === 'string') out.push({ key: 'finally', message: fin });
  const par = parallelOf(raw);
  if (par && typeof par === 'object') out.push({ key: 'parallel', message: par.problem });
  else if (par && fin === true) out.push({ key: 'parallel', message: 'A finally step runs after the others, one at a time: leave out parallel:' });
  return out;
}
