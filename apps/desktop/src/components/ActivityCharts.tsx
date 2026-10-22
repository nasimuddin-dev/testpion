import { trafficKindLabel } from '../lib/traffic-kinds';
import { useState, type ReactNode } from 'react';
import { formatMs, plural } from '../lib/format';
import { axisMs, BarRow, ChartCard, chartKeys, ChartTip, niceMax, StackedColumns, StatTile, Swatch, useWidth } from './charts';

/** Workspace activity from `stats.activity` (see summarizeActivity in core). */
export interface ActivityDay {
  day: string;
  requests: number;
  failedRequests: number;
  medianMs?: number;
  runs: number;
  failedRuns: number;
  tests: number;
  failedTests: number;
}
export interface Activity {
  days: ActivityDay[];
  medianMs?: number;
  byKind: Record<string, number>;
  slowest: Array<{
    name: string;
    kind: string;
    durationMs: number;
    count: number;
  }>;
}


const dayDate = (day: string) => new Date(day + 'T12:00:00');
const shortDay = (day: string, i: number, n: number) =>
  i === n - 1
    ? 'Today'
    : dayDate(day).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      });
const longDay = (day: string) =>
  dayDate(day).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

const H = 140;
const PAD = { l: 48, r: 6, t: 8, b: 20 };

/** First, middle and last day under a day chart. */
function DayAxis({ days, x, width }: { days: ActivityDay[]; x(i: number): number; width: number }) {
  const n = days.length;
  const ticks = n > 2 ? [0, Math.floor((n - 1) / 2), n - 1] : days.map((_, i) => i);
  return (
    <>
      {ticks.map((i) => (
        <text key={i} x={Math.min(Math.max(x(i), PAD.l + 14), width - PAD.r - 14)} y={H - 4} fontSize={10} fill="var(--muted)" textAnchor="middle">
          {shortDay(days[i]!.day, i, n)}
        </text>
      ))}
    </>
  );
}

