import { ClipboardCheck, Cloud, GitCompareArrows, ListTree, Pin, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { EvalCaseDiff, EvalReport, EvalReportFailure, EvalReportFlip, EvalWhy, TrajectoryWithBaseline } from '@testpion/core';
import { call, on } from '../../api';
import { formatCost, formatMs } from '../../lib/format';
import { useRpc } from '../../lib/use-rpc';
import { LABEL } from '../../lib/vocabulary';
import { toastError, useApp } from '../../store';
import { CompareView, type Compared } from '../ResponseHistory';
import { Badge, Button, cx, LinkButton, Spinner } from '../ui';
import { FilterChips } from '../FilterChips';
import { StepTimeline } from '../StepTimeline';
import { ReviewQueue } from './ReviewQueue';
import { AiAction } from './AiAction';

/** The sentence a run is reduced to: "17 of 20 passed" (the same words the CLI and the MCP tools say). */
export function runHeadline(s: { passed: number; total: number }): string {
  return `${s.passed} of ${s.total} passed`;
}

/** The pass rates of the last runs as a small line, oldest left; the last point is this run. */
function PassTrend({ trend }: { trend: EvalReport['trend'] }) {
  if (trend.length < 2) return null;
  const w = 84;
  const h = 22;
  const pts = trend.map((t, i) => [(i / (trend.length - 1)) * (w - 4) + 2, h - 3 - t.passRate * (h - 6)] as const);
  const last = trend[trend.length - 1]!;
  const label = `Pass rate of the last ${trend.length} runs: ${trend.map((t) => `${Math.round(t.passRate * 100)}%`).join(', ')}`;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted" title={label} data-eval-trend>
      <svg width={w} height={h} role="img" aria-label={label}>
        <polyline points={pts.map((p) => p.join(',')).join(' ')} fill="none" stroke="var(--accent)" strokeWidth={1.5} strokeLinejoin="round" />
        <circle cx={pts[pts.length - 1]![0]} cy={pts[pts.length - 1]![1]} r={2.5} fill={last.passRate >= trend[trend.length - 2]!.passRate ? 'var(--ok)' : 'var(--bad)'} />
      </svg>
      Trend
    </span>
  );
}

/** A case against the same case in the run before: both answers, and the difference (the response view's own comparison). */
function CaseDiffPanel({ runId, caseKey }: { runId: string; caseKey: string }) {
  const d = useRpc<EvalCaseDiff>('eval.caseDiff', { run: runId, case: caseKey });
  if (!d) return <Spinner />;
  const c: Compared | undefined =
    d.before && d.diff
      ? {
          before: { id: d.against!.id, timestamp: d.against!.startedAt, status: d.before.status },
          after: { id: d.run.id, timestamp: d.run.startedAt, status: d.now.status },
          diff: d.diff,
          bodyMissing: false,
        }
      : undefined;
  return (
    <div className="rounded-lg border border-line mt-1.5" data-eval-case-diff data-same={d.same ? 'true' : 'false'} data-change={d.change ?? ''}>
      <p className="px-3 py-1.5 text-xs border-b border-line">{d.text}</p>
      {d.retrieved && (
        <div className="px-3 py-1.5 text-xs border-b border-line flex flex-wrap items-center gap-1.5" data-eval-retrieved>
          <span className="text-muted">Retrieved documents</span>
          {d.retrieved.dropped.map((id) => (
            <Badge key={`-${id}`} tone="bad" title="Retrieved in the earlier run, not now">
              − {id}
            </Badge>
          ))}
          {d.retrieved.added.map((id) => (
            <Badge key={`+${id}`} tone="ok" title="Retrieved now, not in the earlier run">
              + {id}
            </Badge>
          ))}
          {!d.retrieved.added.length && !d.retrieved.dropped.length && <span className="text-muted">the same ones</span>}
          {d.retrieved.right && (
            <span className={d.retrieved.right.foundNow < d.retrieved.right.foundBefore ? 'text-bad' : 'text-muted'}>
              · right documents found {d.retrieved.right.foundBefore} of {d.retrieved.right.ids.length} → {d.retrieved.right.foundNow} of {d.retrieved.right.ids.length}
            </span>
          )}
          {d.retrieved.causeNow && <span className="text-muted">· now: {d.retrieved.causeNow}</span>}
        </div>
      )}
      {c && (
        <div className="max-h-72 overflow-auto">
          <CompareView c={c} labels={['The last run', 'This run']} />
        </div>
      )}
    </div>
  );
}

