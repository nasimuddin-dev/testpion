import { useEffect, useState } from 'react';
import { call } from '../api';
import { formatMs, plural } from '../lib/format';
import { BarRow, ChartCard, StackedColumns, Swatch } from './charts';
import { StatusIcon } from './Results';
import { Empty } from './ui';

/** From `runs.breakdown` (runBreakdown in core). */
interface Breakdown {
  timed: number;
  histogram: Array<{
    fromMs: number;
    toMs?: number;
    passed: number;
    failed: number;
  }>;
  slowest: Array<{
    id: string;
    name: string;
    type: string;
    status: string;
    latencyMs: number;
  }>;
  byType: Record<string, { passed: number; failed: number; skipped: number }>;
  failingChecks: Array<{ name: string; count: number }>;
  flaky?: Array<{ id: string; name: string; attempts: number }>;
  scores?: Array<{ name: string; buckets: number[]; mean: number; count: number }>;
  phases?: { requests: number; newConnections: number; reused: number; dnsMs: number; tcpMs: number; tlsMs: number; ttfbMs: number; downloadMs: number };
}

const PHASES = [
  ['dnsMs', 'DNS lookup', true],
  ['tcpMs', 'TCP connect', true],
  ['tlsMs', 'TLS handshake', true],
  ['ttfbMs', 'Server (TTFB)', false],
  ['downloadMs', 'Download', false],
] as const;

