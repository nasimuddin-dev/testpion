import type { Rule } from '../DebuggerRules';
import type { Exchange } from './model';

/**
 * A condition applied to the rows already captured, at once, when a row's menu adds a "Capture only" or "Filter out"
 * rule: `keep` shows only what matches (=), otherwise what matches is hidden (!=). The rule itself handles what comes next.
 */
export interface QuickFilter {
  id: string;
  label: string;
  keep: boolean;
  match: Rule['match'];
}

const escapeRe = (t: string) => t.replace(/[.+?^$()|{}[\]\\]/g, (c) => '\\' + c);
const glob = (pattern: string, text: string) => new RegExp('^' + escapeRe(pattern).replace(/\*/g, '.*') + '$', 'i').test(text);

/** The columns a quick rule can name (host, URL start, method, program, server address) against one exchange. */
export function matchesQuick(e: Exchange, m: Rule['match']): boolean {
  if (m.host && !glob(m.host, e.host)) return false;
  if (m.url && !glob(m.url, e.url)) return false;
  if (m.method && e.method.toUpperCase() !== m.method.toUpperCase()) return false;
  if (m.application && (e.application ?? '') !== m.application) return false;
  if (m.where?.column === 'ip' && (e.serverAddress ?? '') !== m.where.value) return false;
  return true;
}

export const passesQuick = (e: Exchange, quick: QuickFilter[]) => quick.every((q) => matchesQuick(e, q.match) === q.keep);
