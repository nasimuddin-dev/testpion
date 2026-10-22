import type { ProviderConfig } from '../model/types.js';
import { ApsError } from '../errors.js';

/**
 * The app's own Claude provider: the user's Anthropic API key, saved once in Settings ▸ AI assistant and
 * kept in the OS secret store (never in settings or workspace files). It powers the AI assistant, and
 * shows up in AI Lab and evaluations as "Claude (your API key)" in every workspace.
 */
export const APP_CLAUDE_SECRET = 'app.anthropic.apiKey';
export const APP_CLAUDE_ID = 'claude-app';

export const CLAUDE_MODELS: Array<{ id: string; name: string }> = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5 (most capable, default)' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5 (faster, lower cost)' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5 (fastest, lowest cost)' },
];
export const DEFAULT_CLAUDE_MODEL = CLAUDE_MODELS[0]!.id;

export function appClaudeProvider(model = DEFAULT_CLAUDE_MODEL): ProviderConfig {
  return {
    id: APP_CLAUDE_ID,
    name: 'Claude (your API key)',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: model,
    apiKey: `{{$secret.${APP_CLAUDE_SECRET}}}`,
  };
}

/**
 * Check an Anthropic API key before saving it (lists the models, which costs nothing). Throws a
 * message the user can act on: rejected key, no network, or another answer from Anthropic.
 */
export async function checkAnthropicKey(key: string, opts: { signal?: AbortSignal; baseUrl?: string } = {}): Promise<void> {
  const k = key.trim();
  if (!k) throw new ApsError('ValidationError', 'Paste an Anthropic API key', { suggestions: [] });
  let res: Response;
  try {
    res = await fetch(`${(opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '')}/v1/models?limit=1`, {
      headers: { 'x-api-key': k, 'anthropic-version': '2023-06-01' },
      signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new ApsError('NetworkError', `Couldn't reach the Anthropic API: ${(e as Error).message}`, {
      suggestions: ['Check the internet connection, and the proxy in Settings ▸ Proxy.'],
    });
  }
  if (res.ok) return;
  if (res.status === 401 || res.status === 403)
    throw new ApsError('AuthenticationError', 'Anthropic rejected this API key', { suggestions: ['Copy the key again from console.anthropic.com (API keys), then save it.'] });
  const body = await res.text().catch(() => '');
  throw new ApsError('ServerError', `Anthropic answered HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`, { suggestions: [] });
}
