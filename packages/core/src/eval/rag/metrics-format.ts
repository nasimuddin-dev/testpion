/**
 * The shape of the answer and what judging it cost, as catalogue rows (planning/rag-testing.md §2.3 types 5.4, 5.12, 5.13 and
 * 11.5): `answer-regex`, `answer-length`, `answer-json-schema` and `judge-cost`. The older checks `regex`, `length` and
 * `json-schema` read a response and answer pass or fail; these read the ANSWER of a RAG sample and score it 1 or 0 so a
 * matrix column has a number. `judge-cost` is the spend of the other metrics of the same sample: scoreRagSample fills it in
 * once they have run (a check alone cannot see its neighbours), and it says so when it is asked on its own.
 */
import type { CheckConfig, CheckResult } from '../../model/types.js';
import { registerCheck, validateSchema, type CheckContext } from '../checks.js';
import { tryParseJson } from '../../util/jsonpath.js';
import { result, short } from './metric-util.js';
import { na } from './judged-kit.js';

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);

registerCheck('answer-regex', (cfg, ctx) => {
  const pattern = String(cfg.pattern ?? cfg.expected ?? '');
  if (!pattern) return result(cfg, false, 'answer-regex needs a pattern: set "pattern" on the check.', { explanation: 'No pattern.' });
  let re: RegExp;
  try {
    re = new RegExp(pattern, String(cfg.flags ?? ''));
  } catch (e) {
    return result(cfg, false, `invalid regex: ${(e as Error).message}`);
  }
  const negate = cfg.not === true || cfg.negate === true;
  const found = re.test(ctx.text);
  const ok = negate ? !found : found;
  return result(cfg, ok, ok ? (negate ? `answer-regex 1: the answer does not match /${pattern}/` : `answer-regex 1: the answer matches /${pattern}/`) : negate ? `answer-regex 0: the answer matches /${pattern}/ but must not` : `answer-regex 0: the answer does not match /${pattern}/`, {
    source: 'heuristic',
    score: ok ? 1 : 0,
    actual: short(ctx.text, 300),
    metadata: { metric: 'answer-regex', pattern, negate, threshold: 1 },
  });
});

/** How long the answer is, in the unit asked for (tokens are about four characters). */
export function answerSize(text: string, unit: string): number {
  if (unit === 'words') return (text.match(/\S+/g) ?? []).length;
  if (unit === 'tokens') return Math.ceil(text.length / 4);
  return text.length;
}

registerCheck('answer-length', (cfg, ctx) => {
  const unit = ['characters', 'words', 'tokens'].includes(String(cfg.unit)) ? String(cfg.unit) : 'words';
  const min = num(cfg.min);
  const max = num(cfg.max);
  if (min === undefined && max === undefined) return result(cfg, false, 'answer-length needs a bound: set "min" and/or "max" on the check.', { explanation: 'No bound.' });
  const size = answerSize(ctx.text, unit);
  const ok = (min === undefined || size >= min) && (max === undefined || size <= max);
  const bounds = [min !== undefined ? `at least ${min}` : '', max !== undefined ? `at most ${max}` : ''].filter(Boolean).join(' and ');
  return result(cfg, ok, `answer-length ${ok ? 1 : 0}: ${size} ${unit}, ${bounds}`, { source: 'heuristic', score: ok ? 1 : 0, actual: size, expected: { min, max }, metadata: { metric: 'answer-length', unit, size, min, max, threshold: 1 } });
});

/** The JSON in an answer: the whole text, or what a code fence holds. */
export function jsonOfAnswer(text: string): { ok: true; value: unknown } | { ok: false } {
  const whole = tryParseJson(text.trim());
  if (whole.ok) return whole;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) {
    const inner = tryParseJson(fence[1]!.trim());
    if (inner.ok) return inner;
  }
  return { ok: false };
}

registerCheck('answer-json-schema', (cfg, ctx) => {
  const parsed = jsonOfAnswer(ctx.text);
  if (!parsed.ok) return result(cfg, false, 'answer-json-schema 0: the answer is not valid JSON', { source: 'heuristic', score: 0, actual: short(ctx.text, 300), metadata: { metric: 'answer-json-schema', valid: false, threshold: 1 } });
  const schema = cfg.schema && typeof cfg.schema === 'object' && Object.keys(cfg.schema as object).length ? cfg.schema : { type: ['object', 'array'] };
  try {
    const v = validateSchema(schema, parsed.value);
    return result(cfg, v.valid, v.valid ? 'answer-json-schema 1: the answer is JSON that matches the schema' : `answer-json-schema 0: ${v.errors.slice(0, 5).join('; ')}`, {
      source: 'heuristic',
      score: v.valid ? 1 : 0,
      actual: short(JSON.stringify(parsed.value) ?? '', 500),
      metadata: { metric: 'answer-json-schema', valid: v.valid, errors: v.errors.slice(0, 10), schemaGiven: schema !== undefined && !!cfg.schema, threshold: 1 },
    });
  } catch (e) {
    return result(cfg, false, `invalid schema: ${(e as Error).message}`);
  }
});

/** The USD the judge and the embedding models cost for the other metrics of a sample (their `judgeUsage`). */
export function judgeSpend(results: CheckResult[]): { costUsd: number; calls: number; inputTokens: number; outputTokens: number } {
  let costUsd = 0;
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const r of results) {
    const u = (r.metadata as { judgeUsage?: { costUsd?: number; calls?: number; inputTokens?: number; outputTokens?: number; cached?: boolean } } | undefined)?.judgeUsage;
    if (!u) continue;
    costUsd += u.costUsd ?? 0;
    calls += u.calls ?? 0;
    inputTokens += u.inputTokens ?? 0;
    outputTokens += u.outputTokens ?? 0;
  }
  return { costUsd: Math.round(costUsd * 1e6) / 1e6, calls, inputTokens, outputTokens };
}

/** The `judge-cost` result of a sample whose other metrics have run. */
export function judgeCostResult(cfg: CheckConfig, others: CheckResult[]): CheckResult {
  const s = judgeSpend(others);
  const max = num(cfg.max);
  const ok = max === undefined || s.costUsd <= max;
  return result(cfg, ok, `judge-cost $${s.costUsd}: ${s.calls} judge calls${max !== undefined ? ` (at most $${max})` : ''}`, {
    source: 'deterministic',
    score: s.costUsd,
    metadata: { metric: 'judge-cost', ...s, ...(max !== undefined ? { threshold: max } : {}) },
  });
}

registerCheck('judge-cost', (cfg: CheckConfig, _ctx: CheckContext) => na(cfg, { id: 'judge-cost', version: 'judge-cost-v1' }, 'it is read from the other metrics of the same sample (score it in a RAG run, with at least one judged metric)', { source: 'deterministic' }));
