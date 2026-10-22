import { useEffect, useState } from 'react';
import { Play } from 'lucide-react';
import { call } from '../api';
import { formatMs, plural } from '../lib/format';
import { axisMs, ChartCard, chartKeys, ChartTip, PointLine, RecentRuns, Swatch, useWidth } from './charts';
import { Empty, SectionTitle } from './ui';
import { OutputHeader } from './output/OutputFrame';
import type { OutputSpec } from './output/output-core';
import { outputFileName } from '@testpion/shared';

/** A run in a list of runs (runs.list). */
export interface RunRow {
  id: string;
  name: string;
  startedAt: string;
  durationMs?: number;
  total: number;
  passed: number;
  failed: number;
  errors: number;
  environment?: string;
}

/** Passed / failed share of one run as a thin bar (for run lists). */
export function RunMiniBar({ r }: { r: RunRow }) {
  const bad = r.failed + r.errors;
  const rest = Math.max(0, r.total - r.passed - bad);
  if (!r.total) return null;
  return (
    <span className="flex h-1 gap-px mt-1 rounded-full overflow-hidden" aria-hidden>
      {r.passed > 0 && <span className="bg-ok" style={{ flex: r.passed }} />}
      {bad > 0 && <span className="bg-bad" style={{ flex: bad }} />}
      {rest > 0 && <span className="bg-warn" style={{ flex: rest }} />}
    </span>
  );
}

function RunTip({ r, x, width }: { r: RunRow; x: number; width: number }) {
  return (
    <ChartTip x={x} width={width}>
      <RunTipBody r={r} />
    </ChartTip>
  );
}

function RunTipBody({ r }: { r: RunRow }) {
  return (
    <>
      <div className="font-medium text-fg max-w-[240px] truncate">{r.name}</div>
      <div className="text-muted mt-0.5">
        {r.passed}/{r.total} passed{r.durationMs !== undefined ? ` · ${formatMs(r.durationMs)}` : ''}
        {r.environment ? ` · ${r.environment}` : ''}
      </div>
      <div className="text-muted">{new Date(r.startedAt).toLocaleString()}</div>
    </>
  );
}

/** Pass rate of each of the last runs (oldest left): one column per run, the share of its tests that passed. */
function PassRate({ runs, onSelect }: { runs: RunRow[]; onSelect?(id: string): void }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number>();
  const H = 150;
  const pad = { l: 40, r: 6, t: 8, b: 18 };
  const innerW = Math.max(0, width - pad.l - pad.r);
  const slot = runs.length ? innerW / runs.length : 0;
  const bw = Math.max(3, Math.min(20, slot * 0.7));
  const base = H - pad.b;
  const y = (v: number) => base - v * (base - pad.t);
  const x = (i: number) => pad.l + slot * i + slot / 2;
  const all = runs.reduce((a, r) => a + r.total, 0);
  const passed = runs.reduce((a, r) => a + r.passed, 0);
  return (
    <ChartCard
      title="Pass rate by run"
      aside={
        all ? (
          <span>
            overall <b className="text-fg">{Math.round((passed / all) * 1000) / 10}%</b>
          </span>
        ) : undefined
      }
      legend={
        <>
          <Swatch color="var(--ok)" label="Every test passed" />
          <Swatch color="var(--bad)" label="Some failed" />
          <span className="ml-auto">{plural(runs.length, 'run')}, oldest left</span>
        </>
      }
    >
      <div ref={ref} {...chartKeys(runs.length, hover, setHover, onSelect && ((i) => onSelect(runs[i]!.id)))} className="relative outline-none focus-visible:ring-2 focus-visible:ring-accent/50 rounded" onMouseLeave={() => setHover(undefined)}>
        <svg width={width} height={H} role="img" aria-label="Share of tests that passed in each run">
          {[0, 0.5, 1].map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
              <text x={pad.l - 6} y={y(t) + 3} textAnchor="end" fontSize={10} fill="var(--muted)">
                {t * 100}%
              </text>
            </g>
          ))}
          {runs.map((r, i) => {
            const v = r.total ? r.passed / r.total : 0;
            return (
              <g key={r.id} onMouseEnter={() => setHover(i)} onClick={() => onSelect?.(r.id)} className={onSelect ? 'cursor-pointer' : undefined} opacity={hover === undefined || hover === i ? 1 : 0.5}>
                <rect x={pad.l + slot * i} y={pad.t} width={slot} height={base - pad.t} fill="transparent" />
                <rect x={x(i) - bw / 2} y={Math.min(y(v), base - 2)} width={bw} height={Math.max(2, base - y(v))} rx={2} fill={r.failed + r.errors ? 'var(--bad)' : 'var(--ok)'} />
              </g>
            );
          })}
        </svg>
        {hover !== undefined && runs[hover] && <RunTip r={runs[hover]!} x={x(hover)} width={width} />}
      </div>
    </ChartCard>
  );
}

/** Duration of each of the last runs (oldest left): one line, points coloured by result. */
function RunDurations({ runs, onSelect }: { runs: RunRow[]; onSelect?(id: string): void }) {
  const timed = runs.filter((r) => typeof r.durationMs === 'number');
  if (!timed.length) return null;
  return (
    <ChartCard title="Run duration">
      <PointLine
        items={timed}
        value={(r) => r.durationMs!}
        color={(r) => (r.failed + r.errors ? 'var(--bad)' : 'var(--ok)')}
        keyOf={(r) => r.id}
        axis={axisMs}
        tip={(r) => <RunTipBody r={r} />}
        label="Duration of each run"
        onPick={onSelect && ((r) => onSelect(r.id))}
      />
    </ChartCard>
  );
}

