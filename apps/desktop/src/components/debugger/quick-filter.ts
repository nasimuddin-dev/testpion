import { matchesSpec, passesChips } from '@testpion/shared';
import type { Rule } from '../DebuggerRules';
import type { Exchange } from './model';

/**
 * A condition applied to the rows already captured, at once, when a row's menu adds a "Capture only" or "Filter out"
 * rule: `keep` shows only what matches (=), otherwise what matches is hidden (!=). The rule itself handles what comes next.
 * The matching is the engine's (one matcher in @testpion/shared): a chip hides the rows its rule will not list.
 */
export interface QuickFilter {
  id: string;
  label: string;
  keep: boolean;
  match: Rule['match'];
}

/** The columns a quick rule can name (host, URL, method, program, server address) against one exchange. */
export const matchesQuick = (e: Exchange, m: Rule['match']): boolean => matchesSpec(m, e);

/** All "Capture only" chips together keep a row if any matches; each "Filter out" chip hides what it matches. */
export const passesQuick = (e: Exchange, quick: QuickFilter[]) => passesChips(e, quick);

/** The verbs of the quick rules, as the row menu's submenus and the Rules list name them. */
const VERB = { only: 'Capture only', ignore: 'Filter out', highlight: 'Highlight' } as const;
export type QuickKind = keyof typeof VERB;

/** "Domain = x" read as its opposite, for what the click does to the view: the menu line and the chip of a Filter out. */
export const negatedLabel = (label: string) => label.replace(' = ', ' != ').replace('starts with', 'does not start with');

/** The name a quick rule is stored under: from what it MATCHES (`Filter out Domain = x`), never `!=`, so the Rules list, the file and agents read it right. */
export const quickRuleName = (kind: QuickKind, label: string) => `${VERB[kind]} ${label}`;

/** What a chip says: the condition on the rows still shown (`Domain = x` for Capture only, `Domain != x` for Filter out). */
export function chipText(q: Pick<QuickFilter, 'label' | 'keep'>): string {
  const base = q.label.replace(/^(Capture only|Filter out) /, '');
  return q.keep ? base : negatedLabel(base);
}

/** The chip's spoken name: its action is to show the rows again. */
export const chipAria = (q: Pick<QuickFilter, 'label' | 'keep'>) => `Show the rows hidden by ${chipText(q)}`;

/** The chip's hover text per kind; the rule outlives the chip. */
export const chipTitle = (q: Pick<QuickFilter, 'label' | 'keep'>) =>
  q.keep
    ? `Showing only the rows where ${chipText(q)}. Click to show every row again. The rule stays in Rules.`
    : `Hiding the rows where ${chipText({ label: q.label, keep: true })}. Click to show them again. The rule stays in Rules.`;

/** A filter as a preset stores it: the chips are a view of this window, never part of a saved preset. */
export function presetOf<F extends { quick: unknown }>(filter: F): Omit<F, 'quick'> {
  const { quick: _quick, ...rest } = filter;
  return rest;
}

/** Applying a preset keeps the chips on screen and ignores any `quick` an older preset carries. */
export function applyPreset<F extends { quick: QuickFilter[] }>(current: F, preset: Record<string, unknown>): F {
  const { quick: _quick, ...rest } = preset;
  return { ...current, ...(rest as Partial<F>), quick: current.quick };
}