/** Where the time of the run's HTTP and GraphQL requests went: one bar per phase, its share of the whole. */
export function TimeByPhase({ p }: { p: NonNullable<Breakdown['phases']> }) {
  const total = PHASES.reduce((n, [k]) => n + p[k], 0) || 1;
  const max = Math.max(...PHASES.map(([k]) => p[k]), 1);
  return (
    <ChartCard
      title="Where the time went"
      aside={plural(p.requests, 'request')}
      legend={
        <>
          <Swatch color="color-mix(in oklab, var(--accent) 50%, transparent)" label="Setting up connections" />
          <Swatch color="var(--accent)" label="The request itself" />
          <span className="ml-auto">
            {plural(p.newConnections, 'new connection')}, {p.reused} reused
          </span>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        {PHASES.map(([k, label, connect]) => (
          <BarRow
            key={k}
            label={label}
            segments={[{ value: p[k], color: connect ? 'color-mix(in oklab, var(--accent) 50%, transparent)' : 'var(--accent)' }]}
            of={max}
            right={`${formatMs(p[k])} · ${Math.round((p[k] / total) * 100)}%`}
            labelClass="w-24"
            rightClass="w-24"
            title={`${label}: ${formatMs(p[k])} in all, ${Math.round((p[k] / total) * 100)}% of the requests' time${connect ? ' (new connections only)' : ''}`}
          />
        ))}
      </div>
    </ChartCard>
  );
}

/** Scores of one evaluator in five ranges (one hue: magnitude), its mean marked, low ranges read as weak. */
function ScoreBars({ s }: { s: NonNullable<Breakdown['scores']>[number] }) {
  const max = Math.max(1, ...s.buckets);
  const labels = ['0–.2', '.2–.4', '.4–.6', '.6–.8', '.8–1'];
  return (
    <div className="min-w-0">
      <div className="flex items-baseline gap-2 text-xs mb-1">
        <span className="truncate text-fg font-medium" title={s.name}>
          {s.name}
        </span>
        <span className="ml-auto text-muted shrink-0">
          mean <b className={s.mean >= 0.7 ? 'text-ok' : 'text-warn'}>{s.mean.toFixed(2)}</b> · {s.count}
        </span>
      </div>
      <div className="flex items-end gap-1 h-12" role="img" aria-label={`${s.name}: ${s.buckets.map((n, i) => `${n} in ${labels[i]}`).join(', ')}, mean ${s.mean}`}>
        {s.buckets.map((n, i) => (
          <span key={i} className="flex-1 flex flex-col items-center justify-end h-full" title={`${labels[i]}: ${n}`}>
            <span className="w-full rounded-sm bg-accent" style={{ height: `${n ? Math.max(6, (n / max) * 100) : 0}%`, opacity: 0.45 + i * 0.13 }} />
          </span>
        ))}
      </div>
      <div className="flex gap-1 text-[0.65rem] text-muted mt-0.5">
        {labels.map((l) => (
          <span key={l} className="flex-1 text-center">
            {l}
          </span>
        ))}
      </div>
    </div>
  );
}

const TYPE_LABEL: Record<string, string> = {
  http: 'REST',
  graphql: 'GraphQL',
  grpc: 'gRPC',
  mcp: 'MCP',
  llm: 'AI',
  websocket: 'WebSocket',
  script: 'Script',
  evaluation: 'Evaluation',
  rag: 'RAG',
  agent: 'Agent',
};
/** Round bounds read better short: 250 ms, 1 s, 2.5 s. */
const bound = (ms: number) => (ms < 1000 ? `${ms} ms` : `${ms / 1000} s`);
const bucketLabel = (b: Breakdown['histogram'][number]) => (b.toMs === undefined ? `≥ ${bound(b.fromMs)}` : b.fromMs === 0 ? `< ${bound(b.toMs)}` : `${bound(b.fromMs)}–${bound(b.toMs)}`);

/** How long the run's tests took: one column per latency range, passed at the base, failed above. */
function LatencyHistogram({ data }: { data: Breakdown['histogram'] }) {
  return (
    <ChartCard
      title="Response time"
      aside="tests per range"
      legend={
        <>
          <Swatch color="var(--ok)" label="Passed" />
          <Swatch color="var(--bad)" label="Failed" />
        </>
      }
    >
      <StackedColumns
        items={data}
        ok={(b) => b.passed}
        bad={(b) => b.failed}
        keyOf={(b) => String(b.fromMs)}
        height={160}
        maxBar={48}
        label="Tests per response-time range"
        labelOf={(b, _i, _n, slot) => (slot > 64 ? bucketLabel(b) : b.toMs === undefined ? `≥${bound(b.fromMs)}` : `<${bound(b.toMs)}`)}
        tip={(b) => (
          <>
            <div className="font-medium text-fg">{bucketLabel(b)}</div>
            <div className="text-muted mt-0.5">
              {plural(b.passed, 'test')} passed · {b.failed} failed
            </div>
          </>
        )}
      />
    </ChartCard>
  );
}

/** Results per test type as one proportional bar each (passed, failed, skipped). */
function ByType({ byType }: { byType: Breakdown['byType'] }) {
  const rows = Object.entries(byType).sort((a, b) => b[1].passed + b[1].failed + b[1].skipped - (a[1].passed + a[1].failed + a[1].skipped));
  const max = Math.max(...rows.map(([, v]) => v.passed + v.failed + v.skipped), 1);
  return (
    <ChartCard
      title="By type"
      legend={
        <>
          <Swatch color="var(--ok)" label="Passed" />
          <Swatch color="var(--bad)" label="Failed" />
          <Swatch color="var(--warn)" label="Skipped" />
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        {rows.map(([t, v]) => {
          const total = v.passed + v.failed + v.skipped;
          return (
            <BarRow
              key={t}
              label={TYPE_LABEL[t] ?? t}
              segments={[
                { value: v.passed, color: 'var(--ok)' },
                { value: v.failed, color: 'var(--bad)' },
                { value: v.skipped, color: 'var(--warn)' },
              ]}
              of={max}
              right={`${v.passed}/${total}`}
              title={`${TYPE_LABEL[t] ?? t}: ${v.passed} passed, ${v.failed} failed, ${v.skipped} skipped`}
            />
          );
        })}
      </div>
    </ChartCard>
  );
}

/** The run at a glance: response-time histogram, results per type, slowest tests and the checks that failed most. */
export function RunCharts({ runId, onPick }: { runId: string; onPick?(name: string): void }) {
  const [data, setData] = useState<Breakdown>();
  useEffect(() => {
    setData(undefined);
    void call<Breakdown>('runs.breakdown', { runId }).then(setData, () => setData(undefined));
  }, [runId]);
  if (!data) return <Empty title="Loading…" />;
  if (!data.timed && !Object.keys(data.byType).length) return <Empty title="No results in this run" />;
  return (
    <div className="h-full overflow-auto p-3">
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
        {data.timed > 0 && <LatencyHistogram data={data.histogram} />}
        <ByType byType={data.byType} />
        {data.phases && <TimeByPhase p={data.phases} />}
        {!!data.scores?.length && (
          <ChartCard title="Scores" aside="per evaluator, 0 to 1">
            <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
              {data.scores.map((s) => (
                <ScoreBars key={s.name} s={s} />
              ))}
            </div>
          </ChartCard>
        )}
        {data.slowest.length > 0 && (
          <ChartCard title="Slowest tests">
            <div className="flex flex-col">
              {data.slowest.map((r) => (
                <button
                  key={r.id}
                  className="flex items-center gap-2 py-1 px-1 -mx-1 rounded text-xs text-left min-w-0 hover:bg-hover"
                  title={`Show ${r.name} in the results`}
                  onClick={() => onPick?.(r.name)}
                >
                  <StatusIcon status={r.status} />
                  <span className="truncate flex-1 min-w-0 text-fg">{r.name}</span>
                  <span className="w-16 text-right tabular-nums shrink-0 text-fg">{formatMs(r.latencyMs)}</span>
                </button>
              ))}
            </div>
          </ChartCard>
        )}
        {!!data.flaky?.length && (
          <ChartCard title="Flaky tests" aside="passed after a retry">
            <div className="flex flex-col">
              {data.flaky.map((f) => (
                <button key={f.id} className="flex items-center gap-2 py-1 px-1 -mx-1 rounded text-xs text-left min-w-0 hover:bg-hover" title={`Show ${f.name} in the results`} onClick={() => onPick?.(f.name)}>
                  <span className="truncate flex-1 min-w-0 text-fg">{f.name}</span>
                  <span className="text-warn tabular-nums shrink-0">{f.attempts} attempts</span>
                </button>
              ))}
            </div>
          </ChartCard>
        )}
        {data.failingChecks.length > 0 && (
          <ChartCard title="Checks that failed most">
            <div className="flex flex-col">
              {data.failingChecks.map((c) => (
                <div key={c.name} className="flex items-center gap-2 py-1 text-xs min-w-0">
                  <span className="truncate flex-1 min-w-0 text-fg" title={c.name}>
                    {c.name}
                  </span>
                  <span className="text-bad tabular-nums shrink-0">{plural(c.count, 'time')}</span>
                </div>
              ))}
            </div>
          </ChartCard>
        )}
      </div>
    </div>
  );
}
