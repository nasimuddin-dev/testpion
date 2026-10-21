import { useEffect, useState } from 'react';
import type { RagTrend as RagTrendData, TrendPoint } from '@testpion/core';
import { asError, call } from '../../api';
import { timeAgo } from '../../lib/format';
import { ChartCard, PointLine, Swatch } from '../charts';
import { Callout, Empty, Spinner } from '../ui';

/**
 * The mean of every metric run by run for an evaluation (and its monitor): one chart per metric with the shared chart card, so
 * every chart offers the same picture / plot download. A run measured with another judge or another wording of a metric is
 * drawn in the warning colour and is not read as a regression; the metrics that moved are said in words above the charts.
 * The engine builds the trend (`rag.trend`, the same as `testpion rag trend`); this only draws it.
 */
export function RagTrend({ evaluation, onOpenRun }: { evaluation: string; onOpenRun?(runId: string): void }) {
  const [data, setData] = useState<RagTrendData>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    setData(undefined);
    call<RagTrendData>('rag.trend', { evaluation, runs: 30 }).then(
      (r) => live && (setData(r), setError(undefined)),
      (e) => live && setError(asError(e).message),
    );
    return () => {
      live = false;
    };
  }, [evaluation]);
  if (error) return <div className="p-3"><Callout tone="warn">{error}</Callout></div>;
  if (!data) return <div className="p-6 grid place-items-center"><Spinner /></div>;
  const keys = [...new Set(data.points.flatMap((p) => Object.entries(p.metrics).filter(([, m]) => m.mean !== undefined).map(([k]) => k)))];
  if (data.points.length < 2 || !keys.length)
    return (
      <div className="p-3" data-rag-trend-empty>
        <Empty title="Not enough runs for a trend">A trend needs two scored runs of this evaluation. Run it again, or let a monitor run it on a schedule.</Empty>
      </div>
    );
  return (
    <div className="p-3 overflow-auto h-full grid gap-3 content-start" data-rag-trend>
      <div className="flex flex-col gap-1 text-sm" data-rag-trend-findings>
        {data.findings.length ? data.findings.map((f) => <Callout key={f.metric} tone={f.worse ? 'bad' : 'ok'}>{f.text}</Callout>) : <span className="text-xs text-muted">No metric moved more than its interval since the runs before it.</span>}
      </div>
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
        {keys.slice(0, 12).map((k) => {
          const pts = data.points.filter((p) => p.metrics[k]?.mean !== undefined);
          const last = pts[pts.length - 1]!;
          return (
            <ChartCard key={k} title={k} aside={<span>latest <b>{last.metrics[k]!.mean}</b> · {pts.length} runs</span>} legend={pts.some((p) => p.judgeChanged) ? <Swatch color="var(--warn)" label="judge or wording changed" /> : undefined}>
              <div data-rag-trend-chart={k}>
                <PointLine<TrendPoint>
                  items={pts}
                  value={(p) => p.metrics[k]!.mean!}
                  color={(p) => (p.judgeChanged ? 'var(--warn)' : 'var(--accent)')}
                  keyOf={(p) => p.runId}
                  axis={(v) => String(Math.round(v * 100) / 100)}
                  ends={(p) => timeAgo(p.at)}
                  label={`${k} across ${pts.length} runs`}
                  tip={(p) => (
                    <div className="text-xs">
                      <div className="font-medium">
                        {k} {p.metrics[k]!.mean}
                      </div>
                      <div>{new Date(p.at).toLocaleString()}</div>
                      <div className="text-muted">
                        {p.n} samples{p.metrics[k]!.naCount ? ` · ${p.metrics[k]!.naCount} n/a` : ''}
                        {p.metrics[k]!.ci ? ` · 95% ${p.metrics[k]!.ci![0]} to ${p.metrics[k]!.ci![1]}` : ''}
                      </div>
                      {p.judge && <div className="text-muted">judge {p.judge}</div>}
                      {p.judgeChanged && <div className="text-warn">judge or wording changed: not comparable</div>}
                    </div>
                  )}
                  onPick={onOpenRun && ((p) => onOpenRun(p.runId))}
                />
              </div>
            </ChartCard>
          );
        })}
      </div>
    </div>
  );
}
