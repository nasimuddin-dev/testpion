import { CodeBlock } from './CodeBlock';
import { Activity, Braces, Download, FileBarChart, FileCode2, FileText, GitCompare, Square, Target, RotateCcw, ScanSearch, Sparkles, ThumbsDown, ThumbsUp } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { call, on } from '../api';
import { toastError, useApp } from '../store';
import type { RunSummary, TestResult, Trace } from '../types';
import { formatCost, formatMs, plural, timeAgo } from '../lib/format';
import { CheckList, ErrorPanel, StatusIcon } from './Results';
import { TraceView } from './TraceView';
import { RunCharts } from './RunCharts';
import { TestHistory } from './TestHistory';
import { finishSave, viewContent, type SaveResult } from '../lib/files';
import { Badge, Button, cx, Empty, Field, Input, Metric, Modal, Segmented, Select, Split, Tabs, VirtualList, Menu, MetricGrid, Textarea } from './ui';
import { usePersisted } from '../lib/sticky';

interface Progress {
  completed: number;
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  running: number;
}

const PAGE = 200;

/** Show test files relative to the workspace's tests/ folder (keeps absolute paths out of screenshots). */
function displayPath(file: string): string {
  const p = file.split('\\').join('/');
  const i = p.lastIndexOf('/tests/');
  return i >= 0 ? p.slice(i + 1) : p;
}

/** Live progress + paged, virtualised results for a test/evaluation run. Results are read from disk page by page. */
const humanize = (k: string) => k.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** A result's weakest scored check (similarity, judge, RAG…): what to look at first in an evaluation. */
function lowestScore(r: TestResult): number | undefined {
  let low: number | undefined;
  for (const c of r.checks ?? []) if (typeof c.score === 'number' && (low === undefined || c.score < low)) low = c.score;
  return low;
}

