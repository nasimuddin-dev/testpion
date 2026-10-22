import { ArrowDown, ArrowUp, Grid3x3, Play, Search, Target, X } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import type { EvalColumnStats, EvalMatrixColumn, EvalMatrixPage, EvalMatrixQuery, EvalMatrixRow, EvalMatrixRowCell } from '@testpion/core';
import { call } from '../api';
import { usePagedRows } from '../lib/paged-rows';
import { useSticky } from '../lib/sticky';
import { plural, timeAgo } from '../lib/format';
import type { TestResult } from '../types';
import type { RunRow } from './RunsOverview';
import { ResultDetail } from './RunPanel';
import { Badge, Button, cx, Empty, Input, Segmented, Select, Split, VirtualList } from './ui';
import { outputFileName } from '@testpion/shared';
import { OutputActions } from './output/OutputFrame';
import type { OutputSpec } from './output/output-core';

type Filter = NonNullable<EvalMatrixQuery['filter']>;
type Sort = NonNullable<EvalMatrixQuery['sort']>;
type Column = EvalMatrixColumn & { stats: EvalColumnStats };

const ROW = 30;
const MAX_RUNS = 20;

/** The newest run of each evaluation (at most 10): what the matrix shows until the user picks. */
function defaultRuns(runs: RunRow[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of runs) {
    if (seen.has(r.name)) continue;
    seen.add(r.name);
    out.push(r.id);
    if (out.length >= 10) break;
  }
  return out;
}

const fmt = (n: number | undefined) => (n === undefined ? '' : n.toFixed(2));
const signed = (n: number | undefined) => (n === undefined ? '' : `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n).toFixed(2)}`);

/** A cell's look: against a baseline its change decides (regressed red, improved green), else its status. */
function cellTone(c: EvalMatrixRowCell): string {
  switch (c.change) {
    case 'regressed':
      return 'bg-bad/20 text-bad';
    case 'improved':
      return 'bg-ok/20 text-ok';
    case 'missing':
      return 'bg-warn/10 text-warn';
    case 'new':
      return 'bg-accent-soft text-accent';
  }
  if (c.status === 'passed') return 'bg-ok/[0.07] text-fg';
  if (c.status === 'failed' || c.status === 'error') return 'bg-bad/10 text-bad';
  return 'text-muted';
}

function cellTitle(c: EvalMatrixRowCell, col: Column): string {
  if (!c.status && c.change !== 'missing') return `${col.label}: no result for this case`;
  const parts = [`${col.label}: ${c.status ?? 'not run'}`];
  if (c.score !== undefined) parts.push(`score ${fmt(c.score)}`);
  if (c.baseline) parts.push(`baseline ${c.baseline.status}${c.baseline.score !== undefined ? ` ${fmt(c.baseline.score)}` : ''}`);
  if (c.delta !== undefined) parts.push(`Δ ${signed(c.delta)}`);
  if (c.change && c.change !== 'unchanged') parts.push(c.change);
  return parts.join(' · ');
}

function Cell({ c, col, selected, onOpen }: { c: EvalMatrixRowCell; col: Column; selected: boolean; onOpen(): void }) {
  const has = !!c.status;
  return (
    <button
      type="button"
      className={cx(
        'h-full w-full px-2 flex items-center justify-end gap-1 tabular-nums text-xs border-l border-line/60 text-right',
        cellTone(c),
        selected && 'ring-2 ring-inset ring-accent',
        has || c.baseline?.id ? 'hover:brightness-110 cursor-pointer' : 'cursor-default',
      )}
      title={cellTitle(c, col)}
      data-cell-status={c.status ?? 'none'}
      data-cell-change={c.change ?? 'none'}
      disabled={!has && !c.baseline?.id}
      onClick={onOpen}
    >
      {c.change === 'missing' ? (
        <span>missing</span>
      ) : !has ? (
        <span className="text-muted">·</span>
      ) : (
        <>
          {(c.change === 'regressed' || c.change === 'improved') && c.delta !== undefined && <span className="text-[10px] opacity-90">{signed(c.delta)}</span>}
          {c.change === 'regressed' && c.delta === undefined && <ArrowDown size={11} />}
          {c.change === 'improved' && c.delta === undefined && <ArrowUp size={11} />}
          <span className="font-medium">{c.score !== undefined ? fmt(c.score) : c.status === 'passed' ? '✓' : c.status === 'skipped' ? '–' : '✗'}</span>
        </>
      )}
    </button>
  );
}