function YGrid({ max, y, width, format = String, whole }: { max: number; y(v: number): number; width: number; format?(v: number): string; whole?: boolean }) {
  return (
    <>
      {[0, whole ? Math.round(max / 2) : max / 2, max].map((t) => (
        <g key={t}>
          <line x1={PAD.l} x2={width - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
          <text x={PAD.l - 6} y={y(t) + 3} textAnchor="end" fontSize={10} fill="var(--muted)">
            {t === 0 ? '0' : format(t)}
          </text>
        </g>
      ))}
    </>
  );
}

/** One stacked column per day: the good part at the base, the failed part above it. First, middle and last day labelled. */
function DailyStack({
  title,
  aside,
  days,
  ok,
  bad,
  okLabel,
  badLabel,
  tip,
  empty,
}: {
  title: string;
  aside?: ReactNode;
  days: ActivityDay[];
  ok(d: ActivityDay): number;
  bad(d: ActivityDay): number;
  okLabel: string;
  badLabel: string;
  tip(d: ActivityDay): ReactNode;
  empty: string;
}) {
  const ticks = (n: number) => (n > 2 ? [0, Math.floor((n - 1) / 2), n - 1] : [...Array(n).keys()]);
  return (
    <ChartCard
      title={title}
      aside={aside}
      legend={
        <>
          <Swatch color="var(--ok)" label={okLabel} />
          <Swatch color="var(--bad)" label={badLabel} />
        </>
      }
    >
      <StackedColumns
        items={days}
        ok={ok}
        bad={bad}
        keyOf={(d) => d.day}
        label={`${title} per day`}
        empty={empty}
        labelOf={(d, i, n) => (ticks(n).includes(i) ? shortDay(d.day, i, n) : undefined)}
        tip={(d) => (
          <>
            <div className="font-medium text-fg">{longDay(d.day)}</div>
            <div className="text-muted mt-0.5">{tip(d)}</div>
          </>
        )}
      />
    </ChartCard>
  );
}

/** Median response time per day: one line, gaps on days without requests. */
function MedianLine({ days, overall }: { days: ActivityDay[]; overall?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number>();
  const max = niceMax(Math.max(...days.map((d) => d.medianMs ?? 0), 1));
  const innerW = Math.max(0, width - PAD.l - PAD.r);
  const slot = days.length ? innerW / days.length : 0;
  const x = (i: number) => PAD.l + slot * i + slot / 2;
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  // a new segment starts after every day without requests
  let path = '';
  let pen = false;
  days.forEach((d, i) => {
    if (d.medianMs === undefined) return void (pen = false);
    path += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.medianMs).toFixed(1)} `;
    pen = true;
  });
  const onMove = (e: React.MouseEvent) => {
    if (!slot) return;
    const i = Math.floor((e.clientX - e.currentTarget.getBoundingClientRect().left - PAD.l) / slot);
    setHover(i >= 0 && i < days.length ? i : undefined);
  };
  const any = days.some((d) => d.medianMs !== undefined);
  return (
    <ChartCard
      title="Median response"
      aside={
        overall !== undefined ? (
          <span>
            period <b className="text-fg">{formatMs(overall)}</b>
          </span>
        ) : undefined
      }
    >
      <div ref={ref} {...chartKeys(days.length, hover, setHover)} className="relative outline-none focus-visible:ring-2 focus-visible:ring-accent/50 rounded" onMouseMove={onMove} onMouseLeave={() => setHover(undefined)}>
        <svg width={width} height={H} role="img" aria-label="Median response time per day">
          <YGrid max={max} y={y} width={width} format={axisMs} />
          {hover !== undefined && <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} stroke="var(--muted)" strokeWidth={1} />}
          <path d={path} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {days.map((d, i) => d.medianMs !== undefined && <circle key={d.day} cx={x(i)} cy={y(d.medianMs)} r={hover === i ? 5 : 4} fill="var(--accent)" stroke="var(--bg)" strokeWidth={2} />)}
          <DayAxis days={days} x={x} width={width} />
          {!any && (
            <text x={PAD.l + innerW / 2} y={H / 2} textAnchor="middle" fontSize={11} fill="var(--muted)">
              No timed requests yet
            </text>
          )}
        </svg>
        {hover !== undefined && days[hover] && (
          <ChartTip x={x(hover)} width={width}>
            <div className="font-medium text-fg">{longDay(days[hover]!.day)}</div>
            <div className="text-muted mt-0.5">
              {days[hover]!.medianMs !== undefined ? `median ${formatMs(days[hover]!.medianMs!)} over ${plural(days[hover]!.requests, 'request')}` : 'no requests'}
            </div>
          </ChartTip>
        )}
      </div>
    </ChartCard>
  );
}

/** Requests per protocol: one hue (it's magnitude), labelled bars. */
function ByKind({ byKind }: { byKind: Record<string, number> }) {
  const rows = Object.entries(byKind).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...rows.map((r) => r[1]), 1);
  return (
    <ChartCard title="Requests by type">
      {rows.length ? (
        <div className="flex flex-col gap-1.5">
          {rows.map(([k, n]) => (
            <BarRow key={k} label={trafficKindLabel(k)} segments={[{ value: n, color: 'var(--accent)' }]} of={max} right={n} title={plural(n, `${trafficKindLabel(k)} request`)} />
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted py-3">Nothing sent in this period.</p>
      )}
    </ChartCard>
  );
}

function Slowest({ rows }: { rows: Activity['slowest'] }) {
  return (
    <ChartCard title="Slowest requests" aside="average">
      {rows.length ? (
        <div className="flex flex-col">
          {rows.map((r) => (
            <div key={r.kind + r.name} className="flex items-center gap-2 py-1 text-xs min-w-0">
              <span className="w-16 shrink-0 text-muted">{trafficKindLabel(r.kind)}</span>
              <span className="truncate flex-1 min-w-0 text-fg" title={r.name}>
                {r.name}
              </span>
              <span className="text-muted shrink-0">×{r.count}</span>
              <span className="w-16 text-right tabular-nums shrink-0 text-fg">{formatMs(r.durationMs)}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted py-3">No timed requests in this period.</p>
      )}
    </ChartCard>
  );
}

const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 1000) / 10}%` : '—');

/** The Home dashboard: headline numbers, requests, response time and tests per day, requests by type and the slowest ones. */
export function ActivityCharts({ activity }: { activity: Activity }) {
  const { days } = activity;
  const sum = (f: (d: ActivityDay) => number) => days.reduce((a, d) => a + f(d), 0);
  const requests = sum((d) => d.requests);
  const failed = sum((d) => d.failedRequests);
  const runs = sum((d) => d.runs);
  const tests = sum((d) => d.tests);
  const failedTests = sum((d) => d.failedTests);
  // nothing yet: one line instead of empty charts
  if (!requests && !runs)
    return (
      <p className="text-sm text-muted px-1 py-2">
        Nothing in the last {days.length} days. Send requests or run tests and collections, and this shows how many worked, how fast they were and what failed, day by day.
      </p>
    );
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile label="Requests sent" value={String(requests)} sub={failed ? `${failed} failed` : requests ? 'none failed' : 'nothing sent yet'} />
        <StatTile label="Request success" value={pct(requests - failed, requests)} tone={!requests ? undefined : failed / requests > 0.05 ? 'bad' : 'ok'} sub="2xx/3xx, OK and tool results" />
        <StatTile label="Median response" value={activity.medianMs !== undefined ? formatMs(activity.medianMs) : '—'} sub="all requests of the period" />
        <StatTile
          label="Tests passed"
          value={pct(tests - failedTests, tests)}
          tone={!tests ? undefined : failedTests ? 'bad' : 'ok'}
          sub={runs ? `${plural(tests, 'test')} in ${plural(runs, 'run')}` : 'no test runs yet'}
        />
      </div>
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
        <DailyStack
          title="Requests"
          aside={
            requests ? (
              <span>
                failed <b className="text-fg">{pct(failed, requests)}</b>
              </span>
            ) : undefined
          }
          days={days}
          ok={(d) => d.requests - d.failedRequests}
          bad={(d) => d.failedRequests}
          okLabel="Succeeded"
          badLabel="Failed"
          empty="No requests sent yet"
          tip={(d) => (d.requests ? `${plural(d.requests, 'request')} · ${d.failedRequests} failed` : 'no requests')}
        />
        <MedianLine days={days} overall={activity.medianMs} />
        <DailyStack
          title="Tests"
          aside={runs ? <span>{plural(runs, 'run')}</span> : undefined}
          days={days}
          ok={(d) => d.tests - d.failedTests}
          bad={(d) => d.failedTests}
          okLabel="Passed"
          badLabel="Failed"
          empty="No test runs yet"
          tip={(d) => (d.runs ? `${plural(d.runs, 'run')} · ${d.tests - d.failedTests}/${d.tests} tests passed` : 'no runs')}
        />
      </div>
      <div className="grid lg:grid-cols-2 gap-3">
        <ByKind byKind={activity.byKind} />
        <Slowest rows={activity.slowest} />
      </div>
    </div>
  );
}
