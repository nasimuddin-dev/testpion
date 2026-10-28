import { plural } from '../../lib/format';
import { Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { MetricChange, MetricComparison, MetricMatrix, MetricPivot, RunEstimate } from '@testpion/core';
import type { RagJudgeSetup } from '@testpion/shared';
import { asError, call } from '../../api';
import { toastError } from '../../store';
import type { CheckConfig, ProviderConfig } from '../../types';
import { ChartCard } from '../charts';
import { Badge, Button, Callout, cx, Empty, Field, Input, Modal, NamedOptions, SectionTitle, Select, Spinner, useDebounced } from '../ui';
import { RagEstimateView } from './RagEstimate';
import { RagJudgeOptions } from './RagJudgeOptions';

export interface RunChoice {
  id: string;
  name: string;
  startedAt: string;
}

/** A tint for a mean on 0..1 (green high, red low) that the number beside it never depends on. */
const tint = (v: number | null | undefined, lower?: boolean) => (v === null || v === undefined ? '' : `color-mix(in srgb, var(${(lower ? 1 - v : v) >= 0.7 ? '--ok' : (lower ? 1 - v : v) >= 0.4 ? '--warn' : '--bad'}) 14%, transparent)`);

/* ------------------------------------------------------------------ charts: one histogram per metric, a metric by tag */

/** The distribution of every metric (ten bins over 0..1, pass mark marked) and each metric's mean by tag. */
export function RagCharts({ m }: { m: MetricMatrix }) {
  return (
    <div className="p-3 overflow-auto h-full grid gap-4" data-rag-charts>
      <div>
        <SectionTitle size="sm" className="mb-2">Score distribution per metric</SectionTitle>
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
          {m.columns.map((c) => {
            const a = m.aggregates.find((x) => x.key === c.key);
            if (!a || !a.n) return null;
            const max = Math.max(1, ...a.distribution);
            return (
              <ChartCard key={c.key} title={c.key} aside={a.mean !== undefined ? <span>mean <b>{a.mean}</b></span> : undefined}>
                <div className="flex items-end gap-1 h-24" role="img" aria-label={`${c.key} score distribution, ${a.n} samples`} data-rag-histogram={c.key}>
                  {a.distribution.map((n, i) => (
                    <div key={i} className="flex-1 flex flex-col justify-end items-center h-full" title={`${(i / 10).toFixed(1)}–${((i + 1) / 10).toFixed(1)}: ${plural(n, 'sample')}`}>
                      <div className={cx('w-full rounded-t', c.threshold !== undefined && (c.direction === 'lower' ? (i + 1) / 10 <= c.threshold + 1e-9 : i / 10 >= c.threshold - 1e-9) ? 'bg-ok/70' : 'bg-bad/60')} style={{ height: `${Math.max(n ? 6 : 0, (n / max) * 100)}%` }} />
                    </div>
                  ))}
                </div>
                <div className="flex justify-between text-2xs text-muted mt-0.5">
                  <span>0</span>
                  <span>{a.naCount ? `${a.naCount} n/a` : ''}</span>
                  <span>1</span>
                </div>
              </ChartCard>
            );
          })}
        </div>
      </div>
      <RagByTag m={m} />
    </div>
  );
}

/** The mean of every metric for each tag of the dataset records: where the system is weak (one row per tag). */
export function RagByTag({ m }: { m: MetricMatrix }) {
  if (!m.byTag.length) return <div className="text-xs text-muted" data-rag-bytag-empty>The records have no tags: add a "tags" column to the dataset to see the metrics by kind of question.</div>;
  return (
    <div data-rag-bytag>
      <SectionTitle size="sm" className="mb-2">Mean by tag</SectionTitle>
      <table className="text-xs border-separate border-spacing-0">
        <thead>
          <tr>
            <th className="text-left px-2 py-1 border-b border-line">Tag</th>
            <th className="text-right px-2 py-1 border-b border-line">Samples</th>
            {m.columns.map((c) => (
              <th key={c.key} className="text-right px-2 py-1 border-b border-l border-line whitespace-nowrap font-medium">
                {c.key}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {m.byTag.map((t) => (
            <tr key={t.tag} data-rag-tag-row={t.tag}>
              <td className="px-2 py-1 border-b border-line/60 font-medium">{t.tag}</td>
              <td className="px-2 py-1 border-b border-line/60 text-right tabular-nums text-muted">{t.n}</td>
              {t.means.map((v, i) => (
                <td key={i} className="px-2 py-1 border-b border-l border-line/60 text-right tabular-nums" style={{ background: tint(v, m.columns[i]?.direction === 'lower') }}>
                  {v ?? '–'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ compare two runs (paired bootstrap) */

const CHANGE_TONE: Record<MetricChange['change'], 'ok' | 'bad' | 'default' | 'accent'> = { improved: 'ok', regressed: 'bad', unchanged: 'default', new: 'accent', missing: 'default' };

/** This run against another, metric by metric: the means, the change, and whether a paired bootstrap says it is real. */
export function RagCompare({ runId, runs }: { runId: string; runs: RunChoice[] }) {
  const others = runs.filter((r) => r.id !== runId);
  const [base, setBase] = useState(others[0]?.id ?? '');
  const [minDelta, setMinDelta] = useState(0.05);
  const [cmp, setCmp] = useState<MetricComparison>();
  const [error, setError] = useState<string>();
  const delta = useDebounced(minDelta, 300);
  useEffect(() => {
    if (!base) return setCmp(undefined);
    let live = true;
    setCmp(undefined);
    setError(undefined);
    void call<MetricComparison>('rag.compare', { runId, baselineId: base, minDelta: delta }).then(
      (r) => live && setCmp(r),
      (e) => live && setError(asError(e).message),
    );
    return () => {
      live = false;
    };
  }, [runId, base, delta]);
  if (!others.length) return <Empty title="No other run to compare with">Run the evaluation again (or re-score this run) and the two can be compared metric by metric.</Empty>;
  return (
    <div className="h-full flex flex-col min-h-0" data-rag-compare>
      <div className="flex items-center gap-2 flex-wrap p-2 border-b border-line">
        <label className="text-xs text-muted flex items-center gap-1">
          Compare with
          <Select className="h-7 min-h-7 py-0 text-xs max-w-64" value={base} onChange={(e) => setBase(e.target.value)} aria-label="Baseline run" data-rag-baseline>
            {others.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} · {new Date(r.startedAt).toLocaleString()}
              </option>
            ))}
          </Select>
        </label>
        <label className="text-xs text-muted flex items-center gap-1" title="A change in a mean smaller than this is not called a regression or an improvement">
          counts from
          <Input type="number" step="0.01" min="0" className="h-7 min-h-7 w-16 text-xs" value={minDelta} onChange={(e) => setMinDelta(Number(e.target.value))} aria-label="Smallest change that counts" />
        </label>
        {cmp && (
          <span className="text-xs ml-auto" data-rag-compare-summary>
            <span className={cmp.regressions.length ? 'text-bad' : 'text-ok'}>{plural(cmp.regressions.length, 'regression')}</span> · <span className={cmp.improvements.length ? 'text-ok' : 'text-muted'}>{plural(cmp.improvements.length, 'improvement')}</span> · {cmp.samples.shared} shared samples
          </span>
        )}
      </div>
      {error && <Callout tone="bad" className="m-2">{error}</Callout>}
      {!cmp && !error && (
        <div className="p-6 grid place-items-center">
          <Spinner />
        </div>
      )}
      {cmp && (
        <div className="flex-1 min-h-0 overflow-auto">
          <table className="text-xs w-full">
            <thead className="sticky top-0 bg-bg">
              <tr className="text-muted text-left">
                <th className="px-2 py-1 font-medium">Metric</th>
                <th className="px-2 py-1 font-medium text-right">Baseline</th>
                <th className="px-2 py-1 font-medium text-right">This run</th>
                <th className="px-2 py-1 font-medium text-right">Change</th>
                <th className="px-2 py-1 font-medium text-right" title="95% interval of the paired difference over the samples both runs scored">95% interval</th>
                <th className="px-2 py-1 font-medium"> </th>
              </tr>
            </thead>
            <tbody>
              {[...cmp.metrics]
                .sort((a, b) => Number(b.change === 'regressed') - Number(a.change === 'regressed') || Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0))
                .map((c) => (
                  <tr key={c.key} className="border-t border-line/60" data-rag-compare-row={c.key} data-change={c.change}>
                    <td className="px-2 py-1">
                      {c.key} {c.direction === 'lower' && <span className="text-muted">(lower is better)</span>}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums">{c.baseline ?? '–'}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{c.current ?? '–'}</td>
                    <td className={cx('px-2 py-1 text-right tabular-nums', c.change === 'regressed' ? 'text-bad' : c.change === 'improved' ? 'text-ok' : '')}>{c.delta === undefined ? '' : `${c.delta > 0 ? '+' : ''}${Math.round(c.delta * 1000) / 1000}`}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-muted">{c.ci ? `${c.ci[0]} to ${c.ci[1]}` : ''}</td>
                    <td className="px-2 py-1">
                      <Badge tone={CHANGE_TONE[c.change]} title={c.significant ? 'The interval does not include 0: the change is real, not one unlucky sample' : c.paired < 3 ? 'Fewer than 3 samples in common: no interval' : undefined}>
                        {c.change}
                        {c.significant ? ' · real' : ''}
                      </Badge>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ the variant × metric pivot */

/** Several runs side by side: the mean of every metric per run, the best run of each in bold. */
export function RagPivot({ runs }: { runs: RunChoice[] }) {
  const [picked, setPicked] = useState<string[]>(() => runs.slice(0, 4).map((r) => r.id));
  const [pivot, setPivot] = useState<MetricPivot>();
  const key = picked.join(',');
  useEffect(() => {
    if (picked.length < 1) return setPivot(undefined);
    let live = true;
    void call<MetricPivot>('rag.pivot', { runIds: picked, labels: Object.fromEntries(runs.map((r) => [r.id, `${r.name} · ${new Date(r.startedAt).toLocaleDateString()}`])) }).then((p) => live && setPivot(p), () => live && setPivot(undefined));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(-8)));
  return (
    <div className="h-full flex flex-col min-h-0" data-rag-pivot>
      <div className="flex items-center gap-x-3 gap-y-1 flex-wrap p-2 border-b border-line text-xs">
        <span className="text-muted">Runs</span>
        {runs.slice(0, 12).map((r) => (
          <label key={r.id} className="flex items-center gap-1 whitespace-nowrap">
            <input type="checkbox" checked={picked.includes(r.id)} onChange={() => toggle(r.id)} /> {r.name} · {new Date(r.startedAt).toLocaleDateString()}
          </label>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {!pivot ? (
          <div className="p-6 grid place-items-center">{picked.length ? <Spinner /> : <span className="text-sm text-muted">Pick two or more runs.</span>}</div>
        ) : (
          <table className="text-xs border-separate border-spacing-0 min-w-full">
            <thead className="sticky top-0 bg-bg">
              <tr>
                <th className="text-left px-2 py-1 border-b border-line">Metric</th>
                {pivot.variants.map((v) => (
                  <th key={v.runId} className="text-right px-2 py-1 border-b border-l border-line font-medium whitespace-nowrap">
                    {v.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pivot.metrics.map((mt, i) => (
                <tr key={mt.key} data-rag-pivot-row={mt.key}>
                  <td className="px-2 py-1 border-b border-line/60">
                    {mt.key} {mt.direction === 'lower' && <span className="text-muted">(lower is better)</span>}
                  </td>
                  {pivot.cells[i]!.map((c, v) => (
                    <td key={v} className={cx('px-2 py-1 border-b border-l border-line/60 text-right tabular-nums', pivot.best[i] === v && 'font-bold')} style={{ background: tint(c?.mean, mt.direction === 'lower') }}>
                      {c ? c.mean : '–'}
                      {c?.ci && <div className="font-normal text-muted text-2xs">{c.ci[0]}–{c.ci[1]}</div>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ score again (rescore) */

/**
 * Score a finished run again, without calling the RAG system: with the metrics of the run or of the evaluation as it is now,
 * and a judge you choose (another model, a jury). What it costs is estimated from the stored answers first, with the cache
 * hits counted. The result is a new run beside the old one.
 */
export function RagRescoreDialog({ runId, evaluators, evaluation, judge, providers, onDone, onClose }: { runId: string; evaluators: CheckConfig[]; /** The saved evaluation whose database the SQL metrics use. */ evaluation?: string; judge?: RagJudgeSetup; providers: ProviderConfig[]; onDone(newRunId: string): void; onClose(): void }) {
  const [which, setWhich] = useState<'run' | 'evaluation'>(evaluators.length ? 'evaluation' : 'run');
  const [j, setJ] = useState<RagJudgeSetup>(judge ?? {});
  const [est, setEst] = useState<RunEstimate>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const chosen = which === 'evaluation' ? evaluators : undefined;
  const dj = useDebounced(j, 300);
  useEffect(() => {
    let live = true;
    setEst(undefined);
    setError(undefined);
    void call<RunEstimate>('rag.estimateRescore', { runId, evaluators: chosen, ...(evaluation ? { evaluation } : {}), judge: dj }).then(
      (r) => live && setEst(r),
      (e) => live && setError(asError(e).message),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, which, JSON.stringify(dj)]);
  const go = async () => {
    setBusy(true);
    try {
      const r = await call<{ runId: string }>('rag.rescore', { runId, evaluators: chosen, ...(evaluation ? { evaluation } : {}), judge: j });
      onDone(r.runId);
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const provider = providers.find((p) => p.id === j.provider);
  return (
    <Modal
      title="Score this run again"
      onClose={onClose}
      onSubmit={() => void go()}
      width={720}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={busy ? <Spinner /> : <Play size={13} />} disabled={busy || !est || !!est.judgeProblem} reason={busy ? 'Still scoring' : est?.judgeProblem ?? 'Still estimating the cost'} onClick={() => void go()} data-rag-rescore-run>
            Score again
          </Button>
        </>
      }
    >
      <div className="grid gap-3 text-sm" data-rag-rescore>
        <p className="text-xs text-muted">The answers and the retrieved documents of the run are kept: your RAG system is not called. The result is a new run beside this one, so two judges, or a metric you added, can be compared.</p>
        <div className="flex items-center gap-4 text-sm">
          <label className="flex items-center gap-1">
            <input type="radio" checked={which === 'evaluation'} onChange={() => setWhich('evaluation')} disabled={!evaluators.length} /> The evaluation’s metrics now ({evaluators.length})
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" checked={which === 'run'} onChange={() => setWhich('run')} /> The metrics this run had
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2 [&>*]:min-w-0">
          <Field label="AI reviewer">
            <Select value={j.provider ?? ''} onChange={(e) => setJ({ ...j, provider: e.target.value || undefined, model: providers.find((p) => p.id === e.target.value)?.defaultModel || undefined })} aria-label="AI reviewer provider">
              <option value="">The AI settings’ large model</option>
              <NamedOptions items={providers} />
            </Select>
          </Field>
          <Field label="Model">
            <Input className="mono" value={j.model ?? ''} placeholder={provider?.defaultModel ?? ''} onChange={(e) => setJ({ ...j, model: e.target.value || undefined })} aria-label="AI reviewer model" />
          </Field>
        </div>
        <RagJudgeOptions judge={j} providers={providers} onChange={(p) => p.judge && setJ(p.judge)} />
        {error && <Callout tone="bad">{error}</Callout>}
        {!est && !error && <Spinner />}
        {est && <RagEstimateView estimate={est} />}
      </div>
    </Modal>
  );
}
