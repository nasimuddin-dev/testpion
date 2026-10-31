import { useEffect } from 'react';
import { useApp } from '../../store';
import { rememberAiView } from '../../lib/ai-quality';
import { Tabs } from '../ui';
import { AI_TAB_NAME, VIEW_NAME } from '../../lib/ui-names';

/** The tabs of the one "AI Quality" rail item (AU-21). */
export type AiQualityTab = 'start' | 'checks' | 'playground' | 'compare' | 'providers';

/**
 * The tab strip of AI quality: Start, Checks, Try a prompt, Compare, Models and keys (bots with sources have their own rail item, R-1). One component for
 * the two views that host the tabs (the view ids `ai` and `evaluations` stay, so links, intents, shortcuts and drafts keep
 * working): Checks is the evaluations view, the others are the former AI Lab. Both views render this strip at their top.
 */
export function AiQualityTabs({ active, models }: { active: AiQualityTab; /** How many models are set up (shown on Models and keys). */ models?: number }) {
  useEffect(() => rememberAiView(active === 'checks' ? 'evaluations' : 'ai'), [active]);
  return (
    <Tabs
      label={VIEW_NAME.aiQuality}
      value={active}
      onChange={(t) => (t === 'checks' ? useApp.getState().openIntent('evaluations', { host: 'ai' }) : useApp.getState().openIntent('ai', { tab: t }))}
      tabs={[
        { id: 'start', label: AI_TAB_NAME.start, title: 'What do you want to check? Cards by task, the sample, your latest runs' },
        { id: 'checks', label: AI_TAB_NAME.checks, title: 'Your evaluations: test cases, what a good answer is, and the runs' },
        { id: 'playground', label: AI_TAB_NAME.playground, title: 'Send one prompt to a model and see the answer' },
        { id: 'compare', label: AI_TAB_NAME.compare, title: 'The same input on several models: the fastest and the cheapest are marked' },
        { id: 'providers', label: AI_TAB_NAME.providers, badge: models || undefined, title: 'The AI providers prompts are sent to, their keys and prices, and what you have used' },
      ]}
    />
  );
}
