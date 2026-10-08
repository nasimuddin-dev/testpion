import { envNameForSecret } from '../storage/secrets.js';
import { DEFAULT_BASE_URLS, isLocalProvider } from '@testpion/shared';
import type { ModelRef, PriceEntry, ProviderConfig, TokenUsage } from '../model/types.js';
import { ApsError } from '../errors.js';
import type { ChatRequest, ChatResponse, LlmProvider } from './types.js';
import { OpenAICompatibleProvider } from './providers/openai.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { GeminiProvider } from './providers/gemini.js';
import { BedrockProvider } from './providers/bedrock.js';
import { MockProvider } from './providers/mock.js';
import { RateLimiter, Semaphore, withRetry } from '../util/concurrency.js';
import type { Redactor } from '../util/redact.js';
import { globToRegex } from '../util/glob.js';
import type { VariableScope } from '../vars/variables.js';

export * from './types.js';

export { DEFAULT_BASE_URLS, isLocalProvider, providerNeedsKey, PROVIDER_KINDS, PROVIDER_PRESETS, providerKindLabel } from '@testpion/shared';

/** Wraps a provider with rate limiting, bounded concurrency and retry with exponential backoff. */
class ManagedProvider implements LlmProvider {
  private limiter: RateLimiter;
  private sem: Semaphore;

  constructor(
    private inner: LlmProvider,
    private retries = 2,
  ) {
    const rl = inner.config.rateLimit ?? {};
    this.limiter = new RateLimiter(rl);
    this.sem = new Semaphore(rl.concurrency ?? 64);
  }

  get config(): ProviderConfig {
    return this.inner.config;
  }

  chat(req: ChatRequest): Promise<ChatResponse> {
    return this.sem.run(
      () =>
        withRetry(
          async () => {
            await this.limiter.acquire(req.signal);
            const r = await this.inner.chat(req);
            this.limiter.consumeTokens(r.usage.totalTokens);
            return r;
          },
          {
            retries: this.retries,
            signal: req.signal,
            // never retry once streaming has produced output, or on client errors
            shouldRetry: (e) => ['RateLimitError', 'ServerError', 'NetworkError', 'TimeoutError'].includes((e as ApsError).kind),
          },
        ),
      req.signal,
    );
  }

  get embed(): LlmProvider['embed'] {
    return this.inner.embed ? (texts, model, signal) => this.inner.embed!(texts, model, signal) : undefined;
  }

  get listModels(): LlmProvider['listModels'] {
    return this.inner.listModels ? (signal) => this.inner.listModels!(signal) : undefined;
  }
}

export function createProvider(config: ProviderConfig, apiKey: string | undefined, redactor?: Redactor): LlmProvider {
  redactor?.addSecret(apiKey);
  let p: LlmProvider;
  switch (config.kind) {
    case 'openai-compatible':
    case 'azure-openai':
    case 'ollama':
      p = new OpenAICompatibleProvider({ ...config, baseUrl: config.baseUrl || DEFAULT_BASE_URLS[config.kind]! }, apiKey, redactor);
      break;
    case 'anthropic':
      p = new AnthropicProvider({ ...config, baseUrl: config.baseUrl || DEFAULT_BASE_URLS.anthropic! }, apiKey, redactor);
      break;
    case 'gemini':
      p = new GeminiProvider({ ...config, baseUrl: config.baseUrl || DEFAULT_BASE_URLS.gemini! }, apiKey, redactor);
      break;
    case 'bedrock':
      p = new BedrockProvider({ ...config, baseUrl: config.baseUrl || DEFAULT_BASE_URLS.bedrock! }, apiKey, redactor);
      break;
    case 'mock':
      p = new MockProvider(config);
      break;
    default:
      throw new ApsError('ConfigurationError', `Unknown provider kind "${(config as ProviderConfig).kind}"`);
  }
  return new ManagedProvider(p);
}

/** "No API key for OpenAI", with where to add it: the app's Providers, or the variable the CLI and CI read. */
export function missingKeyError(cfg: ProviderConfig): ApsError {
  const secret = /\{\{\s*\$secret\.([^}\s]+)\s*\}\}/.exec(cfg.apiKey ?? '')?.[1];
  const env = /\{\{\s*\$env\.([^}\s]+)\s*\}\}/.exec(cfg.apiKey ?? '')?.[1];
  return new ApsError('ConfigurationError', `No API key for ${cfg.name}`, {
    why: `The provider's key (${cfg.apiKey}) has no value on this computer, so nothing was sent.`,
    // the app shows "Add the key", which opens this provider in AI Lab
    details: { setup: { provider: cfg.id } },
    suggestions: [
      `In the app: AI Lab ▸ Providers ▸ ${cfg.name} ▸ API key (it is kept in the operating system's secret store, never in the workspace).`,
      secret ? `In the CLI or CI: set the environment variable ${envNameForSecret(secret)}.` : env ? `Set the environment variable ${env}.` : 'In the CLI or CI: set the key as an environment variable the provider refers to.',
      ...(isLocalProvider(cfg) ? ['A local server that needs no key: clear the provider\'s API key field.'] : []),
    ],
  });
}

/**
 * Resolves `ModelRef`s to live providers. Providers are matched by id, then name, then kind.
 * API keys are resolved from templates (`{{$secret.x}}`, `{{$env.X}}`) through the variable scope.
 */
