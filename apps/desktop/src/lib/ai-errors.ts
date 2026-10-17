import { asError, type NormalizedError } from '../api';
import { useApp } from '../store';

/**
 * The one way the window offers to fix an AI setup problem, wherever it shows up (a toast, the assistant panel, an
 * error panel, an AI button): a provider without its key → "Add the key" (AI Lab ▸ Providers, its key field); a cap
 * of the AI settings → "Change the limits"; no model,
 * the app's Claude key missing, or Local only refusing a cloud model → "Set up AI" (Settings ▸ AI assistant).
 */
export function aiSetupAction(e: unknown): { label: string; onClick(): void } | undefined {
  const err: NormalizedError = asError(e);
  const details = err.details as { setup?: { provider?: string; assistant?: boolean }; aiLimit?: unknown } | undefined;
  const setup = details?.setup;
  // a cap of the AI settings refused the call: the limits are the fix
  if (details?.aiLimit) return { label: 'Change the limits', onClick: () => (useApp.getState().set({ assistant: undefined }), useApp.getState().openIntent('settings', { tab: 'assistant' })) };
  if (setup?.provider) return { label: 'Add the key', onClick: () => useApp.getState().openIntent('ai', { providerId: setup.provider, tab: 'providers' }) };
  if (setup?.assistant || /AI assistant is off|No Claude API key|No AI provider|Local only is on/.test(err.message))
    return { label: 'Set up AI', onClick: () => (useApp.getState().set({ assistant: undefined }), useApp.getState().openIntent('settings', { tab: 'assistant' })) };
  return undefined;
}

/** An AI action failed: the message, with the setup action when that is what is missing. */
export function toastAiError(e: unknown): void {
  useApp.getState().toast(asError(e).message, 'error', aiSetupAction(e));
}
