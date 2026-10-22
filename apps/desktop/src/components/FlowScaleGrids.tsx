import { FileSpreadsheet, Layers, Square, Target } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { asError, call, on } from '../api';
import { toastError } from '../store';
import type { TestResult } from '../types';
import { formatMs, plural, timeAgo } from '../lib/format';
import { StatusIcon } from './Results';
import { ResultDetail } from './RunPanel';
import { Badge, Button, cx, Empty, SECTION_LABEL, Segmented, Spinner, Split, VirtualList } from './ui';
import { usePagedRows } from '../lib/paged-rows';
import { htmlDocument, jsonPretty, outputFileName, rowsFromObjects, scaleRunStatus, toCsv, type FlowRunStatus } from '@testpion/shared';
import { OutputActions, OutputHeader } from './output/OutputFrame';
import type { OutputSpec } from './output/output-core';

/** A run's status as a badge tone: skipped (nothing ran) is a warning, not a pass. */
const STATUS_TONE: Record<string, 'ok' | 'bad' | 'warn'> = { passed: 'ok', failed: 'bad', cancelled: 'warn', skipped: 'warn' };

/* ------------------------------------------------------------------ shapes (core flow-data-run / flow-env-matrix / flow-scale-runs) */

interface DataRow {
  index: number;
  status: FlowRunStatus;
  durationMs: number;
  values: Record<string, unknown>;
  failedStep?: string;
  failedStepName?: string;
  error?: string;
  steps: Array<{ id: string; status: string; ms: number }>;
  detail?: boolean;
}
interface RowsPage {
  total: number;
  matched: number;
  counts: { passed: number; failed: number; cancelled: number; skipped?: number };
  offset: number;
  rows: DataRow[];
}
interface ScaleRow {
  id: string;
  kind: 'data' | 'matrix';
  file: string;
  startedAt: string;
  durationMs: number;
  status: string;
  total: number;
  passed: number;
  failed: number;
  source?: string;
  environments?: string[];
  running?: boolean;
}
interface DataSummary {
  kind: 'data';
  /** The run's status (finished runs): skipped when nothing ran. */
  status?: string;
  source?: string;
  total: number;
  passed: number;
  failed: number;
  cancelled: number;
  skipped?: number;
  bailed?: boolean;
  stopped?: boolean;
  truncated?: boolean;
  dataError?: string;
  durationMs: number;
  columns?: string[];
  steps?: Array<{ id: string; name: string }>;
  averageRowMs?: number;
  slowestRowMs?: number;
  running?: boolean;
}
interface MatrixColumn {
  environment: string;
  status: string;
  durationMs: number;
  failedStep?: string;
  error?: string;
  cells?: Record<string, { status: string; ms: number; error?: string }>;
  results?: TestResult[];
}
interface Matrix {
  kind: 'matrix';
  environments: string[];
  steps?: Array<{ id: string; name: string }>;
  columns: MatrixColumn[];
  outputs?: Array<{ key: string; values: unknown[]; differs: boolean }>;
  differingSteps?: string[];
  /** The matrix's status (finished): skipped when nothing ran in any environment. */
  status?: string;
  passed: number;
  failed: number;
  skipped?: number;
  durationMs: number;
  running?: boolean;
}
type Progress = { id: string; done: number; passed: number; failed: number; cancelled: number; skipped?: number; columns?: MatrixColumn[] };

const PAGE = 200;
/** Pages of rows kept in the window at once (the rest are asked for again when scrolled back to). */
const KEEP_PAGES = 12;

