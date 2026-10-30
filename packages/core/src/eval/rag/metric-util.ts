/** Small helpers the RAG metric checks share (metrics.ts, metrics-ir.ts, metrics-judged.ts). */
import type { CheckConfig, CheckResult } from '../../model/types.js';
import type { CheckContext } from '../checks.js';

export const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
export const text = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v));

export function result(cfg: CheckConfig, passed: boolean, message: string, extra: Partial<CheckResult> = {}): CheckResult {
  return { type: cfg.type, name: cfg.name ?? cfg.type, passed, source: 'deterministic', message, ...extra };
}

export const needsReference = (cfg: CheckConfig) =>
  result(cfg, false, `${cfg.type} needs a reference answer: add a "reference" column to the dataset (or set "expected" on the check).`, { explanation: 'No reference answer to compare with.' });

export const referenceOf = (cfg: CheckConfig, ctx: CheckContext): string | undefined => {
  const r = cfg.expected ?? ctx.expected;
  return r === undefined || r === null || r === '' ? undefined : text(r);
};

/** The gold ids: `expected` of the check as a list, else the record's reference_ids. */
export const goldIds = (cfg: CheckConfig, ctx: CheckContext): string[] | undefined => {
  const g = Array.isArray(cfg.expected) ? cfg.expected.map(String) : ctx.referenceIds;
  // an explicit empty list is an answer ("no document is right for this question"); only a missing column is undefined
  return Array.isArray(g) ? g.map(String).filter(Boolean) : undefined;
};

/** The id measures on a record that names no right document: there is nothing to find, so nothing can be missed. */
export const noGoldNeeded = (cfg: CheckConfig): CheckResult =>
  result(cfg, true, `${cfg.type}: the record names no right document (reference_ids is empty), so there is nothing to find`, { source: 'deterministic', score: 1, expected: [], metadata: { gold: 0, notApplicable: true } });

export const short = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