/** What the agent did in a case, step by step, with its tool checks pinned to the step that decided them (A-1). */
function TrajectoryPanel({ runId, caseKey }: { runId: string; caseKey: string }) {
  const t = useRpc<TrajectoryWithBaseline>('eval.trajectory', { run: runId, case: caseKey });
  if (!t) return <Spinner />;
  return (
    <div className="rounded-lg border border-line mt-1.5" data-eval-trajectory>
      <p className="px-3 py-1.5 text-xs border-b border-line">{t.text}</p>
      {t.vsBaseline && (
        <p className={cx('px-3 py-1.5 text-xs border-b border-line', t.vsBaseline.kind === 'same' ? 'text-ok' : 'text-warn')} data-eval-vs-baseline={t.vsBaseline.kind}>
          Against the baseline: {t.vsBaseline.text}
        </p>
      )}
      <div className="max-h-96 overflow-auto">
        <StepTimeline items={t.items} endPins={t.endPins} label={`What the agent did in ${caseKey}`} />
      </div>
    </div>
  );
}

/** "Why did this fail?" for a case an AI reviewer did not grade: the AI task, with what is sent and what it costs shown first. */
function WhyAi({ runId, f }: { runId: string; f: EvalReportFailure }) {
  return (
    <span data-eval-why-ai={f.key}>
      <AiAction
        label="Why did this fail?"
        hint="The AI reads the prompt, the reply, the expected answer and what each check said, and tells you what went wrong and what to change first. It proposes nothing."
        request={async () => {
          const w = await call<EvalWhy>('eval.why', { run: runId, case: f.resultId });
          return { task: 'eval-why', title: `Why “${f.key}” failed`, context: w.context };
        }}
      />
    </span>
  );
}

function FailureRow({ runId, f, hasPrevious }: { runId: string; f: EvalReportFailure; hasPrevious: boolean }) {
  const [open, setOpen] = useState<'why' | 'diff' | 'steps' | undefined>();
  const snippet = (s?: string, n = 90) => (s ? s.replace(/\s+/g, ' ').slice(0, n) : '');
  // the case is the end of the prompt (where its values were filled in): the last line says it better than the instructions above
  const lastLine = (s?: string) => (s ? (s.trim().split(/\r?\n/).filter((l) => l.trim()).pop() ?? s) : undefined);
  return (
    <li className="px-3 py-1.5 border-b border-line/60 last:border-b-0" data-eval-failure={f.key}>
      <div className="flex items-start gap-2 text-xs">
        <X size={13} className="mt-0.5 text-bad shrink-0" aria-label={f.status} />
        <span className="mono shrink-0 pt-px">{f.key}</span>
        <div className="min-w-0 flex-1">
          {f.input && <div className="truncate text-muted" title={f.input} data-eval-failure-input>{snippet(lastLine(f.input), 140)}</div>}
          <div className="truncate">
            {f.expected !== undefined && (
              <>
                Expected <b className="font-medium">{snippet(f.expected, 60)}</b> ·{' '}
              </>
            )}
            {f.error ? <span className="text-bad">{snippet(f.error, 100)}</span> : <>Got <b className="font-medium">{snippet(f.got, 70) || 'nothing'}</b></>}
          </div>
          <div className="text-muted truncate">{f.failedChecks.map((c) => c.name).join(', ')}</div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {f.reason ? (
            <Button size="sm" onClick={() => setOpen(open === 'why' ? undefined : 'why')} title="The AI reviewer’s own reason, kept with the run: no model is called" data-eval-why-stored={f.key}>
              Why did this fail?
            </Button>
          ) : (
            <WhyAi runId={runId} f={f} />
          )}
          {f.agent && (
            <Button size="sm" icon={<ListTree size={12} />} onClick={() => setOpen(open === 'steps' ? undefined : 'steps')} title="What the agent did, step by step, and which tool check each step satisfied or broke" data-eval-trajectory-open={f.key}>
              Show the steps
            </Button>
          )}
          <Button
            size="sm"
            icon={<GitCompareArrows size={12} />}
            disabled={!hasPrevious}
            reason="There is no earlier run of this evaluation to compare with. Run it again to see what changed."
            onClick={() => setOpen(open === 'diff' ? undefined : 'diff')}
            title="This answer against the same case in the run before"
            data-eval-diff-open={f.key}
          >
            Since last run
          </Button>
        </div>
      </div>
      {open === 'why' && f.reason && (
        <div className="mt-1.5 rounded-md bg-judge/10 border border-judge/25 px-3 py-1.5 text-xs" data-eval-why-text>
          <div className="text-muted mb-0.5">AI reviewer’s reason (the model’s opinion, kept with the run)</div>
          {f.reason}
        </div>
      )}
      {open === 'diff' && hasPrevious && <CaseDiffPanel runId={runId} caseKey={f.key} />}
      {open === 'steps' && <TrajectoryPanel runId={runId} caseKey={f.key} />}
    </li>
  );
}

