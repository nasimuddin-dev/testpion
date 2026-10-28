import { PROVIDER_PRESETS } from '@testpion/shared';
import { call } from '../api';
import type { ProviderConfig } from '../types';
import { uid } from './format';

/** The one remedy for "no model yet": every screen that needs a model offers this button, worded the same. */
export const OFFLINE_DEMO_LABEL = 'Use the offline demo model';

/** What the demo model is, said once where it is chosen. */
export const OFFLINE_DEMO_NOTE = 'The offline demo model needs no key and no network. Its answers come from rules, so use it to try things out, not to judge a real model.';

/**
 * The offline demo model of the workspace: the one it has, or the preset added and saved (no key, no network). One
 * click for a person who has no model connected yet (AU-8).
 */
export async function ensureOfflineDemo(providers: ProviderConfig[]): Promise<{ provider: ProviderConfig; providers: ProviderConfig[] }> {
  const have = providers.find((p) => p.kind === 'mock');
  if (have) return { provider: have, providers };
  const preset = PROVIDER_PRESETS.find((p) => p.kind === 'mock')!;
  const provider: ProviderConfig = { ...preset, id: providers.some((p) => p.id === preset.id) ? uid('prov-') : preset.id };
  const all = [...providers, provider];
  await call('ai.saveProviders', { providers: all.map(({ hasKey: _h, ...x }) => x), keys: {} });
  return { provider, providers: all };
}
