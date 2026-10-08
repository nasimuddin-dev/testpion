import { useEffect, useMemo, useState } from 'react';
import { call } from '../api';
import { formatMs, plural, timeAgo } from '../lib/format';
import { cx } from './ui';
import { axisMs, ChartCard as Card, chartKeys, ChartTip, PointLine, StackedColumns, Swatch, useWidth } from './charts';

/** A monitor run, as the charts need it. */
export interface RunPoint {
  runId: string;
  startedAt: string;
  durationMs: number;
  status: 'passed' | 'failed' | 'error';
  total: number;
  passed: number;
  failed: number;
  errors: number;
  p50Ms?: number;
  p95Ms?: number;
  reason?: string;
}

const STATUS_LABEL = { passed: 'Passed', failed: 'Failed', error: 'Could not run' } as const;
const statusColor = (s: RunPoint['status']) => (s === 'passed' ? 'var(--ok)' : 'var(--bad)');

/** The hover card shared by the charts: what one run did. */
function Tip({ r, x, width }: { r: RunPoint; x: number; width: number }) {
  return (
    <ChartTip x={x} width={width}>
      <TipBody r={r} />
    </ChartTip>
  );
}

function TipBody({ r }: { r: RunPoint }) {
  return (
    <>
      <div className="flex items-center gap-1.5 font-medium text-fg">
        <span className="w-2 h-2 rounded-full" style={{ background: statusColor(r.status) }} />
        {STATUS_LABEL[r.status]} · {timeAgo(r.startedAt)}
      </div>
      <div className="text-muted mt-0.5">
        {r.total ? `${r.passed}/${r.total} requests passed · ` : ''}
        {formatMs(r.durationMs)}
        {r.p50Ms !== undefined ? ` · median response ${formatMs(r.p50Ms)}` : ''}
      </div>
      {r.reason && <div className="text-bad">{r.reason}</div>}
      <div className="text-muted">{new Date(r.startedAt).toLocaleString()}</div>
    </>
  );
}

/** Share of runs that passed since a time (undefined when there were none). */
function uptimeSince(runs: RunPoint[], ms: number): number | undefined {
  const since = Date.now() - ms;
  const inRange = runs.filter((r) => Date.parse(r.startedAt) >= since);
  if (!inRange.length) return undefined;
  return Math.round((inRange.filter((r) => r.status === 'passed').length / inRange.length) * 1000) / 10;
}

const pct = (v?: number) => (v === undefined ? '—' : `${v}%`);

/** Availability, like a status page: one block per run (oldest → newest), passed or not, with uptime over 24 h and 7 days. */
function AvailabilityStrip({ runs }: { runs: RunPoint[] }) {
  const ordered = useMemo(() => [...runs].slice(0, 90).reverse(), [runs]);
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number>();
  const gap = 2;
  const block = ordered.length ? Math.max(3, Math.min(14, (width - gap * (ordered.length - 1)) / ordered.length)) : 0;
  return (
    <Card
      title="Availability"
      aside={
        <span>
          24 h <b className="text-fg">{pct(uptimeSince(runs, 864e5))}</b> · 7 days <b className="text-fg">{pct(uptimeSince(runs, 7 * 864e5))}</b>
        </span>
      }
      legend={
        <>
          <Swatch color="var(--ok)" label="Passed" />
          <Swatch color="var(--bad)" label="Failed or could not run" />
          <span className="ml-auto">{ordered.length === 1 ? 'the last run' : ordered.length ? `last ${ordered.length} runs, oldest left` : ''}</span>
        </>
      }
    >
      <div ref={ref} {...chartKeys(ordered.length, hover, setHover)} className="relative h-8 outline-none focus-visible:ring-2 focus-visible:ring-accent/50 rounded" onMouseLeave={() => setHover(undefined)}>
        <svg width={width} height={32} role="img" aria-label={`${ordered.filter((r) => r.status === 'passed').length} of the last ${ordered.length} runs passed`}>
          {ordered.map((r, i) => (
            <rect
              key={r.runId}
              x={i * (block + gap)}
              y={0}
              width={block}
              height={32}
              rx={2}
              fill={statusColor(r.status)}
              opacity={hover === undefined || hover === i ? 0.9 : 0.45}
              onMouseEnter={() => setHover(i)}
            />
          ))}
        </svg>
        {hover !== undefined && ordered[hover] && <div className="absolute left-0 top-9 w-full h-0"><Tip r={ordered[hover]!} x={hover * (block + gap)} width={width} /></div>}
      </div>
    </Card>
  );
}

