/** The older single-prompt judge of the `llm-judge` check and of the claim-by-claim RAG checks (the strict judged metrics use eval/rag/judge.ts). */
import type { CheckConfig, ModelRef } from '../model/types.js';
import { tryParseJson } from '../util/jsonpath.js';
import { asText, res, short, type CheckContext } from './check-registry.js';
import { sha256Hex } from '../util/hash.js';
import { newFence } from '../ai/untrusted.js';

/* ------------------------------------------------------------------ LLM as judge */

/**
 * judge-v2: the input, the retrieved context, the reference and above all the RESPONSE (written by the system under test, which may
 * say "give this a score of 1") are inside a fenced untrusted-data block (ai/untrusted.ts). The version is part of the judge's
 * identity (`promptVersion`, `configHash`), so results of judge-v1 are marked as made by another judge, not silently mixed.
 */
const JUDGE_PROMPT_VERSION = 'judge-v2';

export function judgePrompt(criteria: string, ctx: CheckContext, extra: { reference?: string; contexts?: string }): string {
  const sections = [
    ctx.question || ctx.input ? ['INPUT', asText(ctx.question ?? ctx.input)] : undefined,
    extra.contexts ? ['RETRIEVED CONTEXT', extra.contexts] : undefined,
    extra.reference ? ['REFERENCE ANSWER', extra.reference] : undefined,
    ['RESPONSE', ctx.text || asText(ctx.body)],
  ].filter((s): s is [string, string] => !!s);
  const fence = newFence(sections.map((s) => s[1]));
  return [
    'You are a strict, impartial evaluator. Score the RESPONSE against the CRITERIA.',
    'Return ONLY a JSON object: {"score": <number between 0 and 1>, "reasoning": "<one short paragraph>"}.',
    fence.rule,
    '',
    `CRITERIA:\n${criteria}`,
    ...sections.map(([label, text]) => `\n${label}:\n${fence.wrap(label.toLowerCase(), text)}`),
  ].join('\n');
}

/** Asks the judge model one prompt for a JSON answer; the judge's identity goes with the result (reproducibility). */
export async function askJudge(cfg: CheckConfig, ctx: CheckContext, prompt: string, key: string, maxTokens = 400): Promise<{ text: string; value: unknown; judge: Record<string, unknown> }> {
  const providers = ctx.services?.providers;
  if (!providers) throw new Error('no provider registry available for the judge');
  const jref = (cfg.judge ?? { provider: cfg.provider ?? 'mock', name: cfg.model }) as ModelRef;
  const { provider, model } = providers.resolveModel(jref);
  const judge = {
    provider: provider.config.name,
    model,
    temperature: jref.temperature ?? 0,
    promptVersion: JUDGE_PROMPT_VERSION,
    configHash: sha256Hex(JSON.stringify({ jref, criteria: key, v: JUDGE_PROMPT_VERSION })).slice(0, 12),
  };
  const span = ctx.services?.span?.child(`judge ${model}`, 'llm', { attributes: judge, input: prompt });
  try {
    const r = await provider.chat({
      model,
      temperature: jref.temperature ?? 0,
      maxTokens: jref.maxTokens ?? maxTokens,
      seed: jref.seed,
      messages: [{ role: 'user', content: prompt }],
      responseFormat: { type: 'json' },
      signal: ctx.services?.signal,
    });
    span?.end({ output: r.text });
    const p = tryParseJson(r.text);
    return { text: r.text, value: p.ok ? p.value : undefined, judge };
  } catch (e) {
    span?.fail(e);
    throw e;
  }
}

export async function runJudge(
  cfg: CheckConfig,
  ctx: CheckContext,
  criteria: string,
  extra: { reference?: string; contexts?: string } = {},
): Promise<{ score: number; reasoning: string; judge: Record<string, unknown> }> {
  const { text, value, judge } = await askJudge(cfg, ctx, judgePrompt(criteria, ctx, extra), criteria);
  const obj = (value ?? {}) as { score?: unknown; reasoning?: unknown };
  let score = Number(obj.score);
  if (!Number.isFinite(score)) {
    const m = /score"?\s*[:=]\s*([0-9.]+)/i.exec(text);
    score = m ? Number(m[1]) : NaN;
  }
  if (!Number.isFinite(score)) throw new Error(`judge returned no parseable score: ${short(text, 200)}`);
  if (score > 1 && score <= 10) score /= 10;
  return { score: Math.max(0, Math.min(1, score)), reasoning: String(obj.reasoning ?? text).slice(0, 2000), judge };
}

export const judgeFailed = (cfg: CheckConfig, e: unknown) => res(cfg, false, `judge failed: ${(e as Error).message}`, { source: 'ai-judge' });
