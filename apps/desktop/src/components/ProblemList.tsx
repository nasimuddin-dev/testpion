import { Fragment, useState } from 'react';
import { AlertCircle, AlertTriangle, ChevronRight, Info, Play, Sparkles } from 'lucide-react';
import { call } from '../api';
import { toastError, useApp } from '../store';
import { openRef } from '../lib/open-ref';
import { runAgain } from '../lib/run-again';
import { askAboutProblem, type Problem } from '../lib/problems';
import { timeAgo } from '../lib/format';
import { RowMenu } from './TreeParts';
import { LABEL } from '../lib/vocabulary';
import { cx, type MenuItem } from './ui';

const DOT = { high: 'bg-bad', medium: 'bg-warn', low: 'bg-muted/60' } as const;
/** A problem's type as an icon (a failure, an error, a warning): the Problems panel's, and every run list's split of failures from errors. */
export const TYPE_ICON = { failure: <AlertTriangle size={13} className="text-bad" />, error: <AlertCircle size={13} className="text-bad" />, warning: <Info size={13} className="text-warn" /> } as const;

/** Run a monitor now; its result updates the list. */
function runMonitor(id: string) {
  void call<{ status: string; passed: number; total: number }>('monitor.run', { id }).then(
    (r) =>
      useApp
        .getState()
        .toast(r.status === 'passed' ? `Monitor passed (${r.passed}/${r.total})` : `Monitor still ${r.status === 'error' ? 'cannot run' : 'failing'}`, r.status === 'passed' ? 'success' : 'error'),
    (e) => toastError(e),
  );
}

/** What a problem offers: open what it names, run it again (a run, a monitor), ask the assistant. */
export function problemActions(p: Problem): MenuItem[] {
  return [
    { label: LABEL.open, icon: <ChevronRight size={14} />, onSelect: () => void openRef(p.ref) },
    ...(p.kind === 'run' && p.ref.kind === 'run' ? [{ label: LABEL.runAgain, icon: <Play size={14} />, onSelect: () => void runAgain(p.ref.runId!) }] : []),
    ...(p.kind === 'monitor' && p.ref.monitorId ? [{ label: 'Run now', icon: <Play size={14} />, onSelect: () => runMonitor(p.ref.monitorId!) }] : []),
    { label: 'Ask AI', icon: <Sparkles size={14} />, separator: true, onSelect: () => askAboutProblem(p) },
  ];
}

/**
 * WF-03: the one list of problems, the same rows in the bottom panel's Problems tab and Home's "Needs attention":
 * severity, failure / error / warning, the message (a click opens what it names), its age, and its actions on the row's
 * ⋯ and right-click. `grouped` shows the groups' headings; `limit` the first n.
 */
export function ProblemList({ problems, grouped, limit }: { problems: Problem[]; grouped?: boolean; limit?: number }) {
  const [menuFor, setMenuFor] = useState<number>();
  const shown = limit ? problems.slice(0, limit) : problems;
  // grouped: the groups in their most severe item's order
  const list = grouped ? [...new Set(shown.map((p) => p.group))].flatMap((g) => shown.filter((p) => p.group === g)) : shown;
  return (
    <div role="list" aria-label="Problems" className="flex flex-col">
      {list.map((p, n) => (
        <Fragment key={`${p.kind}:${JSON.stringify(p.ref)}:${n}`}>
          {grouped && p.group !== list[n - 1]?.group && <div className="px-3 pt-2 pb-0.5 text-[0.7rem] font-semibold uppercase tracking-wide text-muted">{p.group}</div>}
          <div
            role="listitem"
            data-problem={p.kind}
            className={cx('group flex items-center gap-2 pl-2 pr-1 rounded-md text-sm', menuFor === n ? 'bg-hover' : 'hover:bg-hover')}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenuFor(n);
            }}
          >
            <button className="flex-1 min-w-0 flex items-center gap-2 py-1.5 text-left" onClick={() => void openRef(p.ref)} title={p.message}>
              <span className={cx('w-2 h-2 rounded-full shrink-0', DOT[p.severity])} aria-label={p.severity} />
              <span className="shrink-0" aria-label={p.type}>
                {TYPE_ICON[p.type]}
              </span>
              <span className="flex-1 min-w-0 truncate">{p.message}</span>
              {p.at && <span className="text-xs text-muted shrink-0">{timeAgo(p.at)}</span>}
            </button>
            <RowMenu label={p.message} items={menuFor === n ? problemActions(p) : []} open={menuFor === n} onOpenChange={(o) => setMenuFor(o ? n : undefined)} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}
