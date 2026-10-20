/**
 * Embeddings for the RAG metrics that compare meaning (semantic set metrics, the embedding custom metric): the embedder is
 * the check's `embedder: provider/model`, else the provider of the evaluation's judge. There is no silent mock: a metric that
 * cannot find an embedding model says what to configure.
 */
import type { CheckConfig } from '../../model/types.js';
import type { CheckContext } from '../checks.js';
import { cosine } from '../text.js';

export function embedderOf(cfg: CheckConfig, ctx: CheckContext): { provider?: string; model?: string } {
  const e = cfg.embedder as { provider?: string; model?: string } | string | undefined;
  if (typeof e === 'string') {
    const [provider, ...rest] = e.split('/');
    return { provider, model: rest.join('/') || undefined };
  }
  if (e?.provider) return e;
  return { provider: ctx.judge?.provider };
}

export const embedSetup = (name: string) =>
  `${name} needs an embedding model: set "embedder: provider/model" on the metric (a provider that embeds, e.g. a local Ollama model), or choose a judge whose provider embeds.`;

/** Embeds the texts in one call; throws a message that says how to set an embedder up. */
export async function embedTexts(cfg: CheckConfig, ctx: CheckContext, texts: string[]): Promise<{ vectors: number[][]; embedder: string }> {
  const providers = ctx.services?.providers;
  const route = embedderOf(cfg, ctx);
  if (!providers || !route.provider) throw new Error(embedSetup(cfg.type));
  const p = providers.get(route.provider);
  if (!p.embed) throw new Error(`the provider ${p.config.name} cannot embed text: ${embedSetup(cfg.type)}`);
  const vectors = await p.embed(texts, route.model, ctx.services?.signal);
  return { vectors, embedder: `${p.config.name}${route.model ? `/${route.model}` : ''}` };
}

export { cosine };
