import { asError, type NormalizedError } from '../api';

// (a type only: the store itself uses this file, so it may not import the store's values)
type AppState = ReturnType<(typeof import('../store'))['useApp']['getState']>;

/**
 * The one way the window offers to fix an AI setup problem, wherever it shows up (a toast, the assistant panel, an
 * error panel, an AI button): a provider without its key → "Add the key" (AI Lab ▸ Providers, its key field); a cap
 * of the AI settings → "Change the limits"; no model,
 * the app's Claude key missing, or Local only refusing a cloud model → "Set up AI" (Settings ▸ AI assistant).
 */
export function aiSetupActionFor(e: unknown, app: () => AppState): { label: string; onClick(): void } | undefined {
  const err: NormalizedError = asError(e);
  const details = err.details as { setup?: { provider?: string; assistant?: boolean }; aiLimit?: unknown } | undefined;
  const setup = details?.setup;
  // a cap of the AI settings refused the call: the limits are the fix
  if (details?.aiLimit) return { label: 'Change the limits', onClick: () => (app().set({ assistant: undefined }), app().openIntent('settings', { tab: 'assistant' })) };
  if (setup?.provider) return { label: 'Add the key', onClick: () => app().openIntent('ai', { providerId: setup.provider, tab: 'providers' }) };
  if (setup?.assistant || /AI assistant is off|No Claude API key|No AI provider|Local only is on/.test(err.message))
    return { label: 'Set up AI', onClick: () => (app().set({ assistant: undefined }), app().openIntent('settings', { tab: 'assistant' })) };
  return undefined;
}
