import { useCallback, useEffect, useRef, useState } from 'react';
import { useSticky } from '../lib/sticky';
import { AiUsage } from '../components/AiUsage';
import { call } from '../api';
import { useIntent } from '../hooks';
import type { ProviderConfig } from '../types';
import { Tabs } from '../components/ui';
import { Playground } from './ai/Playground';
import { Compare } from './ai/Compare';
import { Providers } from './ai/Providers';

export function AiLabView() {
  // kept while the app runs, so switching tabs or views doesn't lose results
  const [tab, setTab] = useSticky<'playground' | 'compare' | 'providers' | 'usage'>('ai:tab', 'playground');
  const [providers, setProviders] = useState<ProviderConfig[]>();
  const load = useCallback(() => call<ProviderConfig[]>('ai.providers').then(setProviders), []);
  useEffect(() => {
    void load();
  }, [load]);
  // nothing else here works without a provider: a workspace without one opens on Providers
  const landed = useRef(false);
  useEffect(() => {
    if (!providers || landed.current) return;
    landed.current = true;
    if (!providers.length) setTab('providers');
  }, [providers, setTab]);
  /** A provider to show (a link such as an error's "Add the key"): selected, its key field focused. */
  const [focusProvider, setFocusProvider] = useState<{ id: string; at: number }>();
  useIntent('ai', (p) => {
    if (p?.savedId) setTab('playground');
    if (p?.tab) setTab(p.tab);
    if (p?.providerId) {
      setTab('providers');
      setFocusProvider({ id: p.providerId, at: Date.now() });
    }
    if (p?.reset) setTab('playground');
  });
  return (
    <div className="h-full flex flex-col">
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          // providers first: the rest needs one
          { id: 'providers', label: 'Providers', badge: providers?.length || undefined, title: 'The AI providers prompts are sent to (set up first)' },
          { id: 'playground', label: 'Playground' },
          { id: 'compare', label: 'Model comparison' },
          { id: 'usage', label: 'Usage' },
        ]}
      />
      <div className="flex-1 min-h-0">
        {tab === 'playground' && <Playground providers={providers ?? []} onSetUp={() => setTab('providers')} />}
        {tab === 'compare' && <Compare providers={providers ?? []} onSetUp={() => setTab('providers')} />}
        {tab === 'providers' && <Providers providers={providers ?? []} onSaved={load} focus={focusProvider} />}
        {tab === 'usage' && <AiUsage />}
      </div>
    </div>
  );
}

