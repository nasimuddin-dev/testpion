import { useCallback, useEffect, useState } from 'react';
import { useSticky } from '../lib/sticky';
import { AiUsage } from '../components/AiUsage';
import { call } from '../api';
import { useIntent } from '../hooks';
import type { ProviderConfig } from '../types';
import { Segmented } from '../components/ui';
import { AiQualityTabs } from '../components/ai/AiQualityTabs';
import { Playground } from './ai/Playground';
import { Compare } from './ai/Compare';
import { Providers } from './ai/Providers';
import { Rag } from './ai/Rag';
import { Start } from './ai/Start';

export function AiLabView() {
  // kept while the app runs, so switching tabs or views doesn't lose results
  const [tab, setTab] = useSticky<'start' | 'playground' | 'compare' | 'rag' | 'providers'>('ai:tab', 'start');
  // Models and keys holds the providers and, beside them, what the AI calls used
  const [models, setModels] = useSticky<'providers' | 'usage'>('ai:models', 'providers');
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
    if (p?.tab === 'usage') (setTab('providers'), setModels('usage'));
    else if (p?.tab) (setTab(p.tab), p.tab === 'providers' && setModels('providers'));
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
      {/* AU-21: one rail item, AI quality; the first page says what it does and works with no model (the sample) */}
      <AiQualityTabs active={tab} models={providers?.length} />
      <div className="flex-1 min-h-0">
        {tab === 'start' && <Start providers={providers} onTab={setTab} />}
        {tab === 'playground' && <Playground providers={providers ?? []} onSetUp={() => setTab('providers')} />}
        {tab === 'compare' && <Compare providers={providers ?? []} onSetUp={() => setTab('providers')} />}
        {tab === 'rag' && <Rag openTarget={ragTarget} />}
        {tab === 'providers' && (
          <div className="h-full flex flex-col" data-models-and-keys>
            <div className="px-3 py-1.5 border-b border-line">
              <Segmented
                label="Models and keys"
                size="xs"
                value={models}
                onChange={setModels}
                options={[
                  { value: 'providers', label: 'Providers', title: 'The AI providers prompts are sent to: keys, models and prices' },
                  { value: 'usage', label: 'Usage', title: 'Tokens and cost of the AI calls, per model' },
                ]}
              />
            </div>
            <div className="flex-1 min-h-0">{models === 'usage' ? <AiUsage /> : <Providers providers={providers ?? []} onSaved={load} focus={focusProvider} />}</div>
          </div>
        )}
      </div>
    </div>
  );
}

