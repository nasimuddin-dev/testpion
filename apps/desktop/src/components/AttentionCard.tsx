import { AlertTriangle, Copy, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { useApp } from '../store';
import { LinkButton } from './ui';
import { copyText } from '../lib/clipboard';
import { plural } from '../lib/format';
import { ProblemList } from './ProblemList';
import { useProblems } from '../lib/problems';

/** What needs attention in the workspace, most severe first; nothing is shown when all is well. */
export function AttentionCard() {
  // the Problems list (WF-03): the same rows as the bottom panel's tab, the first five here
  const items = useProblems();
  const [all, setAll] = useState(false);
  if (!items.length) return null;
  return (
    <section aria-label="Needs attention" className="rounded-2xl border border-line bg-bg shadow-sm">
      <header className="flex items-center gap-2 px-4 h-12 border-b border-line text-sm font-semibold">
        <span className="grid place-items-center h-7 w-7 rounded-lg bg-warn/15 text-warn">
          <AlertTriangle size={15} />
        </span>
        Needs attention
        <button
          className="ml-auto inline-flex items-center gap-1 text-xs font-normal text-accent hover:underline"
          title="Ask the AI assistant what to fix first (the items' messages and severities are sent)"
          onClick={() =>
            useApp
              .getState()
              .set({ assistant: { task: 'triage-attention', title: 'What to fix first', context: { items: items.map((i) => ({ severity: i.severity, kind: i.kind, message: i.message })) } } })
          }
        >
          <Sparkles size={12} /> What first?
        </button>
        <button
          className="inline-flex items-center gap-1 text-xs font-normal text-accent hover:underline"
          title="Copy the list as Markdown (to paste into a chat or an issue)"
          onClick={() =>
            void copyText(['**Needs attention**', ...items.map((i) => `- ${i.severity === 'high' ? '🔴' : i.severity === 'medium' ? '🟠' : '⚪'} ${i.message}`)].join('\n'))
          }
        >
          <Copy size={12} /> Copy
        </button>
        <span className="text-xs font-normal text-muted">
          {plural(items.length, 'item')}
        </span>
      </header>
      <div className="p-2">
        <ProblemList problems={items} limit={all ? undefined : 5} />
        {items.length > 5 && (
          <LinkButton className="px-2 pt-1 text-xs" onClick={() => setAll(!all)}>
            {all ? 'Show fewer' : `Show all ${items.length}`}
          </LinkButton>
        )}
      </div>
    </section>
  );
}
