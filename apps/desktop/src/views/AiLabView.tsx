import { useCallback, useEffect, useState } from 'react';
import { useSticky } from '../lib/sticky';
import { AiUsage } from '../components/AiUsage';
import { call } from '../api';
import { useIntent } from '../hooks';
import type { ProviderConfig } from '../types';
import { Tabs } from '../components/ui';
import { Playground } from './ai/Playground';
import { Compare } from './ai/Compare';
import { Providers } from './ai/Providers';
import { Rag } from './ai/Rag';
import { Start } from './ai/Start';

export function AiLabView() {
  // kept while the app runs, so switching tabs or views doesn't lose results
  const [tab, setTab] = useSticky<'start' | 'playground' | 'compare' | 'rag' | 'providers' | 'usage'>('ai:tab', 'start');
  const [providers, setProviders] = useState<ProviderConfig[]>();
  const load = useCallback(() => call<ProviderConfig[]>('ai.providers').then(setProviders), []);
  useEffect(() => {
    void load();
  }, [load]);
  /** A provider to show (a link such as an error's "Add the key"): selected, its key field focused. */
  const [focusProvider, setFocusProvider] = useState<{ id: string; at: number }>();
  /** A RAG target to open (a link to it). */
  const [ragTarget, setRagTarget] = useState<{ id: string; at: number }>();
  useIntent('ai', (p) => {
    if (p?.savedId || p?.prompt) setTab('playground');
    if (p?.tab) setTab(p.tab);
    if (p?.ragTargetId) {
      setTab('rag');
      setRagTarget({ id: p.ragTargetId, at: Date.now() });
    }
    if (p?.providerId) {
      setTab('providers');
      setFocusProvider({ id: p.providerId, at: Date.now() });
    }
    if (p?.reset) setTab('playground');
    if (p?.start) setTab('start');
  });
  return (
    <div className="h-full flex flex-col">
      <Tabs label="AI Lab"
        value={tab}
        onChange={setTab}
        tabs={[
          // the first page says what AI Lab does and works with no model (the sample); models are set up on the next tabs
          { id: 'start', label: 'Start', title: 'What do you want to check? Cards by task, the sample, your latest runs' },
          { id: 'providers', label: 'Providers', badge: providers?.length || undefined, title: 'The AI providers prompts are sent to (set up first)' },
          { id: 'playground', label: 'Playground' },
          { id: 'compare', label: 'Model comparison' },
          { id: 'rag', label: 'RAG', title: 'RAG systems under test: connect an endpoint, map its answer and retrieved documents, then evaluate it in Evaluations' },
          { id: 'usage', label: 'Usage' },
        ]}
      />
      <div className="flex-1 min-h-0">
        {tab === 'start' && <Start providers={providers} onTab={setTab} />}
        {tab === 'playground' && <Playground providers={providers ?? []} onSetUp={() => setTab('providers')} />}
        {tab === 'compare' && <Compare providers={providers ?? []} onSetUp={() => setTab('providers')} />}
        {tab === 'rag' && <Rag openTarget={ragTarget} />}
        {tab === 'providers' && <Providers providers={providers ?? []} onSaved={load} focus={focusProvider} />}
        {tab === 'usage' && <AiUsage />}
      </div>
    </div>
  );
}

