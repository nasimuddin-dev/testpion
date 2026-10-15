import { FileDown, GanttChart } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { timelineSvg, type FlowTimeline } from '@testpion/shared';
import { asError, call } from '../api';
import { toastError } from '../store';
import { formatMs } from '../lib/format';
import { finishSave, type SaveResult } from '../lib/files';
import { Button, Empty, Metric, MetricGrid, Spinner } from './ui';

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
 * A run as a timeline (shared `timelineSvg`, the same picture `Save as HTML` writes): each step's bar from its start to
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
    <div className="h-full flex flex-col min-h-0" data-run-timeline={runId}>
      <div className="flex items-start gap-2 p-2 border-b border-line">
        <MetricGrid compact className="flex-1">
          <Metric label="Total" value={formatMs(tl.totalMs)} />
          <Metric label="Steps" value={tl.bars.length} sub={t.truncated ? 'the first ones of the run' : undefined} />
          <Metric label="Critical path" value={`${tl.criticalPath.length} steps`} sub={`${formatMs(tl.criticalBusyMs)} running${tl.waitMs ? ` · ${formatMs(tl.waitMs)} waiting` : ''}`} />
          <Metric label="Most at once" value={tl.lanes} />
          {tl.slowest[0] && <Metric label="Slowest step" value={formatMs(tl.slowest[0].durationMs)} sub={tl.slowest[0].name} />}
        </MetricGrid>
        <Button
          size="sm"
          icon={<FileDown size={12} />}
          data-timeline-save-html
          title="A self-contained HTML file (no network needed to open it) to share"
          onClick={() => void call<SaveResult>('tests.flowTimelineHtml', { runId, ...(file ? { file } : {}) }).then((r) => finishSave(r, 'Timeline'), toastError)}
        >
          Save as HTML
        </Button>
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
