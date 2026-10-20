/**
 * "Try on one sample" (planning/rag-testing.md §4c): one metric, one sample, here and now. A dry run shows what is read
 * (the inputs, with the missing ones named) and WHAT WILL BE SENT (the exact judge prompts after redaction, their size and
 * cost, whether the cache already holds the verdict) without sending anything; a real run scores the sample and returns
 * the result with its items, the judge, the usage and the cost. The app's Try dialog, `testpion rag metric`, and the MCP
 * `rag_try_metric` tool all call this one function.
 */
import type { RagJudgeSetup } from '@testpion/shared';
import type { CheckConfig, CheckResult } from '../../model/types.js';
import type { ProviderRegistry } from '../../ai/index.js';
import type { CheckContext } from '../checks.js';
import { ApsError } from '../../errors.js';
import { dryHost, type DryJudgeCall, type RagJudgeHost } from './judge.js';
import { INPUT_LABELS, metricToCheck, resolveMetric, type MetricDef, type MetricInput } from './metric-registry.js';
import type { RagRecord, RagToolCall } from './record.js';
import { scoreRagSample } from './score.js';

/** A sample written by hand, taken from a stored result or probed from a target. */
export interface TrySample {
  question?: string;
  answer?: string;
  contexts?: Array<{ id?: string; text: string; score?: number }>;
  reference?: string;
  referenceIds?: string[];
  referenceContexts?: string[];
  /** The other fields of the dataset record (eval/rag/record.ts). */
  record?: RagRecord;
  toolCalls?: RagToolCall[];
  latencyMs?: number;
}

/** The inputs this sample has, by the registry's codes. */
export function sampleInputs(s: TrySample): Partial<Record<MetricInput, boolean>> {
  return { question: !!s.question?.trim(), answer: !!s.answer?.trim(), contexts: !!s.contexts?.length, reference: !!s.reference?.trim(), referenceIds: !!s.referenceIds?.length, referenceContexts: !!s.referenceContexts?.length,
    canaries: !!s.record?.canaries?.length,
    toolCalls: !!(s.toolCalls ?? s.record?.toolCalls)?.length,
    referenceToolCalls: !!s.record?.referenceToolCalls?.length,
    answerable: s.record?.answerable !== undefined,
    source: !!s.record?.source,
    rubric: !!s.record?.rubric,
    goodAnswers: !!s.record?.goodAnswers?.length,
    latency: s.latencyMs !== undefined,
    scores: !!s.contexts?.some((d) => typeof d.score === 'number'),
    relevance: !!s.record?.relevance,
  };
}

export function missingFor(def: MetricDef, s: TrySample): Array<{ input: MetricInput; message: string }> {
  const has = sampleInputs(s);
  return def.requires.filter((i) => !has[i]).map((input) => ({ input, message: `${def.id} needs ${INPUT_LABELS[input]}` }));
}

/** The check context of a sample (the same shape a run's target call gives). */
export function contextOfSample(s: TrySample, o: { judge?: RagJudgeSetup; providers?: ProviderRegistry; ragJudge?: RagJudgeHost; signal?: AbortSignal } = {}): CheckContext {
  const text = s.answer ?? '';
  return {
    testType: 'rag',
    body: text,
    text,
    question: s.question,
    expected: s.reference,
    contexts: (s.contexts ?? []).map((d, i) => ({ id: d.id ?? `doc-${i + 1}`, text: d.text, ...(d.score !== undefined ? { score: d.score } : {}) })),
    referenceIds: s.referenceIds,
    referenceContexts: s.referenceContexts,
    record: s.record,
    toolCalls: s.toolCalls ?? s.record?.toolCalls,
    latencyMs: s.latencyMs,
    judge: o.judge,
    services: { providers: o.providers, ragJudge: o.ragJudge, signal: o.signal },
  };
}

export interface TryResult {
  metric: { id: string; name: string; kind: MetricDef['kind']; direction: MetricDef['direction']; threshold?: number };
  /** What the sample lacks (the run would fail with these messages). */
  missing: Array<{ input: MetricInput; message: string }>;
  /** A dry run: the judge calls the metric would make. */
  willSend?: Array<{ metric: string; version: string; cached: boolean; preview: DryJudgeCall['preview'] }>;
  /** A real run: the result. */
  result?: CheckResult;
  /** A real run: what the judge spent on it. */
  usage?: { calls: number; inputTokens: number; outputTokens: number; costUsd: number; cached: boolean };
}

export async function tryMetric(
  o: { providers?: ProviderRegistry; ragJudge: RagJudgeHost },
  req: { metric: string | CheckConfig; sample: TrySample; judge?: RagJudgeSetup; dryRun?: boolean; signal?: AbortSignal },
): Promise<TryResult> {
  const name = typeof req.metric === 'string' ? req.metric : req.metric.type;
  const resolved = resolveMetric(name);
  if (!resolved) throw new ApsError('ValidationError', `No RAG metric called "${name}"`, { suggestions: ['List them with `testpion rag metrics` (the id, an alias or a Ragas name works).'] });
  const def = resolved.def;
  const cfg: CheckConfig = typeof req.metric === 'string' ? metricToCheck(req.metric) : { ...resolved.options, ...req.metric, type: def.check };
  const missing = missingFor(def, req.sample);
  const head = { metric: { id: def.id, name: def.name, kind: def.kind, direction: def.direction, ...(def.threshold !== undefined ? { threshold: def.threshold } : {}) }, missing };
  if (req.dryRun) {
    if (def.kind === 'deterministic' || def.kind === 'sql') return { ...head, willSend: [] };
    const dry = dryHost(o.ragJudge);
    await scoreRagSample([cfg], contextOfSample(req.sample, { judge: req.judge, providers: o.providers, ragJudge: dry, signal: req.signal }));
    return { ...head, willSend: dry.dry.map((c) => ({ metric: c.metric, version: c.version, cached: c.cached, preview: c.preview })) };
  }
  const { checks } = await scoreRagSample([cfg], contextOfSample(req.sample, { judge: req.judge, providers: o.providers, ragJudge: o.ragJudge, signal: req.signal }));
  const result = checks[0]!;
  const usage = (result.metadata as { judgeUsage?: TryResult['usage'] } | undefined)?.judgeUsage;
  return { ...head, result, ...(usage ? { usage } : {}) };
}
