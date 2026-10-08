import { useState } from 'react';
import { formatMs, timeAgo } from '../lib/format';
import { axisMs, ChartCard, PointLine } from './charts';
import { Badge, cx } from './ui';
import { useRpc } from '../lib/use-rpc';

/** From `load.history` (LoadRunRecord in core). */
export interface LoadRun {
  id: string;
  startedAt: string;
  savedId?: string;
  name: string;
  target: string;
  environment?: string;
  virtualUsers: number;
  durationSec: number;
  stopped?: boolean;
  requests: number;
  throughput: number;
  errorRate: number;
  p50: number;
  p95: number;
  p99: number;
  ttfbP95?: number;
  newConnectionShare?: number;
  passed?: boolean;
}

const pct = (v: number) => `${Math.round(v * 10000) / 100}%`;

/** One metric across the last runs (oldest left): a line, points coloured by the run's result. */
function Trend({ runs, title, value, format, axis }: { runs: LoadRun[]; title: string; value(r: LoadRun): number; format(v: number): string; axis(v: number): string }) {
  const last = runs[runs.length - 1];
  return (
    <ChartCard title={title} aside={last ? <span>last <b className="text-fg">{format(value(last))}</b></span> : undefined}>
      <PointLine
        items={runs}
        value={value}
        color={(r) => (r.passed === false || r.errorRate > 0.01 ? 'var(--bad)' : 'var(--ok)')}
        keyOf={(r) => r.id}
        axis={axis}
        height={120}
        label={`${title} of the last ${runs.length} load tests`}
        tip={(r) => (
          <>
            <div className="font-medium text-fg">
              {format(value(r))} · {timeAgo(r.startedAt)}
            </div>
            <div className="text-muted mt-0.5">
              {r.virtualUsers} VUs · {r.durationSec}s · errors {pct(r.errorRate)}
            </div>
          </>
        )}
      />
    </ChartCard>
  );
}

/**
 * Earlier load tests (of the opened saved load test, or all): p95 and throughput trends and a list.
 * Every finished load test is recorded by the backend.
 */
/** Change against the reference run, coloured by whether it is better (higher req/s, lower p95). */
function Delta({ value, base, higherIsBetter }: { value: number; base?: number; higherIsBetter: boolean }) {
  if (base === undefined || !base) return null;
  const pctChange = Math.round(((value - base) / base) * 100);
  if (!pctChange) return <span className="text-muted text-[0.7rem] ml-1">±0%</span>;
  const better = higherIsBetter ? pctChange > 0 : pctChange < 0;
  return <span className={cx('text-[0.7rem] ml-1', better ? 'text-ok' : 'text-bad')}>{pctChange > 0 ? `+${pctChange}` : pctChange}%</span>;
}

export function LoadHistory({ savedId }: { savedId?: string }) {
  const runs = useRpc<LoadRun[]>('load.history', { savedId, limit: 30 }, { fallback: [], reloadOn: ['load.recorded'], keep: true }) ?? [];
  // click a run to compare the others with it
  const [refId, setRefId] = useState<string>();
  if (!runs.length) return null;
  const ordered = [...runs].reverse();
  const ref = runs.find((r) => r.id === refId);
  return (
    <section aria-label="Earlier load tests" className="flex flex-col gap-2">
      <div className="text-xs text-muted font-semibold">
        {savedId ? 'Earlier runs of this load test' : 'Earlier load tests'}
        <span className="font-normal ml-2">{ref ? '· compared with the highlighted run' : runs.length > 1 ? '· click a run to compare the others with it' : ''}</span>
      </div>
      {ordered.length > 1 && (
        <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
          <Trend runs={ordered} title="p95 latency" value={(r) => r.p95} format={formatMs} axis={axisMs} />
          <Trend runs={ordered} title="Throughput" value={(r) => r.throughput} format={(v) => `${Math.round(v)}/s`} axis={(v) => String(Math.round(v))} />
        </div>
      )}
      <table className="w-full text-sm">
        <thead className="text-xs text-muted text-left">
          <tr>
            <th className="font-medium py-1">When</th>
            {!savedId && <th className="font-medium">Load test</th>}
            <th className="font-medium text-right">VUs</th>
            <th className="font-medium text-right">Req/s</th>
            <th className="font-medium text-right">p95</th>
            <th className="font-medium text-right" title="Server time: p95 time to the first byte">Server p95</th>
            <th className="font-medium text-right">Errors</th>
            <th className="font-medium text-right">Result</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {runs.map((r) => (
            <tr
              key={r.id}
              className={cx('border-t border-line cursor-pointer', r.id === refId ? 'bg-accent/10' : 'hover:bg-hover')}
              title={`${r.target}${r.environment ? ` · ${r.environment}` : ''}\n${r.id === refId ? 'The reference: click again to stop comparing' : 'Click to compare the other runs with this one'}`}
              onClick={() => setRefId((x) => (x === r.id ? undefined : r.id))}
            >
              <td className="py-1 pr-2 whitespace-nowrap">{timeAgo(r.startedAt)}</td>
              {!savedId && <td className="pr-2 truncate max-w-56">{r.name}</td>}
              <td className="text-right">{r.virtualUsers}</td>
              <td className="text-right whitespace-nowrap">
                {Math.round(r.throughput)}
                {ref && r.id !== ref.id && <Delta value={r.throughput} base={ref.throughput} higherIsBetter />}
              </td>
              <td className="text-right whitespace-nowrap">
                {formatMs(r.p95)}
                {ref && r.id !== ref.id && <Delta value={r.p95} base={ref.p95} higherIsBetter={false} />}
              </td>
              <td className="text-right whitespace-nowrap" title={r.newConnectionShare !== undefined ? `${Math.round(r.newConnectionShare * 100)}% of the requests opened a new connection` : undefined}>
                {r.ttfbP95 !== undefined ? formatMs(r.ttfbP95) : <span className="text-muted">—</span>}
                {ref && r.id !== ref.id && r.ttfbP95 !== undefined && ref.ttfbP95 !== undefined && <Delta value={r.ttfbP95} base={ref.ttfbP95} higherIsBetter={false} />}
              </td>
              <td className={cx('text-right', r.errorRate > 0.01 && 'text-bad')}>{pct(r.errorRate)}</td>
              <td className="text-right">{r.passed === undefined ? (r.stopped ? <Badge tone="warn">stopped</Badge> : <span className="text-muted">—</span>) : <Badge tone={r.passed ? 'ok' : 'bad'}>{r.passed ? 'passed' : 'failed'}</Badge>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