export function RunPanel({ runId, expectedTotal, onRerunFailed, focusName }: { runId: string; expectedTotal?: number; onRerunFailed?(runId: string): void; /** A result to select once the run is read (by the test's name): the flow diagram's node, a preview row. */ focusName?: string }) {
  const [progress, setProgress] = useState<Progress>({ completed: 0, passed: 0, failed: 0, skipped: 0, errors: 0, running: 0 });
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [done, setDone] = useState(false);
  const [live, setLive] = useState<TestResult[]>([]);
  const [rows, setRows] = useState<TestResult[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState('all');
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState<TestResult>();
  const [reviewed, setReviewed] = useState(0);
  const onReviewed = (r: TestResult) => {
    setSel(r);
    setRows((xs) => xs.map((x) => (x.id === r.id && x.attempts === r.attempts ? r : x)));
    setReviewed((n) => n + 1);
  };
  const [rated, setRated] = useState<{ good: number; bad: number; unreviewed: number }>();
  useEffect(() => {
    if (done && summary) void call<{ good: number; bad: number; unreviewed: number }>('runs.reviewCounts', { runId, total: summary.total }).then(setRated, () => undefined);
  }, [done, summary, runId, reviewed]);
  const [baselineOpen, setBaselineOpen] = useState(false);
  // results list or the run's charts (once it finished); remembered
  const [pane, pickPane] = usePersisted<'results' | 'charts'>('aps.runPane', 'results', { text: true, parse: (v) => (v === 'charts' ? 'charts' : 'results') });
  const loadingPage = useRef(false);

  useEffect(() => {
    setProgress({ completed: 0, passed: 0, failed: 0, skipped: 0, errors: 0, running: 0 });
    setLive([]);
    setRows([]);
    setSummary(null);
    setDone(false);
    setSel(undefined);
    void call<RunSummary | null>('runs.summary', { runId }).then((s) => {
      if (s) {
        setSummary(s);
        setDone(true);
      }
    });
    const a = on<Array<{ type: string; runId: string; result?: TestResult; completed?: number; passed?: number; failed?: number; skipped?: number; errors?: number; running?: number; summary?: RunSummary }>>('run.events', (evs) => {
      const mine = evs.filter((e) => e.runId === runId);
      if (!mine.length) return;
      const results = mine.filter((e) => e.type === 'test-end').map((e) => e.result!);
      if (results.length) setLive((l) => [...l, ...results].slice(-2000));
      const p = [...mine].reverse().find((e) => e.type === 'progress');
      if (p) setProgress({ completed: p.completed!, passed: p.passed!, failed: p.failed!, skipped: p.skipped!, errors: p.errors!, running: p.running! });
      const end = mine.find((e) => e.type === 'run-end');
      if (end) setSummary(end.summary!);
    });
    const b = on<{ runId: string }>('run.finished', (p) => p.runId === runId && setDone(true));
    return () => {
      a();
      b();
    };
  }, [runId]);

  const loadPage = useCallback(
    async (reset: boolean) => {
      if (loadingPage.current) return;
      loadingPage.current = true;
      try {
        const offset = reset ? 0 : rows.length;
        const r = await call<{ items: TestResult[]; total: number }>('runs.results', { runId, offset, limit: PAGE, status, query: query || undefined });
        setRows((x) => (reset ? r.items : [...x, ...r.items]));
        setTotal(r.total);
      } finally {
        loadingPage.current = false;
      }
    },
    [runId, rows.length, status, query],
  );
  useEffect(() => {
    if (done) void loadPage(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done, status, query]);
  const autoPicked = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!done || !summary || autoPicked.current === runId) return;
    autoPicked.current = runId;
    const failed = summary.failed + summary.errors > 0;
    if (failed || summary.total === 1)
      void call<{ items: TestResult[] }>('runs.results', { runId, offset: 0, limit: 1, ...(failed ? { status: 'failed' } : {}) }).then((r) => r.items[0] && setSel((cur) => cur ?? r.items[0]), () => undefined);
  }, [done, summary, runId]);

  // a result asked for from outside (the Flow tab's node) is selected once the run is readable
  useEffect(() => {
    if (!done || !focusName) return;
    void call<{ items: TestResult[] }>('runs.results', { runId, offset: 0, limit: 50, query: focusName }).then((r) => {
      const hit = r.items.find((x) => x.name === focusName) ?? r.items[0];
      if (hit) setSel(hit);
    }, () => undefined);
  }, [done, focusName, runId]);

  const liveList = useMemo(() => {
    const q = query.toLowerCase();
    return live.filter((r) => (status === 'all' || (status === 'failed' ? r.status === 'failed' || r.status === 'error' : r.status === status)) && (!q || r.name.toLowerCase().includes(q)));
  }, [live, status, query]);
  const list = done ? rows : liveList;
  // ↑ ↓ (or J K) move through the results, so a run can be reviewed from the keyboard
  const onListKey = (e: React.KeyboardEvent) => {
    const step = e.key === 'ArrowDown' || e.key === 'j' ? 1 : e.key === 'ArrowUp' || e.key === 'k' ? -1 : 0;
    if (!step || !list.length || (e.target as HTMLElement).tagName === 'INPUT') return;
    e.preventDefault();
    const at = sel ? list.findIndex((r) => r.id === sel.id && r.attempts === sel.attempts) : -1;
    const next = list[Math.max(0, Math.min(list.length - 1, at + step))];
    if (next) {
      setSel(next);
      (e.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-result="${CSS.escape(`${next.id}:${next.attempts ?? ''}`)}"]`)?.focus();
    }
  };
  const counts = { passed: summary?.passed ?? progress.passed, failed: (summary?.failed ?? progress.failed) + (summary?.errors ?? progress.errors), skipped: summary?.skipped ?? progress.skipped };
  const s = summary;
  const completed = s?.total ?? progress.completed;
  const pct = expectedTotal ? Math.min(100, (completed / expectedTotal) * 100) : undefined;

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-3 px-3 py-2 border-b border-line flex-wrap">
        {!done ? (
          <>
            <Activity size={15} className="text-accent" />
            <span className="text-sm font-medium">Running…</span>
            <Button size="sm" variant="danger" icon={<Square size={11} />} onClick={() => void call('runs.cancel', { runId }).catch(toastError)}>
              Cancel
            </Button>
          </>
        ) : (
          <Badge tone={s && s.failed + s.errors === 0 && !s.cancelled ? 'ok' : 'bad'}>{s?.cancelled ? 'cancelled' : s && s.failed + s.errors === 0 ? 'passed' : 'failed'}</Badge>
        )}
        <span className="flex items-center gap-1.5 flex-wrap text-sm tabular-nums">
          <Badge tone="ok">{s?.passed ?? progress.passed} passed</Badge>
          {(s?.failed ?? progress.failed) > 0 && <Badge tone="bad">{s?.failed ?? progress.failed} failed</Badge>}
          {(s?.errors ?? progress.errors) > 0 && <Badge tone="bad">{s?.errors ?? progress.errors} errors</Badge>}
          {(s?.skipped ?? progress.skipped) > 0 && <Badge tone="warn">{s?.skipped ?? progress.skipped} skipped</Badge>}
          {!done && progress.running > 0 && <span className="text-muted text-xs">{progress.running} running</span>}
        </span>
        {done && (
          <div className="ml-auto flex flex-wrap gap-1">
            {onRerunFailed && s && s.failed + s.errors > 0 && (
              <Button size="sm" icon={<RotateCcw size={12} />} title="Run only the tests that failed or errored" onClick={() => onRerunFailed(runId)}>
                Re-run failed
              </Button>
            )}
            <Button size="sm" icon={<FileBarChart size={12} />} onClick={() =>
              call<{ path: string; view?: { content: string; encoding: 'base64'; type: string } }>('runs.openReport', { runId, format: 'html' })
                .then((r) => r.view && viewContent(r.view))
                .catch((e) => toastError(e))
            }>
              HTML report
            </Button>
            <ExportMenu runId={runId} />
            <Button size="sm" icon={<ScanSearch size={12} />} title="Which OpenAPI operations and responses this run exercised" onClick={() => useApp.getState().set({ apiCoverage: { runId } })}>
              API coverage
            </Button>
            <Button size="sm" icon={<GitCompare size={12} />} onClick={() => setBaselineOpen(true)}>
              Baselines
            </Button>
          </div>
        )}
      </div>
      {!done && (
        <div className="h-1 bg-panel2 relative overflow-hidden">
          {pct !== undefined ? <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} /> : <div className="absolute inset-0 indeterminate" />}
        </div>
      )}
      {s && (
        <MetricGrid compact className="p-2 border-b border-line max-h-[35%] overflow-auto">
          <Metric label="Duration" value={formatMs(s.durationMs)} />
          <Metric label="Latency p50 / p95" value={`${formatMs(s.latency.p50)} / ${formatMs(s.latency.p95)}`} sub={`p99 ${formatMs(s.latency.p99)}`} />
          {s.tokens.totalTokens > 0 && <Metric label="Tokens" value={s.tokens.totalTokens.toLocaleString()} sub={`${s.tokens.inputTokens} in / ${s.tokens.outputTokens} out`} />}
          {s.costUsd > 0 && <Metric label="Est. cost" value={formatCost(s.costUsd)} />}
          {Object.entries(s.scores).map(([k, v]) => (
            <Metric key={k} label={humanize(k)} value={v.mean.toFixed(3)} sub={`score · ${plural(v.count, 'check')}`} tone={v.mean >= 0.7 ? 'ok' : 'warn'} />
          ))}
        </MetricGrid>
      )}
      {done && (
        <Tabs
          className="min-h-9 [&>button]:h-9"
          tabs={[
            { id: 'results', label: 'Results', badge: total || undefined },
            { id: 'charts', label: 'Charts' },
          ]}
          value={pane}
          onChange={pickPane}
        />
      )}
      {done && pane === 'charts' ? (
        <div className="flex-1 min-h-0">
          <RunCharts
            runId={runId}
            onPick={(name) => {
              setQuery(name);
              pickPane('results');
            }}
          />
        </div>
      ) : (
        <div className="flex-1 min-h-0">
          <Split id="run-results" initial={48}>
            <div className="h-full flex flex-col">
              <div className="flex items-center gap-2 p-2 border-b border-line">
                <Segmented
                  label="Status filter"
                  size="xs"
                  value={status}
                  onChange={setStatus}
                  options={[
                    { value: 'all', label: 'All' },
                    { value: 'failed', label: `Failed ${counts.failed}`, title: 'Failed and errored' },
                    { value: 'passed', label: `Passed ${counts.passed}` },
                    ...(counts.skipped ? [{ value: 'skipped', label: `Skipped ${counts.skipped}` }] : []),
                    ...(done ? [{ value: 'unreviewed', label: `To review ${rated?.unreviewed ?? ''}`.trim(), title: 'Not rated good or bad yet (👍 / 👎 on a result)' }] : []),
                  ]}
                />
                <Input className="flex-1 h-7 min-h-7 text-sm" placeholder="Filter by name" value={query} onChange={(e) => setQuery(e.target.value)} />
                <span className="text-xs text-muted tabular-nums">{done ? `${rows.length}/${total}` : `${live.length} shown`}</span>
              </div>
              {list.length ? (
                <div className="flex-1 min-h-0 flex flex-col" onKeyDown={onListKey}>
                <VirtualList
                  className="flex-1"
                  items={list}
                  rowHeight={30}
                  onEndReached={done && rows.length < total ? () => void loadPage(false) : undefined}
                  render={(r) => {
                    const low = lowestScore(r);
                    return (
                    <button
                      title={r.name}
                      data-result={`${r.id}:${r.attempts ?? ''}`}
                      onClick={() => setSel(r)}
                      className={cx('w-full h-full flex items-center gap-2 px-3 border-b border-line/50 text-sm text-left hover:bg-hover', sel?.id === r.id && sel.attempts === r.attempts && 'bg-accent/10')}
                    >
                      <StatusIcon status={r.status} />
                      <span className="truncate flex-1 min-w-0">{r.name}</span>
                      {r.review?.rating === 'good' && <ThumbsUp size={12} className="text-ok shrink-0" aria-label="Rated good" />}
                      {r.review?.rating === 'bad' && <ThumbsDown size={12} className="text-bad shrink-0" aria-label="Rated bad" />}
                      {low !== undefined && (
                        <span title="The lowest check score" className={cx('text-xs tabular-nums shrink-0', low >= 0.7 ? 'text-ok' : 'text-warn')}>
                          {low.toFixed(2)}
                        </span>
                      )}
                      <span className="text-[0.7rem] text-muted uppercase tracking-wide shrink-0">{r.type}</span>
                      <span className="text-xs text-muted tabular-nums w-14 text-right shrink-0">{formatMs(r.latencyMs ?? r.durationMs)}</span>
                    </button>
                    );
                  }}
                />
                </div>
              ) : (
                <Empty title={done ? 'No results match' : 'Waiting for results…'} />
              )}
            </div>
            <div className="h-full min-h-0">{sel ? <ResultDetail r={sel} runId={runId} onReviewed={onReviewed} /> : <Empty icon={<Target size={24} />} title="Select a result to inspect checks, output and trace" />}</div>
          </Split>
        </div>
      )}
      {baselineOpen && <BaselineModal runId={runId} onClose={() => setBaselineOpen(false)} />}
    </div>
  );
}

function ExportMenu({ runId }: { runId: string }) {
  const exp = (format: 'html' | 'json' | 'junit' | 'markdown') => void call<SaveResult>('runs.exportReport', { runId, format }).then((r) => finishSave(r, 'Report'), toastError);
  return (
    <Menu
      width={210}
      items={[
        { label: 'HTML report', icon: <FileBarChart size={14} />, onSelect: () => exp('html') },
        { label: 'JSON results', icon: <Braces size={14} />, onSelect: () => exp('json') },
        { label: 'JUnit XML (CI)', icon: <FileCode2 size={14} />, onSelect: () => exp('junit') },
        { label: 'Markdown summary', icon: <FileText size={14} />, onSelect: () => exp('markdown') },
      ]}
      trigger={
        <Button size="sm" icon={<Download size={12} />}>
          Export
        </Button>
      }
    />
  );
}

/**
 * A person's verdict: 👍 / 👎 (a second click clears it) and a note. The checks measure; the reviewer decides. A bad
 * rating on a passing result says the checks missed something, a good one on a failure that a check is too strict.
 */
function ReviewButtons({ r, runId, onReviewed }: { r: TestResult; runId: string; onReviewed(r: TestResult): void }) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState(r.review?.note ?? '');
  useEffect(() => setNote(r.review?.note ?? ''), [r]);
  const save = (change: { rating?: 'good' | 'bad' | null; note?: string | null }) =>
    call<TestResult['review'] | null>('runs.review', { runId, resultId: r.id, ...change })
      .then((review) => onReviewed({ ...r, review: review ?? undefined }))
      .catch((e) => toastError(e));
  const rate = (rating: 'good' | 'bad') => void save({ rating: r.review?.rating === rating ? null : rating });
  return (
    <div className="flex items-center gap-0.5 shrink-0">
      <Button size="sm" variant="ghost" aria-pressed={r.review?.rating === 'good'} title="Good result (press again to clear)" className={cx(r.review?.rating === 'good' && 'text-ok bg-ok/10')} icon={<ThumbsUp size={13} />} onClick={() => rate('good')} />
      <Button size="sm" variant="ghost" aria-pressed={r.review?.rating === 'bad'} title="Bad result (press again to clear)" className={cx(r.review?.rating === 'bad' && 'text-bad bg-bad/10')} icon={<ThumbsDown size={13} />} onClick={() => rate('bad')} />
      <Button size="sm" variant="ghost" title="Add a note: why it is good or bad" onClick={() => setNoteOpen(true)}>
        Note
      </Button>
      {noteOpen && (
        <Modal
          title={`Review: ${r.name}`}
          onClose={() => setNoteOpen(false)}
          width={480}
          footer={
            <>
              <Button onClick={() => setNoteOpen(false)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={() => {
                  setNoteOpen(false);
                  void save({ note: note.trim() || null });
                }}
              >
                Save note
              </Button>
            </>
          }
        >
          <Textarea aria-label="Review note" className="field min-h-28 w-full text-sm" value={note} placeholder="Why it is good or bad (people and agents read it)" onChange={(e) => setNote(e.target.value)} autoFocus />
        </Modal>
      )}
    </div>
  );
}

export function ResultDetail({ r, runId, onReviewed }: { r: TestResult; runId?: string; onReviewed?(r: TestResult): void }) {
  const [tab, setTab] = useState<'checks' | 'io' | 'trace' | 'history' | 'meta'>('checks');
  const [trace, setTrace] = useState<Trace | null>();
  useEffect(() => {
    setTrace(undefined);
    setTab('checks');
  }, [r]);
  useEffect(() => {
    if (tab === 'trace' && r.traceId && trace === undefined) void call<Trace | null>('traces.get', { id: r.traceId }).then((t) => setTrace(t ?? null));
  }, [tab, r.traceId, trace]);
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="px-3 py-2 border-b border-line">
        <div className="flex items-center gap-2">
          <StatusIcon status={r.status} />
          <span className="font-medium flex-1 min-w-0 truncate">{r.name}</span>
          {runId && onReviewed && <ReviewButtons r={r} runId={runId} onReviewed={onReviewed} />}
        </div>
        {r.review?.note && (
          <div className="text-xs mt-1 border-l-2 border-line pl-2">
            <span className="text-muted">Review{r.review.by === 'agent' ? ' (by an agent)' : ''}: </span>
            {r.review.note}
          </div>
        )}
        <div className="text-xs text-muted mt-0.5 flex gap-3 flex-wrap">
          <span>{r.type}</span>
          {r.model && <span>{r.model}</span>}
          <span>{formatMs(r.durationMs)}</span>
          {r.tokens && <span>{r.tokens.totalTokens} tokens</span>}
          {r.costUsd !== undefined && <span>{formatCost(r.costUsd)}</span>}
          {r.attempts > 1 && <span>{r.attempts} attempts</span>}
          {r.file && <span className="mono truncate" title={r.file}>{displayPath(r.file)}</span>}
        </div>
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'checks', label: 'Checks', badge: r.checks.length },
          { id: 'io', label: 'Input / output' },
          { id: 'trace', label: 'Trace' },
          ...(runId ? [{ id: 'history' as const, label: 'History' }] : []),
          { id: 'meta', label: 'Metadata' },
        ]}
      />
      <div className="flex-1 min-h-0 overflow-auto">
        {tab === 'checks' && (
          <>
            {r.error && <ErrorPanel error={r.error} raw={false} context={{ test: r.name, input: r.input }} />}
            {r.status === 'skipped' && <div className="p-3 text-sm text-warn">Skipped: {String(r.metadata?.reason ?? '')}</div>}
            {r.status === 'failed' && (
              <div className="px-3 pt-3">
                <Button
                  size="sm"
                  icon={<Sparkles size={12} />}
                  title="Ask the AI assistant why the checks failed and what to change (the test or the API)"
                  onClick={() =>
                    useApp.getState().set({
                      assistant: {
                        task: 'explain-test-failure',
                        title: `Why "${r.name}" failed`,
                        context: {
                          test: r.name,
                          type: r.type,
                          failedChecks: r.checks.filter((c) => !c.passed).map((c) => ({ name: c.name, type: c.type, message: c.message, expected: c.expected, actual: c.actual })),
                          passedChecks: r.checks.filter((c) => c.passed).map((c) => c.name),
                          input: String(r.input ?? '').slice(0, 4000),
                          output: String(r.output ?? '').slice(0, 8000),
                        },
                      },
                    })
                  }
                >
                  Explain with AI
                </Button>
              </div>
            )}
            <CheckList checks={r.checks} />
          </>
        )}
        {tab === 'io' && (
          <div className="p-3 flex flex-col gap-3 text-sm">
            <div>
              <div className="text-xs text-muted font-semibold mb-1">Input</div>
              <CodeBlock className="mono text-xs whitespace-pre-wrap bg-panel p-2 rounded" text={r.input ?? '—'} />
            </div>
            <div>
              <div className="text-xs text-muted font-semibold mb-1">Output</div>
              <CodeBlock className="mono text-xs whitespace-pre-wrap bg-panel p-2 rounded" text={r.output ?? '—'} />
            </div>
          </div>
        )}
        {tab === 'trace' && (trace ? <TraceView trace={trace} /> : trace === null ? <Empty title="No trace stored for this result" /> : <Empty title="Loading…" />)}
        {tab === 'history' && runId && <TestHistory id={r.id} name={r.name} runId={runId} />}
        {tab === 'meta' && <CodeBlock className="p-3 mono text-xs whitespace-pre-wrap" language={'json'} text={JSON.stringify(r.metadata ?? {}, null, 2)} />}
      </div>
    </div>
  );
}

interface RegressionReport {
  baseline: string;
  regressions: Array<{ id: string; kind: string; message: string }>;
  improvements: Array<{ id: string; kind: string; message: string }>;
  summary: Array<{ metric: string; baseline: number; current: number; delta: number; deltaPct: number; regressed: boolean }>;
  passed: boolean;
}

function BaselineModal({ runId, onClose }: { runId: string; onClose(): void }) {
  const [baselines, setBaselines] = useState<Array<{ name: string; createdAt: string; tests: number }>>([]);
  const [name, setName] = useState('');
  const [compareWith, setCompareWith] = useState('');
  const [th, setTh] = useState({ latencyPct: 25, tokensPct: 20, scoreDrop: 0.05 });
  const [report, setReport] = useState<RegressionReport>();
  // earlier runs can be compared too (value "run:<id>"): what changed since then
  const [earlier, setEarlier] = useState<Array<{ id: string; name: string; startedAt: string }>>([]);
  const load = () =>
    Promise.all([call<Array<{ name: string; createdAt: string; tests: number }>>('baselines.list'), call<{ items: Array<{ id: string; name: string; startedAt: string }> }>('runs.list', { limit: 30 })]).then(([b, r]) => {
      const runs = r.items.filter((x) => x.id !== runId);
      setBaselines(b);
      setEarlier(runs);
      setCompareWith((c) => c || b[0]?.name || (runs[0] ? `run:${runs[0].id}` : ''));
    });
  useEffect(() => {
    void load();
  }, []);
  return (
    <Modal title="Baselines & regression" onClose={onClose} width={760}>
      <div className="flex flex-col gap-4 text-sm">
        <div className="flex items-end gap-2">
          <Field label="Save this run as baseline" className="flex-1">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. main-2026-09" />
          </Field>
          <Button disabled={!name} onClick={() => void call('baselines.save', { runId, name }).then(() => (useApp.getState().toast('Baseline saved', 'success'), void load()), toastError)}>
            Save baseline
          </Button>
        </div>
        <div className="flex items-end gap-2 flex-wrap">
          <Field label="Compare with">
            <Select value={compareWith} onChange={(e) => setCompareWith(e.target.value)}>
              {baselines.length > 0 && (
                <optgroup label="Baselines">
                  {baselines.map((b) => (
                    <option key={b.name} value={b.name}>
                      {b.name} ({plural(b.tests, 'test')})
                    </option>
                  ))}
                </optgroup>
              )}
              {earlier.length > 0 && (
                <optgroup label="Earlier runs">
                  {earlier.map((r) => (
                    <option key={r.id} value={`run:${r.id}`}>
                      {r.name} · {timeAgo(r.startedAt)}
                    </option>
                  ))}
                </optgroup>
              )}
            </Select>
          </Field>
          <Field label="Latency +%">
            <Input className="w-20" type="number" value={th.latencyPct} onChange={(e) => setTh({ ...th, latencyPct: Number(e.target.value) })} />
          </Field>
          <Field label="Tokens +%">
            <Input className="w-20" type="number" value={th.tokensPct} onChange={(e) => setTh({ ...th, tokensPct: Number(e.target.value) })} />
          </Field>
          <Field label="Score drop">
            <Input className="w-20" type="number" step="0.01" value={th.scoreDrop} onChange={(e) => setTh({ ...th, scoreDrop: Number(e.target.value) })} />
          </Field>
          <Button variant="primary" disabled={!compareWith} onClick={() => call<RegressionReport>('baselines.compare', compareWith.startsWith('run:') ? { runId, withRun: compareWith.slice(4), thresholds: th } : { runId, name: compareWith, thresholds: th }).then(setReport)}>
            Compare
          </Button>
        </div>
        {report && (
          <div>
            <Badge tone={report.passed ? 'ok' : 'bad'}>{report.passed ? 'No regressions beyond thresholds' : `${report.regressions.length + report.summary.filter((m) => m.regressed).length} regression(s)`}</Badge>
            <table className="w-full mt-2 text-sm">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="py-1">Metric</th>
                  <th>Baseline</th>
                  <th>Current</th>
                  <th>Δ</th>
                </tr>
              </thead>
              <tbody>
                {report.summary.map((m) => (
                  <tr key={m.metric} className={cx('border-t border-line', m.regressed && 'text-bad')}>
                    <td className="py-1">{m.metric}</td>
                    <td className="tabular-nums">{m.baseline}</td>
                    <td className="tabular-nums">{m.current}</td>
                    <td className="tabular-nums">
                      {m.delta > 0 ? '+' : ''}
                      {m.delta} ({m.deltaPct}%)
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-3 max-h-60 overflow-auto">
              {report.regressions.map((r, i) => (
                <div key={i} className="text-bad text-xs">
                  ✗ {r.id}: {r.message}
                </div>
              ))}
              {report.improvements.map((r, i) => (
                <div key={i} className="text-ok text-xs">
                  ✓ {r.id}: {r.message}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