/** A row of the matrix: the case, then a cell per variant. Memoised: a row already on screen is not rendered again while scrolling. */
const MatrixRow = memo(function MatrixRow({ row, cols, grid, selCol, onOpen }: { row: EvalMatrixRow; cols: Column[]; grid: string; selCol?: number; onOpen(row: EvalMatrixRow, k: number): void }) {
  return (
    // contained: a row's layout and paint stay inside it (rows coming into view do not lay out the list again)
    <div className={cx('grid h-full border-b border-line/40', selCol !== undefined && 'bg-accent/5')} style={{ gridTemplateColumns: grid, contain: 'strict' }} data-matrix-row={row.key}>
      <div
        className="px-2 flex items-center gap-1.5 min-w-0 text-xs"
        title={`${row.name}${
          row.tags
            ? `
Tags: ${row.tags.join(', ')}`
            : ''
        }`}
      >
        <span className={cx('mono shrink-0', row.name !== row.key && 'text-muted')}>{row.key}</span>
        {row.name !== row.key && <span className="truncate">{row.name}</span>}
        {row.tags?.slice(0, 2).map((t) => (
          <Badge key={t}>{t}</Badge>
        ))}
      </div>
      {row.cells.map((c, k) => (
        <Cell key={k} c={c} col={cols[k] ?? NO_COLUMN} selected={selCol === k} onOpen={() => onOpen(row, k)} />
      ))}
    </div>
  );
});

const NO_COLUMN = { key: '', runId: '', runName: '', label: '', stats: {} } as unknown as Column;

/** The detail of a cell: the run panel's ResultDetail on the input / output, with the baseline's result a click away. */
function CellDetail({ sel, onClose }: { sel: { runId: string; resultId: string; baseline?: { runId: string; resultId: string } }; onClose(): void }) {
  const [side, setSide] = useState<'run' | 'baseline'>('run');
  const [r, setR] = useState<TestResult | null>();
  const target = side === 'baseline' && sel.baseline ? sel.baseline : sel;
  useEffect(() => setSide(sel.resultId ? 'run' : 'baseline'), [sel]);
  useEffect(() => {
    let live = true;
    setR(undefined);
    void call<TestResult | null>('eval.matrixResult', { runId: target.runId, resultId: target.resultId }).then(
      (x) => live && setR(x),
      () => live && setR(null),
    );
    return () => {
      live = false;
    };
  }, [target.runId, target.resultId]);
  return (
    <div className="h-full flex flex-col min-h-0" data-eval-cell-detail={target.resultId}>
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-line">
        {sel.baseline && sel.resultId ? (
          <Segmented
            label="Result"
            size="xs"
            value={side}
            onChange={setSide}
            options={[
              { value: 'run', label: 'This run' },
              { value: 'baseline', label: 'Baseline' },
            ]}
          />
        ) : (
          <span className="text-xs text-muted">{side === 'baseline' ? 'Baseline (missing from this run)' : 'Result'}</span>
        )}
        <Button size="sm" variant="ghost" className="ml-auto" icon={<X size={12} />} onClick={onClose} aria-label="Close the case">
          Close
        </Button>
      </div>
      <div className="flex-1 min-h-0">
        {r ? (
          <ResultDetail r={r} runId={target.runId} initialTab="io" />
        ) : r === null ? (
          <Empty icon={<Target size={22} />} title="This result is no longer in its run" />
        ) : (
          <div className="p-3 text-sm text-muted">Loading…</div>
        )}
      </div>
    </div>
  );
}

/**
 * Evaluations as a matrix: rows are the cases, columns the runs compared (each a prompt × model, or one column per
 * model of a run), cells the score or pass / fail. Against a baseline run each cell is coloured by regression or
 * improvement with the score delta. Filter chips (failed, regressed, improved, missing, a tag), search and sorts; a
 * cell opens the case (input, output, expected, the judge's reasoning). The backend holds the matrix and answers
 * pages, so 5,000 cases × 10 variants costs the renderer the rows on screen.
 */
