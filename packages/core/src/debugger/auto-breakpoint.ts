import type { DebuggerRule } from './rules.js';

/**
 * One-click automatic breakpoints (FG-5): Fiddler's Rules > Automatic Breakpoints. The split button of the Debugger's filter
 * strip, the `debugger_rules` tool and `testpion debugger breakpoints` all keep ONE managed rule, "Auto breakpoint", in the
 * active profile: a mode creates or replaces it, `off` removes it. Rules the person made themselves are never touched.
 */
export type AutoBreakpointMode = 'off' | 'request' | 'response' | 'post' | 'errors';

export const AUTO_BREAKPOINT_MODES: AutoBreakpointMode[] = ['off', 'request', 'response', 'post', 'errors'];
export const AUTO_BREAKPOINT_ID = 'auto-breakpoint';
export const AUTO_BREAKPOINT_NAME = 'Auto breakpoint';

/** What each mode says in words (the menu, the rules bar and the tool answer). */
export const AUTO_BREAKPOINT_LABEL: Record<AutoBreakpointMode, string> = {
  off: 'Off',
  request: 'Every request',
  response: 'Every response',
  post: 'Only POST',
  errors: 'Only errors',
};

/** The managed rule for a mode (undefined for `off`). "Errors" are responses with a status of 400 or more. */
export function autoBreakpointRule(mode: AutoBreakpointMode): DebuggerRule | undefined {
  const base = { id: AUTO_BREAKPOINT_ID, name: AUTO_BREAKPOINT_NAME, enabled: true, kind: 'breakpoint' as const };
  switch (mode) {
    case 'off':
      return undefined;
    case 'request':
      return { ...base, match: {}, breakpoint: 'request' };
    case 'response':
      return { ...base, match: {}, breakpoint: 'response' };
    case 'post':
      return { ...base, match: { method: 'POST' }, breakpoint: 'request' };
    case 'errors':
      return { ...base, match: { where: { column: 'status', op: 'greater-than', value: '399' } }, breakpoint: 'response' };
  }
}

/** Which mode the managed rule in a list is in (off when there is none or it is switched off). */
export function autoBreakpointMode(rules: DebuggerRule[]): AutoBreakpointMode {
  const r = rules.find((x) => x.id === AUTO_BREAKPOINT_ID);
  if (!r || !r.enabled) return 'off';
  if (r.breakpoint === 'response') return r.match.where ? 'errors' : 'response';
  return r.match.method === 'POST' ? 'post' : 'request';
}

/** The rules with the managed one set to a mode: replaced in place, appended when new, removed for `off`. */
export function withAutoBreakpoint(rules: DebuggerRule[], mode: AutoBreakpointMode): DebuggerRule[] {
  const rule = autoBreakpointRule(mode);
  const rest = rules.filter((r) => r.id !== AUTO_BREAKPOINT_ID);
  if (!rule) return rest;
  const i = rules.findIndex((r) => r.id === AUTO_BREAKPOINT_ID);
  return i < 0 ? [...rules, rule] : [...rules.slice(0, i), rule, ...rules.slice(i + 1)];
}

/** Breakpoint rules the person made themselves and left on: the strip says "Custom". */
export const hasCustomBreakpoint = (rules: DebuggerRule[]): boolean => rules.some((r) => r.enabled && r.kind === 'breakpoint' && r.id !== AUTO_BREAKPOINT_ID);

export function parseAutoBreakpointMode(v: unknown): AutoBreakpointMode {
  const m = String(v ?? '').trim().toLowerCase().replace(/\s+/g, '-').replace(/^every-?/, '').replace(/^only-?/, '');
  const alias: Record<string, AutoBreakpointMode> = { off: 'off', none: 'off', request: 'request', requests: 'request', response: 'response', responses: 'response', post: 'post', error: 'errors', errors: 'errors' };
  const mode = alias[m];
  if (!mode) throw new Error(`Unknown breakpoint mode "${String(v)}": use one of ${AUTO_BREAKPOINT_MODES.join(', ')}`);
  return mode;
}

/** A colour mark on an exchange (the same names a highlight uses). */
export const MARK_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'grey'] as const;

/** A note and a mark from the outside (the window, a tool, a command), checked: a note is at most 2000 characters. */
export function cleanAnnotation(a: { note?: unknown; mark?: unknown }): { note?: string; mark?: string } {
  const out: { note?: string; mark?: string } = {};
  if (a.note !== undefined) out.note = String(a.note ?? '').trim().slice(0, 2000);
  if (a.mark !== undefined) {
    const m = String(a.mark ?? '').trim().toLowerCase();
    if (m && !(MARK_COLORS as readonly string[]).includes(m)) throw new Error(`Unknown mark colour "${m}": use one of ${MARK_COLORS.join(', ')}, or an empty value to remove it`);
    out.mark = m;
  }
  return out;
}

/** Apply a cleaned annotation to an exchange: an empty note or mark removes it. */
export function annotate(e: { note?: string; mark?: string }, a: { note?: string; mark?: string }): void {
  if (a.note !== undefined) (a.note ? (e.note = a.note) : delete e.note);
  if (a.mark !== undefined) (a.mark ? (e.mark = a.mark) : delete e.mark);
}
