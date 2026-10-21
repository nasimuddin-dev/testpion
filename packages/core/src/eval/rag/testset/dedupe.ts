/**
 * Finding repeated questions of a generated test set by what they mean (planning/rag-testing.md §4b; B-33b). The words they
 * share (lexical.ts, token-set Jaccard) stay the first and the only check that FAILS on its own; with `dedupe: embedding` an
 * embedding model also compares the questions, so a paraphrase that shares few words is caught too. Without a model that
 * embeds, or when it fails, or Local only forbids it, the answer is the lexical one and the badge says so: the check never
 * makes up a score. Question texts go through the redactor before they leave; vectors are kept for the process, per model.
 */
import type { ProviderRegistry } from '../../../ai/index.js';
import { aiLocalOnly, assertLocalAllowed, resolveAiRoute, type AiSettingsSource } from '../../../ai/ai-settings.js';
import type { Redactor } from '../../../util/redact.js';
import { cosine } from '../../text.js';

/** A cosine at or above this is the same question worded differently (fail); at or above the second it is close (warn). */
export const EMBED_DUPLICATE_AT = 0.92;
export const EMBED_WARN_AT = 0.85;
/** Most questions of the dataset compared with one new question (the newest first), so a big dataset costs one bounded call. */
export const MAX_COMPARED = 400;

export interface EmbedderSource {
  providers?: ProviderRegistry;
  settings?: AiSettingsSource;
  env?: Record<string, string | undefined>;
  redactor?: Redactor;
  signal?: AbortSignal;
}

export type Embedder = { name: string; embed(texts: string[]): Promise<number[][]> } | { problem: string };

/** `provider/model` or a bare provider name. */
const split = (spec: string): { provider: string; model?: string } => {
  const [provider, ...rest] = spec.split('/');
  return { provider: provider!, ...(rest.length ? { model: rest.join('/') } : {}) };
};

/** The embedding model for a run: the one named, else the judge's provider, else the AI settings' large-model provider. */
export function embedderFor(src: EmbedderSource, spec?: string, judgeProvider?: string): Embedder {
  const providers = src.providers;
  if (!providers) return { problem: 'no AI provider is available here' };
  let route: { provider: string; model?: string } | undefined = spec ? split(spec) : judgeProvider ? { provider: judgeProvider } : undefined;
  if (!route && src.settings) {
    try {
      route = { provider: resolveAiRoute({ settings: src.settings, tier: 'large', env: src.env }).provider };
    } catch {
      route = undefined;
    }
  }
  if (!route) return { problem: 'no embedding model is chosen: name one with “embedder: provider/model”' };
  try {
    const found = providers.find(route.provider);
    if (found) assertLocalAllowed(found, src.settings ? aiLocalOnly(src.settings, src.env) : false);
    const p = providers.get(route.provider);
    assertLocalAllowed(p.config, src.settings ? aiLocalOnly(src.settings, src.env) : false);
    if (!p.embed) return { problem: `${p.config.name} cannot embed text: name a provider that does (a local Ollama model, for one)` };
    const name = `${p.config.name}${route.model ? `/${route.model}` : ''}`;
    return {
      name,
      embed: (texts) => p.embed!(texts.map((t) => (src.redactor ? src.redactor.redactString(t) : t)), route!.model, src.signal),
    };
  } catch (e) {
    return { problem: (e as Error).message };
  }
}

const vectors = new Map<string, number[]>();
const keyOf = (embedder: string, text: string) => `${embedder}\u0000${text}`;

/** The vectors of the texts, one embedding call for those not seen before. */
export async function embedAll(e: { name: string; embed(texts: string[]): Promise<number[][]> }, texts: string[]): Promise<number[][]> {
  const missing = [...new Set(texts.filter((t) => !vectors.has(keyOf(e.name, t))))];
  if (missing.length) {
    const got = await e.embed(missing);
    if (got.length !== missing.length) throw new Error('the embedding model returned the wrong number of vectors');
    missing.forEach((t, i) => vectors.set(keyOf(e.name, t), got[i]!));
    // a long session cannot grow this without end
    if (vectors.size > 20_000) for (const k of [...vectors.keys()].slice(0, 5_000)) vectors.delete(k);
  }
  return texts.map((t) => vectors.get(keyOf(e.name, t))!);
}

export interface Closest {
  question: string;
  similarity: number;
}

/** The question among `others` that `candidate` is closest to in meaning, or undefined when there is none or the model failed (`problem`). */
export async function closestQuestion(embedder: Embedder, candidate: string, others: string[]): Promise<{ closest?: Closest; embedder?: string; problem?: string }> {
  if ('problem' in embedder) return { problem: embedder.problem };
  const pool = others.filter((q) => q !== candidate).slice(-MAX_COMPARED);
  if (!pool.length) return { embedder: embedder.name };
  try {
    const [c, ...rest] = await embedAll(embedder, [candidate, ...pool]);
    let best: Closest | undefined;
    rest.forEach((v, i) => {
      const s = cosine(c!, v);
      if (!best || s > best.similarity) best = { question: pool[i]!, similarity: Math.round(s * 1000) / 1000 };
    });
    return { closest: best, embedder: embedder.name };
  } catch (e) {
    return { problem: `the embedding model failed: ${(e as Error).message}` };
  }
}