interface Flaky {
  id: string;
  name: string;
  runs: number;
  passed: number;
  flips: number;
  retried: number;
  lastStatus: string;
  recent: string[];
}

/** Tests whose result keeps changing across the latest runs (or that pass only after retries). */
function FlakyTests({ refresh }: { refresh?: string }) {
  const [rows, setRows] = useState<Flaky[]>();
  useEffect(() => {
    void call<Flaky[]>('runs.flaky', { runs: 30 }).then(setRows, () => setRows([]));
  }, [refresh]);
  if (!rows) return null;
  return (
    <ChartCard title="Flaky tests" aside="latest 30 runs">
      {rows.length ? (
        <div className="flex flex-col">
          {rows.slice(0, 8).map((t) => (
            <div key={t.id} className="flex items-center gap-2 py-1 text-xs min-w-0" title={`${t.name}: ${t.passed} of ${t.runs} runs passed, the result flipped ${t.flips} times${t.retried ? `, ${t.retried} passed after a retry` : ''}`}>
              <RecentRuns statuses={t.recent} />
              <span className="truncate flex-1 min-w-0 text-fg">{t.name}</span>
              <span className="text-warn tabular-nums shrink-0">
                {t.flips}× flipped{t.retried ? ` · ${t.retried} retried` : ''}
              </span>
            </div>
          ))}
          {rows.length > 8 && <div className="text-xs text-muted pt-1">and {rows.length - 8} more: testpion history flaky</div>}
        </div>
      ) : (
        <div className="text-sm text-ok">None: every test gave the same result run after run.</div>
      )}
    </ChartCard>
  );
}

interface ScorePoint {
  runId: string;
  name: string;
  startedAt: string;
  scores: Record<string, number>;
}

/** One small chart per evaluator: its mean score in each run (oldest left), green at 0.7 and above. */
function ScoreTrends({ runIds, onSelect }: { runIds: string[]; onSelect?(id: string): void }) {
  const [points, setPoints] = useState<ScorePoint[]>([]);
  const key = runIds.join(',');
  useEffect(() => {
    void call<ScorePoint[]>('runs.scoreTrend', { runIds, limit: runIds.length }).then(setPoints, () => setPoints([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const evaluators = [...new Set(points.flatMap((p) => Object.keys(p.scores)))].sort();
  if (points.length < 2 || !evaluators.length) return null;
  return (
    <div className="mt-3">
      <SectionTitle size="sm" className="mb-2">Scores by run</SectionTitle>
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
        {evaluators.map((e) => {
          const series = points.filter((p) => p.scores[e] !== undefined);
          const last = series[series.length - 1]?.scores[e] ?? 0;
          return (
            <ChartCard key={e} title={e} aside={<span>latest <b className={last >= 0.7 ? 'text-ok' : 'text-warn'}>{last.toFixed(2)}</b></span>}>
              <PointLine
                items={series}
                value={(p) => p.scores[e]!}
                color={(p) => (p.scores[e]! >= 0.7 ? 'var(--ok)' : 'var(--warn)')}
                keyOf={(p) => p.runId}
                axis={(v) => v.toFixed(1)}
                reference={0.7}
                height={110}
                ends={(p) => new Date(p.startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                tip={(p) => (
                  <>
                    <div className="font-medium text-fg">
                      {e} {p.scores[e]!.toFixed(3)}
                    </div>
                    <div className="text-muted">{p.name} · {new Date(p.startedAt).toLocaleString()}</div>
                  </>
                )}
                label={`${e} mean score in the last ${series.length} runs, latest ${last.toFixed(2)}`}
                onPick={onSelect ? (p) => onSelect(p.runId) : undefined}
              />
            </ChartCard>
          );
        })}
      </div>
    </div>
  );
}

/** The runs at a glance (shown when no run is selected): pass rate and duration of the last 40 runs. */
const RUNS_SOURCE = { kind: 'runs-overview' as const, limit: 500 };
const RUNS_SPEC: OutputSpec = {
  id: 'runs.overview',
  what: 'runs list',
  name: outputFileName({ name: 'testpion-runs', ext: '' }),
  formats: [
    { format: 'csv', label: 'Runs (CSV)', source: RUNS_SOURCE, default: true },
    { format: 'json', label: 'Runs (JSON)', source: RUNS_SOURCE },
  ],
};

export function RunsOverview({
  runs,
  onSelect,
  hint = 'Click a bar or point, or a run in the list, to see its results.',
  flaky,
  scores,
  onRun,
}: {
  runs: RunRow[];
  onSelect?(id: string): void;
  hint?: string;
  flaky?: boolean;
  scores?: boolean;
  /** What a first run is here (Run all tests, Run collection): the empty state offers it. */
  onRun?: { label: string; run(): void };
}) {
  const last = runs.slice(0, 40).reverse();
  if (!last.length)
    return (
      <Empty title="No runs yet" actions={onRun ? [{ label: onRun.label, icon: <Play size={13} />, onClick: onRun.run }] : undefined}>
        Each run of tests, a suite or a collection is listed here with its results and charts.
      </Empty>
    );
  return (
    <div className="h-full flex flex-col min-h-0" data-output="runs.overview">
      <OutputHeader spec={RUNS_SPEC} title="Runs at a glance" />
      <div className="flex-1 min-h-0 overflow-auto p-3">
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
        <PassRate runs={last} onSelect={onSelect} />
        <RunDurations runs={last} onSelect={onSelect} />
        {flaky && <FlakyTests refresh={runs[0]?.id} />}
      </div>
      {scores && <ScoreTrends runIds={last.map((r) => r.id)} onSelect={onSelect} />}
      <p className="text-xs text-muted mt-3">{hint}</p>
      </div>
    </div>
  );
}