export class ProviderRegistry {
  private cache = new Map<string, LlmProvider>();

  constructor(
    private configs: ProviderConfig[],
    private vars: VariableScope,
    private redactor?: Redactor,
  ) {}

  list(): ProviderConfig[] {
    return this.configs;
  }

  find(ref: string): ProviderConfig | undefined {
    const r = ref.toLowerCase();
    return (
      this.configs.find((c) => c.id.toLowerCase() === r) ??
      this.configs.find((c) => c.name.toLowerCase() === r) ??
      this.configs.find((c) => c.kind === r)
    );
  }

  get(ref: string): LlmProvider {
    const cfg = this.find(ref) ?? this.implicit(ref);
    if (!cfg)
      throw new ApsError('ConfigurationError', `No AI provider named "${ref}" is configured`, {
        suggestions: ['Add a provider in AI Lab → Providers (or providers.json in the workspace).', `Configured providers: ${this.configs.map((c) => c.name).join(', ') || 'none'}`],
      });
    let p = this.cache.get(cfg.id);
    if (!p) {
      const resolved = this.vars.resolveDeep(cfg);
      const key = resolved.apiKey && !/\{\{/.test(resolved.apiKey) ? resolved.apiKey : undefined;
      // the provider names a key (a secret, an environment variable) that has no value here: say so before anything
      // is sent (the provider would answer 401 with a message about Authorization headers)
      if (cfg.apiKey && !key && cfg.kind !== 'mock' && cfg.kind !== 'ollama') throw missingKeyError(cfg);
      // (a local server with a key reference set still gets the error: the reference says a key was meant)
      p = createProvider(resolved, key, this.redactor);
      this.cache.set(cfg.id, p);
    }
    return p;
  }

  /** Allow `provider: mock` / `provider: ollama` without explicit configuration. */
  private implicit(ref: string): ProviderConfig | undefined {
    if (ref === 'mock') return { id: 'mock', name: 'Mock', kind: 'mock', baseUrl: DEFAULT_BASE_URLS.mock! };
    if (ref === 'ollama') return { id: 'ollama', name: 'Ollama', kind: 'ollama', baseUrl: DEFAULT_BASE_URLS.ollama! };
    if (ref === 'openai-compatible' && process.env.OPENAI_API_KEY)
      return { id: 'openai-env', name: 'OpenAI (env)', kind: 'openai-compatible', baseUrl: process.env.OPENAI_BASE_URL || DEFAULT_BASE_URLS['openai-compatible']!, apiKey: '{{$env.OPENAI_API_KEY}}' };
    if (ref === 'anthropic' && process.env.ANTHROPIC_API_KEY)
      return { id: 'anthropic-env', name: 'Anthropic (env)', kind: 'anthropic', baseUrl: DEFAULT_BASE_URLS.anthropic!, apiKey: '{{$env.ANTHROPIC_API_KEY}}' };
    return undefined;
  }

  resolveModel(ref: ModelRef): { provider: LlmProvider; model: string } {
    const provider = this.get(ref.provider);
    const model = ref.name || provider.config.defaultModel;
    if (!model) throw new ApsError('ConfigurationError', `No model name given for provider "${provider.config.name}"`, { suggestions: ['Set `model.name` in the test or a default model on the provider.'] });
    return { provider, model };
  }
}

/* ------------------------------------------------------------------ cost */

/** A price entry's model (`gpt-4o*`, `*`) against the model used; a `?` in a model name is literal. */
const globMatch = (pattern: string, value: string): boolean => globToRegex(pattern, { question: false }).test(value);

/**
 * Estimated cost = input tokens × input price + output tokens × output price.
 * Prices are user configuration (versioned); nothing is hard-coded.
 */
export function estimateCost(pricing: PriceEntry[], provider: ProviderConfig | undefined, model: string, usage: TokenUsage): { cost?: number; priceVersion?: string } {
  const forProvider = (p: PriceEntry) => p.provider === '*' || p.provider === provider?.id || p.provider === provider?.kind || p.provider === provider?.name;
  let candidates = pricing.filter((p) => forProvider(p) && globMatch(p.model, model));
  // providers answer with a dated snapshot (gpt-4o-mini-2024-07-18, claude-3-5-sonnet-20240620, …@20240620):
  // a price set for the model's name applies to its snapshots
  const undated = model.replace(/(-\d{4}-\d{2}-\d{2}|-\d{8}|@\d{8})$/, '');
  if (!candidates.length && undated !== model) candidates = pricing.filter((p) => forProvider(p) && globMatch(p.model, undated));
  // prefer the most specific pattern (longest without wildcards)
  const p = candidates.sort((a, b) => b.model.replace(/\*/g, '').length - a.model.replace(/\*/g, '').length)[0];
  if (!p) return {};
  const cost = (usage.inputTokens * p.inputPerMillion + usage.outputTokens * p.outputPerMillion) / 1_000_000;
  return { cost: Math.round(cost * 1e6) / 1e6, priceVersion: p.version };
}

/* ------------------------------------------------------------------ prompts */

export function renderPrompt(template: string, vars: VariableScope, input?: Record<string, unknown>): string {
  const scope = vars.clone();
  if (input) for (const [k, v] of Object.entries(input)) scope.set(k, v, 'request');
  return scope.resolve(template);
}
