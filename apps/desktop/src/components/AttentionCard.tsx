import { AlertTriangle, ChevronRight, Copy, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { call } from '../api';
import { toastError, useApp } from '../store';
import { LinkButton, cx } from './ui';
import { useRpc } from '../lib/use-rpc';
import { copyText } from '../lib/clipboard';
import { plural } from '../lib/format';

/** From `stats.attention` (workspaceAttention in core). */
interface Item {
  kind: 'monitor' | 'certificate' | 'flaky' | 'request' | 'run';
  severity: 'high' | 'medium' | 'low';
  message: string;
  ref: { monitorId?: string; host?: string; testId?: string; collectionId?: string; requestId?: string; runId?: string };
}

const DOT = { high: 'bg-bad', medium: 'bg-warn', low: 'bg-muted/60' } as const;

/** Where to go for an item: the monitor, the run, the request (certificates have no page of their own). */
function openItem(i: Item) {
  const s = useApp.getState();
  if (i.kind === 'monitor' && i.ref.monitorId) s.openIntent('monitors', { monitorId: i.ref.monitorId });
  else if ((i.kind === 'run' || i.kind === 'flaky') && i.ref.runId) s.openIntent('tests', { runId: i.ref.runId });
  else if (i.kind === 'flaky') s.setView('tests');
  else if (i.kind === 'request' && i.ref.collectionId && i.ref.requestId) s.openIntent('rest', { collectionId: i.ref.collectionId, requestId: i.ref.requestId });
}

/** Run a monitor now; the card refreshes on its result. */
function runMonitor(id: string) {
  void call<{ status: string; passed: number; total: number }>('monitor.run', { id }).then(
    (r) =>
      useApp
        .getState()
        .toast(r.status === 'passed' ? `Monitor passed (${r.passed}/${r.total})` : `Monitor still ${r.status === 'error' ? 'cannot run' : 'failing'}`, r.status === 'passed' ? 'success' : 'error'),
    (e) => toastError(e),
  );
}

/** What needs attention in the workspace, most severe first; nothing is shown when all is well. */
export function AttentionCard() {
  const items = useRpc<Item[]>('stats.attention', undefined, { fallback: [], reloadOn: ['run.finished', 'monitor.result'] }) ?? [];
  const [all, setAll] = useState(false);
  if (!items.length) return null;
  const shown = all ? items : items.slice(0, 5);
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
        {shown.map((i, n) => {
          const clickable = i.kind !== 'certificate';
          return (
            <div key={n} className="flex items-center gap-2">
              <button
                disabled={!clickable}
                onClick={() => openItem(i)}
                className={cx('flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-left', clickable ? 'hover:bg-hover' : 'cursor-default')}
              >
                <span className={cx('w-2 h-2 rounded-full shrink-0', DOT[i.severity])} aria-label={i.severity} />
                <span className="flex-1 min-w-0 truncate" title={i.message}>
                  {i.message}
                </span>
                {clickable && <ChevronRight size={14} className="text-muted shrink-0" />}
              </button>
              {i.kind === 'monitor' && i.ref.monitorId && (
                <LinkButton className="text-xs shrink-0 pr-2" title="Run this monitor now" onClick={() => runMonitor(i.ref.monitorId!)}>
                  Run now
                </LinkButton>
              )}
            </div>
          );
        })}
        {items.length > 5 && (
          <LinkButton className="px-2 pt-1 text-xs" onClick={() => setAll(!all)}>
            {all ? 'Show fewer' : `Show all ${items.length}`}
          </LinkButton>
        )}
      </div>
    </section>
  );
}
