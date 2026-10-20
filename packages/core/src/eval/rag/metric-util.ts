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
  return g?.length ? g : undefined;
};

export const short = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