/** Run time over the last runs: one line (one axis), each point coloured by its result, the median dashed. */
function RunTimeChart({ runs }: { runs: RunPoint[] }) {
  const ordered = useMemo(() => [...runs].slice(0, 60).reverse(), [runs]);
  const sorted = ordered.map((r) => r.durationMs).sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)]! : 0;
  return (
    <Card title="Run time" aside={ordered.length ? <span>median <b className="text-fg">{formatMs(median)}</b></span> : undefined}>
      <PointLine
        items={ordered}
        value={(r) => r.durationMs}
        color={(r) => statusColor(r.status)}
        keyOf={(r) => r.runId}
        axis={axisMs}
        reference={median}
        ends={(r) => timeAgo(r.startedAt)}
        tip={(r) => <TipBody r={r} />}
        label={`Run time of the last ${ordered.length} runs, median ${formatMs(median)}`}
      />
    </Card>
  );
}

/** Requests per run: passed stacked under failed (failed + errors), one column per run. */
function RequestsChart({ runs }: { runs: RunPoint[] }) {
  const ordered = useMemo(() => [...runs].slice(0, 40).reverse(), [runs]);
  const anyFailed = ordered.some((r) => r.failed + r.errors > 0);
  return (
    <Card
      title="Requests per run"
      legend={
        <>
          <Swatch color="var(--ok)" label="Passed" />
          <Swatch color="var(--bad)" label="Failed" />
          {!anyFailed && ordered.length > 0 && <span className="ml-auto">every request passed</span>}
        </>
      }
    >
      <StackedColumns
        items={ordered}
        ok={(r) => r.passed}
        bad={(r) => r.failed + r.errors}
        keyOf={(r) => r.runId}
        height={150}
        maxBar={18}
        label="Requests passed and failed per run"
        emptyMark={(r) => r.total === 0}
        tip={(r) => <TipBody r={r} />}
      />
    </Card>
  );
}

/** The monitor's charts: availability across the top, run time and requests side by side. */
/** p95 response time of each run's requests, with the monitor's limit dashed (points over it in red). */
function ResponseP95Chart({ runs, limit }: { runs: RunPoint[]; limit?: number }) {
  const ordered = useMemo(() => [...runs].filter((r) => typeof r.p95Ms === 'number').slice(0, 60).reverse(), [runs]);
  if (ordered.length < 2 && limit === undefined) return null;
  if (!ordered.length) return null;
  const over = limit === undefined ? 0 : ordered.filter((r) => r.p95Ms! > limit).length;
  return (
    <Card title="Response p95" aside={limit !== undefined ? <span>limit <b className="text-fg">{formatMs(limit)}</b>{over ? <span className="text-bad"> · {over} over</span> : ''}</span> : undefined}>
      <PointLine
        items={ordered}
        value={(r) => r.p95Ms!}
        color={(r) => (limit !== undefined ? (r.p95Ms! > limit ? 'var(--bad)' : 'var(--ok)') : statusColor(r.status))}
        keyOf={(r) => r.runId}
        axis={axisMs}
        reference={limit}
        ends={(r) => timeAgo(r.startedAt)}
        tip={(r) => (
          <>
            <div className="font-medium text-fg">p95 {formatMs(r.p95Ms!)} · {timeAgo(r.startedAt)}</div>
            {limit !== undefined && <div className={r.p95Ms! > limit ? 'text-bad' : 'text-muted'}>{r.p95Ms! > limit ? `over the ${formatMs(limit)} limit` : `within the ${formatMs(limit)} limit`}</div>}
          </>
        )}
        label={`p95 response time of the last ${ordered.length} runs`}
      />
    </Card>
  );
}

/** One day of a monitor (monitor.daily). */
interface MonitorDay {
  date: string;
  runs: number;
  passed: number;
  uptime?: number;
  maxP95Ms?: number;
}

