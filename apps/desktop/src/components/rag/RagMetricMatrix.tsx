import { ChevronDown, ChevronRight, RefreshCw, Map as MapIcon, Scale } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MatrixCell, MatrixRow, MetricColumn, MetricMatrix } from '@testpion/core';
import { outputFileName, type RagJudgeSetup } from '@testpion/shared';
import { call } from '../../api';
import { listWindow } from '../../lib/list-window';
import type { CheckConfig, ProviderConfig } from '../../types';
import { Badge, Button, cx, FilterInput, Segmented, Select, Spinner, useDebounced } from '../ui';
import { OutputActions } from '../output/OutputFrame';
import type { OutputSpec } from '../output/output-core';
import { RagByTag, RagCharts, RagCompare, RagPivot, RagRescoreDialog, type RunChoice } from './RagResultViews';
import { RagSampleDetail } from './RagSampleDetail';
import { RagCalibration } from './RagCalibration';
import { RagEmbeddingMap } from './RagEmbeddingMap';
import { RagTrend } from './RagTrend';
import { RunReport } from '../ai/RunReport';

const PAGE = 100;
/** A sample row is one fixed height, so only the rows on screen are drawn (100 rows × 84 metrics is 8,400 cells). */
const ROW_H = 44;

/** The columns of a group, as the table draws them: all of them, and the ones shown (none of them collapsed). */
interface GroupLayout {
  id: string;
  collapsed: boolean;
  all: Array<{ c: MetricColumn; i: number }>;
  shown: Array<{ c: MetricColumn; i: number }>;
}

/** Ten bars of a distribution over 0..1: where the scores of a metric fall (a sparkline of counts). */
function Spark({ bins }: { bins: number[] }) {
  const max = Math.max(1, ...bins);
  return (
    <span className="inline-flex items-end gap-px h-4" aria-label="distribution">
      {bins.map((b, i) => (
        <span key={i} className="w-1 bg-accent/60 rounded-sm" style={{ height: `${Math.max(b ? 12 : 0, (b / max) * 100)}%` }} />
      ))}
    </span>
  );
}

/** What each statistic row means, in words (the rows are labelled with these, and the label's hover says what it measures). */
const STAT: Record<string, { label: string; title: string }> = {
  mean: { label: 'average', title: 'The average score of the samples that were scored' },
  p10: { label: 'lowest 10%', title: 'The score that only the weakest 10% of the samples fall below: it shows how bad the bad cases are, which the average hides' },
  pass: { label: 'pass rate', title: 'The share of scored samples that reached the pass mark' },
  'n/a': { label: 'not scored', title: 'Samples this metric could not score (nothing to check, or the judge failed)' },
  '95%': { label: '95% interval', title: 'The range the true average most likely lies in, given how many samples there are' },
  spread: { label: 'spread (min to max)', title: 'How the scores are distributed from the lowest to the highest: ten bars, a taller bar means more samples' },
};

const cellClass = (c: MatrixCell | null) => (!c ? '' : c.failed ? 'bg-bad/10 text-bad' : c.na ? 'text-muted' : c.passed === false ? 'bg-bad/10 text-bad' : c.passed === true ? 'bg-ok/10 text-ok' : '');

