/**
 * The AI provider kinds, as every part of the app names them: the engine (core), the window (the Providers list,
 * its presets) and the workspace defaults. One table, so a base URL or a label is not kept in three places.
 */
export type ProviderKind = 'openai-compatible' | 'azure-openai' | 'anthropic' | 'gemini' | 'bedrock' | 'ollama' | 'mock';

export interface ProviderKindInfo {
  kind: ProviderKind;
  label: string;
  /** The base URL a new provider of this kind starts with. */
  baseUrl: string;
}

export const PROVIDER_KINDS: readonly ProviderKindInfo[] = [
  { kind: 'openai-compatible', label: 'OpenAI-compatible', baseUrl: 'https://api.openai.com/v1' },
  { kind: 'azure-openai', label: 'Azure OpenAI', baseUrl: 'https://YOUR-RESOURCE.openai.azure.com/openai/deployments/YOUR-DEPLOYMENT' },
  { kind: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com' },
  { kind: 'gemini', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com' },
  { kind: 'bedrock', label: 'Amazon Bedrock', baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com' },
  { kind: 'ollama', label: 'Ollama (local)', baseUrl: 'http://127.0.0.1:11434/v1' },
  { kind: 'mock', label: 'Mock (offline, deterministic)', baseUrl: 'mock://local' },
];

/** kind → its default base URL. */
export const DEFAULT_BASE_URLS: Record<string, string> = Object.fromEntries(PROVIDER_KINDS.map((k) => [k.kind, k.baseUrl]));

export const providerKindLabel = (kind: string): string => PROVIDER_KINDS.find((k) => k.kind === kind)?.label ?? kind;

/** What a provider must have for the "needs a key" rule and the local-server exception. */
export interface ProviderLike {
  kind: string;
  baseUrl?: string;
}

/** A local OpenAI-compatible server (LM Studio, vLLM on this machine) that needs no key. */
export const isLocalProvider = (p: ProviderLike): boolean => p.kind === 'openai-compatible' && /localhost|127\.0\.0\.1/.test(p.baseUrl ?? '');

/** Whether a provider must have an API key to be used: the cloud ones; not the offline demo, Ollama or a local server. */
export const providerNeedsKey = (p: ProviderLike): boolean => p.kind !== 'mock' && p.kind !== 'ollama' && !isLocalProvider(p);

/** A provider configuration as the presets make it (the fields every kind shares). */
export interface ProviderPreset {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  defaultModel: string;
  /** A reference to the secret store (`{{$secret.provider.<id>.apiKey}}`) for the kinds that need a key. */
  apiKey?: string;
}

/** The usual providers, as the examples workspace has them: a cloud one takes its key from the secret store. */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { id: 'demo', name: 'Offline demo model', kind: 'mock', baseUrl: DEFAULT_BASE_URLS.mock!, defaultModel: 'demo' },
  { id: 'openai', name: 'OpenAI', kind: 'openai-compatible', baseUrl: DEFAULT_BASE_URLS['openai-compatible']!, defaultModel: 'gpt-4o-mini', apiKey: '{{$secret.provider.openai.apiKey}}' },
  { id: 'anthropic', name: 'Anthropic', kind: 'anthropic', baseUrl: DEFAULT_BASE_URLS.anthropic!, defaultModel: 'claude-haiku-4-5-20251001', apiKey: '{{$secret.provider.anthropic.apiKey}}' },
  { id: 'gemini', name: 'Google Gemini', kind: 'gemini', baseUrl: DEFAULT_BASE_URLS.gemini!, defaultModel: 'gemini-2.5-flash', apiKey: '{{$secret.provider.gemini.apiKey}}' },
  { id: 'ollama', name: 'Ollama (local)', kind: 'ollama', baseUrl: DEFAULT_BASE_URLS.ollama!, defaultModel: 'llama3.2' },
];
