import { useApp } from '../../store';
import { Tabs } from '../ui';

/** The tabs of the RAG bots rail item (R-1), in the order of the work. */
export type RagTab = 'start' | 'bots' | 'questions' | 'metrics' | 'checks';

/**
 * The tab strip of RAG bots: Start, Bots, Questions, Metrics, Checks. One component for the two views that host
 * it (`rag` for the first four, `evaluations` for Checks when it shows an evaluation of type rag), so the strip is the same
 * wherever the person is in the work.
 */
export function RagTabs({ active }: { active: RagTab }) {
  return (
    <Tabs
      label="RAG bots"
      value={active}
      onChange={(t) => (t === 'checks' ? useApp.getState().openIntent('evaluations', { host: 'rag' }) : useApp.getState().openIntent('rag', { tab: t }))}
      tabs={[
        { id: 'start', label: 'Start', title: 'What do you want to find out? The steps in order, and your latest runs' },
        { id: 'bots', label: 'Bots', title: 'The bots you test: connect one (any protocol), ask it a question, click its answer and the documents it retrieved' },
        { id: 'questions', label: 'Questions', title: 'The questions you ask every bot: write them, generate them from your documents, or take them from real calls' },
        { id: 'metrics', label: 'Metrics', title: 'Your own measures of a good answer: a rule, a checklist, a formula or a criterion an AI reviewer decides' },
        { id: 'checks', label: 'Checks', title: 'The evaluations of your bots: which questions, which measures, and the runs with their results' },
      ]}
    />
  );
}
