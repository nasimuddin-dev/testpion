import { useEffect } from 'react';
import { useApp } from '../../store';
import { rememberAiView } from '../../lib/ai-quality';
import { Tabs } from '../ui';

/** The tabs of the one "AI quality" rail item (AU-21). */
export type AiQualityTab = 'start' | 'checks' | 'playground' | 'compare' | 'rag' | 'providers';

/**
 * The tab strip of AI quality: Start, Checks, Try a prompt, Compare, Bots with sources, Models and keys. One component for
 * the two views that host the tabs (the view ids `ai` and `evaluations` stay, so links, intents, shortcuts and drafts keep
 * working): Checks is the evaluations view, the others are the former AI Lab. Both views render this strip at their top.
 */
export function AiQualityTabs({ active, models }: { active: AiQualityTab; /** How many models are set up (shown on Models and keys). */ models?: number }) {
  useEffect(() => rememberAiView(active === 'checks' ? 'evaluations' : 'ai'), [active]);
  return (
    <Tabs
      label="AI quality"
      value={active}
      onChange={(t) => (t === 'checks' ? useApp.getState().setView('evaluations') : useApp.getState().openIntent('ai', { tab: t }))}
      tabs={[
        { id: 'start', label: 'Start', title: 'What do you want to check? Cards by task, the sample, your latest runs' },
        { id: 'checks', label: 'Checks', title: 'Your evaluations: test cases, what a good answer is, and the runs' },
        { id: 'playground', label: 'Try a prompt', title: 'Send one prompt to a model and see the answer' },
        { id: 'compare', label: 'Compare', title: 'The same input on several models: the fastest and the cheapest are marked' },
        { id: 'rag', label: 'Bots with sources', title: 'Bots that answer from documents (RAG): connect one, map its answer and retrieved documents' },
        { id: 'providers', label: 'Models and keys', badge: models || undefined, title: 'The AI providers prompts are sent to, their keys and prices, and what you have used' },
      ]}
    />
  );
}
