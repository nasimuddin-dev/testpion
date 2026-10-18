import { GanttChart } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { outputFileName, timelineSvg, type FlowTimeline } from '@testpion/shared';
import { asError, call } from '../api';
import { formatMs } from '../lib/format';
import { Empty, Metric, MetricGrid, Spinner } from './ui';
import { OutputActions } from './output/OutputFrame';
import type { OutputSpec } from './output/output-core';

interface TimelineAnswer {
  file?: string;
  runId: string;
  name?: string;
  truncated?: boolean;
  timeline: FlowTimeline;
}

/** The timeline's colours from the app's theme tokens (the HTML export carries its own light / dark set). */
const THEME = {
  '--tl-fg': 'var(--fg)',
  '--tl-muted': 'var(--muted)',
  '--tl-grid': 'var(--line)',
  '--tl-stripe': 'color-mix(in oklch, var(--hover) 45%, transparent)',
  '--tl-ok': 'var(--ok)',
  '--tl-bad': 'var(--bad)',
  '--tl-skip': 'var(--line-strong)',
  '--tl-accent': 'var(--accent)',
  '--tl-critical': 'var(--brand-to)',
} as React.CSSProperties;

/**
 * A run as a timeline (shared `timelineSvg`, the same picture its HTML download holds): each step's bar from its start to
 * its end, the wait before it, steps that ran at the same time (L1, L2 …), the critical path outlined; hover a bar for
 * its numbers, click it to open the step's result. Of a flow file's run (`file`) or of a whole run.
 */
export function RunTimeline({ runId, file, onPickStep }: { runId: string; file?: string; onPickStep?(name: string, id: string): void }) {
  const [t, setT] = useState<TimelineAnswer | { error: string }>();
  useEffect(() => {
    let live = true;
    setT(undefined);
    call<TimelineAnswer>('tests.flowTimeline', { runId, ...(file ? { file } : {}) }).then(
      (r) => live && setT(r),
      (e) => live && setT({ error: asError(e).message }),
    );
    return () => {
      live = false;
    };
  }, [runId, file]);
  const svg = useMemo(() => (t && !('error' in t) ? timelineSvg(t.timeline) : ''), [t]);
  // the down arrow: a self-contained HTML page (no network needed to open it) or the timeline's data
  const spec = useMemo<OutputSpec>(() => {
    const source = { kind: 'flow-timeline' as const, runId, ...(file ? { file } : {}) };
    const name = t && !('error' in t) ? t.name : undefined;
    return {
      id: 'flow.timeline',
      what: 'run timeline',
      name: outputFileName({ name: `timeline-${name ?? runId}`, ext: '' }),
      formats: [
        { format: 'html', label: 'HTML timeline', source, default: true },
        { format: 'json', label: 'Timeline data (JSON)', source },
      ],
    };
  }, [runId, file, t]);
  if (!t)
    return (
      <div className="p-4">
        <Spinner />
      </div>
    );
  if ('error' in t)
    return (
      <Empty icon={<GanttChart size={24} />} title="No timeline for this run">
        {t.error}
      </Empty>
    );
  const tl = t.timeline;
  const crit = tl.criticalPath.map((id) => tl.bars.find((b) => b.id === id)?.name ?? id);
  return (
    <div className="h-full flex flex-col min-h-0" data-run-timeline={runId} data-output="flow.timeline">
      <div className="flex items-start gap-2 p-2 border-b border-line">
        <MetricGrid compact className="flex-1">
          <Metric label="Total" value={formatMs(tl.totalMs)} />
          <Metric label="Steps" value={tl.bars.length} sub={t.truncated ? 'the first ones of the run' : undefined} />
          <Metric label="Critical path" value={`${tl.criticalPath.length} steps`} sub={`${formatMs(tl.criticalBusyMs)} running${tl.waitMs ? ` · ${formatMs(tl.waitMs)} waiting` : ''}`} />
          <Metric label="Most at once" value={tl.lanes} />
          {tl.slowest[0] && <Metric label="Slowest step" value={formatMs(tl.slowest[0].durationMs)} sub={tl.slowest[0].name} />}
        </MetricGrid>
        <OutputActions spec={spec} />
      </div>
      <div className="px-3 py-1.5 text-xs text-muted border-b border-line truncate" title={crit.join(' → ')}>
        <span className="font-medium text-fg/80">Critical path:</span> {crit.join(' → ')}
      </div>
      <div
        className="flex-1 min-h-0 overflow-auto p-2 [&_.tl-step]:cursor-pointer [&_.tl-step:hover_rect]:opacity-80"
        style={THEME}
        onClick={(e) => {
          const g = (e.target as Element).closest('[data-step-id]');
          const id = g?.getAttribute('data-step-id');
          const bar = id ? tl.bars.find((b) => b.id === id) : undefined;
          if (bar) onPickStep?.(bar.name, bar.id);
        }}
        // the SVG is built from the run's data with every text escaped (shared timelineSvg)
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  );
}
