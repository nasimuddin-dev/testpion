/**
 * The judge service of the RAG metrics (planning/rag-testing.md §4c): every judged metric goes through here, so a judge
 * call behaves the same in the app, the CLI, the MCP server and CI:
 *
 *  - it is the registered AI task `rag-judge` run by `runAiTask`: the model comes from the evaluation's judge, else the
 *    AI settings' large model; the context is redacted and budgeted; the usage ledger and the daily caps apply;
 *  - the verdict is cached by the content hash of the exact prompt (the metastore's judge cache), so a re-run of an
 *    unchanged sample costs nothing, and the same sample asked twice at once is asked once;
 *  - there is NO silent fallback: without a usable judge the call fails with the list of what to configure; a mock
 *    judge is used only when the evaluation names the mock provider;
 *  - a run can be limited (calls, cost); when the limit is reached the remaining scores are not guessed.
 */
import { createHash } from 'node:crypto';
import { ApsError } from '../../errors.js';
import type { AppSettings } from '../../model/types.js';
import { aiLocalOnly, assertLocalAllowed, resolveAiRoute } from '../../ai/ai-settings.js';
import type { prepareAiTask, runAiTask, AiPreview, AiRunDeps, AiTaskRequest } from '../../ai/tasks/run.js';
import type { AiSurface } from '../../storage/ai-usage.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import type { ProviderRegistry } from '../../ai/index.js';
import type { Redactor } from '../../util/redact.js';
import type { ChatImage } from '../../ai/types.js';
import { visionCapable } from '../../ai/vision.js';
import { VERDICT_SCHEMA, type JudgedMetric, type Verdict } from './judge-prompts.js';
import { validateSchema } from '../checks.js';

/** The judge an evaluation names; unset parts come from the AI settings. */
export interface JudgeRef {
  provider?: string;
  model?: string;
  /** Stop judging once the run has spent this much (USD, from the price table) or made this many model calls. */
  maxCostUsd?: number;
  maxCalls?: number;
}

