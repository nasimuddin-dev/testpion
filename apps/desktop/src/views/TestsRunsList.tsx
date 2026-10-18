import { useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { cx, Input } from '../components/ui';
import { NodeMenu } from '../components/TreeParts';
import { RunMiniBar, type RunRow } from '../components/RunsOverview';
import { EnvBadge } from '../components/EnvSelect';
import { TYPE_ICON } from '../components/ProblemList';
import { startAiAnalysis } from '../components/ai/ai-analysis';
import { copyText } from '../lib/clipboard';
import { saveRunReport } from '../components/output/run-specs';
import { timeAgo } from '../lib/format';
import { copyRunCommand, runInCi } from '../lib/run-ci';

/** The Tests view's list of runs: each row the `run` kind's node, with the one menu (lib/node-menu.ts). */
export function RunList({ runs, active, onSelect, onOverview, onRerunFailed }: { runs: RunRow[]; active?: string; onSelect(id: string): void; onOverview?(): void; onRerunFailed?(id: string): void }) {
  // the row whose menu is open (its ⋯, or a right-click on the row): the shared item menu (TreeParts NodeMenu)
  const [menuFor, setMenuFor] = useState<string>();
  // filter by name / environment, and only the runs where something failed
  const [query, setQuery] = useState('');
  const [failedOnly, setFailedOnly] = useState(false);
  const q = query.toLowerCase();
  const shown = runs.filter((r) => (!failedOnly || r.failed + r.errors > 0) && (!q || `${r.name} ${r.environment ?? ''}`.toLowerCase().includes(q)));
  return (
    <div className="h-full flex flex-col min-h-0">
      {onOverview && (
        <button className="flex items-center gap-1.5 px-3 py-1.5 border-b border-line text-xs text-accent hover:bg-hover text-left" onClick={onOverview}>
          <BarChart3 size={12} /> Overview of all runs
        </button>
      )}
      {runs.length > 3 && (
        <div className="flex items-center gap-2 px-2 py-1.5 border-b border-line">
          <Input className="h-7 min-h-7 text-sm flex-1 min-w-0" placeholder="Filter runs" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter runs" />
          <label className="flex items-center gap-1 text-xs text-muted whitespace-nowrap">
            <input type="checkbox" checked={failedOnly} onChange={(e) => setFailedOnly(e.target.checked)} /> Failed
          </label>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto">
        {shown.map((r) => (
          <div
            key={r.id}
            className={cx('group flex items-start border-b border-line/60', active === r.id ? 'bg-accent/10' : 'hover:bg-hover')}
            data-run-row={r.id}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenuFor(r.id);
            }}
          >
            <button onClick={() => onSelect(r.id)} className="flex-1 min-w-0 text-left pl-3 py-2">
              <div className="text-sm truncate">{r.name}</div>
              <RunMiniBar r={r} />
              <div className="text-xs text-muted flex gap-2">
                <span className={r.failed + r.errors ? 'text-bad' : 'text-ok'}>
                  {r.passed}/{r.total}
                </span>
                {/* failures (a check did not hold) apart from errors (it could not run), as the Problems panel tells them apart */}
                {r.failed > 0 && (
                  <span className="inline-flex items-center gap-0.5 text-bad" title="Failures: checks that did not hold" data-run-failures={r.failed}>
                    {TYPE_ICON.failure}
                    {r.failed} failed
                  </span>
                )}
                {r.errors > 0 && (
                  <span className="inline-flex items-center gap-0.5 text-bad" title="Errors: could not run (network, TLS, timeout or a script)" data-run-errors={r.errors}>
                    {TYPE_ICON.error}
                    {r.errors} error{r.errors === 1 ? '' : 's'}
                  </span>
                )}
                {r.environment && <EnvBadge name={r.environment} className="max-w-32" />}
                <span className="ml-auto">{timeAgo(r.startedAt)}</span>
              </div>
            </button>
            <div className="pt-1.5 pr-1">
              <NodeMenu
                kind="run"
                label={r.name}
                open={menuFor === r.id}
                onOpenChange={(o) => setMenuFor(o ? r.id : undefined)}
                ctx={() => ({
                  ref: { kind: 'run', runId: r.id },
                  name: r.name,
                  on: {
                    open: () => onSelect(r.id),
                    ...(onRerunFailed ? { rerunFailed: () => onRerunFailed(r.id) } : {}),
                    exportReport: () => void saveRunReport({ id: r.id, name: r.name }),
                    copyCli: () => void copyRunCommand(r.id),
                    copyRunId: () => void copyText(r.id, 'Run id'),
                    ci: () => void runInCi(r.id),
                    ...(r.failed + r.errors > 0 ? { triage: () => startAiAnalysis({ kind: 'triage', runId: r.id, title: r.name }) } : {}),
                  },
                  disabled: r.failed + r.errors > 0 ? {} : { rerunFailed: 'Nothing failed in this run' },
                })}
              />
            </div>
          </div>
        ))}
        {!runs.length && <div className="p-3 text-sm text-muted">No runs yet</div>}
        {runs.length > 0 && !shown.length && <div className="p-3 text-sm text-muted">No runs match</div>}
      </div>
    </div>
  );
}
