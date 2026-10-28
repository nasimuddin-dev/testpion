import { Cloud } from 'lucide-react';
import { useEffect, useState } from 'react';
import { on } from '../../api';
import { formatCost, formatMs } from '../../lib/format';
import { useRpc } from '../../lib/use-rpc';
import { LABEL } from '../../lib/vocabulary';
import type { RunSummary } from '../../types';
import { Badge, Button, cx } from '../ui';

/** The sentence a run is reduced to: "17 of 20 passed" (the same words the CLI and the MCP tools say). */
export function runHeadline(s: Pick<RunSummary, 'passed' | 'total'>): string {
  return `${s.passed} of ${s.total} passed`;
}

/**
 * The first thing above a run of an evaluation (AU-7): how many passed, in one chip, with the cost and the time, a label
 * when the answers came from the offline demo model, a note when the run stopped at its spend cap, and Run in CI.
 */
export function EvalRunHeadline({ runId, offline, onCi, ciReason }: { runId: string; offline?: boolean; onCi?(): void; /** Why Run in CI is not available yet. */ ciReason?: string }) {
  const summary = useRpc<RunSummary | null>('runs.summary', { runId }, { reloadOn: ['run.finished'], keep: true });
  const [capped, setCapped] = useState<string>();
  useEffect(() => {
    setCapped(undefined);
    return on<{ runId: string; message: string }>('eval.capped', (e) => e.runId === runId && setCapped(e.message));
  }, [runId]);
  const bad = !!summary && summary.failed + summary.errors > 0;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 border-b border-line" data-eval-headline={summary ? (bad ? 'failed' : 'passed') : 'running'}>
      {summary ? (
        <span className={cx('rounded-full px-2.5 py-0.5 text-sm font-semibold ring-1', bad ? 'bg-bad/10 text-bad ring-bad/30' : 'bg-ok/10 text-ok ring-ok/30')} data-eval-headline-text>
          {runHeadline(summary)}
        </span>
      ) : (
        <span className="text-sm text-muted" data-eval-headline-text>
          Running …
        </span>
      )}
      {summary && (
        <span className="text-xs text-muted">
          {summary.costUsd ? `Cost ${formatCost(summary.costUsd)} · ` : ''}
          {summary.latency.count ? `Average ${formatMs(summary.latency.mean)} · ` : ''}
          {formatMs(summary.durationMs)} in all
        </span>
      )}
      {offline && (
        <Badge tone="warn" title="These answers came from the offline demo model, which answers by rules. Connect a real model in Models and keys to judge a real one.">
          Offline demo
        </Badge>
      )}
      {capped && (
        <span className="text-xs text-warn" data-eval-capped>
          {capped}
        </span>
      )}
      {onCi && (
        <Button size="sm" className="ml-auto" icon={<Cloud size={12} />} onClick={onCi} disabled={!!ciReason} reason={ciReason} title="A pipeline that runs this evaluation on every push and fails when a case got worse" data-eval-ci>
          {LABEL.runInCi}
        </Button>
      )}
    </div>
  );
}