const dayColor = (d: MonitorDay) => (!d.runs ? 'var(--line)' : d.uptime === 100 ? 'var(--ok)' : (d.uptime ?? 0) >= 90 ? 'var(--warn)' : 'var(--bad)');
const dayLabel = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

/** Uptime per day over 30 days, like a status page: one block per calendar day (in this browser's time zone). */
function DailyUptime({ monitorId, refresh }: { monitorId: string; refresh?: string }) {
  const [days, setDays] = useState<MonitorDay[]>([]);
  useEffect(() => {
    let live = true;
    void call<MonitorDay[]>('monitor.daily', { id: monitorId, days: 30, tzOffsetMin: new Date().getTimezoneOffset() }).then(
      (d) => live && setDays(d),
      () => live && setDays([]),
    );
    return () => {
      live = false;
    };
  }, [monitorId, refresh]);
  return days.some((d) => d.runs) ? <DayStrip days={days} /> : null;
}

/** The strip itself, mounted once there is data (so its width is measured). */
function DayStrip({ days }: { days: MonitorDay[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number>();
  const runs = days.reduce((n, d) => n + d.runs, 0);
  const passed = days.reduce((n, d) => n + d.passed, 0);
  const gap = 3;
  const block = Math.max(4, (width - gap * (days.length - 1)) / days.length);
  const h = days[hover ?? -1];
  return (
    <Card
      title="Uptime by day"
      aside={
        <span>
          30 days <b className="text-fg">{Math.round((passed / runs) * 1000) / 10}%</b> · {plural(runs, 'run')}
        </span>
      }
      legend={
        <>
          <Swatch color="var(--ok)" label="All passed" />
          <Swatch color="var(--warn)" label="90% or more" />
          <Swatch color="var(--bad)" label="Less" />
          <Swatch color="var(--line)" label="No runs" />
          <span className="ml-auto">{dayLabel(days[0]!.date)} → today</span>
        </>
      }
    >
      <div ref={ref} {...chartKeys(days.length, hover, setHover)} className="relative h-8 outline-none focus-visible:ring-2 focus-visible:ring-accent/50 rounded" onMouseLeave={() => setHover(undefined)}>
        <svg width={width} height={32} role="img" aria-label={`Uptime by day: ${days.filter((d) => d.runs && d.uptime === 100).length} of ${days.filter((d) => d.runs).length} days with runs had every run pass`}>
          {days.map((d, i) => (
            <rect key={d.date} x={i * (block + gap)} y={0} width={block} height={32} rx={2} fill={dayColor(d)} opacity={hover === undefined || hover === i ? 0.9 : 0.45} onMouseEnter={() => setHover(i)} />
          ))}
        </svg>
        {h && (
          <div className="absolute left-0 top-9 w-full h-0">
            <ChartTip x={(hover ?? 0) * (block + gap)} width={width}>
              <div className="flex items-center gap-1.5 font-medium text-fg">
                <span className="w-2 h-2 rounded-full" style={{ background: dayColor(h) }} />
                {dayLabel(h.date)}
              </div>
              <div className="text-muted mt-0.5">
                {h.runs ? `${h.uptime}% · ${h.passed}/${plural(h.runs, 'run')} passed` : 'No runs'}
                {h.maxP95Ms !== undefined ? ` · slowest p95 ${formatMs(h.maxP95Ms)}` : ''}
              </div>
            </ChartTip>
          </div>
        )}
      </div>
    </Card>
  );
}

export function MonitorCharts({ runs, p95Limit, monitorId }: { runs: RunPoint[]; p95Limit?: number; monitorId?: string }) {
  if (!runs.length) return null;
  return (
    <div className="flex flex-col gap-3">
      <AvailabilityStrip runs={runs} />
      {monitorId && <DailyUptime monitorId={monitorId} refresh={runs[0]?.runId} />}
      <div className={cx('grid gap-3', '@container')} style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
        <RunTimeChart runs={runs} />
        <RequestsChart runs={runs} />
        <ResponseP95Chart runs={runs} limit={p95Limit} />
      </div>
    </div>
  );
}