/** One case whose verdict changed since the last run (A-3): what it was, what it is, and the answers side by side on a click. */
function FlipRow({ runId, f }: { runId: string; f: EvalReportFlip }) {
  const [open, setOpen] = useState(false);
  const worse = f.to === 'failed';
  return (
    <li className="px-3 py-1.5 border-b border-line/60 text-sm" data-eval-flip={worse ? 'worse' : 'better'}>
      <div className="flex items-center gap-2">
        <Badge tone={worse ? 'bad' : 'ok'}>{worse ? 'got worse' : 'got better'}</Badge>
        <span className="truncate min-w-0 flex-1" title={f.key}>
          {f.name}
        </span>
        <Button size="sm" icon={<GitCompareArrows size={12} />} onClick={() => setOpen(!open)} title="This answer against the same case in the run before" data-eval-flip-open={f.key}>
          {open ? 'Hide' : 'What changed'}
        </Button>
      </div>
      {open && <CaseDiffPanel runId={runId} caseKey={f.key} />}
    </li>
  );
}

/**
 * The report card of a run, one component (AU-14): the sentence "17 of 20 passed" with cost and time, how it compares with the
 * last run and the trend, the pass line, how many cases passed each check, and the failed cases first, each with "Why did this
 * fail?" and "Since last run" (AU-15, AU-22). The words come from core (`eval.summary`), the same as `testpion eval summary`
 * and the `eval_summary` tool. `compact` is the sentence line alone (a place that shows the run's table itself).
 */