export function EvalMatrix({ runs: all, onRun }: { runs: RunRow[]; /** Run the evaluation (the empty matrix's first step). */ onRun(): void }) {
  // finished runs only: a run still going (the view lists it at once, without a duration) has no results to compare yet
  const runs = useMemo(() => all.filter((r) => r.durationMs !== undefined), [all]);
  const [picked, setPicked] = useSticky<string[] | undefined>('eval:matrix:runs', undefined, { persist: true });
  const [baseline, setBaseline] = useSticky<string>('eval:matrix:baseline', '', { persist: true });
  const [threshold, setThreshold] = useSticky<number>('eval:matrix:threshold', 0.05, { persist: true });
  const [filter, setFilter] = useSticky<Filter>('eval:matrix:filter', 'all');
  const [tag, setTag] = useSticky<string>('eval:matrix:tag', '');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useSticky<{ by: Sort; column?: number; dir: 'asc' | 'desc' }>('eval:matrix:sort', { by: 'case', dir: 'asc' });
  const [sel, setSel] = useState<{ row: number; col: number; runId: string; resultId: string; baseline?: { runId: string; resultId: string } }>();
  // runs deleted since they were picked drop out; none picked (or none left): the newest run of each evaluation
  const known = useMemo(() => new Set(runs.map((r) => r.id)), [runs]);
  const columns = useMemo(() => {
    const kept = (picked ?? []).filter((id) => known.has(id));
    return kept.length ? kept : defaultRuns(runs);
  }, [picked, known, runs]);
  const base = baseline && known.has(baseline) ? baseline : '';
  useEffect(() => {
    const t = setTimeout(() => setQuery(search), 200);
    return () => clearTimeout(t);
  }, [search]);
  const params = useMemo(
    () => ({
      runs: columns,
      ...(base ? { baseline: base } : {}),
      threshold,
      filter,
      ...(tag ? { tag } : {}),
      ...(query ? { search: query } : {}),
      sort: sort.by,
      ...(sort.column !== undefined ? { column: sort.column } : {}),
      dir: sort.dir,
    }),
    [columns, base, threshold, filter, tag, query, sort],
  );
  const key = JSON.stringify(params);
  const fetchPage = useCallback(
    (offset: number, limit: number) => (params.runs.length ? call<EvalMatrixPage>('eval.matrix', { ...params, offset, limit }) : Promise.reject(new Error('No finished evaluation runs yet'))),
    [params],
  );
  const { meta, total, rowAt, error } = usePagedRows<EvalMatrixRow, EvalMatrixPage>(fetchPage, key, { pageSize: 200 });
  const indices = useMemo(() => Array.from({ length: total }, (_, i) => i), [total]);
  // the same columns from page to page are the same object (the memoised rows stay as they are when a page comes)
  const colsText = JSON.stringify(meta?.columns ?? []);
  const cols = useMemo<Column[]>(() => JSON.parse(colsText), [colsText]);
  const grid = `minmax(180px, 1.6fr) repeat(${Math.max(1, cols.length)}, minmax(88px, 1fr))`;
  const minWidth = 180 + Math.max(1, cols.length) * 88;
  const counts = meta?.counts;
  const runName = (id: string) => runs.find((r) => r.id === id);
  // one function for every cell (the rows are memoised: scrolling renders only the rows that come into view)
  const open = useCallback(
    (row: EvalMatrixRow, k: number) => {
      const c = row.cells[k]!;
      const col = cols[k];
      const b = c.baseline?.id && base ? { runId: base, resultId: c.baseline.id } : undefined;
      if (!col || (!c.id && !b)) return;
      setSel({ row: row.index, col: k, runId: col.runId, resultId: c.id ?? '', baseline: b });
    },
    [cols, base],
  );
  // other runs make other rows: an open case belongs to the matrix it was opened in
  const columnsKey = `${columns.join(',')}|${base}`;
  useEffect(() => setSel(undefined), [columnsKey]);
  // the down arrow: every case of the matrix as it is filtered and sorted now, paged by the backend (never in the window)
  const spec = useMemo<OutputSpec>(() => {
    const source = { kind: 'grid' as const, grid: 'eval-matrix' as const, params };
    return {
      id: 'eval.matrix',
      what: 'evaluation matrix',
      name: outputFileName({ name: `eval-matrix${filter === 'all' ? '' : `-${filter}`}`, ext: '' }),
      formats: [
        { format: 'csv', source },
        { format: 'json', source },
        { format: 'md', source },
        { format: 'html', source },
      ],
      empty: !params.runs.length ? 'No finished evaluation runs yet' : total ? undefined : 'No cases match',
    };
  }, [params, filter, total]);
  const sortBy = (k: number) => setSort((s) => (s.by === 'score' && s.column === k ? { ...s, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { by: 'score', column: k, dir: 'asc' }));

  if (!runs.length)
    return (
      <Empty icon={<Grid3x3 size={26} />} title="No evaluation runs yet" actions={[{ label: 'Run this evaluation', icon: <Play size={13} />, onClick: onRun }]}>
        Each run (one per prompt or model) is compared here case by case.
      </Empty>
    );

  const table = (
    <div className="h-full flex flex-col min-h-0" data-eval-matrix data-cases={meta?.cases ?? ''} data-total={total} data-baseline={meta?.baseline?.[0]?.runId ?? ''} data-filter={filter} data-output="eval.matrix">
      {/* the variants and the baseline */}
      <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5 border-b border-line text-xs">
        <span className="text-muted mr-1">Variants</span>
        {columns.map((id) => {
          const r = runName(id);
          return (
            <span key={id} className="inline-flex items-center gap-1 rounded-md border border-line bg-panel2 pl-2 pr-0.5 h-6" data-matrix-run={id}>
              <span className="truncate max-w-40">{r?.name ?? id}</span>
              {r && <span className="text-muted">{timeAgo(r.startedAt)}</span>}
              <button
                className="p-0.5 rounded hover:bg-hover text-muted"
                aria-label={`Remove ${r?.name ?? id}`}
                title="Remove from the matrix"
                onClick={() => setPicked(columns.filter((x) => x !== id))}
                disabled={columns.length <= 1}
              >
                <X size={11} />
              </button>
            </span>
          );
        })}
        {columns.length < MAX_RUNS && (
          <Select className="h-6 min-h-6 py-0 text-xs max-w-48" aria-label="Add a run" value="" onChange={(e) => e.target.value && setPicked([...columns, e.target.value])}>
            <option value="">+ Add a run…</option>
            {runs
              .filter((r) => !columns.includes(r.id))
              .slice(0, 200)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} · {timeAgo(r.startedAt)}
                </option>
              ))}
          </Select>
        )}
        <span className="ml-auto text-muted">Baseline</span>
        <Select className="h-6 min-h-6 py-0 text-xs max-w-52" aria-label="Baseline run" value={base} onChange={(e) => setBaseline(e.target.value)}>
          <option value="">None</option>
          {runs.slice(0, 200).map((r) => (
            <option key={r.id} value={r.id}>
              {r.name} · {timeAgo(r.startedAt)}
            </option>
          ))}
        </Select>
        {base && (
          <label className="flex items-center gap-1 text-muted" title="A score change counts as a regression or an improvement beyond this (a drop of exactly it does not)">
            ±
            <Input
              className="h-6 min-h-6 w-16 text-xs"
              type="number"
              min={0}
              max={1}
              step={0.01}
              aria-label="Threshold"
              value={threshold}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v >= 0 && v <= 1) setThreshold(v);
              }}
            />
          </label>
        )}
      </div>
      {/* filter chips, tag, search, sort */}
      <div className="flex flex-wrap items-center gap-2 px-2 py-1.5 border-b border-line">
        <Segmented
          label="Cases"
          size="xs"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: `All ${counts?.all ?? ''}`.trim() },
            { value: 'failed', label: `Failed ${counts?.failed ?? ''}`.trim() },
            ...(base
              ? [
                  { value: 'regressed' as const, label: `Regressed ${counts?.regressed ?? ''}`.trim() },
                  { value: 'improved' as const, label: `Improved ${counts?.improved ?? ''}`.trim() },
                  { value: 'missing' as const, label: `Missing ${counts?.missing ?? ''}`.trim() },
                ]
              : []),
          ]}
        />
        {!!meta?.tags.length && (
          <Select className="h-6 min-h-6 py-0 text-xs max-w-40" aria-label="Tag" value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">Every tag</option>
            {meta.tags.map((t) => (
              <option key={t.tag} value={t.tag}>
                {t.tag} ({t.count})
              </option>
            ))}
          </Select>
        )}
        <label className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
          <Input className="h-6 min-h-6 w-40 text-xs pl-6" placeholder="Find a case" aria-label="Find a case" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <Select
          className="h-6 min-h-6 py-0 text-xs"
          aria-label="Sort"
          value={sort.column === undefined ? `${sort.by}:${sort.dir}` : 'column'}
          onChange={(e) => {
            const [by, dir] = e.target.value.split(':') as [Sort, 'asc' | 'desc'];
            if (by) setSort({ by, dir: dir ?? 'asc' });
          }}
        >
          <option value="case:asc">By case</option>
          <option value="score:asc">Lowest score first</option>
          <option value="score:desc">Highest score first</option>
          {base && <option value="delta:asc">Biggest drop first</option>}
          {base && <option value="delta:desc">Biggest gain first</option>}
          <option value="failures:asc">Most failures first</option>
          {sort.column !== undefined && <option value="column">By {cols[sort.column]?.label ?? 'a column'}</option>}
        </Select>
        <OutputActions spec={spec}>
          <span className="text-xs text-muted tabular-nums">{meta ? `${plural(total, 'case')}${total !== meta.cases ? ` of ${meta.cases}` : ''}` : 'Loading…'}</span>
        </OutputActions>
      </div>
      {error && <div className="px-3 py-1.5 text-xs text-bad border-b border-line">{error}</div>}
      <div className="flex-1 min-h-0 overflow-x-auto">
        <div className="h-full flex flex-col min-h-0" style={{ minWidth }}>
          {/* the column heads: the variant, its pass count and mean score (and the change against the baseline); a click sorts by it */}
          <div className="grid border-b border-line text-[11px] shrink-0" style={{ gridTemplateColumns: grid }}>
            <div className="px-2 py-1 text-muted uppercase tracking-wide self-end">Case</div>
            {cols.map((c, k) => (
              <button
                key={c.key}
                type="button"
                className={cx('px-2 py-1 text-right border-l border-line/60 hover:bg-hover min-w-0', sort.column === k && 'bg-accent-soft')}
                title={`${c.label}${c.startedAt ? ` · ${new Date(c.startedAt).toLocaleString()}` : ''}\nClick to sort by this column`}
                onClick={() => sortBy(k)}
                data-matrix-column={c.key}
              >
                <div className="font-medium truncate">{c.label}</div>
                <div className="text-muted tabular-nums truncate">
                  {c.stats.passed}/{c.stats.cases}
                  {c.stats.meanScore !== undefined && ` · ${fmt(c.stats.meanScore)}`}
                  {sort.column === k && (sort.dir === 'asc' ? ' ↑' : ' ↓')}
                </div>
                {base && (
                  <div className="tabular-nums truncate">
                    {c.stats.regressed > 0 && <span className="text-bad">▼{c.stats.regressed} </span>}
                    {c.stats.improved > 0 && <span className="text-ok">▲{c.stats.improved} </span>}
                    {c.stats.meanDelta !== undefined && <span className={c.stats.meanDelta < 0 ? 'text-bad' : c.stats.meanDelta > 0 ? 'text-ok' : 'text-muted'}>{signed(c.stats.meanDelta)}</span>}
                  </div>
                )}
              </button>
            ))}
          </div>
          {meta && !total ? (
            <Empty icon={<Grid3x3 size={22} />} title={filter === 'all' && !tag && !query ? 'These runs have no results' : 'No case matches'}>
              {filter !== 'all' || tag || query ? 'Clear the filter, the tag or the search to see every case.' : undefined}
            </Empty>
          ) : (
            <VirtualList
              className="flex-1 min-h-0"
              items={indices}
              rowHeight={ROW}
              scrollKey={key}
              render={(i) => {
                const row = rowAt(i);
                if (!row) return <div className="h-full border-b border-line/40 bg-panel2/40" data-matrix-row="loading" />;
                return <MatrixRow row={row} cols={cols} grid={grid} selCol={sel?.row === row.index ? sel.col : undefined} onOpen={open} />;
              }}
            />
          )}
        </div>
      </div>
    </div>
  );

  // one tree whether a case is open or not: opening one keeps the list where it was scrolled
  return (
    <Split id="eval-matrix-detail" initial={58} min={25} collapsedSecond={!sel}>
      {table}
      {sel ? <CellDetail sel={sel} onClose={() => setSel(undefined)} /> : null}
    </Split>
  );
}
