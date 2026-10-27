/**
 * Models that are not chat judges (planning/rag-testing.md §2.3 3.2 and 7.14): a classifier that decides whether a claim is
 * entailed by a premise (Vectara HHEM served from a local endpoint), and a reward model that rates an answer (NVIDIA Nemotron
 * reward models through an OpenAI-compatible provider). They obey the same rules as every judge call: the AI privacy level
 * must send content ("Full"), "Local only" refuses an endpoint that is not on this computer, the text is redacted before it
 * is sent, the network policy applies, and every call is a row in the usage ledger. Nothing runs without being named.
 */
import { staysOnThisComputer } from '@testpion/shared';
import { ApsError } from '../../errors.js';
import { aiLocalOnly, aiPrivacyOf, assertLocalAllowed } from '../../ai/ai-settings.js';
import { maskSensitiveText } from '../../util/redact.js';
import { assertUrlAllowed } from '../../net/policy.js';
import { queryAll } from '../../util/jsonpath.js';
import { shortId } from '../../util/ids.js';
import type { RagJudgeHost } from './judge.js';
import { netFetch } from '../../net/proxy.js';

/** The text as it may leave this computer: secrets and (unless switched off) personal data masked. */
export function outbound(host: RagJudgeHost, s: string): string {
  const pii = host.deps.settings.ai?.maskPersonalData !== false;
  return maskSensitiveText(host.deps.redactor.redactString(s), { pii });
}

function assertMayLeave(host: RagJudgeHost, what: string): void {
  const privacy = aiPrivacyOf(host.deps.settings);
  if (privacy !== 'full') throw new ApsError('ConfigurationError', `${what} reads the answer and the documents, and the AI privacy level is "${privacy}"`, { suggestions: ['Settings ▸ AI assistant ▸ Privacy ▸ Full (redacted).'] });
}

function ledger(host: RagJudgeHost, task: string, provider: string, model: string, ms: number, outcome: 'ok' | 'error', inputTokens = 0, outputTokens = 0): void {
  try {
    host.deps.store?.meta.addAiCall({ id: `${shortId('aic-')}e`, at: new Date().toISOString(), surface: host.deps.surface, task, provider, model, inputTokens, outputTokens, ms, outcome, calls: 1 });
  } catch {
    /* the ledger must never fail a call */
  }
}

/* ------------------------------------------------------------------ a classifier over HTTP (HHEM) */

interface ClassifierConfig {
  /** Where to POST. Local only requires an address on this computer. */
  url: string;
  /** The JSON field names of the premise and the hypothesis (default `premise` and `hypothesis`). */
  premiseField?: string;
  hypothesisField?: string;
  /** Where the score is in the JSON answer (default `$.score`). */
  scorePath?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export function classifierOf(raw: unknown): ClassifierConfig | string {
  // typed in the picker as JSON text
  let v = raw;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      v = JSON.parse(raw);
    } catch {
      return 'the classifier is not valid JSON: { "url": "http://127.0.0.1:8000/hhem" }';
    }
  }
  if (!v || typeof v !== 'object') return 'set "classifier": { url } — the endpoint that scores whether a claim follows from the documents (a local server around the Vectara HHEM model).';
  const c = v as ClassifierConfig;
  if (typeof c.url !== 'string' || !/^https?:\/\//i.test(c.url)) return 'the classifier needs a "url" (http or https).';
  return c;
}

/** The entailment score (0 to 1) the classifier gives a hypothesis against a premise. */
export async function classify(host: RagJudgeHost, c: ClassifierConfig, premise: string, hypothesis: string, signal?: AbortSignal): Promise<number> {
  assertMayLeave(host, 'The classifier');
  if (aiLocalOnly(host.deps.settings, host.deps.env) && !staysOnThisComputer({ kind: 'openai-compatible', baseUrl: c.url } as never))
    throw new ApsError('ConfigurationError', `Local only is on: the classifier at ${c.url} is not on this computer`, { suggestions: ['Serve the classifier locally (127.0.0.1), or turn Local only off in Settings ▸ AI assistant.'] });
  await assertUrlAllowed(c.url);
  const t0 = Date.now();
  try {
    const res = await netFetch(c.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(c.headers ?? {}) },
      body: JSON.stringify({ [c.premiseField ?? 'premise']: outbound(host, premise), [c.hypothesisField ?? 'hypothesis']: outbound(host, hypothesis) }),
      signal: signal ?? AbortSignal.timeout(c.timeoutMs ?? 30_000),
      redirect: 'error',
    });
    if (!res.ok) throw new ApsError('ProtocolError', `The classifier answered HTTP ${res.status}`);
    const body = (await res.json()) as unknown;
    const raw = queryAll(body, c.scorePath ?? '$.score')[0];
    const score = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    if (!Number.isFinite(score)) throw new ApsError('ProtocolError', `The classifier's answer has no number at ${c.scorePath ?? '$.score'}`);
    ledger(host, 'rag:classifier', new URL(c.url).host, 'classifier', Date.now() - t0, 'ok');
    return score;
  } catch (e) {
    ledger(host, 'rag:classifier', new URL(c.url).host, 'classifier', Date.now() - t0, 'error');
    throw e;
  }
}

/* ------------------------------------------------------------------ a reward model through a provider */

interface RewardCall {
  text: string;
  provider: string;
  model: string;
}

/** Asks a reward model for its rating of an answer: the question as the user turn, the answer as the assistant turn. */
export async function rewardCall(host: RagJudgeHost, o: { provider: string; model?: string; question: string; answer: string; signal?: AbortSignal }): Promise<RewardCall> {
  assertMayLeave(host, 'The reward model');
  const { providers, settings, env } = host.deps;
  const resolved = providers.resolveModel({ provider: o.provider, name: o.model });
  assertLocalAllowed(resolved.provider.config, aiLocalOnly(settings, env));
  const t0 = Date.now();
  try {
    const r = await resolved.provider.chat({
      model: resolved.model,
      messages: [
        { role: 'user', content: outbound(host, o.question) },
        { role: 'assistant', content: outbound(host, o.answer) },
      ],
      temperature: 0,
      maxTokens: 64,
      signal: o.signal,
    });
    ledger(host, 'rag:reward-score', resolved.provider.config.name, resolved.model, Date.now() - t0, 'ok', r.usage.inputTokens, r.usage.outputTokens);
    return { text: r.text, provider: resolved.provider.config.name, model: resolved.model };
  } catch (e) {
    ledger(host, 'rag:reward-score', resolved.provider.config.name, resolved.model, Date.now() - t0, 'error');
    throw e;
  }
}

/** The ratings in a reward model's reply: `helpfulness:3.2,correctness:3.1` (Nemotron-4 attributes), `reward: -1.5`, or a bare number. */
export function parseRatings(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of text.matchAll(/([A-Za-z_][\w-]*)\s*[:=]\s*(-?\d+(?:\.\d+)?)/g)) out[m[1]!.toLowerCase()] = Number(m[2]);
  if (!Object.keys(out).length) {
    const bare = /-?\d+(?:\.\d+)?/.exec(text);
    if (bare) out.reward = Number(bare[0]);
  }
  return out;
}