const short = (v: unknown) => {
  const s = v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 59)}…` : s;
};

/** Objects as the three formats of a small grid the window holds (the matrix, the list of runs). */
function gridFormats(title: string, objects: () => Array<Record<string, unknown>>): OutputSpec['formats'] {
  const table = () => rowsFromObjects(objects());
  return [
    {
      format: 'csv',
      build: () => {
        const t = table();
        return toCsv([t.columns, ...t.rows]);
      },
    },
    { format: 'json', build: () => jsonPretty(objects()) },
    {
      format: 'html',
      build: () => {
        const t = table();
        return htmlDocument(title, [{ table: { columns: t.columns, rows: t.rows } }], { generatedAt: new Date().toISOString() });
      },
    },
  ];
}

/** The progress events of one scale run, and its end. */
function useScaleEvents(id: string, onProgress: (p: Progress) => void, onFinished: () => void) {
  const cb = useRef({ onProgress, onFinished });
  cb.current = { onProgress, onFinished };
  useEffect(() => {
    const offP = on<Progress[]>('scale.progress', (items) => {
      const last = [...items].reverse().find((p) => p.id === id);
      if (last) cb.current.onProgress(last);
    });
    const offF = on<{ id: string }>('scale.finished', (p) => p.id === id && cb.current.onFinished());
    return () => {
      offP();
      offF();
    };
  }, [id]);
}

/* ------------------------------------------------------------------ data runs */

/**
 * The per-row results of a data-driven run: a virtualised grid (row number, status, time, failing step, the row's
 * values) that holds only the pages on screen (a 100,000-row run costs the same as 200), filtered to failures with
 * one click, live while it runs; a row opens its steps, and a step its full result (the run panel's ResultDetail).
 */
export function FlowDataGrid({ id }: { id: string }) {
  const [summary, setSummary] = useState<DataSummary | { error: string }>();
  const [filter, setFilter] = useState<'all' | 'failed' | 'passed' | 'cancelled' | 'skipped'>('all');
  const [counts, setCounts] = useState({ passed: 0, failed: 0, cancelled: 0, skipped: 0 });
  const [sel, setSel] = useState<DataRow>();
  const running = !!summary && !('error' in summary) && !!summary.running;

  const loadSummary = useCallback(() => call<DataSummary>('tests.scaleRun', { id }).then(setSummary, (e) => setSummary({ error: asError(e).message })), [id]);
  useEffect(() => void loadSummary(), [loadSummary]);
  // the rows a page at a time (the window's one paging mechanism: lib/paged-rows); the list is as long as the rows the filter keeps
  const fetchRows = useCallback(
    (offset: number, limit: number) => call<RowsPage>('tests.scaleRows', { id, offset, limit, status: filter }).then((p) => ({ ...p, total: p.matched })),
    [id, filter],
  );
  const { meta, total: matched, rowAt, reload, refreshPage, peek } = usePagedRows<DataRow, RowsPage>(fetchRows, `${id}|${filter}`, { pageSize: PAGE, keep: KEEP_PAGES });
  useEffect(() => {
    if (meta) setCounts({ skipped: 0, ...meta.counts });
  }, [meta]);
  // while it runs: the counts, and the last (growing) page, at most twice a second
  const lastFetch = useRef(0);
  useScaleEvents(
    id,
    (p) => {
      setCounts({ passed: p.passed, failed: p.failed, cancelled: p.cancelled, skipped: p.skipped ?? 0 });
      const now = Date.now();
      if (now - lastFetch.current < 500) return;
      lastFetch.current = now;
      const lastPage = Math.floor(Math.max(0, matched - 1) / PAGE);
      refreshPage(lastPage);
      if (matched % PAGE === 0) refreshPage(lastPage + 1);
    },
    () => {
      void loadSummary();
      reload();
    },
  );

  const indices = useMemo(() => Array.from({ length: matched }, (_, i) => i), [matched]);
  const s = summary && !('error' in summary) ? summary : undefined;
  // the value columns: from the run (once finished), else from the rows on screen
  const columns = (s?.columns?.length ? s.columns : Object.keys(peek(0)?.[0]?.values ?? {})).slice(0, 6);
  const grid = `56px 22px 72px minmax(120px,1.2fr) ${columns.map(() => 'minmax(80px,1fr)').join(' ')}`;
  // the run's status as the engine gives it (a run where nothing ran is skipped, never passed)
  const status = s ? (s.status ?? scaleRunStatus(s)) : undefined;
  // the down arrow: every row the grid pages through (with the current filter), paged by the backend, never in the window
  const spec = useMemo<OutputSpec>(() => {
    const source = { kind: 'grid' as const, grid: 'scale-rows' as const, params: { id, status: filter === 'all' ? undefined : filter } };
    return {
      id: 'flow.grid',
      what: 'data run rows',
      name: outputFileName({ name: `data-run-${id}${filter === 'all' ? '' : `-${filter}`}`, status: running ? undefined : status, ext: '' }),
      formats: [
        { format: 'csv', source },
        { format: 'json', source },
        { format: 'html', source },
      ],
      empty: matched ? undefined : filter === 'all' ? 'No rows yet' : `No ${filter} rows`,
    };
  }, [id, filter, running, status, matched]);
  if (summary && 'error' in summary)
    return (
      <Empty icon={<FileSpreadsheet size={24} />} title="This data run cannot be read">
        {summary.error}
      </Empty>
    );
  const done = counts.passed + counts.failed + counts.cancelled + counts.skipped;
  return (
    <div className="h-full flex flex-col min-h-0" data-flow-data-grid={id} data-running={!summary ? 'unknown' : running ? 'true' : 'false'}>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line flex-wrap">
        <FileSpreadsheet size={14} className="text-muted" />
        {running ? (
          <Badge tone="accent">running · {plural(done, 'row')}</Badge>
        ) : (
          <Badge tone={STATUS_TONE[status ?? 'failed'] ?? 'bad'} data-scale-status={status}>
            {status ?? '…'}
          </Badge>
        )}
        <span className="text-sm tabular-nums flex gap-1.5">
          <Badge tone="ok">{counts.passed} passed</Badge>
          {counts.failed > 0 && <Badge tone="bad">{counts.failed} failed</Badge>}
          {counts.cancelled > 0 && <Badge tone="warn">{counts.cancelled} cancelled</Badge>}
          {counts.skipped > 0 && <Badge tone="warn">{counts.skipped} skipped</Badge>}
        </span>
        {s && !running && (
          <span className="text-xs text-muted">
            {[
              s.source,
              formatMs(s.durationMs),
              s.averageRowMs ? `${formatMs(s.averageRowMs)} a row` : '',
              s.bailed ? 'stopped at the first failing row' : '',
              s.truncated ? 'more rows than it read' : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        )}
        <OutputActions spec={spec}>
          {running && (
            <Button size="sm" variant="danger" icon={<Square size={11} />} data-scale-cancel onClick={() => void call('tests.scaleCancel', { id }).catch(toastError)}>
              Cancel
            </Button>
          )}
        </OutputActions>
      </div>
      {s?.dataError && <div className="px-3 py-1.5 text-xs text-warn border-b border-line">The data could not be read to the end: {s.dataError}</div>}
      <Split id="flow-data-grid" initial={62} min={25}>
        <div className="h-full flex flex-col min-h-0">
          <div className="flex items-center gap-2 p-2 border-b border-line">
            <Segmented
              label="Rows"
              size="xs"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: 'All' },
                { value: 'failed', label: `Failed ${counts.failed}` },
                { value: 'passed', label: `Passed ${counts.passed}` },
                ...(counts.cancelled ? [{ value: 'cancelled' as const, label: `Cancelled ${counts.cancelled}` }] : []),
                ...(counts.skipped ? [{ value: 'skipped' as const, label: `Skipped ${counts.skipped}` }] : []),
              ]}
            />
            <span className="ml-auto text-xs text-muted tabular-nums">{plural(matched, 'row')}</span>
          </div>
          <div className={cx(SECTION_LABEL, 'grid gap-2 px-3 py-1.5 items-center border-b border-line')} style={{ gridTemplateColumns: grid }}>
            <span>Row</span>
            <span />
            <span className="text-right">Time</span>
            <span>Failed at</span>
            {columns.map((c) => (
              <span key={c} className="truncate normal-case" title={c}>
                {c}
              </span>
            ))}
          </div>
          {matched ? (
            <VirtualList
              key={filter}
              className="flex-1"
              items={indices}
              rowHeight={28}
              render={(i) => {
                const r = rowAt(i);
                if (!r) return <div className="h-full px-3 flex items-center text-xs text-muted border-b border-line/50">…</div>;
                return (
                  <button
                    data-data-row={r.index}
                    data-status={r.status}
                    onClick={() => setSel(r)}
                    className={cx('w-full h-full grid gap-2 px-3 items-center text-sm text-left border-b border-line/50 hover:bg-hover', sel?.index === r.index && 'bg-accent-soft')}
                    style={{ gridTemplateColumns: grid }}
                  >
                    <span className="tabular-nums text-muted">{r.index}</span>
                    <StatusIcon status={r.status} />
                    <span className="tabular-nums text-xs text-muted text-right">{formatMs(r.durationMs)}</span>
                    <span className={cx('truncate text-xs', r.failedStep ? 'text-bad' : 'text-muted')} title={r.error}>
                      {r.failedStepName ?? r.failedStep ?? ''}
                    </span>
                    {columns.map((c) => (
                      <span key={c} className="truncate mono text-xs" title={short(r.values[c])}>
                        {short(r.values[c])}
                      </span>
                    ))}
                  </button>
                );
              }}
            />
          ) : (
            <Empty title={running ? 'Waiting for the first rows…' : filter === 'all' ? 'No rows' : `No ${filter} rows`} />
          )}
        </div>
        <div className="h-full min-h-0">{sel ? <DataRowDetail id={id} row={sel} steps={s?.steps} /> : <Empty icon={<Target size={24} />} title="Select a row to see its steps" />}</div>
      </Split>
    </div>
  );
}

/** One row of a data run: its values, its steps (status and time) and, when kept, each step's full result. */
function DataRowDetail({ id, row, steps }: { id: string; row: DataRow; steps?: Array<{ id: string; name: string }> }) {
  const [full, setFull] = useState<TestResult[] | null>();
  const [pick, setPick] = useState<string>();
  useEffect(() => {
    let live = true;
    setFull(undefined);
    setPick(row.failedStep);
    call<TestResult[] | null>('tests.scaleRow', { id, index: row.index }).then(
      (r) => live && setFull(r),
      () => live && setFull(null),
    );
    return () => {
      live = false;
    };
  }, [id, row]);
  const nameOf = (sid: string) => steps?.find((x) => x.id === sid)?.name ?? full?.find((x) => x.id === sid)?.name ?? sid;
  const chosen = full?.find((r) => r.id === pick);
  return (
    <div className="h-full flex flex-col min-h-0" data-data-row-detail={row.index}>
      <div className="px-3 py-2 border-b border-line text-xs flex flex-col gap-1 max-h-[35%] overflow-auto">
        <div className="flex items-center gap-2 text-sm">
          <StatusIcon status={row.status} />
          <span className="font-medium">Row {row.index}</span>
          <span className="text-muted">{formatMs(row.durationMs)}</span>
        </div>
        {row.error && <div className="text-bad">{row.error}</div>}
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 mono">
          {Object.entries(row.values).map(([k, v]) => (
            <span key={k} className="contents">
              <span className="text-muted">{k}</span>
              <span className="truncate" title={short(v)}>
                {short(v)}
              </span>
            </span>
          ))}
        </div>
      </div>
      <div className="border-b border-line max-h-[30%] overflow-auto">
        {row.steps.map((st) => (
          <button
            key={st.id}
            data-row-step={st.id}
            onClick={() => setPick(st.id)}
            className={cx('w-full flex items-center gap-2 px-3 h-7 text-sm text-left hover:bg-hover border-b border-line/40', pick === st.id && 'bg-accent-soft')}
          >
            <StatusIcon status={st.status} />
            <span className="truncate flex-1">{nameOf(st.id)}</span>
            <span className="text-xs text-muted tabular-nums">{st.status === 'skipped' ? '' : formatMs(st.ms)}</span>
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0">
        {full === undefined ? (
          <div className="p-3">
            <Spinner />
          </div>
        ) : chosen ? (
          <ResultDetail r={chosen} />
        ) : full === null ? (
          <Empty title="Only the steps' status and time are kept for this row">Full results are kept for failing rows and the first 100 passing ones.</Empty>
        ) : (
          <Empty title="Select a step to see its result" />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ environment matrix */

const CELL_TONE: Record<string, string> = { passed: 'text-ok', failed: 'text-bad bg-bad/10', error: 'text-bad bg-bad/10', skipped: 'text-warn' };

/**
 * An environment matrix: environment × step (status and time), the steps whose status differs marked, then the values
 * the flow extracted or returned in each environment, those that differ highlighted; a cell opens that step's result.
 */
export function FlowMatrixGrid({ id }: { id: string }) {
  const [m, setM] = useState<Matrix | { error: string }>();
  const [cell, setCell] = useState<{ env: string; step: string }>();
  const load = useCallback(() => call<Matrix>('tests.scaleRun', { id }).then(setM, (e) => setM({ error: asError(e).message })), [id]);
  useEffect(() => void load(), [load]);
  useScaleEvents(
    id,
    (p) => setM((cur) => (cur && !('error' in cur) && cur.running ? { ...cur, columns: p.columns ?? cur.columns } : cur)),
    () => void load(),
  );
  // the down arrow: the matrix the window holds (environment × step, then the values), one row per cell
  const spec = useMemo<OutputSpec>(() => {
    const mx = m && !('error' in m) ? m : undefined;
    const cells = (): Array<Record<string, unknown>> => {
      if (!mx) return [];
      const out: Array<Record<string, unknown>> = [];
      for (const st of mx.steps ?? [])
        for (const c of mx.columns) {
          const x = c.cells?.[st.id];
          out.push({ kind: 'step', name: st.name, environment: c.environment, status: x?.status ?? '', ms: x ? x.ms : '', error: x?.error ?? '', differs: !!mx.differingSteps?.includes(st.id) });
        }
      for (const o of mx.outputs ?? []) mx.environments.forEach((e, i) => out.push({ kind: 'value', name: o.key, environment: e, value: o.values[i], differs: o.differs }));
      return out;
    };
    const status = mx ? (mx.status ?? scaleRunStatus({ kind: 'matrix', passed: mx.passed ?? 0, failed: mx.failed ?? 0, skipped: mx.skipped })) : undefined;
    return {
      id: 'flow.grid',
      what: 'environment matrix',
      name: outputFileName({ name: `matrix-${id.replace(/^matrix-/, '')}`, status: mx?.running ? undefined : status, ext: '' }),
      formats: gridFormats('Environment matrix', cells),
      empty: mx?.steps?.length || mx?.outputs?.length ? undefined : 'Nothing in the matrix yet',
    };
  }, [id, m]);
  if (!m)
    return (
      <div className="p-4">
        <Spinner />
      </div>
    );
  if ('error' in m)
    return (
      <Empty icon={<Layers size={24} />} title="This matrix cannot be read">
        {m.error}
      </Empty>
    );
  const matrixStatus = m.status ?? scaleRunStatus({ kind: 'matrix', passed: m.passed ?? 0, failed: m.failed ?? 0, skipped: m.skipped });
  const cols = m.environments.map((e) => m.columns.find((c) => c.environment === e) ?? ({ environment: e, status: m.running ? 'running' : 'not run', durationMs: 0 } as MatrixColumn));
  const steps = m.steps ?? [];
  const chosen = cell ? cols.find((c) => c.environment === cell.env)?.results?.find((r) => r.id === cell.step) : undefined;
  return (
    <div className="h-full flex flex-col min-h-0" data-flow-matrix={id} data-running={m.running ? 'true' : 'false'}>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line flex-wrap">
        <Layers size={14} className="text-muted" />
        {m.running ? (
          <Badge tone="accent">running</Badge>
        ) : (
          <Badge tone={STATUS_TONE[matrixStatus] ?? 'bad'} data-scale-status={matrixStatus}>
            {matrixStatus}
          </Badge>
        )}
        <span className="text-sm">
          {m.passed} of {m.environments.length} environments passed
        </span>
        {!m.running && <span className="text-xs text-muted">{formatMs(m.durationMs)}</span>}
        <OutputActions spec={spec}>
          {m.running && (
            <Button size="sm" variant="danger" icon={<Square size={11} />} onClick={() => void call('tests.scaleCancel', { id }).catch(toastError)}>
              Cancel
            </Button>
          )}
        </OutputActions>
      </div>
      <Split id="flow-matrix" initial={60} min={25}>
        <div className="h-full overflow-auto">
          <table className="w-full text-sm border-collapse">
            <thead className="sticky top-0 bg-bg z-10">
              <tr className={SECTION_LABEL}>
                <th className="text-left font-medium px-3 py-1.5 border-b border-line">Step</th>
                {cols.map((c) => (
                  <th key={c.environment} className="text-left font-medium px-3 py-1.5 border-b border-line normal-case" data-matrix-column={c.environment} data-status={c.status}>
                    <span className="flex items-center gap-1.5">
                      <StatusIcon status={c.status} />
                      {c.environment}
                      <span className="text-muted font-normal">{c.durationMs ? formatMs(c.durationMs) : ''}</span>
                    </span>
                    {c.error && !c.cells && (
                      <span className="block text-bad font-normal truncate max-w-[16rem]" title={c.error}>
                        {c.error}
                      </span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {steps.map((s) => {
                const differs = m.differingSteps?.includes(s.id);
                return (
                  <tr key={s.id} data-matrix-step={s.id} data-differs={differs ? 'true' : 'false'}>
                    <td className="px-3 py-1 border-b border-line/50 truncate max-w-[14rem]" title={s.name}>
                      {differs && (
                        <span className="text-warn mr-1" title="The status differs between environments">
                          ≠
                        </span>
                      )}
                      {s.name}
                    </td>
                    {cols.map((c) => {
                      const x = c.cells?.[s.id];
                      return (
                        <td key={c.environment} className="border-b border-line/50 p-0">
                          <button
                            data-matrix-cell={`${c.environment}|${s.id}`}
                            data-status={x?.status ?? 'none'}
                            disabled={!x}
                            title={x?.error}
                            onClick={() => setCell({ env: c.environment, step: s.id })}
                            className={cx(
                              'w-full text-left px-3 py-1 text-xs tabular-nums hover:bg-hover',
                              x ? CELL_TONE[x.status] : 'text-muted',
                              cell?.env === c.environment && cell.step === s.id && 'ring-1 ring-inset ring-accent',
                            )}
                          >
                            {x ? `${x.status}${x.status === 'skipped' ? '' : ` · ${formatMs(x.ms)}`}` : '–'}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!!m.outputs?.length && (
            <table className="w-full text-xs border-collapse mt-3">
              <thead>
                <tr className={SECTION_LABEL}>
                  <th className="text-left font-medium px-3 py-1.5 border-b border-line">Value</th>
                  {m.environments.map((e) => (
                    <th key={e} className="text-left font-medium px-3 py-1.5 border-b border-line normal-case">
                      {e}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {m.outputs.map((o) => (
                  <tr key={o.key} data-matrix-output={o.key} data-differs={o.differs ? 'true' : 'false'} className={cx(o.differs && 'bg-warn/10')}>
                    <td className="px-3 py-1 border-b border-line/50 mono">
                      {o.differs && <span className="text-warn mr-1">≠</span>}
                      {o.key}
                    </td>
                    {o.values.map((v, i) => (
                      <td key={i} className="px-3 py-1 border-b border-line/50 mono truncate max-w-[16rem]" title={short(v)}>
                        {short(v)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="h-full min-h-0">{chosen ? <ResultDetail r={chosen} /> : <Empty icon={<Target size={24} />} title="Select a cell to see that step's result in that environment" />}</div>
      </Split>
    </div>
  );
}

/* ------------------------------------------------------------------ the list */

/**
 * The data runs and environment matrices of a flow file (newest first, running ones on top) beside the one selected:
 * the Tests view's Runs tab shows it when such a run is open.
 */
export function ScaleRunPanel({ file, id, onSelect }: { file?: string; id: string; onSelect(id: string): void }) {
  const [runs, setRuns] = useState<ScaleRow[]>([]);
  const load = useCallback(() => call<ScaleRow[]>('tests.scaleRuns', { file, limit: 50 }).then(setRuns, () => setRuns([])), [file]);
  useEffect(() => void load(), [load, id]);
  useEffect(() => on('scale.finished', () => void load()), [load]);
  // the down arrow of the list: the runs it shows (at most 50, already in the window)
  const spec = useMemo<OutputSpec>(
    () => ({
      id: 'flow.grid',
      what: 'data runs and matrices',
      name: outputFileName({ name: `scale-runs${file ? `-${file.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '')}` : ''}`, ext: '' }),
      formats: gridFormats('Data runs and environment matrices', () =>
        runs.map((r) => ({ id: r.id, kind: r.kind, file: r.file, startedAt: r.startedAt, status: r.running ? 'running' : r.status, total: r.total, passed: r.passed, failed: r.failed, durationMs: r.durationMs, source: r.source ?? '', environments: (r.environments ?? []).join(' ') })),
      ),
      empty: runs.length ? undefined : 'No data runs or matrices yet',
    }),
    [file, runs],
  );
  return (
    // the list and the open run show together: the marker is on their common root, each has its own down arrow
    <div className="h-full min-h-0" data-output="flow.grid">
    <Split id="tests-scale-runs" initial={22} min={12}>
      <div className="h-full flex flex-col min-h-0">
      <OutputHeader spec={spec} title="Runs" />
      <div className="flex-1 min-h-0 overflow-auto" data-scale-runs>
        {runs.map((r) => (
          <button
            key={r.id}
            data-scale-run={r.id}
            onClick={() => onSelect(r.id)}
            className={cx('w-full text-left px-3 py-2 border-b border-line/50 hover:bg-hover text-sm', r.id === id && 'bg-accent-soft')}
          >
            <div className="flex items-center gap-1.5">
              {r.kind === 'data' ? <FileSpreadsheet size={12} className="text-muted shrink-0" /> : <Layers size={12} className="text-muted shrink-0" />}
              <StatusIcon status={r.running ? 'running' : r.status} />
              <span className="truncate flex-1">{r.kind === 'data' ? `${plural(r.total, 'row')}${r.source ? ` · ${r.source}` : ''}` : (r.environments ?? []).join(', ')}</span>
            </div>
            <div className="text-xs text-muted mt-0.5">
              {r.running ? 'running' : `${r.passed}/${r.total} passed`} · {timeAgo(r.startedAt)} · {r.file}
            </div>
          </button>
        ))}
      </div>
      </div>
      <div className="h-full min-h-0">{id.startsWith('matrix-') ? <FlowMatrixGrid key={id} id={id} /> : <FlowDataGrid key={id} id={id} />}</div>
    </Split>
    </div>
  );
}