/** What a run has used of the judge so far (shared by every sample of the run). */
export interface JudgeBudget {
  calls: number;
  cached: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** One judge call a dry run would make (nothing is sent): the prompt, its size and whether the cache already holds the verdict. */
export interface DryJudgeCall {
  metric: string;
  version: string;
  input: Record<string, unknown>;
  preview: AiPreview;
  cached: boolean;
}

export interface RagJudgeHost {
  deps: AiRunDeps;
  /** The AI task service, lent by the engine (engine.ts): this module takes only types from ai/tasks. */
  tasks: RagTaskService;
  budget: JudgeBudget;
  /** Set on a dry host (see `dryHost`): judge calls are listed here and answered with an empty verdict, never sent. */
  dry?: DryJudgeCall[];
  /** Verdicts being asked right now, by key: the same question asked twice at once is asked once. */
  inflight: Map<string, Promise<JudgeAnswer>>;
}

export interface JudgeAnswer {
  verdict: Verdict;
  cached: boolean;
  judge: { provider: string; model: string; metric: string; promptVersion: string };
  usage: { calls: number; inputTokens: number; outputTokens: number; costUsd?: number };
  redactionCount: number;
}

/** The two calls of the AI task service a judge call needs (`prepareAiTask`, `runAiTask`). */
export interface RagTaskService {
  prepare: typeof prepareAiTask;
  run: typeof runAiTask;
}

/** The judge host of an engine context; the engine lends the task service (`createRagJudgeHost` in engine.ts is the one hosts call). */
export function buildRagJudgeHost(o: { store?: WorkspaceStore; providers: ProviderRegistry; redactor: Redactor; settings: AppSettings; surface: AiSurface; env?: Record<string, string | undefined>; tasks: RagTaskService }): RagJudgeHost {
  return {
    tasks: o.tasks,
    deps: { store: o.store, providers: o.providers, redactor: o.redactor, settings: o.settings, surface: o.surface, env: o.env },
    budget: { calls: 0, cached: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    inflight: new Map(),
  };
}

/** A host that sends nothing: the metrics run against it and every judge call they would make is recorded in `dry`. */
export function dryHost(host: RagJudgeHost): RagJudgeHost & { dry: DryJudgeCall[] } {
  return { deps: host.deps, tasks: host.tasks, budget: { calls: 0, cached: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }, inflight: new Map(), dry: [] };
}

/** What to configure for a judge: the one error a missing or refused judge gives, in every host. */
export function judgeSetupError(why: string, extra: string[] = []): ApsError {
  return new ApsError('ConfigurationError', 'This RAG evaluation needs a judge model, and none is set up', {
    why: `${why} TestPion never guesses a judge: a score from a model nobody chose could not be compared with another run.`,
    details: { setup: { assistant: true } },
    suggestions: [
      'In the evaluation: choose the judge (a provider of this workspace and its model).',
      'In the app: Settings ▸ AI assistant ▸ Large tasks, or save your Claude key there.',
      'CLI and CI: --judge <provider>/<model>, or set TESTPION_AI_PROVIDER and TESTPION_AI_MODEL.',
      'A model on this computer works (Ollama, LM Studio); for an offline test, name the mock provider as the judge.',
      ...extra,
    ],
  });
}

/**
 * Checks, before any sample is run, that the judge can be used: a route exists, its provider is configured and allowed
 * by Local only. Throws the setup error with what to configure otherwise.
 */
export function assertJudgeUsable(host: RagJudgeHost, judge?: JudgeRef): { provider: string; model: string; vision: boolean } {
  const { deps } = host;
  let route;
  try {
    route = resolveAiRoute({ settings: deps.settings, tier: 'large', override: judge?.provider ? { provider: judge.provider, model: judge.model } : judge?.model ? { model: judge.model } : undefined, env: deps.env });
  } catch (e) {
    if (e instanceof ApsError && /AI assistant is off/.test(e.message)) throw judgeSetupError('No judge is chosen for this evaluation and the AI settings have no model for large tasks.');
    throw e;
  }
  const localOnly = aiLocalOnly(deps.settings, deps.env);
  // Local only is checked on the provider's settings before its key is looked up (a cloud provider is refused for leaving this computer first)
  const configured = deps.providers.find(route.provider);
  if (configured) assertLocalAllowed(configured, localOnly);
  let resolved;
  try {
    resolved = deps.providers.resolveModel({ provider: route.provider, name: route.model });
  } catch (e) {
    if (e instanceof ApsError && /No AI provider named/.test(e.message)) throw judgeSetupError(`The judge provider "${route.provider}" is not a provider of this workspace.`, [`Providers here: ${deps.providers.list().map((p) => p.name).join(', ') || 'none'} (the mock and Ollama can always be named).`]);
    throw e;
  }
  assertLocalAllowed(resolved.provider.config, localOnly);
  return { provider: resolved.provider.config.name, model: resolved.model, vision: visionCapable(resolved.provider.config, resolved.model) };
}

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** The AI task request of a metric's judge call. */
export function judgeRequest(metric: JudgedMetric, input: Record<string, unknown>, judge?: JudgeRef): AiTaskRequest {
  // images ride beside the text fields (`__images`, from eval/rag/images.ts): they are data for a vision judge, never text in the context
  const { __images, __allowImages, ...context } = input as Record<string, unknown> & { __images?: ChatImage[]; __allowImages?: boolean };
  return { task: 'rag-judge', question: metric.instruction, context, provider: judge?.provider, model: judge?.model, ...(__images?.length ? { images: __images, allowImages: __allowImages === true } : {}) };
}

/** The messages as the cache key sees them: an image by its hash, so the same picture hits and a different one misses. */
const keyMessages = (messages: AiPreview['messages']) => messages.map(({ images, ...m }) => (images?.length ? { ...m, images: images.map((i) => `${i.mime}:${i.sha256}`) } : m));

/** "What will be sent": the exact messages, the context sections, the estimate and the redactions of a judge call (nothing is sent). */
export function previewJudge(host: RagJudgeHost, metric: JudgedMetric, input: Record<string, unknown>, judge?: JudgeRef): AiPreview {
  assertJudgeUsable(host, judge);
  return host.tasks.prepare(host.deps, judgeRequest(metric, input, judge)).preview;
}

const verdictProblems = (v: unknown, metric?: JudgedMetric): string[] => {
  const s = validateSchema(VERDICT_SCHEMA, v);
  if (!s.valid) return s.errors;
  // a rating metric needs a rating in range on every item, not only a verdict
  if (metric?.rating !== undefined) {
    const min = metric.ratingMin ?? 0;
    const bad = (v as Verdict).items.findIndex((i) => !Number.isInteger(i.rating) || i.rating! < min || i.rating! > metric.rating! || (metric.ratingValues !== undefined && !metric.ratingValues.includes(i.rating!)));
    if (bad >= 0) return [`items[${bad}].rating must be ${metric.ratingValues ? `one of ${metric.ratingValues.join(', ')}` : `an integer from ${min} to ${metric.rating}`}`];
  }
  return [];
};

/** Asks the judge one metric of one sample (cache, budget, ledger and caps as the module comment says). */
export async function judgeCall(host: RagJudgeHost, metric: JudgedMetric, input: Record<string, unknown>, o: { judge?: JudgeRef; signal?: AbortSignal; fresh?: boolean } = {}): Promise<JudgeAnswer> {
  assertJudgeUsable(host, o.judge);
  const deps: AiRunDeps = { ...host.deps, signal: o.signal ?? host.deps.signal };
  const req = judgeRequest(metric, input, o.judge);
  const prepared = host.tasks.prepare(deps, req);
  const { preview } = prepared;
  if (preview.privacy !== 'full') throw new ApsError('ConfigurationError', `Judged RAG metrics need the AI privacy level "Full (redacted)", not "${preview.privacy}"`, { why: 'A judge reads the question, the answer and the documents themselves; at a lower level they are not sent.', suggestions: ['Settings ▸ AI assistant ▸ Privacy ▸ Full (redacted).', 'Or use the metrics that need no model (token-f1, rouge, context-precision-ids …).'] });
  // a section that had to be shortened or sampled would be judged on part of the sample: refused, never silent
  const cut = preview.context.sections.filter((s) => s.notes.length);
  if (cut.length) throw new ApsError('ValidationError', `The sample is too long for the judge (${cut.map((s) => `${s.name}: ${s.notes.join(', ')}`).join('; ')})`, { suggestions: ['Retrieve fewer or shorter documents, or score this sample with the metrics that need no model.'] });
  const judge = { provider: preview.providerName, model: preview.model, metric: metric.id, promptVersion: metric.version };
  // the key is the exact prompt (after redaction) with the model that answers: any change to the sample, the wording, the model or the task misses
  const key = hash({ task: 'rag-judge', provider: preview.provider, providerName: preview.providerName, model: preview.model, metric: metric.id, version: metric.version, messages: keyMessages(preview.messages) });
  const cache = host.deps.store?.meta;
  if (host.dry) {
    // what a dry run lists goes to the window: the pictures are in preview.images (thumbnails), never twice as base64
    const { __images: _img, ...shown } = input as Record<string, unknown>;
    host.dry.push({ metric: metric.id, version: metric.version, input: shown, preview: { ...preview, messages: preview.messages.map(({ images: _i, ...m }) => m) }, cached: !o.fresh && !!cache?.getJudgeCache(key) });
    return { verdict: { reasoning: '', items: [] }, cached: true, judge, usage: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }, redactionCount: preview.redactionCount };
  }
  // `fresh` asks again whatever the cache holds (a repeat measures the judge's own noise); the answer is still stored
  const hit = o.fresh ? undefined : cache?.getJudgeCache(key);
  if (hit) {
    try {
      const verdict = JSON.parse(hit) as Verdict;
      if (!verdictProblems(verdict, metric).length) {
        host.budget.cached++;
        return { verdict, cached: true, judge, usage: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }, redactionCount: preview.redactionCount };
      }
    } catch {
      /* a broken row is asked again */
    }
  }
  const running = o.fresh ? undefined : host.inflight.get(key);
  if (running) return running.then((a) => ({ ...a, cached: true, usage: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 } }));
  const { maxCalls, maxCostUsd } = o.judge ?? {};
  if (maxCalls !== undefined && host.budget.calls >= maxCalls) throw new ApsError('ValidationError', `The judge budget is used up (${host.budget.calls} of ${maxCalls} model calls); this score is not computed`, { details: { budget: true } });
  if (maxCostUsd !== undefined && host.budget.costUsd >= maxCostUsd) throw new ApsError('ValidationError', `The judge budget is used up ($${host.budget.costUsd.toFixed(4)} of $${maxCostUsd}); this score is not computed`, { details: { budget: true } });
  const ask = (async (): Promise<JudgeAnswer> => {
    const r = await host.tasks.run(deps, req);
    const problems = r.problems.length ? r.problems : verdictProblems(r.value, metric);
    if (r.value === undefined || problems.length)
      throw new ApsError('ValidationError', `The judge (${preview.providerName}/${preview.model}) did not answer in the verdict format: ${problems.slice(0, 3).join('; ') || 'no JSON'}`, {
        suggestions: ['Use a stronger judge model (this format needs one that follows a JSON schema).', 'The usage ledger counted the attempt.'],
      });
    const verdict = r.value as Verdict;
    host.budget.calls += r.calls;
    host.budget.inputTokens += r.usage.inputTokens;
    host.budget.outputTokens += r.usage.outputTokens;
    host.budget.costUsd += r.costUsd ?? 0;
    try {
      cache?.putJudgeCache(key, JSON.stringify(verdict));
    } catch {
      /* a cache that cannot be written is only slower */
    }
    return { verdict, cached: false, judge: { ...judge, provider: r.provider, model: r.model }, usage: { calls: r.calls, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, costUsd: r.costUsd }, redactionCount: preview.redactionCount };
  })();
  if (!o.fresh) host.inflight.set(key, ask);
  try {
    return await ask;
  } finally {
    if (!o.fresh) host.inflight.delete(key);
  }
}