export function RunReport({ runId, offline, compact, onCi, ciReason }: { runId: string; offline?: boolean; compact?: boolean; onCi?(): void; /** Why Run in CI is not available yet. */ ciReason?: string }) {
  const r = useRpc<EvalReport>('eval.summary', { run: runId }, {
    // the pass line is read from the saved evaluation: a save of the evaluations (written to disk) reads the report again
    reloadOn: compact ? ['run.finished'] : ['run.finished', 'data.changed'],
    reloadIf: (e: { paths?: string[] } | undefined) => !e?.paths || e.paths.some((p) => p.split('\\').join('/') === 'library/evaluations.json'),
  });
  const [capped, setCapped] = useState<string>();
  const [all, setAll] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  /** The causes of failure the list is narrowed to (R-3); none: every failed case. */
  const [causeFilter, setCauseFilter] = useState<string[]>([]);
  useEffect(() => {
    setCapped(undefined);
    setAll(false);
    setCauseFilter([]);
    return on<{ runId: string; message: string }>('eval.capped', (e) => e.runId === runId && setCapped(e.message));
  }, [runId]);
  const bad = !!r && r.failed + r.errors > 0;
  const failures = r ? (causeFilter.length ? r.failures.filter((f) => f.cause && causeFilter.includes(f.cause)) : r.failures) : [];
  const shown = r && !all ? failures.slice(0, 5) : failures;
  return (
    <div className="border-b border-line" data-run-report data-eval-headline={r ? (bad ? 'failed' : 'passed') : 'running'}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5">
        {r ? (
          <span className={cx('rounded-full px-2.5 py-0.5 text-sm font-semibold ring-1', bad ? 'bg-bad/10 text-bad ring-bad/30' : 'bg-ok/10 text-ok ring-ok/30')} data-eval-headline-text>
            {r.headline}
          </span>
        ) : (
          <span className="text-sm text-muted" data-eval-headline-text>
            Running …
          </span>
        )}
        {r?.goals && (
          <span className="text-xs" data-eval-goals>
            {r.goals.backed && (
              <span className={r.goals.backed.passed === r.goals.backed.total ? 'text-ok' : 'text-bad'} data-eval-goal="backed" title="Cases whose answer is backed by the documents the bot retrieved">
                Backed by the sources: {r.goals.backed.passed} of {r.goals.backed.total}
              </span>
            )}
            {r.goals.backed && r.goals.found && <span className="text-muted"> · </span>}
            {r.goals.found && (
              <span className={r.goals.found.passed === r.goals.found.total ? 'text-ok' : 'text-bad'} data-eval-goal="found" title="Cases where the bot retrieved the documents the question needs">
                Right documents found: {r.goals.found.passed} of {r.goals.found.total}
              </span>
            )}
          </span>
        )}
        {r && (
          <span className="text-xs text-muted">
            {r.costUsd ? `Cost ${formatCost(r.costUsd)}${r.cost?.lastUsd !== undefined ? ` (last run ${formatCost(r.cost.lastUsd)})` : ''}${r.cost && r.cost.monthRuns > 1 ? `, this month ${formatCost(r.cost.monthUsd)} over ${r.cost.monthRuns} runs` : ''} · ` : ''}
            {r.avgMs !== undefined ? `Average ${formatMs(r.avgMs)} · ` : ''}
            {r.slowestMs !== undefined && r.slowestMs > (r.avgMs ?? 0) * 1.5 ? `Slowest ${formatMs(r.slowestMs)} · ` : ''}
            {formatMs(r.durationMs)} in all
          </span>
        )}
        {r?.vsLast && (
          <span className={cx('text-xs', r.vsLast.gotWorse ? 'text-warn' : 'text-muted')} data-eval-vs-last>
            {r.vsLast.text}
          </span>
        )}
        {r && !compact && <PassTrend trend={r.trend} />}
        {offline && (
          <Badge tone="warn" title="These answers came from the offline demo model, which answers by rules. Connect a real model in Models and keys to judge a real one.">
            Offline demo
          </Badge>
        )}
        {capped && (
          <span className="text-xs text-warn" data-eval-capped>
            {capped}
          </span>
        )}
        {r && !compact && r.total > 0 && (
          <Button size="sm" icon={<ClipboardCheck size={12} />} onClick={() => setReviewing(true)} title="Read ten of the answers and grade each good or bad; the failed ones come first. What the checks decided stays hidden until you have graded." data-eval-review-open>
            Review answers
          </Button>
        )}
        {onCi && (
          <Button size="sm" className="ml-auto" icon={<Cloud size={12} />} onClick={onCi} disabled={!!ciReason} reason={ciReason} title="A pipeline that runs this evaluation on every push and fails when a case got worse" data-eval-ci>
            {LABEL.runInCi}
          </Button>
        )}
      </div>
      {reviewing && <ReviewQueue runId={runId} onClose={() => setReviewing(false)} />}
      {r && !compact && r.underTest && r.underTest.length > 0 && (
        <div className="px-3 pb-1.5 flex flex-wrap items-center gap-1.5 text-xs" data-eval-under-test>
          <span className="text-muted">Under test</span>
          {r.underTest.map((u) => (
            <Badge key={u.name} tone={u.changed ? 'warn' : 'default'} title={u.changed ? `Changed since the last run (was ${u.previous?.join(' / ')})` : undefined} data-under-test={u.name}>
              {u.name} {u.values.join(' / ')}
              {u.changed ? ` (was ${u.previous?.join(' / ')})` : ''}
            </Badge>
          ))}
        </div>
      )}
      {r && !compact && r.toolUse ? (
        <div className={cx('px-3 pb-1 text-xs', r.toolUse.neverCalled.length ? 'text-warn' : 'text-muted')} data-eval-tool-use title="The tools the cases called, and the tools the agent offers that no case called: a case that exercises them is missing">
          {r.toolUse.text}
        </div>
      ) : null}
      {r && !compact && r.agentCases ? (
        <div className="px-3 pb-1.5 flex flex-wrap items-center gap-2 text-xs" data-eval-baseline={r.baselineRun === runId ? 'this' : r.baselineRun ? 'other' : 'none'}>
          <Pin size={12} className="text-muted" />
          {r.baselineRun === runId ? (
            <span className="text-muted">This run is the baseline: later runs are compared with the tools it used.</span>
          ) : (
            <>
              {r.agentBaseline ? (
                <span className={r.agentBaseline.changed ? 'text-warn' : 'text-ok'} data-eval-baseline-text>
                  {r.agentBaseline.text}
                </span>
              ) : (
                <span className="text-muted">No baseline yet: mark a run you trust, and later runs show where the agent's tools changed.</span>
              )}
              <Button
                size="sm"
                title="The tools this run used become the reference: later runs say how theirs differ"
                data-eval-baseline-set
                onClick={() => void call('eval.setBaseline', { run: runId }).then(() => useApp.getState().toast('This run is the baseline of the evaluation', 'success'), toastError)}
              >
                {r.baselineRun ? 'Use this run as the baseline' : 'Mark this run as the baseline'}
              </Button>
            </>
          )}
          {r.baselineRun && (
            <LinkButton onClick={() => void call('eval.setBaseline', { run: runId, clear: true, evaluation: r.run.name }).then(() => useApp.getState().toast('Baseline cleared', 'info'), toastError)} data-eval-baseline-clear>
              Clear the baseline
            </LinkButton>
          )}
        </div>
      ) : null}
      {r && !compact && r.agentBaseline && r.agentBaseline.cases.length > 0 && (
        <ul className="px-3 pb-1.5 text-xs text-muted" data-eval-baseline-cases>
          {r.agentBaseline.cases.slice(0, 5).map((c) => (
            <li key={c.resultId} data-eval-baseline-case={c.key}>
              <span className="mono text-fg">{c.key}</span> {c.text}
            </li>
          ))}
        </ul>
      )}
      {r && !compact && r.passLine && (
        <div className="px-3 pb-1.5 flex items-center gap-2 text-xs" data-eval-pass-line={r.passLine.met ? 'met' : 'not-met'}>
          <div className="relative h-1.5 w-44 rounded-full bg-hover overflow-hidden" role="img" aria-label={`${Math.round(r.passRate * 100)}% passed, pass line ${r.passLine.percent}%`}>
            <div className={cx('h-full', r.passLine.met ? 'bg-ok' : 'bg-bad')} style={{ width: `${r.passRate * 100}%` }} />
            <div className="absolute top-0 bottom-0 w-px bg-fg" style={{ left: `${r.passLine.percent}%` }} />
          </div>
          <span className={r.passLine.met ? 'text-ok' : 'text-bad'}>{r.passLine.text}</span>
        </div>
      )}
      {r && !compact && r.byCheck.length > 0 && (
        <div className="px-3 pb-1.5 flex flex-wrap items-center gap-1.5 text-xs" data-eval-by-check>
          <span className="text-muted">By check</span>
          {r.byCheck.map((c) => (
            <Badge key={c.name} tone={c.passed === c.total ? 'ok' : 'bad'} title={c.aiReviewer ? 'Graded by an AI reviewer: the model’s opinion' : undefined}>
              {c.name} {c.passed}/{c.total}
              {c.aiReviewer ? ' · AI reviewer' : ''}
            </Badge>
          ))}
        </div>
      )}
      {r && !compact && r.flipped && r.flipped.length > 0 && (
        <div className="border-t border-line" data-eval-flipped>
          <div className="px-3 py-1 text-xs text-muted">Changed since the last run, the ones that got worse first</div>
          <ul className="max-h-60 overflow-auto">
            {r.flipped.map((f) => (
              <FlipRow key={f.resultId} runId={runId} f={f} />
            ))}
          </ul>
        </div>
      )}
      {r && !compact && r.causes && r.causes.length > 0 && (
        <div className="border-t border-line pt-1.5" data-eval-causes>
          <div className="px-3 pb-1 text-xs text-muted">Why the failed cases failed</div>
          <FilterChips
            label="Cause of failure"
            value={causeFilter}
            onChange={setCauseFilter}
            options={r.causes.map((c) => ({ value: c.id, label: c.plain, count: c.count, title: `Show only the cases that failed because: ${c.plain}` }))}
          />
        </div>
      )}
      {r && !compact && r.failures.length > 0 && (
        <div className="border-t border-line" data-eval-failures>
          <div className="px-3 py-1 text-xs text-muted flex items-center gap-2">
            {causeFilter.length ? `Failed for this reason (${failures.length})` : 'Failed first'}
            {failures.length > 5 && (
              <LinkButton onClick={() => setAll(!all)} data-eval-failures-toggle>
                {all ? 'Show fewer' : `Show all ${failures.length}`}
              </LinkButton>
            )}
          </div>
          <ul className="max-h-72 overflow-auto">
            {shown.map((f) => (
              <FailureRow key={f.resultId} runId={runId} f={f} hasPrevious={!!r.previous} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