/** The pass mark of a column: typed here, handed on a moment after the last keystroke, so typing never redraws the table. */
function PassMark({ column, value, onCommit }: { column: string; value: number | undefined; onCommit(key: string, v: number): void }) {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  const first = useRef(true);
  // a mark set from outside (the tuned pass mark of Calibrate judge) replaces what is typed; typing commits the same number back, so it does not loop
  useEffect(() => {
    if (value !== undefined && value !== Number(text)) setText(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (text.trim() === '' || !Number.isFinite(Number(text))) return;
    const t = setTimeout(() => onCommit(column, Number(text)), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  return (
    <input type="number" step="0.05" className="w-12 bg-transparent border-b border-line text-right" value={text} onChange={(e) => setText(e.target.value)} aria-label={`${column} pass mark`} data-rag-threshold={column} />
  );
}

/** One sample's row. Memoised: a row is redrawn only when its own data, the layout or the collapsed groups change. */
const MatrixRowView = memo(function MatrixRowView({ r, layout, onOpen }: { r: MatrixRow; layout: GroupLayout[]; onOpen(id: string, metric: string): void }) {
  const groupMean = (g: GroupLayout) => {
    const xs = g.all.flatMap(({ i }) => (r.cells[i]?.score !== undefined ? [r.cells[i]!.score!] : []));
    return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000 : undefined;
  };
  return (
    <tr className="hover:bg-hover" style={{ height: ROW_H }} data-rag-row={r.id}>
      <td className="px-2 py-1 border-b border-line/60 max-w-72">
        <div className="truncate" title={r.question ?? r.name}>
          {r.name}
        </div>
        <div className="flex items-center gap-1 text-muted truncate">
          {r.failure && (
            <Badge tone="warn" title={r.failure.reason}>
              {r.failure.class}
            </Badge>
          )}
          <span className="truncate">{r.question}</span>
        </div>
      </td>
      {layout.map((g) =>
        g.collapsed ? (
          <td key={g.id} className="px-2 py-1 text-right tabular-nums border-b border-l border-line/60">
            {groupMean(g) ?? ''}
          </td>
        ) : (
          g.shown.map(({ c, i }) => {
            const cell = r.cells[i] ?? null;
            return (
              <td
                key={c.key}
                className={cx('px-2 py-1 text-right tabular-nums border-b border-l border-line/60', cellClass(cell), cell && 'cursor-pointer')}
                title={cell?.na ?? cell?.failed}
                onClick={() => cell && onOpen(r.id, c.key)}
                data-rag-cell={`${r.id}|${c.key}`}
              >
                {cell && (
                  // a button inside the cell: the keyboard reaches it and Enter opens the sample (its click is the cell's); pass and fail are said in a mark and in words, not by colour alone
                  <button type="button" className="w-full text-right" aria-label={`${r.name}, ${c.key}: ${cell.failed ? `error, ${cell.failed}` : cell.score !== undefined ? `${cell.score}, ${cell.passed === false ? 'failed' : cell.passed === true ? 'passed' : 'no pass mark'}` : 'not scored'}`}>
                    {cell.failed ? 'error' : cell.score !== undefined ? <>{cell.passed === true ? <span aria-hidden>✓ </span> : cell.passed === false ? <span aria-hidden>✗ </span> : null}{cell.score}</> : 'n/a'}
                  </button>
                )}
              </td>
            );
          })
        ),
      )}
    </tr>
  );
});

/**
 * The samples × metrics matrix of a RAG run: one row per sample, one column per metric, grouped by type under two header
 * rows. A cell is that metric's own score, coloured by its pass mark (n/a is grey, never a zero). The header carries each
 * metric's pass mark, which can be changed here and decides pass and fail again from the stored scores, and its mean, p10,
 * pass rate, n/a count, a 95% interval and the distribution. Rows can be searched, sorted by a metric and filtered by why they
 * failed; a click on a cell opens the sample through that metric.
 */
export function RagMetricMatrix({
  runId,
  target,
  judge,
  runs = [],
  evaluators = [],
  providers = [],
  onRescored,
  evaluation,
  evaluationName,
}: {
  runId: string;
  target?: string;
  judge?: RagJudgeSetup;
  /** The evaluation's runs (compare, the variant pivot). */
  runs?: RunChoice[];
  /** The evaluation's metrics now (score the run again with them). */
  evaluators?: CheckConfig[];
  /** The saved evaluation: the database of its SQL metrics is used when the run is scored again; a tuned pass mark (Calibrate judge) and the Trend are saved in or read from it. */
  evaluation?: string;
  /** The evaluation's name, for an evaluation that is not saved yet: its runs are found by it (Trend, Calibrate judge). */
  evaluationName?: string;
  providers?: ProviderConfig[];
  onRescored?(runId: string): void;
}) {
  const [view, setView] = useState<'samples' | 'tags' | 'charts' | 'compare' | 'pivot' | 'trend'>('samples');
  const [rescoring, setRescoring] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [mapping, setMapping] = useState(false);
  const [query, setQuery] = useState('');
  const [failure, setFailure] = useState('');
  const [sort, setSort] = useState('');
  const [offset, setOffset] = useState(0);
  const [thr, setThr] = useState<Record<string, number>>({});
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [m, setM] = useState<MetricMatrix>();
  const [detail, setDetail] = useState<{ id: string; metric: string }>();
  // the 95% intervals are asked for the columns on screen after the first page is drawn (the backend computes each once)
  const [ci, setCi] = useState<Record<string, [number, number]>>({});
  const asked = useRef(new Set<string>());
  const q = useDebounced(query, 250);
  useEffect(() => setOffset(0), [q, failure, sort, runId]);
  useEffect(() => {
    setCi({});
    asked.current = new Set();
  }, [runId]);
  useEffect(() => {
    let live = true;
    void call<MetricMatrix>('rag.matrix', { runId, offset, limit: PAGE, query: q || undefined, failure: failure || undefined, sort: sort || undefined, thresholds: thr, ci: false }).then(
      (r) => live && setM(r),
      () => live && setM(undefined),
    );
    return () => {
      live = false;
    };
  }, [runId, offset, q, failure, sort, thr]);
  const visibleKeys = useMemo(() => (m?.columns ?? []).filter((c) => !collapsed.has(c.group)).map((c) => c.key), [m?.columns, collapsed]);
  useEffect(() => {
    const keys = visibleKeys.filter((k) => !asked.current.has(k));
    if (!keys.length) return;
    keys.forEach((k) => asked.current.add(k));
    // in chunks, so the first intervals appear at once and a run of 84 metrics never blocks the backend for one long call
    const chunks: string[][] = [];
    for (let i = 0; i < keys.length; i += 12) chunks.push(keys.slice(i, i + 12));
    void (async () => {
      for (const keysOfChunk of chunks) {
        try {
          const got = await call<Record<string, [number, number]>>('rag.matrixCi', { runId, keys: keysOfChunk });
          setCi((prev) => ({ ...prev, ...got }));
        } catch {
          keysOfChunk.forEach((k) => asked.current.delete(k));
          return;
        }
      }
    })();
  }, [visibleKeys, runId]);
  const agg = useMemo(() => new Map((m?.aggregates ?? []).map((a) => [a.key, a])), [m]);
  const commitMark = useCallback((key: string, v: number) => setThr((prev) => (prev[key] === v ? prev : { ...prev, [key]: v })), []);
  const open = useCallback((id: string, metric: string) => setDetail({ id, metric }), []);
  // the columns of each group, as the table draws them (once per answer and per collapsed group, not once per row)
  const layout = useMemo<GroupLayout[]>(() => {
    const cols = (m?.columns ?? []).map((c, i) => ({ c, i }));
    return (m?.groups ?? []).map((g) => {
      const all = cols.filter(({ c }) => c.group === g.id);
      return { id: g.id, collapsed: collapsed.has(g.id), all, shown: collapsed.has(g.id) ? [] : all };
    });
  }, [m?.columns, m?.groups, collapsed]);
  // the output spec only changes with the run, the pass marks and the sample count, not with every keystroke or redraw
  const total = m?.total ?? 0;
  const spec = useMemo<OutputSpec>(() => {
    const source = { kind: 'rag-matrix' as const, runId, ...(Object.keys(thr).length ? { thresholds: thr } : {}) };
    return {
      id: 'rag.matrix',
      what: 'RAG metrics matrix',
      name: outputFileName({ name: `rag-metrics-${runId}`, ext: '' }),
      formats: [
        { format: 'csv', label: 'Samples × metrics (CSV)', source, default: true },
        { format: 'json', label: 'Matrix with aggregates (JSON)', source },
        { format: 'html', label: 'Report (HTML)', source },
      ],
      empty: total ? undefined : 'No scored samples',
    };
  }, [runId, thr, total]);
  // only the rows on screen are drawn: the scroll box and the header's height give the window
  const scroller = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLTableSectionElement>(null);
  const [win, setWin] = useState({ top: 0, height: 600 });
  const ready = !!m && m.columns.length > 0;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let frame: number | undefined;
    const measure = () => {
      frame = undefined;
      setWin((w) => (w.top === el.scrollTop && w.height === (el.clientHeight || w.height) ? w : { top: el.scrollTop, height: el.clientHeight || w.height }));
    };
    const onScroll = () => {
      if (frame === undefined) frame = requestAnimationFrame(measure);
    };
    measure();
    const ro = new ResizeObserver(onScroll);
    ro.observe(el);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', onScroll);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [ready]);
  // a new page, filter or sort starts at the top
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [offset, q, failure, sort, runId]);
  if (!m)
    return (
      <div className="h-full grid place-items-center">
        <Spinner />
      </div>
    );
  if (!m.columns.length) return <div className="p-4 text-sm text-muted">This run holds no scored RAG samples.</div>;
  const toggle = (g: string) => setCollapsed((s) => (s.has(g) ? new Set([...s].filter((x) => x !== g)) : new Set([...s, g])));
  const drawn = layout.reduce((n, g) => n + (g.collapsed ? 1 : g.shown.length), 1);
  const w = listWindow({ count: m.rows.length, rowHeight: ROW_H, scrollTop: Math.max(0, win.top - (head.current?.offsetHeight ?? 0)), height: win.height, overscan: 6 });
  return (
    <div className="h-full flex flex-col min-h-0" data-rag-matrix data-output="rag.matrix">
      <RunReport runId={runId} compact />
      <div className="flex items-center gap-2 px-2 pt-2 flex-wrap">
        <Segmented
          label="View"
          size="xs"
          value={view}
          onChange={setView}
          options={[
            { value: 'samples', label: 'Samples' },
            { value: 'tags', label: 'By tag', title: 'The mean of each metric for each tag of the dataset records' },
            { value: 'charts', label: 'Charts', title: 'The distribution of every metric' },
            { value: 'compare', label: 'Compare', title: 'This run against another, metric by metric, with a paired bootstrap' },
            { value: 'pivot', label: 'Runs × metrics', title: 'Several runs side by side: the mean of every metric' },
            ...(evaluation ?? evaluationName ? [{ value: 'trend' as const, label: 'Trend', title: 'The mean of every metric run by run; a change of judge or wording is marked' }] : []),
          ]}
        />
        <Button size="sm" icon={<RefreshCw size={12} />} onClick={() => setRescoring(true)} title="Score the stored answers again with other metrics or another judge: the RAG system is not called" data-rag-rescore-open>
          Score again…
        </Button>
        <Button size="sm" icon={<Scale size={12} />} onClick={() => setCalibrating(true)} title="How well the judges agree with the Pass / Fail labels you gave in the sample detail: kappa, accuracy, the disagreements, and the pass mark that agrees most" data-rag-calibrate-open>
          Calibrate the AI reviewer…
        </Button>
        <Button size="sm" icon={<MapIcon size={12} />} onClick={() => setMapping(true)} title="Place the questions and documents of this run by meaning: look-alike documents and questions no document covers" data-rag-map-open>
          Map by meaning…
        </Button>
        <OutputActions spec={spec} />
      </div>
      {view === 'tags' && (
        <div className="flex-1 min-h-0 overflow-auto p-3">
          <RagByTag m={m} />
        </div>
      )}
      {view === 'charts' && <RagCharts m={m} />}
      {view === 'compare' && <RagCompare runId={runId} runs={runs} />}
      {view === 'pivot' && <RagPivot runs={runs} />}
      {view === 'trend' && (evaluation ?? evaluationName) && <RagTrend evaluation={(evaluation ?? evaluationName)!} />}
      {mapping && <RagEmbeddingMap runId={runId} onClose={() => setMapping(false)} />}
      {calibrating && (
        <RagCalibration
          runId={runId}
          evaluation={evaluation ?? evaluationName}
          onUseThreshold={(metric, v) => (setThr((s) => ({ ...s, [metric]: v })), setCalibrating(false))}
          onOpenSample={(id, metric) => (setCalibrating(false), setDetail({ id, metric }))}
          onClose={() => setCalibrating(false)}
        />
      )}
      {rescoring && <RagRescoreDialog runId={runId} evaluators={evaluators} evaluation={evaluation} judge={judge} providers={providers} onDone={(id) => onRescored?.(id)} onClose={() => setRescoring(false)} />}
      <div className={cx('flex items-center gap-2 p-2 border-b border-line flex-wrap', view !== 'samples' && 'hidden')}>
        <FilterInput className="w-56" placeholder="Search samples, questions, tags" label="Search samples" value={query} onChange={setQuery} />
        <Select className="h-7 min-h-7 py-0 text-xs" value={failure} onChange={(e) => setFailure(e.target.value)} aria-label="Why a sample failed" data-rag-failure-filter>
          <option value="">All samples</option>
          <option value="passed">Passed</option>
          {m.failures.map((f) => (
            <option key={f.class} value={f.class}>
              {f.label} ({f.count})
            </option>
          ))}
        </Select>
        <Select className="h-7 min-h-7 py-0 text-xs" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort by">
          <option value="">Run order</option>
          <option value="failure">Failures first</option>
          {m.columns.map((c) => (
            <option key={c.key} value={c.key}>
              Lowest {c.key}
            </option>
          ))}
        </Select>
        <span className="text-xs text-muted ml-auto">
          {m.total} samples · {m.columns.length} metrics
          {m.failures.length > 0 && <> · {m.failures.map((f) => `${f.label} ${f.count}`).join(', ')}</>}
        </span>
      </div>
      <div ref={scroller} className={cx('flex-1 min-h-0 overflow-auto', view !== 'samples' && 'hidden')}>
        <table className="text-xs border-separate border-spacing-0 min-w-full" data-rag-matrix-table>
          <thead ref={head} className="sticky top-0 z-10 bg-bg">
            <tr>
              <th className="text-left px-2 py-1 border-b border-line min-w-56" rowSpan={2}>
                Sample
              </th>
              {m.groups.map((g) => (
                <th key={g.id} colSpan={collapsed.has(g.id) ? 1 : g.columns} className="px-2 py-1 border-b border-l border-line text-left font-medium text-muted">
                  <button className="flex items-center gap-1" onClick={() => toggle(g.id)} aria-label={`${collapsed.has(g.id) ? 'Expand' : 'Collapse'} ${g.label}`} data-rag-group-toggle={g.id}>
                    {collapsed.has(g.id) ? <ChevronRight size={12} /> : <ChevronDown size={12} />} {g.label}
                  </button>
                </th>
              ))}
            </tr>
            <tr>
              {layout.map((g) =>
                g.collapsed ? (
                  <th key={g.id} className="px-2 py-1 border-b border-l border-line text-right font-normal text-muted" title={STAT.mean!.title}>
                    average
                  </th>
                ) : (
                  g.shown.map(({ c }) => (
                    <th key={c.key} className="px-2 py-1 border-b border-l border-line text-right font-medium align-bottom" data-rag-col={c.key}>
                      <div className="whitespace-nowrap">{c.key}</div>
                      <div className="font-normal text-muted whitespace-nowrap">
                        {c.direction === 'lower' ? '≤' : '≥'} <PassMark column={c.key} value={thr[c.key] ?? c.threshold} onCommit={commitMark} />
                      </div>
                    </th>
                  ))
                ),
              )}
            </tr>
            {(['mean', 'p10', 'pass', 'n/a', '95%', 'spread'] as const).map((stat) => (
              <tr key={stat} className="bg-panel/60" data-rag-stat={stat}>
                <th className="text-left px-2 py-0.5 font-normal text-muted border-b border-line/60" title={STAT[stat]!.title}>
                  {STAT[stat]!.label}
                </th>
                {layout.map((g) =>
                  g.collapsed ? (
                    <td key={g.id} className="px-2 py-0.5 border-l border-line/60" />
                  ) : (
                    g.shown.map(({ c }) => {
                      const a = agg.get(c.key);
                      const interval = a?.ci ?? ci[c.key];
                      return (
                        <td key={c.key} className="px-2 py-0.5 text-right tabular-nums border-b border-l border-line/60">
                          {!a
                            ? ''
                            : stat === 'mean'
                              ? (a.mean ?? '—')
                              : stat === 'p10'
                                ? (a.p10 ?? '—')
                                : stat === 'pass'
                                  ? a.passRate !== undefined
                                    ? `${Math.round(a.passRate * 100)}%`
                                    : '—'
                                  : stat === 'n/a'
                                    ? a.naCount || ''
                                    : stat === '95%'
                                      ? interval
                                        ? `${interval[0]}–${interval[1]}`
                                        : a.n < 3
                                          ? '—'
                                          : ''
                                      : <Spark bins={a.distribution} />}
                        </td>
                      );
                    })
                  ),
                )}
              </tr>
            ))}
          </thead>
          <tbody>
            {w.start > 0 && (
              <tr aria-hidden style={{ height: w.start * ROW_H }}>
                <td colSpan={drawn} />
              </tr>
            )}
            {m.rows.slice(w.start, w.end).map((r) => (
              <MatrixRowView key={r.id} r={r} layout={layout} onOpen={open} />
            ))}
            {w.end < m.rows.length && (
              <tr aria-hidden style={{ height: (m.rows.length - w.end) * ROW_H }}>
                <td colSpan={drawn} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {m.total > PAGE && view === 'samples' && (
        <div className="flex items-center gap-2 px-2 py-1 border-t border-line text-xs">
          <button className="px-2 py-0.5 rounded hover:bg-hover disabled:opacity-40" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            Previous
          </button>
          <span className="text-muted">
            {offset + 1}–{Math.min(m.total, offset + PAGE)} of {m.total}
          </span>
          <button className="px-2 py-0.5 rounded hover:bg-hover disabled:opacity-40" disabled={offset + PAGE >= m.total} onClick={() => setOffset(offset + PAGE)}>
            Next
          </button>
        </div>
      )}
      {detail && <RagSampleDetail runId={runId} resultId={detail.id} focus={detail.metric} target={target} judge={judge} onClose={() => setDetail(undefined)} />}
    </div>
  );
}
